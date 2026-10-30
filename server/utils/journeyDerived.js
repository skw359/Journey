const { pool, queryTenant, withTenantTransaction } = require('../db');
const { MIN_ROUTE_MILES } = require('../config');
const { statesForCoords } = require('./states');
const { isVisible } = require('./visibility');
const log = require('./logger').scope('derived');

// Per-journey data computed once per write (see route_derived in db.js), so map, heatmap and
// Fun Stats requests don't read every recorded point. Bump VERSION when the output changes.
const VERSION = 1;
// Matches the Atlas's first download (client BASE_MAX_POINTS).
const OVERVIEW_POINTS = 100;
// ~2 m: below half a pixel up to zoom 15, the coarsest view that requests detail lines.
const DETAIL_TOLERANCE_DEG = 2e-5;
// Heatmap cell sizes by zoom, finest first; index + 1 is the stored level.
const HEAT_LEVELS = [
    { level: 1, cell: 0.0002, minZoom: 15 },
    { level: 2, cell: 0.0005, minZoom: 13 },
    { level: 3, cell: 0.001, minZoom: 11 },
    { level: 4, cell: 0.002, minZoom: 9 },
    { level: 5, cell: 0.005, minZoom: 7 },
    { level: 6, cell: 0.01, minZoom: -Infinity },
];
const FINE_LEVEL = 3;   // 0.001°, Fun Stats "exploration" cells
const COARSE_LEVEL = 6; // 0.01°, Fun Stats "locations"

function heatLevelForZoom(zoom) {
    return HEAT_LEVELS.find((entry) => zoom >= entry.minZoom);
}

function roundCoord(coord) {
    if (!Array.isArray(coord) || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return coord;
    return [Math.round(coord[0] * 1e6) / 1e6, Math.round(coord[1] * 1e6) / 1e6];
}

// Evenly spaced picks, first and last included (as maps.js always sampled).
function downsample(coords, max) {
    if (max <= 0) return coords;
    if (coords.length <= max) return coords;
    if (max === 1) return [coords[0]];
    if (max === 2) return [coords[0], coords[coords.length - 1]];
    const result = [coords[0]];
    const step = (coords.length - 1) / (max - 1);
    for (let i = 1; i < max - 1; i++) {
        result.push(coords[Math.round(i * step)]);
    }
    result.push(coords[coords.length - 1]);
    return result;
}

function isPoint(coord) {
    return Array.isArray(coord) && coord.length >= 2 && Number.isFinite(coord[0]) && Number.isFinite(coord[1]);
}

// Douglas–Peucker over segments, in degrees with longitude scaled by cos(latitude).
function simplify(points, tolerance) {
    const n = points.length;
    if (n <= 2) return points.slice();
    let sumLat = 0;
    for (const p of points) sumLat += p[0];
    const k = Math.cos((sumLat / n) * Math.PI / 180);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        xs[i] = points[i][1] * k;
        ys[i] = points[i][0];
    }
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const tol2 = tolerance * tolerance;
    const stack = [0, n - 1];
    while (stack.length) {
        const b = stack.pop();
        const a = stack.pop();
        const ax = xs[a], ay = ys[a];
        const dx = xs[b] - ax, dy = ys[b] - ay;
        const len2 = dx * dx + dy * dy;
        let maxD = -1;
        let idx = -1;
        for (let i = a + 1; i < b; i++) {
            let t = len2 > 0 ? ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + t * dx - xs[i];
            const py = ay + t * dy - ys[i];
            const d = px * px + py * py;
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > tol2) {
            keep[idx] = 1;
            stack.push(a, idx, idx, b);
        }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
    return out;
}

/**
 * Per-point times in ms, indexed like row.coordinates: the recorded times when they line
 * up with the coordinates, otherwise spread evenly over start..end (null if unknown).
 */
function pointTimes(row) {
    const coords = Array.isArray(row.coordinates) ? row.coordinates : [];
    const n = coords.length;
    const times = row.profile_time_ms;
    if (Array.isArray(times) && times.length === n && times.every((t) => Number.isFinite(Number(t)))) {
        return times.map(Number);
    }
    const startMs = row.start_time ? new Date(row.start_time).getTime() : null;
    const endMs = row.end_time ? new Date(row.end_time).getTime() : null;
    if (startMs == null || endMs == null || !(endMs >= startMs)) return null;
    const denom = Math.max(n - 1, 1);
    return coords.map((_, i) => startMs + Math.floor((endMs - startMs) * (i / denom)));
}

function heatCells(points) {
    const level = [];
    const lat = [];
    const lon = [];
    const samples = [];
    const off = [];
    for (const { level: l, cell } of HEAT_LEVELS) {
        off.push(level.length + 1);
        const counts = new Map();
        for (const p of points) {
            const a = Math.round(p[0] / cell);
            const o = Math.round(p[1] / cell);
            const key = `${a},${o}`;
            const entry = counts.get(key);
            if (entry) entry[2] += 1;
            else counts.set(key, [a, o, 1]);
        }
        const cells = [...counts.values()].sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
        for (const [a, o, s] of cells) {
            level.push(l);
            lat.push(a);
            lon.push(o);
            samples.push(s);
        }
    }
    off.push(level.length + 1);
    return { off, level, lat, lon, samples };
}

/** Derived columns for a route row (needs coordinates, profile_time_ms, start/end_time, distance, force_visible). */
function computeDerived(row, { minMiles = MIN_ROUTE_MILES } = {}) {
    const coords = Array.isArray(row.coordinates) ? row.coordinates : [];
    const times = pointTimes(row);
    const points = [];
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    let tMin = null, tMax = null;
    let north = null, south = null, east = null, west = null;
    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        if (!isPoint(c)) continue;
        const [lat, lon] = c;
        points.push([lat, lon]);
        if (lat > maxLat) { maxLat = lat; north = [lat, lon]; }
        if (lat < minLat) { minLat = lat; south = [lat, lon]; }
        if (lon > maxLon) { maxLon = lon; east = [lat, lon]; }
        if (lon < minLon) { minLon = lon; west = [lat, lon]; }
        if (times) {
            const t = times[i];
            if (tMin == null || t < tMin) tMin = t;
            if (tMax == null || t > tMax) tMax = t;
        }
    }
    const has = points.length > 0;
    const heat = heatCells(points);
    return {
        version: VERSION,
        min_miles: minMiles,
        visible: isVisible(row, minMiles),
        point_count: coords.length,
        valid_points: points.length,
        min_lat: has ? minLat : null,
        min_lon: has ? minLon : null,
        max_lat: has ? maxLat : null,
        max_lon: has ? maxLon : null,
        t_min: tMin,
        t_max: tMax,
        extremes: has ? { n: north, s: south, e: east, w: west } : null,
        overview: downsample(coords, OVERVIEW_POINTS).map(roundCoord),
        detail: simplify(points, DETAIL_TOLERANCE_DEG).map(roundCoord),
        states: statesForCoords(points),
        heat_off: heat.off,
        heat_level: heat.level,
        heat_lat: heat.lat,
        heat_lon: heat.lon,
        heat_samples: heat.samples,
    };
}

