const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toApiPhoto } = require('../db');
const { mediaKind, MAX_PHOTO_BYTES } = require('../middleware/storage');
const mediaStorage = require('./mediaStorage');

// Browsers (notably on Windows) may send no usable type; the video row needs a video/* one.
const VIDEO_MIME_BY_EXT = {
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
};

function videoMimetype(file) {
    const mime = (file.mimetype || '').toLowerCase();
    if (mime.startsWith('video/')) return mime;
    return VIDEO_MIME_BY_EXT[path.extname(file.originalname).toLowerCase()] || 'video/mp4';
}

function isHeic(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    return file.mimetype === 'image/heic' || file.mimetype === 'image/heif' || ext === '.heic' || ext === '.heif';
}

// Adds one stored upload ({ path, originalname, mimetype, size }) to a journey. Returns
// { photo, job } where job is a conversion to queue once the response is sent, or { skipped }.
async function addMedia(db, routeId, file, { canProcessVideo }) {
    const uploadedAt = new Date().toISOString();

    if (mediaKind(file) === 'video') {
        if (!canProcessVideo) {
            fs.unlinkSync(file.path);
            return { skipped: { name: file.originalname, reason: 'Video uploads need ffmpeg installed on the server' } };
        }
        const videoId = `video-${crypto.randomBytes(8).toString('hex')}`;
        const { rows } = await db.query(`
            INSERT INTO photos (id, route_id, filename, original_name, mimetype, size, uploaded_at, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing')
            RETURNING *
        `, [videoId, routeId, mediaStorage.toStoredName(file.path), file.originalname, videoMimetype(file), file.size, uploadedAt]);
        return { photo: toApiPhoto(rows[0]), job: { kind: 'video', mediaId: videoId, sourcePath: file.path } };
    }

    if (file.size > MAX_PHOTO_BYTES) {
        fs.unlinkSync(file.path);
        return { skipped: { name: file.originalname, reason: 'Photos must be smaller than 50 MB' } };
    }

    // JPEGs are ready as uploaded; HEIC becomes a JPEG in the background.
    const heic = isHeic(file);
    const photoId = `photo-${crypto.randomBytes(8).toString('hex')}`;
    const { rows } = await db.query(`
        INSERT INTO photos (id, route_id, filename, original_name, mimetype, size, uploaded_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `, [
        photoId, routeId, mediaStorage.toStoredName(file.path), file.originalname,
        heic ? 'image/heic' : file.mimetype, file.size, uploadedAt, heic ? 'processing' : null,
    ]);
    return {
        photo: toApiPhoto(rows[0]),
        job: heic ? { kind: 'photo', mediaId: photoId, sourcePath: file.path } : null,
    };
}

module.exports = { addMedia };
