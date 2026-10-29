const express = require('express');
const router = express.Router();
const { queryTenant } = require('../db');
const { detectTravelMode } = require('../utils/geo');
const { MIN_ROUTE_MILES } = require('../config');
const { sendCompressedJson } = require('../utils/compressedJson');
const log = require('../utils/logger').scope('maps');

// Up to this many points per journey, the overview has Postgres thin each
// journey itself, so only those points leave the database
const MAX_DB_SAMPLE_POINTS = 1000;

// A jsonpath picking `max` evenly spaced points, first and last included, like
// downsample() below. Subscripts are truncated, so `+ 0.5` rounds them.
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

// To 6 decimals (~11 cm): finer than the map can draw, in about half the
// characters of a full-precision number
function roundCoord(coord) {
    if (!Array.isArray(coord) || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return coord;
    return [Math.round(coord[0] * 1e6) / 1e6, Math.round(coord[1] * 1e6) / 1e6];
}

// GET /api/alltime-map-data
router.get('/alltime-map-data', async (req, res) => {
    try {
        const parsedMaxPoints = req.query.maxPoints != null
            ? Number.parseInt(req.query.maxPoints, 10)
            : 100;
        const maxPoints = Number.isFinite(parsedMaxPoints)
            ? Math.max(parsedMaxPoints, 0)
            : 100;
        const boundsQ = req.query.bounds;

        let south, west, north, east;
        let hasBounds = false;
        if (boundsQ) {
            [south, west, north, east] = boundsQ.split(',').map(Number);
            hasBounds = Number.isFinite(south) && Number.isFinite(west)
                        && Number.isFinite(north) && Number.isFinite(east);
        }

        // Every recorded point of every journey (millions) leaving the database
        // was most of this request's time, so the overview gets each journey
        // already thinned, plus its full point count. Filtering to an area
        // needs the full tracks.
        const thinInDb = !hasBounds && maxPoints > 0 && maxPoints <= MAX_DB_SAMPLE_POINTS;
        const { rows: routes } = await queryTenant(req.userId, thinInDb ? `
            SELECT id, name, date, distance, duration, top_speed, avg_speed,
                   start_time, end_time, start_lat, start_lon,
                   end_lat, end_lon, travel_mode, point_count,
                   CASE WHEN point_count <= $2 THEN coordinates
                        ELSE jsonb_path_query_array(coordinates, $3::jsonpath)
                   END AS coordinates
            FROM routes
            CROSS JOIN LATERAL (
                SELECT CASE WHEN jsonb_typeof(coordinates) = 'array'
                            THEN jsonb_array_length(coordinates) ELSE 0 END AS point_count
            ) counted
            WHERE distance >= $1
        ` : `
            SELECT id, name, date, distance, duration, top_speed, avg_speed,
                   start_time, end_time, coordinates, start_lat, start_lon,
                   end_lat, end_lon, travel_mode
            FROM routes
            WHERE distance >= $1
        `, thinInDb ? [MIN_ROUTE_MILES, maxPoints, samplePath(maxPoints)] : [MIN_ROUTE_MILES]);

        if (routes.length === 0) {
            return res.json({
                routes: [],
                stats: {
                    totalRoutes: 0,
                    totalDistance: 0,
                    totalTime: 0,
                    earliestDate: null,
                    latestDate: null
                },
                bounds: null
            });
        }

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

        function pointInBounds(lat, lon) {
            return lat >= south && lat <= north && lon >= west && lon <= east;
        }

        function segmentIntersectsBounds(lat1, lon1, lat2, lon2) {
            if (pointInBounds(lat1, lon1) || pointInBounds(lat2, lon2)) return true;

            const minLat = Math.min(lat1, lat2);
            const maxLat = Math.max(lat1, lat2);
            const minLon = Math.min(lon1, lon2);
            const maxLon = Math.max(lon1, lon2);
            if (maxLat < south || minLat > north || maxLon < west || minLon > east) {
                return false;
            }

            const dx = lon2 - lon1;
            const dy = lat2 - lat1;
            const p = [-dx, dx, -dy, dy];
            const q = [lon1 - west, east - lon1, lat1 - south, north - lat1];

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

        function routeIntersectsBounds(coordinates, startLat, startLon, endLat, endLon) {
            if (!hasBounds) return true;

            if (startLat != null && startLon != null) {
                if (pointInBounds(startLat, startLon)) return true;
            }
            if (endLat != null && endLon != null) {
                if (pointInBounds(endLat, endLon)) return true;
            }

            if (!Array.isArray(coordinates) || coordinates.length === 0) return false;

            let prevLat = null;
            let prevLon = null;
            for (const coord of coordinates) {
                if (!Array.isArray(coord) || coord.length < 2) continue;
                const lat = coord[0];
                const lon = coord[1];
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

                if (pointInBounds(lat, lon)) return true;
                if (prevLat != null && prevLon != null && segmentIntersectsBounds(prevLat, prevLon, lat, lon)) {
                    return true;
                }

                prevLat = lat;
                prevLon = lon;
            }

            return false;
        }

        let totalDistance = 0;
        let totalTimeMs = 0;
        let totalPoints = 0;
        let earliestDate = null;
        let latestDate = null;
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;

        const modeDistances = { drive: 0, scooter: 0, foot: 0, train: 0, metro: 0, flight: 0 };

        const processedRoutes = [];

        for (const row of routes) {
            const dist = Number(row.distance) || 0;
            totalDistance += dist;

            const mode = row.travel_mode || detectTravelMode(row.avg_speed || 0);
            if (modeDistances.hasOwnProperty(mode)) {
                modeDistances[mode] += dist;
            }

            if (row.start_time && row.end_time) {
                const startMs = row.start_time.getTime();
                const endMs = row.end_time.getTime();
                totalTimeMs += (endMs - startMs);
                if (!earliestDate || startMs < earliestDate) earliestDate = startMs;
                if (!latestDate || endMs > latestDate) latestDate = endMs;
            }

            // Already thinned when Postgres did it; the bounds then cover the
            // points that are sent, which is what the map fits to
            const coords = row.coordinates || [];
            totalPoints += thinInDb ? row.point_count : coords.length;

            if (coords.length > 0) {
                coords.forEach(coord => {
                    minLat = Math.min(minLat, coord[0]);
                    maxLat = Math.max(maxLat, coord[0]);
                    minLon = Math.min(minLon, coord[1]);
                    maxLon = Math.max(maxLon, coord[1]);
                });
            }

            if (hasBounds && !routeIntersectsBounds(coords, row.start_lat, row.start_lon, row.end_lat, row.end_lon)) {
                continue;
            }

            // maxPoints=0 is the "Preload journey data" setting asking for full
            // resolution, so those points go out exactly as recorded
            const coordinates = maxPoints === 0 ? coords : downsample(coords, maxPoints).map(roundCoord);

            processedRoutes.push({
                id: row.id,
                name: row.name,
                date: row.date,
                distance: row.distance != null ? Number(row.distance).toFixed(2) : null,
                duration: row.duration,
                topSpeed: row.top_speed != null ? Number(row.top_speed).toFixed(2) : null,
                avgSpeed: row.avg_speed != null ? Number(row.avg_speed).toFixed(2) : null,
                startTime: row.start_time ? row.start_time.toISOString() : null,
                endTime: row.end_time ? row.end_time.toISOString() : null,
                coordinates,
                startCoord: (row.start_lat != null && row.start_lon != null) ? [row.start_lat, row.start_lon] : null,
                endCoord: (row.end_lat != null && row.end_lon != null) ? [row.end_lat, row.end_lon] : null,
                travelMode: row.travel_mode || detectTravelMode(row.avg_speed || 0)
            });
        }

        function formatTotalTime(ms) {
            if (ms <= 0) return null;
            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);
            return { days, hours: hours % 24, minutes: minutes % 60 };
        }

        const bounds = (minLat !== Infinity) ? {
            southwest: [minLat, minLon],
            northeast: [maxLat, maxLon]
        } : null;

        sendCompressedJson(req, res, {
            routes: processedRoutes,
            stats: {
                totalRoutes: routes.length,
                totalDistance: Number(totalDistance.toFixed(1)),
                totalTime: formatTotalTime(totalTimeMs),
                totalPoints,
                earliestDate: earliestDate ? new Date(earliestDate).toISOString() : null,
                latestDate: latestDate ? new Date(latestDate).toISOString() : null,
                dateRangeMs: earliestDate && latestDate ? {
                    earliest: earliestDate,
                    latest: latestDate
                } : null,
                modeDistances: {
                    drive: Number(modeDistances.drive.toFixed(1)),
                    scooter: Number(modeDistances.scooter.toFixed(1)),
                    foot: Number(modeDistances.foot.toFixed(1)),
                    train: Number(modeDistances.train.toFixed(1)),
                    metro: Number(modeDistances.metro.toFixed(1)),
                    flight: Number(modeDistances.flight.toFixed(1))
                }
            },
            bounds
        });
    } catch (err) {
        log.error('GET /api/alltime-map-data error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/all-points
router.get('/all-points', async (req, res) => {
    try {
        const { rows: routes } = await queryTenant(req.userId, `
            SELECT id, distance, start_time, end_time, coordinates, profile_speed_mph
            FROM routes
            WHERE distance >= $1
        `, [MIN_ROUTE_MILES]);

        const startQ = req.query.start ? Date.parse(req.query.start) : null;
        const endQ   = req.query.end   ? Date.parse(req.query.end)   : null;
        const countOnly = req.query.countOnly === '1';
        let totalDistance = 0;
        let earliestDate = null;
        let latestDate = null;

        if (routes.length === 0) {
            const base = {
                stats: { totalRoutes: 0, totalDistance: 0 },
                dateRange: { earliest: null, latest: null }
            };
            return countOnly
                ? res.json({ count: 0, ...base })
                : res.json({ points: [], ...base });
        }

        for (const route of routes) {
            totalDistance += Number(route.distance) || 0;
            if (route.start_time) {
                const s = route.start_time.getTime();
                if (!Number.isNaN(s)) earliestDate = (earliestDate == null) ? s : Math.min(earliestDate, s);
            }
            if (route.end_time) {
                const e = route.end_time.getTime();
                if (!Number.isNaN(e)) latestDate = (latestDate == null) ? e : Math.max(latestDate, e);
            }
        }

        function withinRange(ts) {
            if (startQ != null && ts < startQ) return false;
            if (endQ   != null && ts > endQ)   return false;
            return true;
        }

        if (countOnly) {
            let count = 0;
            for (const route of routes) {
                const coords = Array.isArray(route.coordinates) ? route.coordinates : [];
                if (coords.length === 0) continue;
                const startMs = route.start_time ? route.start_time.getTime() : null;
                const endMs   = route.end_time   ? route.end_time.getTime()   : null;
                if (startMs != null && endMs != null && endMs >= startMs) {
                    const denom = Math.max(coords.length - 1, 1);
                    for (let i = 0; i < coords.length; i++) {
                        const ts = startMs + Math.floor((endMs - startMs) * (i / denom));
                        if (withinRange(ts)) count++;
                    }
                } else {
                    if (startQ == null && endQ == null) count += coords.length;
                }
            }
            return res.json({
                count,
                stats: {
                    totalRoutes: routes.length,
                    totalDistance: Number(totalDistance.toFixed(1))
                },
                dateRange: {
                    earliest: earliestDate ? new Date(earliestDate).toISOString() : null,
                    latest:   latestDate   ? new Date(latestDate).toISOString()   : null
                }
            });
        }

        const points = [];
        for (const route of routes) {
            const coords = Array.isArray(route.coordinates) ? route.coordinates : [];
            if (coords.length === 0) continue;
            const startMs = route.start_time ? route.start_time.getTime() : null;
            const endMs   = route.end_time   ? route.end_time.getTime()   : null;
            const timed   = (startMs != null && endMs != null && endMs >= startMs);
            const speeds = Array.isArray(route.profile_speed_mph) ? route.profile_speed_mph : [];
            const hasSpeeds = speeds.length > 0;
            const denom = Math.max(coords.length - 1, 1);
            for (let i = 0; i < coords.length; i++) {
                const [lat, lon] = coords[i];
                const ts = timed ? (startMs + Math.floor((endMs - startMs) * (i / denom))) : null;
                if (ts != null && !withinRange(ts)) continue;
                if (ts == null && (startQ != null || endQ != null)) continue;
                let speedMph = 0;
                if (hasSpeeds) {
                    const idx = Math.min(Math.floor((i / coords.length) * speeds.length), Math.max(speeds.length - 1, 0));
                    speedMph = Number.isFinite(speeds[idx]) ? speeds[idx] : 0;
                }
                points.push([lat, lon, ts ?? null, speedMph]);
            }
        }

        points.sort((a, b) => {
            const ta = a[2], tb = b[2];
            if (ta == null && tb == null) return 0;
            if (ta == null) return -1;
            if (tb == null) return 1;
            return ta - tb;
        });

        res.json({
            points,
            stats: {
                totalRoutes: routes.length,
                totalDistance: Number(totalDistance.toFixed(1)),
                totalPoints: points.length
            },
            dateRange: {
                earliest: earliestDate ? new Date(earliestDate).toISOString() : null,
                latest:   latestDate   ? new Date(latestDate).toISOString()   : null
            }
        });
    } catch (err) {
        log.error('GET /api/all-points error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/heatmap-grid
router.get('/heatmap-grid', async (req, res) => {
    try {
        const { rows: routes } = await queryTenant(req.userId, `
            SELECT id, distance, start_time, end_time, coordinates
            FROM routes
            WHERE distance >= $1
        `, [MIN_ROUTE_MILES]);

        if (routes.length === 0) {
            return res.json({ cells: [], totalPoints: 0 });
        }

        const startQ = req.query.start ? Date.parse(req.query.start) : null;
        const endQ = req.query.end ? Date.parse(req.query.end) : null;
        const zoom = parseInt(req.query.zoom) || 4;
        const boundsS = req.query.bounds;

        let CELL_SIZE;
        if (zoom >= 15) CELL_SIZE = 0.0002;
        else if (zoom >= 13) CELL_SIZE = 0.0005;
        else if (zoom >= 11) CELL_SIZE = 0.001;
        else if (zoom >= 9) CELL_SIZE = 0.002;
        else if (zoom >= 7) CELL_SIZE = 0.005;
        else CELL_SIZE = 0.01;

        let south, west, north, east;
        if (boundsS) {
            [south, west, north, east] = boundsS.split(',').map(Number);
        }
        const hasBounds = boundsS && Number.isFinite(south) && Number.isFinite(west)
                          && Number.isFinite(north) && Number.isFinite(east);

        const grid = new Map();
        let totalPoints = 0;

        for (const route of routes) {
            const coords = route.coordinates || [];
            if (coords.length === 0) continue;

            const startMs = route.start_time ? route.start_time.getTime() : null;
            const endMs = route.end_time ? route.end_time.getTime() : null;
            const timed = startMs != null && endMs != null && endMs >= startMs;

            if (startQ != null || endQ != null) {
                if (timed) {
                    if (startQ != null && endMs < startQ) continue;
                    if (endQ != null && startMs > endQ) continue;
                } else {
                    continue;
                }
            }

            const denom = Math.max(coords.length - 1, 1);
            for (let i = 0; i < coords.length; i++) {
                if (timed && (startQ != null || endQ != null)) {
                    const ts = startMs + Math.floor((endMs - startMs) * (i / denom));
                    if (startQ != null && ts < startQ) continue;
                    if (endQ != null && ts > endQ) continue;
                }

                const [lat, lon] = coords[i];
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

                if (hasBounds) {
                    const pad = CELL_SIZE * 5;
                    if (lat < south - pad || lat > north + pad ||
                        lon < west - pad || lon > east + pad) continue;
                }

                const cellLat = Math.round(lat / CELL_SIZE) * CELL_SIZE;
                const cellLon = Math.round(lon / CELL_SIZE) * CELL_SIZE;
                const key = `${cellLat},${cellLon}`;
                grid.set(key, (grid.get(key) || 0) + 1);
                totalPoints++;
            }
        }

        const cells = [];
        for (const [key, weight] of grid) {
            const [lat, lon] = key.split(',').map(Number);
            cells.push([lat, lon, weight]);
        }

        res.json({ cells, totalPoints });
    } catch (err) {
        log.error('GET /api/heatmap-grid error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
