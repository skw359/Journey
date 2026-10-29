const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pool, withTenantClient } = require('../db');
const storage = require('./mediaStorage');
const { getThumbnail, deleteThumbnail } = require('./photoThumbs');
const { heicToJpeg } = require('./heic');
const video = require('./video');
const log = require('./logger').scope('media');

// Uploads that need converting (videos, HEIC photos) are stored as-is with status 'processing',
// then converted here. One ffmpeg at a time keeps the rest of the server responsive; photos take
// seconds, so they run alongside it rather than queueing behind a long video.
// In-progress output goes to the OS temp dir rather than photos/ or uploads/, so file sync
// never picks up half-written files.
const TEMP_DIR = path.join(os.tmpdir(), 'journey-media');
const CONCURRENCY = { video: 1, photo: 2 };
const STORAGE_RETRY_MS = 60_000;
const STORAGE_RETRIES = 5;
const queue = [];
const active = new Set();
const storageRetries = new Map();

function unlinkQuiet(filePath) {
    if (!filePath) return;
    fs.promises.unlink(filePath).catch(() => {});
}

async function moveFile(from, to) {
    try {
        await fs.promises.rename(from, to);
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        // Another drive: copy beside the target and rename, so the final name is never a partial file.
        const partial = `${to}.tmp`;
        try {
            await fs.promises.copyFile(from, partial);
            await fs.promises.rename(partial, to);
        } catch (copyErr) {
            await fs.promises.rm(partial, { force: true }).catch(() => {});
            throw copyErr;
        }
        unlinkQuiet(from);
    }
}

// Moves converted output into the current write location. A failure here means the storage
// went away, not that the file is bad.
async function placeOutputs(sourcePath, outputs) {
    const placed = [];
    try {
        const dir = storage.writeDirFor(sourcePath);
        for (const { from, name } of outputs) {
            const to = path.join(dir, name);
            await moveFile(from, to);
            placed.push(to);
        }
        return placed;
    } catch (err) {
        placed.forEach(unlinkQuiet);
        err.storageFailure = true;
        throw err;
    }
}

function markFailed(userId, mediaId) {
    return withTenantClient(userId, (db) => db.query(
        "UPDATE photos SET status = 'failed' WHERE id = $1 AND status = 'processing'", [mediaId]
    ));
}

function kindOf(row) {
    return String(row.mimetype || '').startsWith('video/') ? 'video' : 'photo';
}

function isQueued(mediaId) {
    return queue.some((job) => job.mediaId === mediaId)
        || [...active].some((state) => state.job.mediaId === mediaId);
}

function enqueueMediaJob(kind, userId, mediaId, sourcePath) {
    if (isQueued(mediaId)) return;
    // The attachment mover leaves originals alone until they've been converted.
    storage.markBusy(sourcePath);
    queue.push({ kind, userId, mediaId, sourcePath });
    pump();
}

function cancelWhere(predicate, { deleteSource }) {
    for (let i = queue.length - 1; i >= 0; i--) {
        if (predicate(queue[i])) {
            if (deleteSource) unlinkQuiet(queue[i].sourcePath);
            storage.unmarkBusy(queue[i].sourcePath);
            queue.splice(i, 1);
        }
    }
    for (const state of active) {
        if (!predicate(state.job)) continue;
        state.cancelled = true;
        state.deleteSource = deleteSource;
        state.stop?.();
    }
}

// Stops converting media whose row is gone. With deleteSource, the original upload is removed
// once the converter has let go of it (Windows can't delete a file another process has open).
// Without it the original stays, e.g. for a journey sitting in Trash.
function cancelMediaJob(mediaId, { deleteSource = false } = {}) {
    cancelWhere((job) => job.mediaId === mediaId, { deleteSource });
}

function cancelMediaJobsForUser(userId) {
    cancelWhere((job) => job.userId === userId, { deleteSource: true });
}

function pump() {
    for (const [kind, limit] of Object.entries(CONCURRENCY)) {
        let running = 0;
        for (const state of active) if (state.job.kind === kind) running += 1;
        while (running < limit) {
            const index = queue.findIndex((job) => job.kind === kind);
            if (index === -1) break;
            run(queue.splice(index, 1)[0]);
            running += 1;
        }
    }
}

