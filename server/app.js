const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool, withTenantClient, toApiRoute } = require('./db');
const { CLIENT_DIST, PROJECT_ROOT } = require('./config');
const { requireSession, requireAuth } = require('./middleware/auth');
const requestLogger = require('./middleware/requestLogger');
const log = require('./utils/logger').scope('api');

const app = express();

// Trust reverse proxy headers (X-Forwarded-Proto, X-Forwarded-Host)
app.set('trust proxy', true);

// Request logging — first in the chain so every response is timed end to end.
app.use(requestLogger);

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
    secret: process.env.SESSION_SECRET || 'journey-fallback-secret',
    name: 'journey.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
    },
}));

// Serve React build (production) or legacy public dir
if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
} else {
    app.use(express.static(path.join(PROJECT_ROOT, 'public')));
}

// Mount routes
const journeysRouter = require('./routes/journeys');
const uploadRouter = require('./routes/upload');
const photosRouter = require('./routes/photos');
const mapsRouter = require('./routes/maps');
const authRouter = require('./routes/auth');
const settingsRouter = require('./routes/settings');
const pairingRouter = require('./routes/pairing');
const funstatsRouter = require('./routes/funstats');
const flightsRouter = require('./routes/flights');

// Health check (unprotected)
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Auth routes (unprotected)
app.use('/api/auth', authRouter);

// Upload (accepts session + bearer token)
app.use('/upload', requireAuth, uploadRouter);

// Protected API routes
app.use('/api/settings', requireSession, settingsRouter);
app.use('/api/pairing', requireSession, pairingRouter);

// Journey AI (Marco) — config + natural-language questions (protected)
const askRouter = require('./routes/ask');
app.use('/api/ask', requireSession, askRouter);

// Photos static serving + photo API routes
app.use(photosRouter);

// Large photo/video uploads sent in pieces (protected)
app.use('/api/routes/:id/uploads', requireAuth, require('./routes/mediaUploads').router);

// Journey CRUD (protected)
app.use('/api/routes', requireAuth, journeysRouter);

// Flight import (protected)
app.use('/api/flights', requireSession, flightsRouter);

// Fun stats (protected)
app.use('/api', requireSession, funstatsRouter);

// Map data endpoints (protected)
app.use('/api', requireSession, mapsRouter);

// GET /database - Download/Access the raw JSON data (protected)
app.get('/database', requireSession, async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows: routes } = await db.query('SELECT * FROM routes');
            if (routes.length === 0) {
                return res.status(404).json({ error: 'Database file does not exist yet.' });
            }

            const result = [];
            for (const route of routes) {
                const { rows: waypoints } = await db.query(
                    'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [route.id]
                );
                const { rows: photos } = await db.query(
                    'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [route.id]
                );
                result.push(toApiRoute(route, waypoints, photos));
            }
            res.json(result);
        });
    } catch (err) {
        log.error('GET /database error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// SPA fallback routes
app.get(['/alltime', '/atlas', '/funstats', '/marco'], (req, res) => {
    if (fs.existsSync(CLIENT_DIST)) {
        res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    } else {
        res.sendFile(path.join(PROJECT_ROOT, 'public', 'alltimetravel.html'));
    }
});

// SPA catch-all (production)
if (fs.existsSync(CLIENT_DIST)) {
    app.get('*', (req, res) => {
        res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
}

module.exports = app;
