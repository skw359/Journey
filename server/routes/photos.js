const express = require('express');
const router = express.Router();
const fs = require('fs');
const { withTenantClient, queryTenant, toApiPhoto } = require('../db');
const { photoUpload, UPLOAD_IDLE_MS } = require('../middleware/storage');
const { MAX_VIDEO_UPLOAD_MB } = require('../config');
const { requireAuth } = require('../middleware/auth');
const { getThumbnail } = require('../utils/photoThumbs');
const mediaStorage = require('../utils/mediaStorage');
const { addMedia } = require('../utils/mediaIngest');
const { getCapabilities } = require('../utils/video');
const { enqueueMediaJob, cancelMediaJob } = require('../utils/mediaQueue');
const log = require('../utils/logger').scope('photos');

// Runs multer and turns its errors (bad type, too large, disk full) into JSON instead of HTML 500s.
function acceptMedia(req, res, next) {
    req.setTimeout(UPLOAD_IDLE_MS);
    photoUpload.array('photos')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'ENOSPC') {
            return res.status(507).json({ error: 'The server ran out of disk space while storing this upload' });
        }
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? `Files must be smaller than ${MAX_VIDEO_UPLOAD_MB} MB`
            : err.message;
        res.status(400).json({ error: message });
    });
}

// Absolute path of one of the user's photos (or a video or video poster), or null if it
// isn't theirs or is missing
async function findOwnedPhoto(userId, filename) {
    const { rows } = await queryTenant(
        userId,
        'SELECT 1 FROM photos WHERE filename = $1 OR poster_filename = $1 LIMIT 1',
        [filename]
    );
    if (rows.length === 0) return null;
    return mediaStorage.find(filename);
}

// Reduced copies for previews, by URL prefix:
//   /photos/thumb/<filename>      gallery tiles (720px wide)
//   /photos/thumb-480/<filename>  journey list card backgrounds
// Thumbnails are cached as immutable, so a size change needs a new prefix,
// or browsers keep showing the old images.
// Videos have no thumbnails of their own; clients request their poster's.
const THUMB_PREFIX_SIZES = { thumb: 'gallery', 'thumb-480': 'card' };

// GET /photos/thumb[-480]/<filename>. Registered before the full-size route,
// which would otherwise match it, and kept as its own path (not a query
// string) so caches keyed by path, like the Windows app's photo cache, keep
// each size apart.
router.get(/^\/photos\/(thumb|thumb-480)\/(.+)$/, requireAuth, async (req, res) => {
    try {
        const photoPath = await findOwnedPhoto(req.userId, req.params[1]);
        if (!photoPath) {
            return res.status(404).json({ error: 'Photo not found' });
        }

        let thumbPath = null;
        try {
            thumbPath = await getThumbnail(photoPath, THUMB_PREFIX_SIZES[req.params[0]]);
        } catch (error) {
            log.error('Thumbnail generation failed:', error);
        }
        if (!thumbPath) return res.sendFile(photoPath);

        // Photo filenames are unique, so a thumbnail never changes
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
        res.sendFile(thumbPath);
    } catch (error) {
        log.error('Thumbnail fetch error:', error);
        res.status(500).json({ error: 'Failed to load photo' });
    }
});

router.get(/^\/photos\/(.+)$/, requireAuth, async (req, res) => {
    try {
        const photoPath = await findOwnedPhoto(req.userId, req.params[0]);
        if (!photoPath) {
            return res.status(404).json({ error: 'Photo not found' });
        }

        // sendFile honours Range requests, which video seeking relies on.
        res.sendFile(photoPath);
    } catch (error) {
        log.error('Photo fetch error:', error);
        res.status(500).json({ error: 'Failed to load photo' });
    }
});

// GET /api/routes/:id/photos (lightweight; the web app polls this while uploads convert)
router.get('/api/routes/:id/photos', requireAuth, async (req, res) => {
    try {
        const { rows } = await queryTenant(
            req.userId,
            'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC',
            [req.params.id]
        );
        res.json({ photos: rows.map(toApiPhoto) });
    } catch (error) {
        log.error('Photo list error:', error);
        res.status(500).json({ error: 'Failed to load photos' });
    }
});

// POST /api/routes/:id/photos (photos and videos, field name "photos")
// Responds once the files are stored: HEIC photos and videos come back as 'processing' and are
// converted in the background (utils/mediaQueue.js).
router.post('/api/routes/:id/photos', requireAuth, acceptMedia, async (req, res) => {
    const files = req.files || [];
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows: routeCheck } = await db.query('SELECT 1 FROM routes WHERE id = $1', [req.params.id]);
            if (routeCheck.length === 0) {
                files.forEach((file) => fs.unlinkSync(file.path));
                return res.status(404).json({ error: 'Journey not found' });
            }

            const { rows: countResult } = await db.query(
                'SELECT COUNT(*) AS cnt FROM photos WHERE route_id = $1', [req.params.id]
            );
            const currentCount = parseInt(countResult[0].cnt, 10);

            const { available: canProcessVideo } = await getCapabilities();
            const newPhotos = [];
            const skipped = [];
            const jobs = [];

            for (const file of files) {
                const added = await addMedia(db, req.params.id, file, { canProcessVideo });
                if (added.skipped) {
                    skipped.push(added.skipped);
                    continue;
                }
                newPhotos.push(added.photo);
                if (added.job) jobs.push(added.job);
            }

            res.json({
                message: 'Photos uploaded successfully',
                photos: newPhotos,
                totalPhotos: currentCount + newPhotos.length,
                // HEIC photos queued for conversion to JPEG
                converted: jobs.filter((job) => job.kind === 'photo').length,
                processing: jobs.length,
                skipped,
            });

            for (const job of jobs) {
                enqueueMediaJob(job.kind, req.userId, job.mediaId, job.sourcePath);
            }
        });
    } catch (error) {
        log.error('Photo upload error:', error);
        files.forEach((file) => {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        });
        res.status(500).json({ error: 'Failed to upload photos' });
    }
});

// DELETE /api/routes/:id/photos/:photoId
router.delete('/api/routes/:id/photos/:photoId', requireAuth, async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query(
                'DELETE FROM photos WHERE id = $1 AND route_id = $2 RETURNING filename, poster_filename',
                [req.params.photoId, req.params.id]
            );

            if (rows.length === 0) {
                const { rows: routeCheck } = await db.query('SELECT 1 FROM routes WHERE id = $1', [req.params.id]);
                if (routeCheck.length === 0) {
                    return res.status(404).json({ error: 'Journey not found' });
                }
                return res.status(404).json({ error: 'Photo not found' });
            }

            cancelMediaJob(req.params.photoId, { deleteSource: true });
            await mediaStorage.removeFiles([rows[0].filename, rows[0].poster_filename]);

            res.json({ message: 'Photo deleted successfully' });
        });
    } catch (error) {
        log.error('Photo deletion error:', error);
        res.status(500).json({ error: 'Failed to delete photo' });
    }
});

module.exports = router;
