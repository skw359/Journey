const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { withTenantClient, toApiRoute, toApiSummary, toApiWaypoint } = require('../db');
const { haversine, detectTravelMode } = require('../utils/geo');
const { formatDuration } = require('../utils/format');
const { MIN_ROUTE_MILES } = require('../config');
const log = require('../utils/logger').scope('journeys');
const { requeueProcessing } = require('../utils/mediaQueue');
const {
    startGeoBackfill,
    stopGeoBackfill,
    getGeoBackfillStatus,
    resetGeoBackfill,
} = require('../utils/geoBackfill');
const {
    TRASH_ORIGIN,
    trashExistingRoute,
    restoreTrashedJourney,
    permanentlyDeleteTrash,
    emptyTrash,
    purgeExpiredTrash,
    listTrash,
    getTrashDetail,
} = require('../utils/trash');

// GET /api/routes (list view)
router.get('/', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query(`
                SELECT r.id, r.name, r.date, r.start_time, r.end_time, r.distance, r.duration,
                       r.watch_recorded, r.travel_mode, r.avg_speed, r.cities_passed,
                       (SELECT COUNT(*) FROM waypoints w WHERE w.route_id = r.id) AS waypoint_count,
                       (SELECT COUNT(*) FROM photos p WHERE p.route_id = r.id) AS photo_count,
                       (SELECT COALESCE(p.poster_filename, p.filename) FROM photos p
                        WHERE p.route_id = r.id
                          -- only converted items count (a video's poster is its cover)
                          AND COALESCE(p.status, 'ready') = 'ready'
                          AND (p.mimetype IS NULL OR p.mimetype NOT LIKE 'video/%' OR p.poster_filename IS NOT NULL)
                        ORDER BY p.uploaded_at ASC LIMIT 1) AS cover_photo
                FROM routes r
                WHERE r.distance >= $1 OR r.force_visible = TRUE
                ORDER BY r.start_time DESC
            `, [MIN_ROUTE_MILES]);

            const summarized = rows.map((row) => {
                const summary = toApiSummary(row);
                if (!summary.travelMode && summary.avgSpeed) {
                    summary.travelMode = detectTravelMode(summary.avgSpeed);
                }
                return summary;
            });

            res.json(summarized);
        });
    } catch (err) {
        log.error('GET /api/routes error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Cities/places backfill runs server-side (utils/geoBackfill.js) and survives closed tabs and
// restarts; the status endpoints report the live job so a reloaded page picks it back up.
function geoBackfillRoutes(kind) {
    // GET /api/routes/{cities,places}-status — progress plus the running job, if any
    router.get(`/${kind}-status`, async (req, res) => {
        try {
            res.json(await getGeoBackfillStatus(req.userId, kind));
        } catch (err) {
            log.error(`GET /api/routes/${kind}-status error:`, err);
            res.status(500).json({ error: `Failed to get ${kind} status` });
        }
    });

    // POST /api/routes/reindex-{cities,places} — reset every row to NULL so the backfill recomputes it
    router.post(`/reindex-${kind}`, async (req, res) => {
        try {
            res.json({ reset: await resetGeoBackfill(req.userId, kind) });
        } catch (err) {
            log.error(`POST /api/routes/reindex-${kind} error:`, err);
            res.status(500).json({ error: `Failed to reset ${kind}` });
        }
    });

    // POST /api/routes/backfill-{cities,places} — start the background job, or join the running one
    router.post(`/backfill-${kind}`, async (req, res) => {
        try {
            const { remaining } = await getGeoBackfillStatus(req.userId, kind);
            const started = remaining > 0 && startGeoBackfill(req.userId, kind);
            res.json({ started, ...(await getGeoBackfillStatus(req.userId, kind)) });
        } catch (err) {
            log.error(`POST /api/routes/backfill-${kind} error:`, err);
            res.status(500).json({ error: 'Failed to start backfill' });
        }
    });

    // POST /api/routes/backfill-{cities,places}/stop — routes already done keep their results
    router.post(`/backfill-${kind}/stop`, async (req, res) => {
        try {
            const stopped = stopGeoBackfill(req.userId, kind);
            res.json({ stopped, ...(await getGeoBackfillStatus(req.userId, kind)) });
        } catch (err) {
            log.error(`POST /api/routes/backfill-${kind}/stop error:`, err);
            res.status(500).json({ error: 'Failed to stop backfill' });
        }
    });
}

geoBackfillRoutes('cities');
geoBackfillRoutes('places');

// ── Trash / Recently Deleted ──────────────────────────────────────────────
// Declared before "/:id" so "trash" is never captured as a route id.

// GET /api/routes/trash — list trashed journeys (lazily purges expired ones first)
router.get('/trash', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            await purgeExpiredTrash(db);
            const items = await listTrash(db);
            res.json(items);
        });
    } catch (err) {
        log.error('GET /api/routes/trash error:', err);
        res.status(500).json({ error: 'Failed to load Trash' });
    }
});

