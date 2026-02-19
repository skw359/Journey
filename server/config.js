const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(PROJECT_ROOT, 'photos');
const UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads');
const AVATARS_DIR = path.join(PROJECT_ROOT, 'avatars');

// Ensure required directories exist
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
const CLIENT_DIST = path.join(PROJECT_ROOT, 'client', 'dist');

const PORT = parseInt(process.env.PORT, 10) || 3003;
const MIN_ROUTE_MILES = parseFloat(process.env.MIN_ROUTE_MILES || "0.25");
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || undefined;

module.exports = {
    PROJECT_ROOT,
    PHOTOS_DIR,
    UPLOADS_DIR,
    AVATARS_DIR,
    CLIENT_DIST,
    PORT,
    MIN_ROUTE_MILES,
    PUBLIC_URL,
};
