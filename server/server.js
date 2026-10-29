const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = require('./app');
const { pool, initSchema, withTenantClient } = require('./db');
const { sweepAllTrash } = require('./utils/trash');
const { getCapabilities } = require('./utils/video');
const { resumeMediaJobs, requeueAllProcessing } = require('./utils/mediaQueue');
const mediaStorage = require('./utils/mediaStorage');
const mediaMove = require('./utils/mediaMove');
const { resumeGeoBackfills } = require('./utils/geoBackfill');
const { backfillWindDirections } = require('./utils/weather');
const { sweepAbandonedUploads } = require('./routes/mediaUploads');
const { PORT, CLIENT_DIST, PUBLIC_URL } = require('./config');
const log = require('./utils/logger');
const fs = require('fs');

const { version } = require('../package.json');

// How often to permanently purge journeys that have outlived the Trash window.
const TRASH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Render DATABASE_URL as host:port/db, never leaking the password. */
function describeDatabase() {
    const raw = process.env.DATABASE_URL;
    if (!raw) return 'DATABASE_URL not set';
    try {
        const u = new URL(raw);
        const db = u.pathname.replace(/^\//, '') || 'postgres';
        return `${u.hostname}:${u.port || 5432}/${db}`;
    } catch {
        return 'postgres';
    }
}

async function backfillTravelModes() {
    const { rows: users } = await pool.query('SELECT id FROM users');
    let totalBackfilled = 0;

    for (const user of users) {
        await withTenantClient(user.id, async (db) => {
            const result = await db.query(`
                UPDATE routes SET travel_mode = CASE
                    WHEN avg_speed <= 7 THEN 'foot'
                    WHEN avg_speed <= 22 THEN 'scooter'
                    ELSE 'drive'
                END
                WHERE travel_mode IS NULL AND avg_speed IS NOT NULL
            `);
            totalBackfilled += result.rowCount;
        });
    }

    return { users: users.length, backfilled: totalBackfilled };
}

async function sweepTrash({ boot = false } = {}) {
    try {
        const purged = await sweepAllTrash();
        if (boot) {
            log.step('trash', purged > 0
                ? `${purged} expired journey${purged === 1 ? '' : 's'} purged`
                : 'nothing expired');
        } else if (purged > 0) {
            log.scope('trash').info(`purged ${purged} expired journey${purged === 1 ? '' : 's'}`);
        }
    } catch (err) {
        if (boot) log.step('trash', `sweep failed — ${err.message}`, 'warn');
        else log.scope('trash').error('sweep failed', err);
    }
}

// Video uploads need ffmpeg; without it the server runs fine but rejects videos.
// HEIC photo conversion needs nothing extra, so interrupted conversions resume either way.
async function startMediaProcessing() {
    const { available, toneMapping } = await getCapabilities();
    if (!available) {
        log.step('video', 'ffmpeg not found — video uploads disabled (install ffmpeg to enable)', 'warn');
    } else {
        log.step('video', toneMapping ? 'ffmpeg ready' : 'ffmpeg ready, no zscale — HDR videos keep HDR tags',
            toneMapping ? 'ok' : 'warn');
    }
    try {
        const queued = await resumeMediaJobs();
        if (queued > 0) log.step('media', `${queued} conversion${queued === 1 ? '' : 's'} resumed`);
    } catch (err) {
        log.step('media', `could not resume conversions — ${err.message}`, 'warn');
    }
}

function sweepUploads() {
    sweepAbandonedUploads()
        .then((dropped) => {
            if (dropped > 0) log.scope('uploads').info(`dropped ${dropped} unfinished upload${dropped === 1 ? '' : 's'} idle for a day`);
        })
        .catch((err) => log.scope('uploads').error('upload sweep failed', err));
}

async function startMediaStorage() {
    await mediaStorage.init();
    const location = mediaStorage.currentLocation();
    if (location.online) {
        log.step('storage', location.kind === 'drive' ? `${location.name} ${log.glyphs.dot} ${location.path}` : location.path);
    } else {
        log.step('storage', `${location.name} not connected ${log.glyphs.dot} new attachments go to this PC until it's back`, 'warn');
    }
}

// A drive coming back: catch up on deletes made while it was gone, convert media whose
// original was on it, then move this PC's stand-in files over.
function watchMediaStorage() {
    const scoped = log.scope('storage');
    mediaStorage.onChange(({ online }) => {
        if (!online) return;
        mediaStorage.applyPendingDeletes()
            .then(() => requeueAllProcessing())
            .catch((err) => scoped.error('could not catch up after a drive reconnected', err))
            .finally(() => mediaMove.kick());
    });
    mediaStorage.startWatching();
    mediaStorage.applyPendingDeletes()
        .catch((err) => scoped.error('could not apply queued deletes', err))
        .finally(() => mediaMove.kick());
}

async function resumeGeoBackfillJobs() {
    try {
        const resumed = await resumeGeoBackfills();
        if (resumed > 0) log.step('geocoding', `${resumed} cities/places backfill${resumed === 1 ? '' : 's'} resumed`);
    } catch (err) {
        log.step('geocoding', `could not resume backfills — ${err.message}`, 'warn');
    }
}

// Weather stored before wind direction was recorded gets it filled in once the
// server is up; it's one weather lookup per journey, so it never holds up boot.
function backfillWindDirectionsInBackground() {
    backfillWindDirections()
        .then(({ filled, pending }) => {
            if (pending > 0) {
                log.scope('weather').success(`wind direction backfilled · ${filled}/${pending} journeys`);
            }
        })
        .catch((err) => log.scope('weather').error('wind direction backfill failed', err));
}

async function startServer() {
    const startedAt = Date.now();
    log.banner('the first-class timeline platform');

    try {
        await initSchema();
        log.step('database', describeDatabase());

        const { users, backfilled } = await backfillTravelModes();
        log.step('migrations', backfilled > 0
            ? `travel modes backfilled for ${backfilled} journey${backfilled === 1 ? '' : 's'}`
            : `schema up to date ${log.glyphs.dot} ${users} user${users === 1 ? '' : 's'}`);

        await startMediaStorage();
        await sweepTrash({ boot: true });
        setInterval(() => sweepTrash(), TRASH_SWEEP_INTERVAL_MS);

        await startMediaProcessing();
        watchMediaStorage();
        sweepUploads();
        setInterval(sweepUploads, UPLOAD_SWEEP_INTERVAL_MS);
        await resumeGeoBackfillJobs();

        const hasBuild = fs.existsSync(CLIENT_DIST);
        log.step('frontend',
            hasBuild ? 'serving React build from client/dist'
                     : 'legacy public/ — run "npm run build" for the React app',
            hasBuild ? 'ok' : 'warn');

        const server = app.listen(PORT, () => {
            log.step('server', `node ${process.version} ${log.glyphs.dot} journey v${version}`);
            log.ready({ port: PORT, startedAt, publicUrl: PUBLIC_URL });
            backfillWindDirectionsInBackground();
        });
        // Node's default requestTimeout answers 408 to any request still arriving after 5
        // minutes, which cut off large video uploads. Upload routes drop idle connections instead.
        server.requestTimeout = 0;
    } catch (err) {
        log.flushSteps();
        log.error('server failed to start', err);
        process.exit(1);
    }
}

// Keep crashes as legible as the happy path.
process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('SIGINT', () => {
    process.stdout.write('\n');
    log.scope('server').info('shutting down');
    process.exit(0);
});

startServer();
