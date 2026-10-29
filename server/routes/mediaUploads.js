const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { pool, withTenantClient, queryTenant } = require('../db');
const { mediaKind, MAX_PHOTO_BYTES, UPLOAD_IDLE_MS } = require('../middleware/storage');
const { MAX_VIDEO_UPLOAD_MB } = require('../config');
const mediaStorage = require('../utils/mediaStorage');
const { addMedia } = require('../utils/mediaIngest');
const { getCapabilities } = require('../utils/video');
const { enqueueMediaJob } = require('../utils/mediaQueue');
const { formatBytes } = require('../utils/format');
const log = require('../utils/logger').scope('uploads');

// Big files arrive as a series of PUTs instead of one long POST: the front proxy stores each
// request in full before passing it on, and a dropped connection only costs one piece. The
// bytes so far sit beside the final file as <name>.upload.tmp, which the attachment mover skips.
const router = express.Router({ mergeParams: true });

const PART_SUFFIX = '.upload.tmp';
const MAX_CHUNK_BYTES = 256 * 1024 * 1024;
const SPACE_MARGIN_BYTES = 1024 ** 3;
const ABANDONED_AFTER_HOURS = 24;
// Uploads with a PUT in progress; two at once would interleave their bytes.
const writing = new Set();

async function loadUpload(userId, routeId, uploadId) {
    const { rows } = await pool.query(
        'SELECT * FROM media_uploads WHERE id = $1 AND user_id = $2 AND route_id = $3',
        [uploadId, userId, routeId]
    );
    return rows[0] || null;
}

async function dropUpload(row) {
    await pool.query('DELETE FROM media_uploads WHERE id = $1', [row.id]);
    if (!row.result) await mediaStorage.removeFiles([row.part_name]);
}

// The partial file and how much of it has arrived, or null if it's gone (its drive was
// unplugged, or it was cleaned up).
async function partOf(row) {
    const partPath = mediaStorage.find(row.part_name);
    if (!partPath) return null;
    return { partPath, received: (await fs.promises.stat(partPath)).size };
}

function progress(row, offset) {
    return { id: row.id, size: Number(row.size), offset };
}

// Adds the finished file to its journey the same way POST /api/routes/:id/photos does.
// Returns that route's response fields, or null if the journey no longer exists.
async function finishUpload(userId, row, partPath) {
    const finalPath = partPath.slice(0, -PART_SUFFIX.length);
    mediaStorage.markBusy(finalPath);
    try {
        await fs.promises.rename(partPath, finalPath);
        const file = {
            path: finalPath,
            originalname: row.original_name,
            mimetype: row.mimetype || '',
            size: Number(row.size),
        };
        const { available: canProcessVideo } = await getCapabilities();
        let added;
        try {
            added = await withTenantClient(userId, async (db) => {
                const { rows } = await db.query('SELECT 1 FROM routes WHERE id = $1', [row.route_id]);
                return rows.length === 0 ? null : addMedia(db, row.route_id, file, { canProcessVideo });
            });
        } catch (err) {
            // Put the bytes back where a retried last piece will find them.
            await fs.promises.rename(finalPath, partPath).catch(() => {});
            throw err;
        }
        if (!added) {
            await fs.promises.rm(finalPath, { force: true });
            await pool.query('DELETE FROM media_uploads WHERE id = $1', [row.id]);
            return null;
        }

        const result = {
            photos: added.photo ? [added.photo] : [],
            skipped: added.skipped ? [added.skipped] : [],
            processing: added.job ? 1 : 0,
        };
        await pool.query('UPDATE media_uploads SET result = $2, updated_at = NOW() WHERE id = $1', [row.id, result]);
        if (added.job) enqueueMediaJob(added.job.kind, userId, added.job.mediaId, added.job.sourcePath);
        log.info(`${row.original_name} received · ${formatBytes(file.size)}`);
        return result;
    } finally {
        mediaStorage.unmarkBusy(finalPath);
    }
}

