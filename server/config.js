const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
// Attachments on this PC. They can live on an external drive instead (utils/mediaStorage.js),
// which creates this folder only when it's used.
const PHOTOS_DIR = path.join(PROJECT_ROOT, 'photos');
const UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads');
const AVATARS_DIR = path.join(PROJECT_ROOT, 'avatars');

// Ensure required directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
const CLIENT_DIST = path.join(PROJECT_ROOT, 'client', 'dist');

const PORT = parseInt(process.env.PORT, 10) || 3003;
const MIN_ROUTE_MILES = parseFloat(process.env.MIN_ROUTE_MILES || "0.25");
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || undefined;

// Video uploads (converted to H.264 MP4 with ffmpeg for browser playback).
// Optional per-video cap in MB; unset or 0 means any size.
const MAX_VIDEO_UPLOAD_MB = Math.max(parseInt(process.env.MAX_VIDEO_UPLOAD_MB, 10) || 0, 0);
const VIDEO_MAX_DIMENSION = parseInt(process.env.VIDEO_MAX_DIMENSION, 10) || 1920;
const VIDEO_PRESET = process.env.VIDEO_PRESET || 'veryfast';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

module.exports = {
    PROJECT_ROOT,
    PHOTOS_DIR,
    UPLOADS_DIR,
    AVATARS_DIR,
    CLIENT_DIST,
    PORT,
    MIN_ROUTE_MILES,
    PUBLIC_URL,
    MAX_VIDEO_UPLOAD_MB,
    VIDEO_MAX_DIMENSION,
    VIDEO_PRESET,
    FFMPEG_PATH,
    FFPROBE_PATH,
};
