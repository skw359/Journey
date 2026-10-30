const { pool, withTenantClient } = require('../db');
const { MIN_ROUTE_MILES } = require('../config');
const { visibleSql } = require('./visibility');
const { computeCitiesPassed } = require('./cities');
const { computePlacesPassed } = require('./places');
const log = require('./logger');

// Fun Stats "Compute Cities/Places" runs here, independent of any browser tab. A row in
// geo_backfill_jobs marks a requested run, so a server restart resumes it; the work left
// is whatever routes still have a NULL column, so nothing else needs saving.
const KINDS = {
    cities: { column: 'cities_passed', compute: computeCitiesPassed },
    places: { column: 'places_passed', compute: computePlacesPassed },
};
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const CACHE_MAX_ENTRIES = 250_000;

const jobs = new Map();
const jobKey = (userId, kind) => `${kind}:${userId}`;

function isGeoKind(kind) {
    return Object.hasOwn(KINDS, kind);
}

function pause(job, ms) {
    job.retryAt = Date.now() + ms;
    return new Promise((resolve) => {
        const { signal } = job.controller;
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            job.retryAt = null;
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}

async function run(job) {
    const { userId, kind } = job;
    const { column, compute } = KINDS[kind];
    const { signal } = job.controller;
    const scoped = log.scope(kind);

    await pool.query(
        'INSERT INTO geo_backfill_jobs (user_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, kind]
    );

    // Lookups are deterministic per grid cell, and most journeys retrace the same streets.
    const cache = new Map();
    const skipped = [];
    let retries = 0;

    while (!signal.aborted) {
        // One route at a time, re-queried each pass, so a Reindex or new upload mid-run is picked up.
        const { rows: [row] } = await withTenantClient(userId, (db) => db.query(
            `SELECT id, name, coordinates FROM routes
             WHERE ${column} IS NULL AND coordinates IS NOT NULL AND ${visibleSql('$1')} AND NOT (id = ANY($2))
             ORDER BY start_time ASC LIMIT 1`,
            [MIN_ROUTE_MILES, skipped]
        ));
        if (!row || signal.aborted) break;

        const coords = Array.isArray(row.coordinates) ? row.coordinates : [];
        const current = { id: row.id, name: row.name || null, points: coords.length, pointsDone: 0 };
        job.current = current;
        if (cache.size > CACHE_MAX_ENTRIES) cache.clear();

        let result;
        try {
            result = await compute(coords, {
                signal,
                cache,
                onProgress: (done) => { current.pointsDone = done; },
            });
        } catch (err) {
            scoped.error(`backfill failed for journey #${row.id}`, err);
            skipped.push(row.id);
            continue;
        }
        if (signal.aborted) break;

        if (result === null) {
            const delay = RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length - 1)];
            retries++;
            scoped.warn(`geocoder unreachable — retrying journey #${row.id} in ${delay / 1000}s`);
            await pause(job, delay);
            continue;
        }
        retries = 0;

        try {
            await withTenantClient(userId, (db) => db.query(
                `UPDATE routes SET ${column} = $1 WHERE id = $2`,
                [JSON.stringify(result), row.id]
            ));
            job.done++;
        } catch (err) {
            scoped.error(`backfill failed for journey #${row.id}`, err);
            skipped.push(row.id);
        }
    }

    job.current = null;
    await pool.query('DELETE FROM geo_backfill_jobs WHERE user_id = $1 AND kind = $2', [userId, kind]);
    scoped.success(`backfill ${signal.aborted ? 'stopped' : 'complete'} · ${job.done} journeys`);
}

function startGeoBackfill(userId, kind) {
    const key = jobKey(userId, kind);
    const existing = jobs.get(key);
    if (existing) {
        // Stopped but still unwinding (an in-flight lookup): run again once it exits.
        if (existing.controller.signal.aborted) existing.restart = true;
        return false;
    }

    const job = {
        userId,
        kind,
        startedAt: new Date().toISOString(),
        done: 0,
        current: null,
        retryAt: null,
        restart: false,
        controller: new AbortController(),
    };
    jobs.set(key, job);
    run(job)
        .catch((err) => {
            if (!job.controller.signal.aborted) log.scope(kind).error('backfill aborted', err);
        })
        .finally(() => {
            jobs.delete(key);
            if (job.restart) startGeoBackfill(userId, kind);
        });
    return true;
}

function stopGeoBackfill(userId, kind) {
    const job = jobs.get(jobKey(userId, kind));
    if (!job) return false;
    job.restart = false;
    job.controller.abort();
    return true;
}

function stopGeoBackfillsForUser(userId) {
    for (const kind of Object.keys(KINDS)) stopGeoBackfill(userId, kind);
}

function describeJob(job) {
    if (!job) return null;
    return {
        startedAt: job.startedAt,
        stopping: job.controller.signal.aborted && !job.restart,
        // Relative, so the browser's clock doesn't matter.
        retryInMs: job.retryAt ? Math.max(0, job.retryAt - Date.now()) : null,
        current: job.current && {
            name: job.current.name,
            points: job.current.points,
            pointsDone: job.current.pointsDone,
        },
    };
}

async function getGeoBackfillStatus(userId, kind) {
    const { column } = KINDS[kind];
    const { rows: [counts] } = await withTenantClient(userId, (db) => db.query(
        `SELECT COUNT(*) AS total, COUNT(${column}) AS processed
         FROM routes WHERE ${visibleSql('$1')} AND coordinates IS NOT NULL`,
        [MIN_ROUTE_MILES]
    ));
    const total = Number(counts.total);
    const processed = Number(counts.processed);
    return {
        total,
        processed,
        remaining: total - processed,
        job: describeJob(jobs.get(jobKey(userId, kind))),
    };
}

async function resetGeoBackfill(userId, kind) {
    const { column } = KINDS[kind];
    const { rowCount } = await withTenantClient(userId, (db) => db.query(
        `UPDATE routes SET ${column} = NULL WHERE ${column} IS NOT NULL`
    ));
    return rowCount;
}

async function resumeGeoBackfills() {
    const { rows } = await pool.query('SELECT user_id, kind FROM geo_backfill_jobs ORDER BY started_at');
    let resumed = 0;
    for (const { user_id: userId, kind } of rows) {
        if (isGeoKind(kind) && startGeoBackfill(userId, kind)) resumed++;
    }
    return resumed;
}

module.exports = {
    startGeoBackfill,
    stopGeoBackfill,
    stopGeoBackfillsForUser,
    getGeoBackfillStatus,
    resetGeoBackfill,
    resumeGeoBackfills,
};
