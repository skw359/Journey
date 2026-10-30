const express = require('express');
const router = express.Router();
const { withTenantClient } = require('../db');
const { detectTravelMode } = require('../utils/geo');
const { MIN_ROUTE_MILES } = require('../config');
const { visibleSql } = require('../utils/visibility');
const { sendCompressedJson } = require('../utils/compressedJson');
const {
    ensureDerived,
    heatLevelForZoom,
    downsample,
    roundCoord,
    pointTimes,
    OVERVIEW_POINTS,
    DETAIL_TOLERANCE_DEG,
} = require('../utils/journeyDerived');
const log = require('../utils/logger').scope('maps');

// Other overview sizes are thinned by Postgres up to this many points per journey.
const MAX_DB_SAMPLE_POINTS = 1000;

// A jsonpath picking `max` evenly spaced points, first and last included, like
// downsample(). Subscripts are truncated, so `+ 0.5` rounds them.
function samplePath(max) {
    if (max === 1) return '$[0]';
    const subscripts = [];
    for (let i = 0; i < max; i++) {
        if (i === 0) subscripts.push('0');
        else if (i === max - 1) subscripts.push('last');
        else subscripts.push(`${i} * last / ${max - 1} + 0.5`);
    }
    return `$[${subscripts.join(', ')}]`;
}

function parseBounds(raw) {
    if (!raw) return null;
    const [south, west, north, east] = String(raw).split(',').map(Number);
    if (![south, west, north, east].every(Number.isFinite)) return null;
    return { south, west, north, east };
}