// POST /api/routes/:id/uploads { name, size, type, key } -> { id, size, offset }
// An unfinished upload with the same key and size is resumed instead of started over.
router.post('/', async (req, res) => {
    const { name, type, key } = req.body || {};
    const size = Number(req.body?.size);
    if (typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(size) || size <= 0) {
        return res.status(400).json({ error: 'A file name and a size above 0 are required' });
    }
    const mimetype = typeof type === 'string' ? type : '';
    const kind = mediaKind({ originalname: name, mimetype });
    if (!kind) {
        return res.status(400).json({ error: `Only HEIC/JPG images and MOV/MP4 videos are allowed (rejected "${name}")` });
    }
    if (kind === 'photo' && size > MAX_PHOTO_BYTES) {
        return res.status(400).json({ error: 'Photos must be smaller than 50 MB' });
    }
    if (kind === 'video' && MAX_VIDEO_UPLOAD_MB && size > MAX_VIDEO_UPLOAD_MB * 1024 * 1024) {
        return res.status(413).json({ error: `Files must be smaller than ${MAX_VIDEO_UPLOAD_MB} MB` });
    }

    try {
        if (kind === 'video' && !(await getCapabilities()).available) {
            return res.status(400).json({ error: 'Video uploads need ffmpeg installed on the server' });
        }
        const { rows: routeCheck } = await queryTenant(req.userId, 'SELECT 1 FROM routes WHERE id = $1', [req.params.id]);
        if (routeCheck.length === 0) return res.status(404).json({ error: 'Journey not found' });

        const uploadKey = typeof key === 'string' && key ? key.slice(0, 512) : null;
        if (uploadKey) {
            const { rows } = await pool.query(`
                SELECT * FROM media_uploads
                WHERE user_id = $1 AND route_id = $2 AND upload_key = $3 AND size = $4 AND result IS NULL
                ORDER BY updated_at DESC LIMIT 1
            `, [req.userId, req.params.id, uploadKey, size]);
            if (rows[0]) {
                const part = await partOf(rows[0]);
                if (part) return res.json(progress(rows[0], part.received));
                if (!writing.has(rows[0].id)) await dropUpload(rows[0]);
            }
        }

        const dir = mediaStorage.userDir(req.userId);
        const { freeBytes } = await mediaStorage.diskSpace(dir);
        if (freeBytes < size + SPACE_MARGIN_BYTES) {
            return res.status(507).json({
                error: `Not enough space for ${name} (${formatBytes(size)}): the server has ${formatBytes(freeBytes)} free and keeps 1 GB spare`,
            });
        }

        const partPath = path.join(dir, `${crypto.randomBytes(16).toString('hex')}${path.extname(name)}${PART_SUFFIX}`);
        await fs.promises.writeFile(partPath, '', { flag: 'wx' });
        const id = crypto.randomBytes(16).toString('hex');
        await pool.query(`
            INSERT INTO media_uploads (id, user_id, route_id, upload_key, original_name, mimetype, size, part_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [id, req.userId, req.params.id, uploadKey, name, mimetype, size, mediaStorage.toStoredName(partPath)]);
        res.status(201).json({ id, size, offset: 0 });
    } catch (error) {
        log.error('Could not start upload:', error);
        res.status(500).json({ error: 'Failed to start upload' });
    }
});

// GET /api/routes/:id/uploads/:uploadId -> { id, size, offset } (plus the result once complete)
router.get('/:uploadId', async (req, res) => {
    try {
        const row = await loadUpload(req.userId, req.params.id, req.params.uploadId);
        if (!row) return res.status(404).json({ error: 'Upload not found; start it again' });
        if (row.result) return res.json({ ...progress(row, Number(row.size)), ...row.result });
        const part = await partOf(row);
        if (!part) {
            if (!writing.has(row.id)) await dropUpload(row);
            return res.status(404).json({ error: 'Upload not found; start it again' });
        }
        res.json(progress(row, part.received));
    } catch (error) {
        log.error('Upload status error:', error);
        res.status(500).json({ error: 'Failed to read upload status' });
    }
});

// PUT /api/routes/:id/uploads/:uploadId?offset=N, body = the bytes starting at N.
// -> { id, size, offset }; the piece that completes the file also returns
// { photos, skipped, processing } like POST /api/routes/:id/photos.
router.put('/:uploadId', async (req, res) => {
    req.setTimeout(UPLOAD_IDLE_MS);
    const { uploadId } = req.params;
    const offset = Number(req.query.offset);
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset is required' });
    }
    if (!Number.isSafeInteger(length)) {
        return res.status(411).json({ error: 'Content-Length is required' });
    }
    if (length > MAX_CHUNK_BYTES) {
        return res.status(413).json({ error: `Send at most ${formatBytes(MAX_CHUNK_BYTES)} per request` });
    }
    if (writing.has(uploadId)) {
        return res.status(409).json({ error: 'This upload is already receiving data' });
    }

    writing.add(uploadId);
    try {
        const row = await loadUpload(req.userId, req.params.id, uploadId);
        if (!row) return res.status(404).json({ error: 'Upload not found; start it again' });
        const size = Number(row.size);
        if (row.result) {
            // The last piece was stored but its response never arrived: answer it again.
            return offset === size
                ? res.json({ ...progress(row, size), ...row.result })
                : res.status(409).json({ error: 'This upload is already complete', ...progress(row, size) });
        }
        const part = await partOf(row);
        if (!part) {
            await dropUpload(row);
            return res.status(404).json({ error: 'Upload not found; start it again' });
        }
        if (offset !== part.received) {
            return res.status(409).json({ error: 'offset does not match the bytes received', ...progress(row, part.received) });
        }
        if (offset + length > size) {
            return res.status(413).json({ error: 'More bytes than the upload declared' });
        }

        await pipeline(req, fs.createWriteStream(part.partPath, { flags: 'a' }));
        const received = (await fs.promises.stat(part.partPath)).size;
        await pool.query('UPDATE media_uploads SET updated_at = NOW() WHERE id = $1', [uploadId]);
        if (received < size) return res.json(progress(row, received));

        const result = await finishUpload(req.userId, row, part.partPath);
        if (!result) return res.status(404).json({ error: 'Journey not found' });
        res.json({ ...progress(row, size), ...result });
    } catch (error) {
        // A client that disconnects mid-piece keeps what arrived and resumes from there.
        if (req.destroyed && !res.headersSent) return;
        log.error('Upload piece error:', error);
        if (!res.headersSent) {
            res.status(error.code === 'ENOSPC' ? 507 : 500).json({
                error: error.code === 'ENOSPC' ? 'The server ran out of disk space' : 'Failed to store upload',
            });
        }
    } finally {
        writing.delete(uploadId);
    }
});

// Uploads nobody has added to for a day are given up on.
async function sweepAbandonedUploads() {
    const { rows } = await pool.query(
        `SELECT * FROM media_uploads WHERE updated_at < NOW() - INTERVAL '${ABANDONED_AFTER_HOURS} hours'`
    );
    let dropped = 0;
    for (const row of rows) {
        if (writing.has(row.id)) continue;
        await dropUpload(row);
        if (!row.result) dropped += 1;
    }
    return dropped;
}

module.exports = { router, sweepAbandonedUploads };
