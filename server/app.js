const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { CLIENT_DIST, PROJECT_ROOT, TRUST_PROXY, ensureDataDirs } = require('./config');
const { requireSession, requireAuth, requireAdmin, notePairingTokenUse } = require('./middleware/auth');
const requestLogger = require('./middleware/requestLogger');
const { throttleTouch } = require('./utils/sessionStore');
const log = require('./utils/logger').scope('api');

// Uploads in LONG_UPLOADS have no body deadline; they use idle timeouts instead.
const BODY_DEADLINE_MS = 60 * 1000;
const JOURNEY_UPLOAD_DEADLINE_MS = 15 * 60 * 1000;
const LONG_UPLOADS = [
    /^\/api\/routes\/[^/]+\/photos\/?$/,
    /^\/api\/routes\/[^/]+\/uploads(\/|$)/,
];

const HSTS_MAX_AGE_S = 180 * 24 * 60 * 60;

function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    // Only over HTTPS (as the reverse proxy reports it): a browser ignores it on plain HTTP,
    // and a server reached by LAN address must stay reachable that way.
    if (req.secure) res.set('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_S}`);
    next();
}

// What the web app loads: its own files, Google Fonts, and Carto map tiles. Inline styles are
// allowed because React and the map set them; inline scripts are not.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.basemaps.cartocdn.com",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
].join('; ');

function contentSecurityPolicy(req, res, next) {
    res.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
}

// Per-route body deadline (server.requestTimeout is off for multi-hour uploads).
function bodyDeadline(req, res, next) {
    if (LONG_UPLOADS.some((pattern) => pattern.test(req.path))) return next();
    const limit = req.path === '/upload' || req.path === '/upload/' ? JOURNEY_UPLOAD_DEADLINE_MS : BODY_DEADLINE_MS;
    const timer = setTimeout(() => {
        if (!req.complete) {
            log.warn(`${req.method} ${req.path}: request body not received within ${limit / 1000}s, dropping`);
            req.destroy();
        }
    }, limit);
    timer.unref();
    const clear = () => clearTimeout(timer);
    res.once('finish', clear);
    res.once('close', clear);
    next();
}

function createApp({ sessionSecret }) {
    if (!sessionSecret) throw new Error('createApp needs a session secret');
    ensureDataDirs();
    const app = express();
    app.disable('x-powered-by');

    app.set('trust proxy', TRUST_PROXY);

    // Request logging — first in the chain so every response is timed end to end.
    app.use(requestLogger);
    app.use(securityHeaders);
    app.use(bodyDeadline);

    // Public landing page at /landing — static, no session or auth. Mounted ahead of the session
    // middleware so a visit never touches the session store, and ahead of the SPA catch-all.
    const LANDING_DIR = path.join(PROJECT_ROOT, 'landing');
    if (fs.existsSync(LANDING_DIR)) {
        app.use('/landing', express.static(LANDING_DIR, { maxAge: '1h' }));
    }

    // After the landing page, which is static and has inline scripts of its own.
    app.use(contentSecurityPolicy);

    // The web app's own files need no session either.
    if (fs.existsSync(CLIENT_DIST)) {
        app.use(express.static(CLIENT_DIST));
    }

    app.use(express.json());

    app.use(session({
        store: throttleTouch(new PgSession({
            pool: { query: (...args) => pool.query(...args) },
            tableName: 'session',
            createTableIfMissing: false,
        })),
        secret: sessionSecret,
        name: 'journey.sid',
        resave: false,
        saveUninitialized: false,
        // The 30 days run from the last request, not from sign-in, so someone who uses the
        // app regularly isn't signed out on a schedule.
        rolling: true,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
            httpOnly: true,
            sameSite: 'lax',
            secure: 'auto',
        },
    }));

    // Health checks (unprotected). /ping reads the database only when it carries a pairing
    // token: the iOS app pings with its token right after scanning a code, and that is what
    // marks the code as paired.
    app.get('/ping', async (req, res) => {
        await notePairingTokenUse(req);
        res.status(200).send('pong');
    });
    app.get('/health', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok', database: 'ok' });
        } catch {
            res.status(503).json({ status: 'error', database: 'unreachable' });
        }
    });

    app.use('/api/auth', require('./routes/auth'));

    // Upload (accepts session + bearer token)
    app.use('/upload', requireAuth, require('./routes/upload'));

    app.use('/api/settings', requireSession, require('./routes/settings'));
    app.use('/api/pairing', requireSession, require('./routes/pairing'));
    app.use('/api/admin', requireSession, requireAdmin, require('./routes/admin'));

    // Journey AI (Marco) — config + natural-language questions (protected)
    app.use('/api/ask', requireSession, require('./routes/ask'));

    app.use(require('./routes/photos'));

    // Large photo/video uploads sent in pieces (protected)
    app.use('/api/routes/:id/uploads', requireAuth, require('./routes/mediaUploads').router);

    // Session or pairing token; the router itself marks which routes are web-only.
    app.use('/api/routes', requireAuth, require('./routes/journeys'));

    app.use('/api/flights', requireSession, require('./routes/flights'));

    // Reverse geocoding for the web client, forwarded to GEOCODE_BASE_URL (protected)
    app.use('/api/geocode', requireSession, require('./routes/geocode'));

    const exportRoutes = require('./routes/export');
    app.use('/api/export', requireSession, exportRoutes.router);
    app.get('/database', requireSession, exportRoutes.legacyDatabaseDump);

    app.use('/api', requireSession, require('./routes/funstats'));

    app.use('/api', requireSession, require('./routes/maps'));

    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

    if (fs.existsSync(CLIENT_DIST)) {
        app.get('*', (req, res) => {
            res.sendFile(path.join(CLIENT_DIST, 'index.html'));
        });
    }

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
        if (status >= 500) log.error(`${req.method} ${req.path} failed`, err);
        if (res.headersSent) return res.end();
        res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err.expose ? err.message : 'Bad request') });
    });

    return app;
}

module.exports = { createApp };