function pointInBounds(lat, lon, b) {
    return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

function segmentIntersectsBounds(lat1, lon1, lat2, lon2, b) {
    if (pointInBounds(lat1, lon1, b) || pointInBounds(lat2, lon2, b)) return true;

    const minLat = Math.min(lat1, lat2);
    const maxLat = Math.max(lat1, lat2);
    const minLon = Math.min(lon1, lon2);
    const maxLon = Math.max(lon1, lon2);
    if (maxLat < b.south || minLat > b.north || maxLon < b.west || minLon > b.east) {
        return false;
    }

    const dx = lon2 - lon1;
    const dy = lat2 - lat1;
    const p = [-dx, dx, -dy, dy];
    const q = [lon1 - b.west, b.east - lon1, lat1 - b.south, b.north - lat1];

    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i++) {
        const pi = p[i];
        const qi = q[i];
        if (pi === 0) {
            if (qi < 0) return false;
            continue;
        }
        const r = qi / pi;
        if (pi < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return false;
    }
    return true;
}

function routeIntersectsBounds(coordinates, row, b) {
    if (row.start_lat != null && row.start_lon != null && pointInBounds(row.start_lat, row.start_lon, b)) return true;
    if (row.end_lat != null && row.end_lon != null && pointInBounds(row.end_lat, row.end_lon, b)) return true;
    if (!Array.isArray(coordinates) || coordinates.length === 0) return false;

    let prevLat = null;
    let prevLon = null;
    for (const coord of coordinates) {
        if (!Array.isArray(coord) || coord.length < 2) continue;
        const lat = coord[0];
        const lon = coord[1];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (pointInBounds(lat, lon, b)) return true;
        if (prevLat != null && segmentIntersectsBounds(prevLat, prevLon, lat, lon, b)) return true;
        prevLat = lat;
        prevLon = lon;
    }
    return false;
}

function bboxIntersects(row, b) {
    return row.min_lat != null && row.max_lat >= b.south && row.min_lat <= b.north
        && row.max_lon >= b.west && row.min_lon <= b.east;
}

// Bounds grown by the detail line's simplification tolerance (plus its 1e-6° rounding), so
// testing the simplified line never misses a journey whose full track enters the view.
function paddedForDetail(b, row) {
    const pad = DETAIL_TOLERANCE_DEG + 1e-6;
    const maxAbsLat = Math.min(89, Math.max(Math.abs(row.min_lat), Math.abs(row.max_lat)));
    const padLon = pad / Math.cos(maxAbsLat * Math.PI / 180);
    return {
        south: b.south - pad,
        north: b.north + pad,
        west: b.west - padLon,
        east: b.east + padLon,
    };
}

function formatTotalTime(ms) {
    if (ms <= 0) return null;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    return { days, hours: hours % 24, minutes: minutes % 60 };
}

async function coordinatesById(db, ids, column = 'coordinates', table = 'routes', key = 'id') {
    const map = new Map();
    if (ids.length === 0) return map;
    const { rows } = await db.query(`SELECT ${key} AS id, ${column} AS coords FROM ${table} WHERE ${key} = ANY($1)`, [ids]);
    for (const row of rows) map.set(row.id, row.coords || []);
    return map;
}

// GET /api/alltime-map-data?maxPoints=&bounds=south,west,north,east
router.get('/alltime-map-data', async (req, res) => {
    try {
        const parsedMaxPoints = req.query.maxPoints != null
            ? Number.parseInt(req.query.maxPoints, 10)
            : OVERVIEW_POINTS;
        const maxPoints = Number.isFinite(parsedMaxPoints)
            ? Math.max(parsedMaxPoints, 0)
            : OVERVIEW_POINTS;
        const bounds = parseBounds(req.query.bounds);

        await ensureDerived(req.userId);
        const payload = await withTenantClient(req.userId, async (db) => {
            const { rows: routes } = await db.query(`
                SELECT r.id, r.name, r.date, r.distance, r.duration, r.top_speed, r.avg_speed,
                       r.start_time, r.end_time, r.start_lat, r.start_lon, r.end_lat, r.end_lon,
                       r.travel_mode, d.point_count, d.min_lat, d.min_lon, d.max_lat, d.max_lon
                FROM routes r
                JOIN route_derived d ON d.route_id = r.id
                WHERE ${visibleSql('$1', 'r')}
                ORDER BY r.start_time ASC NULLS LAST, r.id ASC
            `, [MIN_ROUTE_MILES]);

            if (routes.length === 0) {
                return {
                    routes: [],
                    stats: { totalRoutes: 0, totalDistance: 0, totalTime: 0, earliestDate: null, latestDate: null },
                    bounds: null,
                };
            }

            let totalDistance = 0;
            let totalTimeMs = 0;
            let totalPoints = 0;
            let earliestDate = null;
            let latestDate = null;
            let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
            const modeDistances = { drive: 0, scooter: 0, foot: 0, train: 0, metro: 0, flight: 0 };

            for (const row of routes) {
                const dist = Number(row.distance) || 0;
                totalDistance += dist;
                const mode = row.travel_mode || detectTravelMode(row.avg_speed || 0);
                if (Object.hasOwn(modeDistances, mode)) modeDistances[mode] += dist;
                if (row.start_time && row.end_time) {
                    const startMs = row.start_time.getTime();
                    const endMs = row.end_time.getTime();
                    totalTimeMs += (endMs - startMs);
                    if (!earliestDate || startMs < earliestDate) earliestDate = startMs;
                    if (!latestDate || endMs > latestDate) latestDate = endMs;
                }
                totalPoints += row.point_count;
                if (row.min_lat != null) {
                    minLat = Math.min(minLat, row.min_lat);
                    maxLat = Math.max(maxLat, row.max_lat);
                    minLon = Math.min(minLon, row.min_lon);
                    maxLon = Math.max(maxLon, row.max_lon);
                }
            }

            // Coordinates for each journey sent, chosen so only journeys near the view (or a
            // small precomputed overview) are read.
            const coordsFor = new Map();
            let selected = routes;
            if (!bounds) {
                const ids = routes.map((r) => r.id);
                if (maxPoints === OVERVIEW_POINTS) {
                    for (const [id, coords] of await coordinatesById(db, ids, 'overview', 'route_derived', 'route_id')) {
                        coordsFor.set(id, coords);
                    }
                } else if (maxPoints > 0 && maxPoints <= MAX_DB_SAMPLE_POINTS) {
                    const { rows } = await db.query(`
                        SELECT id, CASE WHEN jsonb_typeof(coordinates) = 'array' AND jsonb_array_length(coordinates) > $2
                                        THEN jsonb_path_query_array(coordinates, $3::jsonpath)
                                        ELSE coordinates END AS coords
                        FROM routes WHERE id = ANY($1)
                    `, [ids, maxPoints, samplePath(maxPoints)]);
                    for (const row of rows) coordsFor.set(row.id, (row.coords || []).map(roundCoord));
                } else {
                    for (const [id, coords] of await coordinatesById(db, ids)) {
                        // maxPoints=0 ("Preload journey data") sends points exactly as recorded.
                        coordsFor.set(id, maxPoints === 0 ? coords : downsample(coords, maxPoints).map(roundCoord));
                    }
                }
            } else {
                const candidates = routes.filter((row) => bboxIntersects(row, bounds));
                // The simplified line rules out journeys that never come near the view. Those
                // within the point budget are then tested and sent in full, as recorded; longer
                // ones use their simplified line, which is closer than evenly spaced picks.
                const detail = await coordinatesById(db, candidates.map((r) => r.id), 'detail', 'route_derived', 'route_id');
                const near = candidates.filter((row) => routeIntersectsBounds(detail.get(row.id) || [], row, paddedForDetail(bounds, row)));
                const inBudget = (row) => maxPoints === 0 || row.point_count <= maxPoints;
                const full = await coordinatesById(db, near.filter(inBudget).map((r) => r.id));
                selected = [];
                for (const row of near) {
                    if (inBudget(row)) {
                        const coords = full.get(row.id) || [];
                        if (!routeIntersectsBounds(coords, row, bounds)) continue;
                        coordsFor.set(row.id, maxPoints === 0 ? coords : coords.map(roundCoord));
                    } else {
                        coordsFor.set(row.id, downsample(detail.get(row.id) || [], maxPoints));
                    }
                    selected.push(row);
                }
            }

            return {
                routes: selected.map((row) => ({
                    id: row.id,
                    name: row.name,
                    date: row.date,
                    distance: row.distance != null ? Number(row.distance).toFixed(2) : null,
                    duration: row.duration,
                    topSpeed: row.top_speed != null ? Number(row.top_speed).toFixed(2) : null,
                    avgSpeed: row.avg_speed != null ? Number(row.avg_speed).toFixed(2) : null,
                    startTime: row.start_time ? row.start_time.toISOString() : null,
                    endTime: row.end_time ? row.end_time.toISOString() : null,
                    coordinates: coordsFor.get(row.id) || [],
                    startCoord: (row.start_lat != null && row.start_lon != null) ? [row.start_lat, row.start_lon] : null,
                    endCoord: (row.end_lat != null && row.end_lon != null) ? [row.end_lat, row.end_lon] : null,
                    travelMode: row.travel_mode || detectTravelMode(row.avg_speed || 0),
                })),
                stats: {
                    totalRoutes: routes.length,
                    totalDistance: Number(totalDistance.toFixed(1)),
                    totalTime: formatTotalTime(totalTimeMs),
                    totalPoints,
                    earliestDate: earliestDate ? new Date(earliestDate).toISOString() : null,
                    latestDate: latestDate ? new Date(latestDate).toISOString() : null,
                    dateRangeMs: earliestDate && latestDate ? { earliest: earliestDate, latest: latestDate } : null,
                    modeDistances: {
                        drive: Number(modeDistances.drive.toFixed(1)),
                        scooter: Number(modeDistances.scooter.toFixed(1)),
                        foot: Number(modeDistances.foot.toFixed(1)),
                        train: Number(modeDistances.train.toFixed(1)),
                        metro: Number(modeDistances.metro.toFixed(1)),
                        flight: Number(modeDistances.flight.toFixed(1)),
                    },
                },
                bounds: minLat !== Infinity ? { southwest: [minLat, minLon], northeast: [maxLat, maxLon] } : null,
            };
        });

        sendCompressedJson(req, res, payload);
    } catch (err) {
        log.error('GET /api/alltime-map-data error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function parseInstant(raw) {
    if (raw == null || raw === '') return null;
    const value = /^\d+$/.test(String(raw)) ? Number(raw) : Date.parse(String(raw));
    return Number.isFinite(value) ? value : null;
}

// GET /api/heatmap-grid?zoom=&bounds=&start=&end=
// cells: [lat, lon, journeys, samples] — how many journeys passed through each cell, and
// how many GPS points they recorded there. Dates filter by each point's recorded time.
router.get('/heatmap-grid', async (req, res) => {
    try {
        const zoom = parseInt(req.query.zoom, 10) || 4;
        const { level, cell } = heatLevelForZoom(zoom);
        const startQ = parseInstant(req.query.start);
        const endQ = parseInstant(req.query.end);
        const dated = startQ != null || endQ != null;
        const view = parseBounds(req.query.bounds);
        const pad = cell * 5;
        const range = view ? {
            south: view.south - pad, north: view.north + pad, west: view.west - pad, east: view.east + pad,
        } : null;
        const idx = range ? {
            aMin: Math.ceil(range.south / cell), aMax: Math.floor(range.north / cell),
            oMin: Math.ceil(range.west / cell), oMax: Math.floor(range.east / cell),
        } : null;

        await ensureDerived(req.userId);
        const grid = await withTenantClient(req.userId, async (db) => {
            const cells = new Map();
            const add = (a, o, samples, journeys) => {
                const key = `${a},${o}`;
                const entry = cells.get(key);
                if (entry) { entry[2] += journeys; entry[3] += samples; }
                else cells.set(key, [a, o, journeys, samples]);
            };
            const idxWhere = (a, o, first) => (idx
                ? ` AND ${a} BETWEEN $${first} AND $${first + 1} AND ${o} BETWEEN $${first + 2} AND $${first + 3}`
                : '');
            const idxParams = idx ? [idx.aMin, idx.aMax, idx.oMin, idx.oMax] : [];

            const { rows: [span] } = await db.query(
                'SELECT MIN(t_min) AS t_min, MAX(t_max) AS t_max, COUNT(*) FILTER (WHERE t_min IS NULL) AS untimed FROM route_derived WHERE visible'
            );
            const coversAll = !dated || (Number(span.untimed) === 0
                && (startQ == null || span.t_min == null || startQ <= Number(span.t_min))
                && (endQ == null || span.t_max == null || endQ >= Number(span.t_max)));

            if (coversAll) {
                const { rows } = await db.query(
                    `SELECT lat_idx, lon_idx, samples, journeys FROM heat_cells WHERE level = $1${idxWhere('lat_idx', 'lon_idx', 2)}`,
                    [level, ...idxParams]
                );
                for (const row of rows) add(row.lat_idx, row.lon_idx, Number(row.samples), row.journeys);
                return cells;
            }

            // Journeys wholly inside the dates: their precomputed cells.
            const bboxParams = range ? [range.south, range.north, range.west, range.east] : [];
            const lo = startQ ?? -8.64e15;
            const hi = endQ ?? 8.64e15;
            const slice = (column) => `d.${column}[d.heat_off[$1]:d.heat_off[$1 + 1] - 1]`;
            const { rows } = await db.query(`
                SELECT u.a, u.o, SUM(u.s)::bigint AS samples, COUNT(*)::int AS journeys
                FROM route_derived d
                CROSS JOIN LATERAL unnest(${slice('heat_lat')}, ${slice('heat_lon')}, ${slice('heat_samples')}) AS u(a, o, s)
                WHERE d.visible AND d.t_min >= $2 AND d.t_max <= $3
                  ${range ? 'AND d.max_lat >= $4 AND d.min_lat <= $5 AND d.max_lon >= $6 AND d.min_lon <= $7' : ''}
                  ${idxWhere('u.a', 'u.o', range ? 8 : 4)}
                GROUP BY u.a, u.o
            `, [level, lo, hi, ...bboxParams, ...idxParams]);
            for (const row of rows) add(row.a, row.o, Number(row.samples), row.journeys);

            // Journeys crossing a date boundary: point by point, by recorded time.
            const { rows: partial } = await db.query(`
                SELECT r.id, r.coordinates, r.profile_time_ms, r.start_time, r.end_time
                FROM route_derived d JOIN routes r ON r.id = d.route_id
                WHERE d.visible AND d.t_min IS NOT NULL AND d.t_max >= $1 AND d.t_min <= $2
                  AND NOT (d.t_min >= $1 AND d.t_max <= $2)
                  ${range ? 'AND d.max_lat >= $3 AND d.min_lat <= $4 AND d.max_lon >= $5 AND d.min_lon <= $6' : ''}
            `, [lo, hi, ...bboxParams]);
            for (const row of partial) {
                const coords = Array.isArray(row.coordinates) ? row.coordinates : [];
                const times = pointTimes(row);
                const own = new Map();
                for (let i = 0; i < coords.length; i++) {
                    const t = times[i];
                    if (t < lo || t > hi) continue;
                    const c = coords[i];
                    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
                    const a = Math.round(c[0] / cell);
                    const o = Math.round(c[1] / cell);
                    if (idx && (a < idx.aMin || a > idx.aMax || o < idx.oMin || o > idx.oMax)) continue;
                    const key = `${a},${o}`;
                    own.set(key, (own.get(key) || 0) + 1);
                }
                for (const [key, samples] of own) {
                    const [a, o] = key.split(',').map(Number);
                    add(a, o, samples, 1);
                }
            }
            return cells;
        });

        let totalPoints = 0;
        const cells = [];
        for (const [a, o, journeys, samples] of grid.values()) {
            totalPoints += samples;
            cells.push([a * cell, o * cell, journeys, samples]);
        }
        sendCompressedJson(req, res, { cells, totalPoints });
    } catch (err) {
        log.error('GET /api/heatmap-grid error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
module.exports.samplePath = samplePath;
