const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { CLIENT_DIST, PROJECT_ROOT, TRUST_PROXY } = require('./config');
const { requireSession, requireAuth, requireAdmin } = require('./middleware/auth');
const requestLogger = require('./middleware/requestLogger');
const log = require('./utils/logger').scope('api');

// Uploads in LONG_UPLOADS have no body deadline; they use idle timeouts instead.
const BODY_DEADLINE_MS = 60 * 1000;
const JOURNEY_UPLOAD_DEADLINE_MS = 15 * 60 * 1000;
const LONG_UPLOADS = [
    /^\/api\/routes\/[^/]+\/photos\/?$/,
    /^\/api\/routes\/[^/]+\/uploads(\/|$)/,
];

function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
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

// Pairing tokens may list, view, rename and trash journeys under /api/routes; everything
// else there needs a web session.
const TOKEN_RESERVED = new Set([
    'trash', 'combine', 'cities-status', 'places-status',
    'reindex-cities', 'reindex-places', 'backfill-cities', 'backfill-places',
]);
function pairingTokenAllowed(method, routePath) {
    const parts = routePath.split('/').filter(Boolean);
    if (parts.length === 0) return method === 'GET';
    if (TOKEN_RESERVED.has(parts[0])) return false;
    if (parts.length === 1) return method === 'GET' || method === 'DELETE';
    if (parts.length === 2 && method === 'PATCH') return parts[1] === 'name' || parts[1] === 'travel-mode';
    return false;
}
function limitPairingTokens(req, res, next) {
    if (req.authMethod !== 'token' || pairingTokenAllowed(req.method, req.path)) return next();
    res.status(403).json({ error: 'Paired devices cannot do this; use the web app' });
}

function createApp({ sessionSecret }) {
    if (!sessionSecret) throw new Error('createApp needs a session secret');
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

    // Body parsing
    app.use(express.json());

    // Session middleware
    app.use(session({
        store: new PgSession({
            pool: { query: (...args) => pool.query(...args) },
            tableName: 'session',
            createTableIfMissing: false,
        }),
        secret: sessionSecret,
        name: 'journey.sid',
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
            httpOnly: true,
            sameSite: 'lax',
            secure: 'auto',
        },
    }));

    // Serve React build (production)
    if (fs.existsSync(CLIENT_DIST)) {
        app.use(express.static(CLIENT_DIST));
    }

    // Health checks (unprotected); only /health touches the database.
    app.get('/ping', (req, res) => {
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

    // Auth routes (unprotected)
    app.use('/api/auth', require('./routes/auth'));

    // Upload (accepts session + bearer token)
    app.use('/upload', requireAuth, require('./routes/upload'));

    // Protected API routes
    app.use('/api/settings', requireSession, require('./routes/settings'));
    app.use('/api/pairing', requireSession, require('./routes/pairing'));
    app.use('/api/admin', requireSession, requireAdmin, require('./routes/admin'));

    // Journey AI (Marco) — config + natural-language questions (protected)
    app.use('/api/ask', requireSession, require('./routes/ask'));

    // Photos static serving + photo API routes
    app.use(require('./routes/photos'));

    // Large photo/video uploads sent in pieces (protected)
    app.use('/api/routes/:id/uploads', requireAuth, require('./routes/mediaUploads').router);

    // Journey CRUD (protected)
    app.use('/api/routes', requireAuth, limitPairingTokens, require('./routes/journeys'));

    // Flight import (protected)
    app.use('/api/flights', requireSession, require('./routes/flights'));

    // Reverse geocoding for the web client, forwarded to GEOCODE_BASE_URL (protected)
    app.use('/api/geocode', requireSession, require('./routes/geocode'));

    // Exports (protected)
    const exportRoutes = require('./routes/export');
    app.use('/api/export', requireSession, exportRoutes.router);
    app.get('/database', requireSession, exportRoutes.legacyDatabaseDump);

    // Fun stats (protected)
    app.use('/api', requireSession, require('./routes/funstats'));

    // Map data endpoints (protected)
    app.use('/api', requireSession, require('./routes/maps'));

    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

    // SPA catch-all (production)
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

module.exports = { createApp, pairingTokenAllowed };