async function run(job) {
    const state = { job, stop: null, cancelled: false, deleteSource: false };
    active.add(state);
    try {
        await (job.kind === 'video' ? processVideo(state) : processPhoto(state));
    } catch (err) {
        log.error('queue error', err);
    } finally {
        active.delete(state);
        storage.unmarkBusy(job.sourcePath);
        setImmediate(pump);
    }
}

// Tries a conversion again later, once storage that went away may be back.
function retryLater(job) {
    const attempts = (storageRetries.get(job.mediaId) || 0) + 1;
    storageRetries.set(job.mediaId, attempts);
    if (attempts > STORAGE_RETRIES) return;
    setTimeout(() => {
        withTenantClient(job.userId, (db) => db.query(
            "SELECT id, filename, mimetype FROM photos WHERE id = $1 AND status = 'processing'", [job.mediaId]
        ))
            .then(({ rows }) => requeueProcessing(job.userId, rows))
            .catch((retryErr) => log.error(`${job.mediaId}: could not retry`, retryErr));
    }, STORAGE_RETRY_MS).unref();
}

// After a conversion throws: a cancelled job only cleans up; an unplugged drive keeps the
// original for another try; anything else marks the row failed.
async function failJob(state, err) {
    const { userId, mediaId, sourcePath } = state.job;
    if (state.cancelled) {
        if (state.deleteSource) unlinkQuiet(sourcePath);
        return;
    }
    if (err.storageFailure || !fs.existsSync(sourcePath)) {
        log.warn(`${mediaId}: storage unavailable (${err.message}); will retry`);
        retryLater(state.job);
        return;
    }
    log.error(`${mediaId} processing failed: ${err.message}`);
    unlinkQuiet(sourcePath);
    await markFailed(userId, mediaId).catch((dbErr) => {
        log.error(`${mediaId}: could not mark as failed`, dbErr);
    });
}

async function processVideo(state) {
    const { userId, mediaId, sourcePath } = state.job;
    const token = crypto.randomBytes(16).toString('hex');
    const tmpVideo = path.join(TEMP_DIR, `${token}.mp4`);
    const tmpPoster = path.join(TEMP_DIR, `${token}.jpg`);
    const track = (child) => {
        state.stop = () => child.kill('SIGKILL');
        if (state.cancelled) state.stop();
    };
    const startedAt = Date.now();

    try {
        await fs.promises.mkdir(TEMP_DIR, { recursive: true });
        const source = video.describe(await video.probe(sourcePath));
        if (!source) throw new Error('No video stream found');

        const { toneMapping } = await video.getCapabilities();
        const plan = { remux: video.canRemux(source), toneMap: toneMapping };
        try {
            await video.convert(sourcePath, tmpVideo, source, plan, track);
        } catch (err) {
            // Fall back to a plain re-encode if the remux or the HDR tone-mapping chain chokes on this file.
            if (state.cancelled || (!plan.remux && !(source.hdr && plan.toneMap))) throw err;
            log.warn(`${mediaId}: ${err.message}; retrying with a plain re-encode`);
            plan.remux = false;
            plan.toneMap = false;
            await video.convert(sourcePath, tmpVideo, source, plan, track);
        }

        let hasPoster = true;
        try {
            await video.extractPoster(tmpVideo, tmpPoster, source.durationMs, track);
        } catch (err) {
            if (state.cancelled) throw err;
            hasPoster = false;
            log.warn(`${mediaId}: poster extraction failed: ${err.message}`);
        }
        if (state.cancelled) throw new Error('Cancelled');

        const output = video.describe(await video.probe(tmpVideo)) || source;
        const { size } = await fs.promises.stat(tmpVideo);
        const [finalVideo, finalPoster = null] = await placeOutputs(sourcePath, [
            { from: tmpVideo, name: `${token}.mp4` },
            ...(hasPoster ? [{ from: tmpPoster, name: `${token}.jpg` }] : []),
        ]);

        const { rowCount } = await withTenantClient(userId, (db) => db.query(`
            UPDATE photos
            SET filename = $2, poster_filename = $3, mimetype = 'video/mp4', size = $4,
                duration_ms = $5, width = $6, height = $7, status = 'ready'
            WHERE id = $1 AND status = 'processing'
        `, [
            mediaId,
            storage.toStoredName(finalVideo),
            finalPoster ? storage.toStoredName(finalPoster) : null,
            size,
            output.durationMs || source.durationMs,
            output.width,
            output.height,
        ]));

        if (rowCount === 0) {
            // Deleted (with its journey or account) while we were converting.
            unlinkQuiet(finalVideo);
            unlinkQuiet(finalPoster);
        }
        storageRetries.delete(mediaId);
        unlinkQuiet(sourcePath);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.success(`${mediaId} ${plan.remux ? 'remuxed' : 'transcoded'} in ${seconds}s`);
    } catch (err) {
        unlinkQuiet(tmpVideo);
        unlinkQuiet(tmpPoster);
        await failJob(state, err);
    }
}