const DERIVED_COLUMNS = [
    'route_id', 'version', 'min_miles', 'visible', 'point_count', 'valid_points',
    'min_lat', 'min_lon', 'max_lat', 'max_lon', 't_min', 't_max', 'extremes', 'overview', 'detail',
    'states', 'heat_off', 'heat_level', 'heat_lat', 'heat_lon', 'heat_samples',
];
const JSON_DERIVED = new Set(['extremes', 'overview', 'detail']);

async function refreshRoute(userId, routeId) {
    return withTenantTransaction(userId, async (db) => {
        // FOR SHARE: the route can't change until this derived row is in place.
        const { rows: [row] } = await db.query(
            `SELECT id, coordinates, profile_time_ms, start_time, end_time, distance, force_visible
             FROM routes WHERE id = $1 FOR SHARE`,
            [routeId]
        );
        if (!row) return false;
        const derived = { route_id: routeId, ...computeDerived(row) };
        await db.query('DELETE FROM route_derived WHERE route_id = $1', [routeId]);
        await db.query(
            `INSERT INTO route_derived (${DERIVED_COLUMNS.join(', ')})
             VALUES (${DERIVED_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
             ON CONFLICT (route_id) DO NOTHING`,
            DERIVED_COLUMNS.map((column) => (JSON_DERIVED.has(column) && derived[column] != null
                ? JSON.stringify(derived[column]) : derived[column]))
        );
        return true;
    });
}

const inflight = new Map();
const failed = new Map();
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Computes derived data for every journey of `userId` that lacks a current row. */
function ensureDerived(userId) {
    if (inflight.has(userId)) return inflight.get(userId);
    const job = (async () => {
        const skip = failed.get(userId) || new Set();
        failed.set(userId, skip);
        let computed = 0;
        for (;;) {
            const { rows } = await queryTenant(userId, `
                SELECT r.id FROM routes r
                LEFT JOIN route_derived d ON d.route_id = r.id
                WHERE (d.route_id IS NULL OR d.version <> $1 OR d.min_miles <> $2)
                  AND NOT (r.id = ANY($3))
                LIMIT 100
            `, [VERSION, MIN_ROUTE_MILES, [...skip]]);
            if (rows.length === 0) break;
            for (const { id } of rows) {
                for (let attempt = 1; ; attempt++) {
                    try {
                        if (await refreshRoute(userId, id)) computed += 1;
                        break;
                    } catch (err) {
                        if (err.code === '40P01' && attempt < 3) continue; // deadlock: retry
                        log.error(`could not compute map data for journey #${id}`, err);
                        skip.add(id);
                        break;
                    }
                }
                await yieldToLoop();
            }
        }
        return computed;
    })().finally(() => inflight.delete(userId));
    inflight.set(userId, job);
    return job;
}

const pendingSoon = new Map();
/** Debounced ensureDerived after a write (requests compute on demand anyway). */
function refreshDerivedSoon(userId, delayMs = 250) {
    if (pendingSoon.has(userId)) return;
    const timer = setTimeout(() => {
        pendingSoon.delete(userId);
        ensureDerived(userId).catch((err) => log.error('map data refresh failed', err));
    }, delayMs);
    timer.unref?.();
    pendingSoon.set(userId, timer);
}

async function refreshAllDerived() {
    const { rows: users } = await pool.query('SELECT id FROM users ORDER BY created_at');
    let computed = 0;
    for (const user of users) computed += await ensureDerived(user.id);
    return { computed };
}

/** Cancels pending refreshes and waits for running ones (shutdown, tests). */
async function flushDerived() {
    for (const timer of pendingSoon.values()) clearTimeout(timer);
    pendingSoon.clear();
    await Promise.allSettled([...inflight.values()]);
}

function forgetUser(userId) {
    failed.delete(userId);
    clearTimeout(pendingSoon.get(userId));
    pendingSoon.delete(userId);
}

module.exports = {
    VERSION,
    OVERVIEW_POINTS,
    DETAIL_TOLERANCE_DEG,
    HEAT_LEVELS,
    FINE_LEVEL,
    COARSE_LEVEL,
    heatLevelForZoom,
    roundCoord,
    downsample,
    simplify,
    pointTimes,
    computeDerived,
    refreshRoute,
    ensureDerived,
    refreshDerivedSoon,
    refreshAllDerived,
    flushDerived,
    forgetUser,
};
