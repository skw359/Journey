const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { UPLOADS_DIR, MAX_VIDEO_UPLOAD_MB } = require('../config');
const mediaStorage = require('../utils/mediaStorage');

const upload = multer({ dest: UPLOADS_DIR });

const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            file.mediaDir = mediaStorage.userDir(req.userId || 'unscoped');
            cb(null, file.mediaDir);
        } catch (err) {
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        const uniqueName = `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname)}`;
        // Off limits to the attachment mover until this request is done with the file.
        const fullPath = path.join(file.mediaDir, uniqueName);
        if (!req.busyMediaPaths) {
            req.busyMediaPaths = [];
            req.res.once('close', () => req.busyMediaPaths.forEach(mediaStorage.unmarkBusy));
        }
        req.busyMediaPaths.push(fullPath);
        mediaStorage.markBusy(fullPath);
        cb(null, uniqueName);
    }
});

const ALLOWED_PHOTO_EXT = /^\.(jpe?g|heic|heif)$/;

const ALLOWED_PHOTO_MIME = new Set([
    'image/jpeg',
    'image/jpg',
    'image/pjpeg',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
]);

// Browsers routinely send no usable MIME type for HEIC/HEIF: Windows has no
// registry entry for .heic unless the HEIF Image Extensions are installed, so
// Chrome/Edge fall back to an empty type or application/octet-stream. Trust the
// extension in that case instead of rejecting the file outright.
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const ALLOWED_VIDEO_EXT = /^\.(mov|mp4|m4v|webm|mkv|avi)$/;

const MAX_PHOTO_BYTES = 50 * 1024 * 1024;

// Uploads have no overall deadline (a big video can take hours); a connection that sends
// nothing for this long is dropped instead.
const UPLOAD_IDLE_MS = 5 * 60 * 1000;

// 'photo', 'video', or null for files we don't accept.
function mediaKind(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = (file.mimetype || '').toLowerCase().split(';')[0].trim();

    if (ALLOWED_PHOTO_EXT.test(ext) && (ALLOWED_PHOTO_MIME.has(mime) || GENERIC_MIME.has(mime))) {
        return 'photo';
    }
    if (ALLOWED_VIDEO_EXT.test(ext) && (mime.startsWith('video/') || GENERIC_MIME.has(mime))) {
        return 'video';
    }
    return null;
}

// Multer can only enforce one size limit, so it uses the video limit here (if one is set);
// the photo route rejects photos over MAX_PHOTO_BYTES itself.
const photoUpload = multer({
    storage: photoStorage,
    limits: MAX_VIDEO_UPLOAD_MB ? { fileSize: MAX_VIDEO_UPLOAD_MB * 1024 * 1024 } : {},
    fileFilter: (req, file, cb) => {
        if (mediaKind(file)) {
            cb(null, true);
        } else {
            const ext = path.extname(file.originalname).toLowerCase();
            const err = new Error(
                `Only HEIC/JPG images and MOV/MP4 videos are allowed (rejected "${file.originalname}", ` +
                `extension "${ext || 'none'}", type "${file.mimetype || 'none'}")`
            );
            err.code = 'INVALID_PHOTO_TYPE';
            cb(err);
        }
    }
});

module.exports = { upload, photoUpload, mediaKind, MAX_PHOTO_BYTES, UPLOAD_IDLE_MS };