// DELETE /api/routes/trash — permanently empty Trash
router.delete('/trash', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const removed = await emptyTrash(db);
            res.json({ message: 'Trash emptied', removed });
        });
    } catch (err) {
        log.error('DELETE /api/routes/trash error:', err);
        res.status(500).json({ error: 'Failed to empty Trash' });
    }
});

// GET /api/routes/trash/:trashId — full detail of a single trashed journey
router.get('/trash/:trashId', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const detail = await getTrashDetail(db, req.params.trashId);
            if (!detail) return res.status(404).json({ error: 'Trashed journey not found' });
            res.json(detail);
        });
    } catch (err) {
        log.error('GET /api/routes/trash/:trashId error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/routes/trash/:trashId/restore — restore a trashed journey to the active list
router.post('/trash/:trashId/restore', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            await db.query('BEGIN');
            try {
                const restored = await restoreTrashedJourney(db, req.params.trashId);
                if (!restored) {
                    await db.query('ROLLBACK');
                    return res.status(404).json({ error: 'Trashed journey not found' });
                }
                await db.query('COMMIT');
                const { processingMedia, ...summary } = restored;
                res.json({ message: 'Journey restored', ...summary });
                // Photos and videos trashed mid-conversion pick up where they left off.
                if (processingMedia.length > 0) {
                    requeueProcessing(req.userId, processingMedia)
                        .catch((err) => log.error('could not requeue restored media', err));
                }
            } catch (err) {
                await db.query('ROLLBACK');
                throw err;
            }
        });
    } catch (err) {
        log.error('POST /api/routes/trash/:trashId/restore error:', err);
        res.status(500).json({ error: 'Failed to restore journey' });
    }
});

