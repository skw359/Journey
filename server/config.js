const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
// Parent of photos/, uploads/ and avatars/.
const DATA_DIR = process.env.JOURNEY_DATA_DIR ? path.resolve(process.env.JOURNEY_DATA_DIR) : PROJECT_ROOT;
// Attachments on this PC. They can live on an external drive instead (utils/mediaStorage.js),
// which creates this folder only when it's used.
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');

// Ensure required directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
const CLIENT_DIST = path.join(PROJECT_ROOT, 'client', 'dist');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = parseInt(process.env.PORT, 10) || 3003;
const MIN_ROUTE_MILES = parseFloat(process.env.MIN_ROUTE_MILES || "0.25");
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || undefined;
// Reverse geocoder (/city, /place, /lookup, /building). Unset turns geocoding off.
const GEOCODE_BASE_URL = (process.env.GEOCODE_BASE_URL || '').replace(/\/+$/, '') || undefined;

// Express "trust proxy". Default: one hop (the reverse proxy). Use false without a proxy.
function parseTrustProxy(raw) {
    const value = String(raw ?? '').trim();
    if (value === '') return 1;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^\d+$/.test(value)) return Number(value);
    return value.split(',').map((part) => part.trim()).filter(Boolean);
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// 0 disables the limit.
const DB_STATEMENT_TIMEOUT_MS = Math.max(parseInt(process.env.DB_STATEMENT_TIMEOUT_MS ?? '30000', 10) || 0, 0);
const DB_POOL_MAX = Math.max(parseInt(process.env.DB_POOL_MAX, 10) || 10, 2);

const MAX_JOURNEY_UPLOAD_MB = Math.max(parseInt(process.env.MAX_JOURNEY_UPLOAD_MB, 10) || 100, 1);
const MAX_JOURNEY_CSV_MB = Math.max(parseInt(process.env.MAX_JOURNEY_CSV_MB, 10) || 1024, 1);
const MAX_JOURNEY_ROWS = Math.max(parseInt(process.env.MAX_JOURNEY_ROWS, 10) || 2_000_000, 1);

// Video uploads (converted to H.264 MP4 with ffmpeg for browser playback).
// Optional per-video cap in MB; unset or 0 means any size.
const MAX_VIDEO_UPLOAD_MB = Math.max(parseInt(process.env.MAX_VIDEO_UPLOAD_MB, 10) || 0, 0);
const VIDEO_MAX_DIMENSION = parseInt(process.env.VIDEO_MAX_DIMENSION, 10) || 1920;
const VIDEO_PRESET = process.env.VIDEO_PRESET || 'veryfast';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

module.exports = {
    PROJECT_ROOT,
    DATA_DIR,
    PHOTOS_DIR,
    UPLOADS_DIR,
    AVATARS_DIR,
    CLIENT_DIST,
    IS_PRODUCTION,
    PORT,
    GEOCODE_BASE_URL,
    MIN_ROUTE_MILES,
    PUBLIC_URL,
    TRUST_PROXY,
    DB_STATEMENT_TIMEOUT_MS,
    DB_POOL_MAX,
    MAX_JOURNEY_UPLOAD_MB,
    MAX_JOURNEY_CSV_MB,
    MAX_JOURNEY_ROWS,
    MAX_VIDEO_UPLOAD_MB,
    VIDEO_MAX_DIMENSION,
    VIDEO_PRESET,
    FFMPEG_PATH,
    FFPROBE_PATH,
};