// HEIC -> JPEG (the only photo format that needs converting).
async function processPhoto(state) {
    const { userId, mediaId, sourcePath } = state.job;
    const token = crypto.randomBytes(16).toString('hex');
    const tmpPhoto = path.join(TEMP_DIR, `${token}.jpg`);
    const startedAt = Date.now();

    try {
        await fs.promises.mkdir(TEMP_DIR, { recursive: true });
        await heicToJpeg(sourcePath, tmpPhoto, (worker) => {
            state.stop = () => worker.terminate();
            if (state.cancelled) state.stop();
        });
        if (state.cancelled) throw new Error('Cancelled');

        const { size } = await fs.promises.stat(tmpPhoto);
        const [finalPhoto] = await placeOutputs(sourcePath, [{ from: tmpPhoto, name: `${token}.jpg` }]);
        // Made before the row turns ready, so the gallery tile shows up at once.
        await getThumbnail(finalPhoto, 'gallery').catch(() => {});

        const { rowCount } = await withTenantClient(userId, (db) => db.query(`
            UPDATE photos SET filename = $2, mimetype = 'image/jpeg', size = $3, status = 'ready'
            WHERE id = $1 AND status = 'processing'
        `, [mediaId, storage.toStoredName(finalPhoto), size]));

        if (rowCount === 0) {
            // Deleted (with its journey or account) while we were converting.
            unlinkQuiet(finalPhoto);
            deleteThumbnail(finalPhoto);
        }
        storageRetries.delete(mediaId);
        unlinkQuiet(sourcePath);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.success(`${mediaId} converted to JPEG in ${seconds}s`);
    } catch (err) {
        unlinkQuiet(tmpPhoto);
        await failJob(state, err);
    }
}

// Queues rows still marked 'processing' (after a restart, a journey restored from Trash, or a
// drive reconnecting). Ones whose original upload is gone are marked failed, unless it may be
// on a drive that's unplugged right now.
async function requeueProcessing(userId, rows) {
    const { available: canConvertVideo } = await video.getCapabilities();
    let queued = 0;
    for (const row of rows) {
        if (isQueued(row.id)) continue;
        const kind = kindOf(row);
        const sourcePath = storage.find(row.filename);
        if (!sourcePath) {
            if (!storage.hasOfflineLocations()) await markFailed(userId, row.id);
        } else if (kind === 'photo' || canConvertVideo) {
            enqueueMediaJob(kind, userId, row.id, sourcePath);
            queued += 1;
        }
        // Without ffmpeg, videos stay 'processing' so they convert once it is installed.
    }
    return queued;
}

// On startup: drop half-written outputs and re-queue media that was mid-conversion at shutdown.
async function resumeMediaJobs() {
    await fs.promises.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
    return requeueAllProcessing();
}

async function requeueAllProcessing() {
    const { rows: users } = await pool.query('SELECT id FROM users');
    let queued = 0;
    for (const user of users) {
        const { rows } = await withTenantClient(user.id, (db) => db.query(
            "SELECT id, filename, mimetype FROM photos WHERE status = 'processing' ORDER BY uploaded_at ASC"
        ));
        queued += await requeueProcessing(user.id, rows);
    }
    return queued;
}

module.exports = {
    enqueueMediaJob,
    cancelMediaJob,
    cancelMediaJobsForUser,
    requeueProcessing,
    requeueAllProcessing,
    resumeMediaJobs,
};
