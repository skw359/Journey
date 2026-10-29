/**
 * One tidy line per API request: timestamp, method, status, path, duration.
 *
 * Static assets (the React bundle, photos, avatars, favicons) are skipped so
 * the console stays a readable stream of API activity rather than a flood of
 * chunk fetches. Set JOURNEY_LOG_HTTP=0 to turn request lines off entirely.
 */

'use strict';

const log = require('../utils/logger');

// Paths that would otherwise drown out anything interesting.
const SKIP_PREFIX = ['/assets/', '/photos/', '/avatars/', '/uploads/'];
const SKIP_EXACT = ['/ping', '/favicon.ico'];
const SKIP_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|heic)$/i;
// One line per piece of a chunked upload; routes/mediaUploads.js logs each finished file instead.
const SKIP_PATTERN = /^\/api\/routes\/[^/]+\/uploads\/[^/]+$/;

function isNoisy(pathname) {
    if (SKIP_EXACT.includes(pathname)) return true;
    if (SKIP_PATTERN.test(pathname)) return true;
    if (SKIP_PREFIX.some((p) => pathname.startsWith(p))) return true;
    return SKIP_EXT.test(pathname);
}

module.exports = function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    const pathname = req.originalUrl.split('?')[0];

    res.on('finish', () => {
        // Errors are always worth showing, even on otherwise-muted paths.
        if (isNoisy(pathname) && res.statusCode < 400) return;
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        log.http({ method: req.method, url: pathname, status: res.statusCode, ms });
    });

    next();
};