// DELETE /api/routes/trash/:trashId — permanently delete a single trashed journey
router.delete('/trash/:trashId', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const ok = await permanentlyDeleteTrash(db, req.params.trashId);
            if (!ok) return res.status(404).json({ error: 'Trashed journey not found' });
            res.json({ message: 'Journey permanently deleted' });
        });
    } catch (err) {
        log.error('DELETE /api/routes/trash/:trashId error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/routes/:id (detail view)
router.get('/:id', async (req, res) => {
    try {
        const parsedMaxPoints = req.query.maxPoints != null
            ? Number.parseInt(req.query.maxPoints, 10)
            : null;
        const maxPoints = Number.isFinite(parsedMaxPoints)
            ? Math.max(parsedMaxPoints, 0)
            : null;

        function sampleIndices(total, max) {
            if (max <= 0 || total <= max) {
                return Array.from({ length: total }, (_, i) => i);
            }
            if (max === 1) return [0];
            if (max === 2) return [0, total - 1];
            const step = (total - 1) / (max - 1);
            const indices = [0];
            for (let i = 1; i < max - 1; i++) {
                indices.push(Math.floor(i * step));
            }
            indices.push(total - 1);
            return indices;
        }

        await withTenantClient(req.userId, async (db) => {
            const [routeResult, waypointsResult, photosResult] = await Promise.all([
                db.query('SELECT * FROM routes WHERE id = $1', [req.params.id]),
                db.query('SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [req.params.id]),
                db.query('SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [req.params.id]),
            ]);

            if (routeResult.rows.length === 0) {
                return res.status(404).send('Journey not found');
            }

            const route = toApiRoute(routeResult.rows[0], waypointsResult.rows, photosResult.rows);
            const fullCoords = Array.isArray(route.coordinates) ? route.coordinates : [];
            route.totalPoints = fullCoords.length;
            route.isFullResolution = true;

            if (maxPoints != null && maxPoints > 0 && fullCoords.length > maxPoints) {
                const keep = sampleIndices(fullCoords.length, maxPoints);
                const projectSeries = (series) => {
                    if (!Array.isArray(series) || series.length === 0) return [];
                    return keep.map((idx) => {
                        const sourceIdx = Math.min(idx, series.length - 1);
                        return series[sourceIdx];
                    });
                };

                route.coordinates = keep.map((idx) => fullCoords[idx]);
                route.profileTimeMs = projectSeries(route.profileTimeMs);
                route.profileDistMi = projectSeries(route.profileDistMi);
                route.profileElevM = projectSeries(route.profileElevM);
                route.profileSpeedMph = projectSeries(route.profileSpeedMph);
                route.isFullResolution = false;
            }

            if (!route.travelMode && route.avgSpeed) {
                route.travelMode = detectTravelMode(route.avgSpeed);
            }
            res.json(route);
        });
    } catch (err) {
        log.error('GET /api/routes/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/routes/:id/name
router.patch('/:id/name', express.json(), async (req, res) => {
    const { newName } = req.body;
    if (!newName || typeof newName !== 'string') {
        return res.status(400).json({ error: 'Invalid name' });
    }
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query(
                'UPDATE routes SET name = $1 WHERE id = $2 RETURNING *',
                [newName.trim(), req.params.id]
            );
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Journey not found' });
            }
            const { rows: waypoints } = await db.query(
                'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [req.params.id]
            );
            const { rows: photos } = await db.query(
                'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [req.params.id]
            );
            const route = toApiRoute(rows[0], waypoints, photos);
            res.json({ message: 'Name updated', route });
        });
    } catch (err) {
        log.error('PATCH name error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/routes/:id/travel-mode
router.patch('/:id/travel-mode', express.json(), async (req, res) => {
    const { travelMode } = req.body;
    const validModes = ['foot', 'scooter', 'drive', 'train', 'metro', 'flight'];

    if (!travelMode || !validModes.includes(travelMode)) {
        return res.status(400).json({ error: "Invalid travel mode. Must be 'foot', 'scooter', 'drive', 'train', 'metro', or 'flight'" });
    }

    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query(
                'UPDATE routes SET travel_mode = $1 WHERE id = $2 RETURNING *',
                [travelMode, req.params.id]
            );
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Journey not found' });
            }
            const { rows: waypoints } = await db.query(
                'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [req.params.id]
            );
            const { rows: photos } = await db.query(
                'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [req.params.id]
            );
            const route = toApiRoute(rows[0], waypoints, photos);
            res.json({ message: 'Travel mode updated', route });
        });
    } catch (err) {
        log.error('PATCH travel-mode error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/routes/:id — move journey to Trash (recoverable for 7 days).
// Photo files are kept on disk so a restore can re-link them.
router.delete('/:id', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            await db.query('BEGIN');
            try {
                const result = await trashExistingRoute(db, req.params.id, {
                    origin: TRASH_ORIGIN.USER_DELETED,
                    reason: 'Deleted from journeys',
                });
                if (!result) {
                    await db.query('ROLLBACK');
                    return res.status(404).send('Journey not found');
                }
                await db.query('COMMIT');
                res.status(200).json({ message: 'Journey moved to Trash', trashId: result.trashId });
            } catch (err) {
                await db.query('ROLLBACK');
                throw err;
            }
        });
    } catch (err) {
        log.error('DELETE /api/routes/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/routes/:id/points/:index
router.delete('/:id/points/:index', express.json(), async (req, res) => {
    const routeId = req.params.id;
    const index = parseInt(req.params.index, 10);

    if (Number.isNaN(index)) {
        return res.status(400).json({ error: 'Invalid index' });
    }

    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query('SELECT * FROM routes WHERE id = $1', [routeId]);
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Journey not found' });
            }

            const row = rows[0];
            const profileTimeMs = row.profile_time_ms || [];
            const profileDistMi = row.profile_dist_mi || [];
            const profileElevM = row.profile_elev_m || [];
            const profileSpeedMph = row.profile_speed_mph || [];
            const coordinates = row.coordinates || [];

            if (profileTimeMs.length <= 2) {
                return res.status(400).json({ error: 'Cannot delete points from a journey with too few points.' });
            }

            const safeSplice = (arr) => {
                if (arr && arr.length > index) arr.splice(index, 1);
            };

            safeSplice(profileTimeMs);
            safeSplice(profileDistMi);
            safeSplice(profileElevM);
            safeSplice(profileSpeedMph);
            safeSplice(coordinates);

            const maxSpeed = profileSpeedMph.length > 0 ? Math.max(...profileSpeedMph) : 0;
            const topSpeed = maxSpeed.toFixed(2);

            let duration = row.duration;
            let startTime = row.start_time ? row.start_time.toISOString() : null;
            let endTime = row.end_time ? row.end_time.toISOString() : null;
            if (profileTimeMs.length > 0) {
                const s = profileTimeMs[0];
                const e = profileTimeMs[profileTimeMs.length - 1];
                const durationSec = (e - s) / 1000;
                duration = formatDuration(durationSec);
                startTime = new Date(s).toISOString();
                endTime = new Date(e).toISOString();
            }

            let avgSpeed = row.avg_speed;
            if (profileSpeedMph.length > 0) {
                const sum = profileSpeedMph.reduce((a, b) => a + b, 0);
                avgSpeed = sum / profileSpeedMph.length;
            }

            let distance = row.distance;
            if (profileDistMi.length > 0) {
                distance = profileDistMi[profileDistMi.length - 1];
            }

            let startLat = row.start_lat;
            let startLon = row.start_lon;
            let endLat = row.end_lat;
            let endLon = row.end_lon;
            if (coordinates.length > 0) {
                startLat = coordinates[0][0];
                startLon = coordinates[0][1];
                endLat = coordinates[coordinates.length - 1][0];
                endLon = coordinates[coordinates.length - 1][1];
            }

            await db.query(`
                UPDATE routes SET
                    top_speed = $1, duration = $2, start_time = $3, end_time = $4,
                    avg_speed = $5, distance = $6,
                    start_lat = $7, start_lon = $8, end_lat = $9, end_lon = $10,
                    profile_time_ms = $11, profile_dist_mi = $12,
                    profile_elev_m = $13, profile_speed_mph = $14,
                    coordinates = $15
                WHERE id = $16
            `, [
                parseFloat(topSpeed), duration, startTime, endTime,
                avgSpeed, distance,
                startLat, startLon, endLat, endLon,
                JSON.stringify(profileTimeMs), JSON.stringify(profileDistMi),
                JSON.stringify(profileElevM), JSON.stringify(profileSpeedMph),
                JSON.stringify(coordinates),
                routeId,
            ]);

            const { rows: updatedRows } = await db.query('SELECT * FROM routes WHERE id = $1', [routeId]);
            const { rows: waypoints } = await db.query(
                'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [routeId]
            );
            const { rows: photos } = await db.query(
                'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [routeId]
            );
            const route = toApiRoute(updatedRows[0], waypoints, photos);
            res.json({ message: 'Point deleted', route });
        });
    } catch (err) {
        log.error('DELETE point error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/routes/:id/waypoints/:wpId
router.patch('/:id/waypoints/:wpId', express.json(), async (req, res) => {
    const { label } = req.body;
    if (typeof label !== 'string' || !label.trim()) {
        return res.status(400).json({ error: 'Invalid label' });
    }
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows: routeCheck } = await db.query('SELECT 1 FROM routes WHERE id = $1', [req.params.id]);
            if (routeCheck.length === 0) return res.status(404).json({ error: 'Journey not found' });

            const { rows } = await db.query(
                'UPDATE waypoints SET label = $1 WHERE id = $2 AND route_id = $3 RETURNING *',
                [label.trim(), req.params.wpId, req.params.id]
            );
            if (rows.length === 0) return res.status(404).json({ error: 'Waypoint not found' });

            res.json({ message: 'Waypoint renamed', waypoint: toApiWaypoint(rows[0]) });
        });
    } catch (err) {
        log.error('PATCH waypoint error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/routes/combine
router.post('/combine', express.json(), async (req, res) => {
    const { journeyIds, name } = req.body;

    if (!Array.isArray(journeyIds) || journeyIds.length < 2) {
        return res.status(400).json({ error: 'At least two journey IDs are required' });
    }
    if (journeyIds.length !== new Set(journeyIds).size) {
        return res.status(400).json({ error: 'Duplicate journey IDs' });
    }

    try {
        await withTenantClient(req.userId, async (db) => {
            await db.query('BEGIN');
            try {
                // 1. Fetch all source journeys
                const placeholders = journeyIds.map((_, i) => `$${i + 1}`).join(', ');
                const { rows: routes } = await db.query(
                    `SELECT * FROM routes WHERE id IN (${placeholders})`,
                    journeyIds
                );
                if (routes.length !== journeyIds.length) {
                    const found = new Set(routes.map(r => r.id));
                    const missing = journeyIds.filter(id => !found.has(id));
                    await db.query('ROLLBACK');
                    return res.status(404).json({ error: `Journeys not found: ${missing.join(', ')}` });
                }

                // Sort chronologically by start_time
                routes.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

                // Fetch waypoints and photos for all routes
                const waypointsByRoute = {};
                const photosByRoute = {};
                for (const route of routes) {
                    const { rows: wps } = await db.query(
                        'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC',
                        [route.id]
                    );
                    waypointsByRoute[route.id] = wps;
                    const { rows: phs } = await db.query(
                        'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC',
                        [route.id]
                    );
                    photosByRoute[route.id] = phs;
                }

                // 2. Save backup snapshot
                const backupId = `backup-${crypto.randomBytes(8).toString('hex')}`;
                const sourceSnapshot = routes.map(r => ({
                    route: r,
                    waypoints: waypointsByRoute[r.id],
                    photos: photosByRoute[r.id],
                }));

                const primaryId = routes[0].id;

                await db.query(
                    `INSERT INTO journey_backups (id, combined_journey_id, source_journeys, created_at)
                     VALUES ($1, $2, $3, NOW())`,
                    [backupId, primaryId, JSON.stringify(sourceSnapshot)]
                );

                // 3. Merge data
                // Concatenate coordinates and profiles in chronological order
                let mergedCoords = [];
                let mergedTimeMs = [];
                let mergedDistMi = [];
                let mergedElevM = [];
                let mergedSpeedMph = [];
                let cumulativeDist = 0;

                for (let i = 0; i < routes.length; i++) {
                    const r = routes[i];
                    const coords = r.coordinates || [];
                    const timeMs = r.profile_time_ms || [];
                    const distMi = r.profile_dist_mi || [];
                    const elevM = r.profile_elev_m || [];
                    const speedMph = r.profile_speed_mph || [];

                    // Add gap distance between consecutive journeys
                    if (i > 0 && mergedCoords.length > 0 && coords.length > 0) {
                        const prevCoord = mergedCoords[mergedCoords.length - 1];
                        const nextCoord = coords[0];
                        const gapMiles = haversine(prevCoord[0], prevCoord[1], nextCoord[0], nextCoord[1]);
                        cumulativeDist += gapMiles;
                    }

                    // Append coordinates
                    mergedCoords = mergedCoords.concat(coords);
                    mergedTimeMs = mergedTimeMs.concat(timeMs);
                    mergedElevM = mergedElevM.concat(elevM);
                    mergedSpeedMph = mergedSpeedMph.concat(speedMph);

                    // Offset distance profile by cumulative distance
                    const offsetDist = distMi.map(d => d + cumulativeDist);
                    mergedDistMi = mergedDistMi.concat(offsetDist);

                    // Update cumulative distance to end of this journey
                    if (distMi.length > 0) {
                        cumulativeDist += distMi[distMi.length - 1];
                    }
                }

                // 4. Recalculate aggregate stats
                const totalDistance = mergedDistMi.length > 0
                    ? mergedDistMi[mergedDistMi.length - 1] : 0;

                const startTime = routes[0].start_time;
                const endTime = routes[routes.length - 1].end_time;
                const durationSec = (new Date(endTime) - new Date(startTime)) / 1000;
                const duration = formatDuration(durationSec);

                const validSpeeds = mergedSpeedMph.filter(s => Number.isFinite(s));
                const topSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 0;
                const avgSpeed = validSpeeds.length > 0
                    ? validSpeeds.reduce((a, b) => a + b, 0) / validSpeeds.length : 0;

                const validElevs = mergedElevM.filter(e => e != null && Number.isFinite(e));
                const topElevation = validElevs.length > 0 ? Math.max(...validElevs) : 0;
                const lowestElevation = validElevs.length > 0 ? Math.min(...validElevs) : 0;
                const avgElevation = validElevs.length > 0
                    ? validElevs.reduce((a, b) => a + b, 0) / validElevs.length : 0;

                // Sum elevation gain/loss from all source journeys
                let elevGain = 0, elevLoss = 0;
                for (const r of routes) {
                    if (r.elevation_gain != null) elevGain += r.elevation_gain;
                    if (r.elevation_loss != null) elevLoss += r.elevation_loss;
                }
                // Also calculate gain/loss for the gaps between journeys
                for (let i = 1; i < routes.length; i++) {
                    const prevElevs = routes[i - 1].profile_elev_m || [];
                    const nextElevs = routes[i].profile_elev_m || [];
                    if (prevElevs.length > 0 && nextElevs.length > 0) {
                        const lastElev = prevElevs[prevElevs.length - 1];
                        const firstElev = nextElevs[0];
                        if (lastElev != null && firstElev != null) {
                            const diff = firstElev - lastElev;
                            if (diff > 0.5) elevGain += diff;
                            else if (diff < -0.5) elevLoss += Math.abs(diff);
                        }
                    }
                }

                const startCoord = mergedCoords.length > 0 ? mergedCoords[0] : [null, null];
                const endCoord = mergedCoords.length > 0 ? mergedCoords[mergedCoords.length - 1] : [null, null];

                const combinedName = name || routes[0].name;
                const startDate = new Date(startTime);
                const dateStr = startDate.toLocaleDateString('en-US', {
                    month: 'short', day: '2-digit', year: 'numeric'
                });

                const travelMode = detectTravelMode(avgSpeed);

                // 5. Update the primary journey with merged data
                await db.query(`
                    UPDATE routes SET
                        name = $1, date = $2, distance = $3, duration = $4,
                        top_speed = $5, avg_speed = $6,
                        top_elevation = $7, lowest_elevation = $8, avg_elevation = $9,
                        start_time = $10, end_time = $11,
                        coordinates = $12,
                        elevation_gain = $13, elevation_loss = $14,
                        start_lat = $15, start_lon = $16, end_lat = $17, end_lon = $18,
                        profile_time_ms = $19, profile_dist_mi = $20,
                        profile_elev_m = $21, profile_speed_mph = $22,
                        travel_mode = $23,
                        cities_passed = NULL, places_passed = NULL
                    WHERE id = $24
                `, [
                    combinedName, dateStr, totalDistance, duration,
                    topSpeed, avgSpeed,
                    topElevation, lowestElevation, avgElevation,
                    startTime, endTime,
                    JSON.stringify(mergedCoords),
                    elevGain, elevLoss,
                    startCoord[0], startCoord[1], endCoord[0], endCoord[1],
                    JSON.stringify(mergedTimeMs), JSON.stringify(mergedDistMi),
                    JSON.stringify(mergedElevM), JSON.stringify(mergedSpeedMph),
                    travelMode, primaryId,
                ]);

                // 6. Reassign waypoints and photos from secondary journeys to primary
                const secondaryIds = routes.slice(1).map(r => r.id);
                if (secondaryIds.length > 0) {
                    const secPlaceholders = secondaryIds.map((_, i) => `$${i + 2}`).join(', ');
                    await db.query(
                        `UPDATE waypoints SET route_id = $1 WHERE route_id IN (${secPlaceholders})`,
                        [primaryId, ...secondaryIds]
                    );
                    await db.query(
                        `UPDATE photos SET route_id = $1 WHERE route_id IN (${secPlaceholders})`,
                        [primaryId, ...secondaryIds]
                    );

                    // 7. Delete secondary journeys (waypoints/photos already reassigned)
                    const delPlaceholders = secondaryIds.map((_, i) => `$${i + 1}`).join(', ');
                    await db.query(
                        `DELETE FROM routes WHERE id IN (${delPlaceholders})`,
                        secondaryIds
                    );
                }

                await db.query('COMMIT');

                // Return the combined journey
                const { rows: [updatedRoute] } = await db.query('SELECT * FROM routes WHERE id = $1', [primaryId]);
                const { rows: waypoints } = await db.query(
                    'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [primaryId]
                );
                const { rows: photos } = await db.query(
                    'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [primaryId]
                );
                const combined = toApiRoute(updatedRoute, waypoints, photos);
                res.json({ message: 'Journeys combined successfully', route: combined, backupId });

                // The merged track is a new route as far as the geocoded place
                // index is concerned: the UPDATE above reset both columns to
                // NULL (unprocessed), and this recomputes them for the full
                // merged coordinate list — same fire-and-forget pattern as
                // upload. On geocoder outage (null) the columns stay NULL and
                // the Fun Stats backfill retries later.
                if (mergedCoords.length >= 2) {
                    const { computeCitiesPassed } = require('../utils/cities');
                    const { computePlacesPassed } = require('../utils/places');
                    computeCitiesPassed(mergedCoords)
                        .then(cities => {
                            if (cities === null) {
                                log.scope('cities').error(`geocoder unreachable — combined journey #${primaryId} left for backfill`);
                                return;
                            }
                            return withTenantClient(req.userId, (db2) =>
                                db2.query('UPDATE routes SET cities_passed = $1 WHERE id = $2', [JSON.stringify(cities), primaryId])
                            ).then(() => log.scope('cities').debug(`recomputed for combined journey #${primaryId}`));
                        })
                        .catch(err => log.scope('cities').error('combine recompute failed', err));
                    computePlacesPassed(mergedCoords)
                        .then(places => {
                            if (places === null) {
                                log.scope('places').error(`geocoder unreachable — combined journey #${primaryId} left for backfill`);
                                return;
                            }
                            return withTenantClient(req.userId, (db2) =>
                                db2.query('UPDATE routes SET places_passed = $1 WHERE id = $2', [JSON.stringify(places), primaryId])
                            ).then(() => log.scope('places').debug(`recomputed for combined journey #${primaryId}`));
                        })
                        .catch(err => log.scope('places').error('combine recompute failed', err));
                }
            } catch (err) {
                await db.query('ROLLBACK');
                throw err;
            }
        });
    } catch (err) {
        log.error('POST /api/routes/combine error:', err);
        res.status(500).json({ error: 'Failed to combine journeys' });
    }
});

// POST /api/routes/:id/undo-combine
router.post('/:id/undo-combine', express.json(), async (req, res) => {
    const combinedId = req.params.id;

    try {
        await withTenantClient(req.userId, async (db) => {
            // Find the backup for this combined journey
            const { rows: backups } = await db.query(
                'SELECT * FROM journey_backups WHERE combined_journey_id = $1 ORDER BY created_at DESC LIMIT 1',
                [combinedId]
            );
            if (backups.length === 0) {
                return res.status(404).json({ error: 'No combine backup found for this journey' });
            }

            const backup = backups[0];
            const sourceJourneys = backup.source_journeys;

            await db.query('BEGIN');
            try {
                // Photos may have finished converting since the backup was taken; restore them as they are now.
                const { rows: currentPhotos } = await db.query('SELECT * FROM photos WHERE route_id = $1', [combinedId]);
                const currentPhotoById = new Map(currentPhotos.map((ph) => [ph.id, ph]));

                // Delete the combined journey (cascades waypoints/photos)
                await db.query('DELETE FROM routes WHERE id = $1', [combinedId]);

                // Restore all source journeys
                for (const entry of sourceJourneys) {
                    const r = entry.route;
                    await db.query(`
                        INSERT INTO routes (
                            id, name, date, distance, duration, top_speed, avg_speed,
                            top_elevation, lowest_elevation, avg_elevation,
                            start_time, end_time, coordinates,
                            elevation_gain, elevation_loss,
                            start_lat, start_lon, end_lat, end_lon,
                            source, watch_recorded,
                            profile_time_ms, profile_dist_mi, profile_elev_m, profile_speed_mph,
                            travel_mode,
                            weather_temp, weather_feels_like, weather_humidity, weather_wind_speed, weather_wind_dir,
                            weather_condition, weather_description, weather_icon,
                            sounding_data, cities_passed, places_passed
                        ) VALUES (
                            $1, $2, $3, $4, $5, $6, $7,
                            $8, $9, $10,
                            $11, $12, $13,
                            $14, $15,
                            $16, $17, $18, $19,
                            $20, $21,
                            $22, $23, $24, $25,
                            $26,
                            $27, $28, $29, $30, $31,
                            $32, $33, $34,
                            $35, $36, $37
                        )
                    `, [
                        r.id, r.name, r.date, r.distance, r.duration, r.top_speed, r.avg_speed,
                        r.top_elevation, r.lowest_elevation, r.avg_elevation,
                        r.start_time, r.end_time,
                        typeof r.coordinates === 'string' ? r.coordinates : JSON.stringify(r.coordinates),
                        r.elevation_gain, r.elevation_loss,
                        r.start_lat, r.start_lon, r.end_lat, r.end_lon,
                        r.source, r.watch_recorded,
                        typeof r.profile_time_ms === 'string' ? r.profile_time_ms : JSON.stringify(r.profile_time_ms),
                        typeof r.profile_dist_mi === 'string' ? r.profile_dist_mi : JSON.stringify(r.profile_dist_mi),
                        typeof r.profile_elev_m === 'string' ? r.profile_elev_m : JSON.stringify(r.profile_elev_m),
                        typeof r.profile_speed_mph === 'string' ? r.profile_speed_mph : JSON.stringify(r.profile_speed_mph),
                        r.travel_mode,
                        r.weather_temp, r.weather_feels_like, r.weather_humidity, r.weather_wind_speed,
                        r.weather_wind_dir ?? null,
                        r.weather_condition, r.weather_description, r.weather_icon,
                        typeof r.sounding_data === 'string' ? r.sounding_data : JSON.stringify(r.sounding_data),
                        // Restore the geocoded place index too — omitting these
                        // used to leave every un-combined journey NULL until the
                        // next manual backfill.
                        r.cities_passed == null ? null : (typeof r.cities_passed === 'string' ? r.cities_passed : JSON.stringify(r.cities_passed)),
                        r.places_passed == null ? null : (typeof r.places_passed === 'string' ? r.places_passed : JSON.stringify(r.places_passed)),
                    ]);

                    // Restore waypoints
                    for (const wp of (entry.waypoints || [])) {
                        await db.query(`
                            INSERT INTO waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        `, [wp.id, wp.route_id, wp.lat, wp.lon, wp.elevation, wp.timestamp, wp.note, wp.label]);
                    }

                    // Restore photos
                    for (const saved of (entry.photos || [])) {
                        const ph = { ...saved, ...currentPhotoById.get(saved.id), route_id: saved.route_id };
                        await db.query(`
                            INSERT INTO photos (
                                id, route_id, filename, original_name, mimetype, size, uploaded_at,
                                poster_filename, duration_ms, width, height, status
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                        `, [
                            ph.id, ph.route_id, ph.filename, ph.original_name, ph.mimetype, ph.size, ph.uploaded_at,
                            ph.poster_filename ?? null, ph.duration_ms ?? null, ph.width ?? null, ph.height ?? null, ph.status ?? null,
                        ]);
                    }
                }

                // Delete the backup
                await db.query('DELETE FROM journey_backups WHERE id = $1', [backup.id]);

                await db.query('COMMIT');

                // Return the restored journeys
                const restoredIds = sourceJourneys.map(e => e.route.id);
                const placeholders = restoredIds.map((_, i) => `$${i + 1}`).join(', ');
                const { rows } = await db.query(
                    `SELECT r.id, r.name, r.date, r.start_time, r.end_time, r.distance, r.duration,
                            r.watch_recorded, r.travel_mode, r.avg_speed,
                            (SELECT COUNT(*) FROM waypoints w WHERE w.route_id = r.id) AS waypoint_count,
                            (SELECT COUNT(*) FROM photos p WHERE p.route_id = r.id) AS photo_count
                     FROM routes r WHERE r.id IN (${placeholders})
                     ORDER BY r.start_time DESC`,
                    restoredIds
                );

                res.json({
                    message: 'Combine undone successfully',
                    restoredJourneys: rows.map(toApiSummary),
                });
            } catch (err) {
                await db.query('ROLLBACK');
                throw err;
            }
        });
    } catch (err) {
        log.error('POST /api/routes/:id/undo-combine error:', err);
        res.status(500).json({ error: 'Failed to undo combine' });
    }
});

module.exports = router;
