const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { withTenantClient, withTenantTransaction, toApiRoute, toApiSummary, toApiWaypoint } = require('../db');
const { detectTravelMode } = require('../utils/geo');
const { MIN_ROUTE_MILES, GEOCODE_BASE_URL } = require('../config');
const { visibleSql } = require('../utils/visibility');
const { statsFromTrack, mergeTracksByTime, trackFromRow } = require('../utils/journeyStats');
const { insertRoute, insertWaypoints, insertPhotoRow } = require('../utils/routeRecords');
const { journeyDate } = require('../utils/journeyIngest');
const { refreshDerivedSoon } = require('../utils/journeyDerived');
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
    RestoreConflictError,
    trashExistingRoute,
    restoreTrashedJourney,
    permanentlyDeleteTrash,
    emptyTrash,
    purgeExpiredTrash,
    listTrash,
    getTrashDetail,
} = require('../utils/trash');

const MAX_COMBINE = 50;
const MAX_POINTS_PER_DELETE = 10_000;

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function sendHttpError(res, err) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
}

function newWaypointId() {
    return `wp-${crypto.randomBytes(8).toString('hex')}`;
}

function trackSignature(coordinates) {
    return crypto.createHash('sha256').update(JSON.stringify(coordinates || [])).digest('hex');
}

async function loadRouteDetail(db, routeId) {
    const { rows: [route] } = await db.query('SELECT * FROM routes WHERE id = $1', [routeId]);
    if (!route) return null;
    const { rows: waypoints } = await db.query(
        'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [routeId]
    );
    const { rows: photos } = await db.query(
        'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [routeId]
    );
    return toApiRoute(route, waypoints, photos);
}

function statsColumns(stats) {
    return {
        distance: stats.distance,
        duration: stats.duration,
        top_speed: stats.top_speed,
        avg_speed: stats.avg_speed,
        top_elevation: stats.top_elevation,
        lowest_elevation: stats.lowest_elevation,
        avg_elevation: stats.avg_elevation,
        elevation_gain: stats.elevation_gain,
        elevation_loss: stats.elevation_loss,
        start_time: stats.start_time,
        end_time: stats.end_time,
        start_lat: stats.start_lat,
        start_lon: stats.start_lon,
        end_lat: stats.end_lat,
        end_lon: stats.end_lon,
    };
}

// Skips the write if the track changed again meanwhile.
function recomputePassedLists(userId, routeId, coordinates) {
    if (!GEOCODE_BASE_URL || !coordinates || coordinates.length < 2) return;
    const signature = trackSignature(coordinates);
    const { computeCitiesPassed } = require('../utils/cities');
    const { computePlacesPassed } = require('../utils/places');
    for (const [column, compute, scope] of [
        ['cities_passed', computeCitiesPassed, 'cities'],
        ['places_passed', computePlacesPassed, 'places'],
    ]) {
        compute(coordinates)
            .then((result) => {
                if (result === null) {
                    log.scope(scope).error(`geocoder unreachable — journey #${routeId} left for backfill`);
                    return withTenantClient(userId, (db) => db.query(`UPDATE routes SET ${column} = NULL WHERE id = $1`, [routeId]));
                }
                return withTenantClient(userId, async (db) => {
                    const { rows } = await db.query('SELECT coordinates FROM routes WHERE id = $1', [routeId]);
                    if (!rows[0] || trackSignature(rows[0].coordinates) !== signature) return;
                    await db.query(`UPDATE routes SET ${column} = $1 WHERE id = $2`, [JSON.stringify(result), routeId]);
                });
            })
            .catch((err) => log.scope(scope).error('recompute failed', err));
    }
}

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
                WHERE ${visibleSql('$1', 'r')}
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
        const restored = await withTenantTransaction(req.userId, (db) => restoreTrashedJourney(db, req.params.trashId));
        if (!restored) return res.status(404).json({ error: 'Trashed journey not found' });
        const { processingMedia, ...summary } = restored;
        res.json({ message: 'Journey restored', ...summary });
        refreshDerivedSoon(req.userId);
        // Photos and videos trashed mid-conversion pick up where they left off.
        if (processingMedia.length > 0) {
            requeueProcessing(req.userId, processingMedia)
                .catch((err) => log.error('could not requeue restored media', err));
        }
    } catch (err) {
        if (err instanceof RestoreConflictError) return res.status(409).json({ error: err.message });
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
    const { newName } = req.body || {};
    if (!newName || typeof newName !== 'string' || !newName.trim()) {
        return res.status(400).json({ error: 'Invalid name' });
    }
    if (newName.trim().length > 200) {
        return res.status(400).json({ error: 'Names are limited to 200 characters' });
    }
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rowCount } = await db.query(
                'UPDATE routes SET name = $1 WHERE id = $2',
                [newName.trim(), req.params.id]
            );
            if (rowCount === 0) {
                return res.status(404).json({ error: 'Journey not found' });
            }
            res.json({ message: 'Name updated', route: await loadRouteDetail(db, req.params.id) });
        });
    } catch (err) {
        log.error('PATCH name error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/routes/:id/travel-mode
router.patch('/:id/travel-mode', express.json(), async (req, res) => {
    const { travelMode } = req.body || {};
    const validModes = ['foot', 'scooter', 'drive', 'train', 'metro', 'flight'];

    if (!travelMode || !validModes.includes(travelMode)) {
        return res.status(400).json({ error: "Invalid travel mode. Must be 'foot', 'scooter', 'drive', 'train', 'metro', or 'flight'" });
    }

    try {
        await withTenantClient(req.userId, async (db) => {
            const { rowCount } = await db.query(
                'UPDATE routes SET travel_mode = $1 WHERE id = $2',
                [travelMode, req.params.id]
            );
            if (rowCount === 0) {
                return res.status(404).json({ error: 'Journey not found' });
            }
            res.json({ message: 'Travel mode updated', route: await loadRouteDetail(db, req.params.id) });
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
        const result = await withTenantTransaction(req.userId, (db) => trashExistingRoute(db, req.params.id, {
            origin: TRASH_ORIGIN.USER_DELETED,
            reason: 'Deleted from journeys',
        }));
        if (!result) return res.status(404).send('Journey not found');
        res.status(200).json({ message: 'Journey moved to Trash', trashId: result.trashId });
    } catch (err) {
        log.error('DELETE /api/routes/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Recomputes every statistic from the remaining points (outlier filtering is off by design).
async function deletePoints(req, res, rawIndices) {
    const routeId = req.params.id;
    const indices = [];
    for (const raw of rawIndices) {
        const text = String(raw);
        if (!/^\d+$/.test(text)) return res.status(400).json({ error: 'Point indices must be whole numbers' });
        indices.push(Number(text));
    }
    if (indices.length === 0) return res.status(400).json({ error: 'No points given' });
    if (indices.length > MAX_POINTS_PER_DELETE) {
        return res.status(400).json({ error: `At most ${MAX_POINTS_PER_DELETE} points per request` });
    }

    try {
        const coordinates = await withTenantTransaction(req.userId, async (db) => {
            const { rows } = await db.query('SELECT * FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
            if (rows.length === 0) throw new HttpError(404, 'Journey not found');
            const row = rows[0];

            const { track, error } = trackFromRow(row);
            if (error) throw new HttpError(409, `This journey can't be edited point by point: ${error}`);
            const total = track.coords.length;
            if (total <= 2) throw new HttpError(400, 'Cannot delete points from a journey with too few points.');
            const removed = new Set(indices);
            for (const index of removed) {
                if (index >= total) throw new HttpError(400, `Point ${index} is out of range (the journey has ${total} points)`);
            }
            if (total - removed.size < 2) throw new HttpError(400, 'A journey needs at least two points');

            const stats = statsFromTrack(track, { removed });
            const has = (series) => Array.isArray(series) && series.length === total;
            const columns = {
                ...statsColumns(stats),
                coordinates: JSON.stringify(stats.coordinates),
                profile_time_ms: JSON.stringify(has(row.profile_time_ms) ? stats.profile_time_ms : []),
                profile_dist_mi: JSON.stringify(stats.profile_dist_mi),
                profile_elev_m: JSON.stringify(has(row.profile_elev_m) ? stats.profile_elev_m : []),
                profile_speed_mph: JSON.stringify(has(row.profile_speed_mph) ? stats.profile_speed_mph : []),
            };
            const names = Object.keys(columns);
            await db.query(
                `UPDATE routes SET ${names.map((name, i) => `${name} = $${i + 2}`).join(', ')} WHERE id = $1`,
                [routeId, ...names.map((name) => columns[name])]
            );
            return stats.coordinates;
        });

        const route = await withTenantClient(req.userId, (db) => loadRouteDetail(db, routeId));
        res.json({ message: indices.length === 1 ? 'Point deleted' : 'Points deleted', route });
        refreshDerivedSoon(req.userId);
        recomputePassedLists(req.userId, routeId, coordinates);
    } catch (err) {
        if (err instanceof HttpError) return sendHttpError(res, err);
        log.error('DELETE point error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// DELETE /api/routes/:id/points/:index
router.delete('/:id/points/:index', (req, res) => deletePoints(req, res, [req.params.index]));

// POST /api/routes/:id/points/delete { indices: [..] } — several points in one go
router.post('/:id/points/delete', express.json(), (req, res) => {
    const indices = req.body?.indices;
    if (!Array.isArray(indices)) return res.status(400).json({ error: 'indices must be a list' });
    return deletePoints(req, res, indices);
});

// PATCH /api/routes/:id/waypoints/:wpId
router.patch('/:id/waypoints/:wpId', express.json(), async (req, res) => {
    const { label } = req.body || {};
    if (typeof label !== 'string' || !label.trim()) {
        return res.status(400).json({ error: 'Invalid label' });
    }
    if (label.trim().length > 200) {
        return res.status(400).json({ error: 'Labels are limited to 200 characters' });
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

// POST /api/routes/combine — merges into the earliest journey, interleaving points by time.
router.post('/combine', express.json(), async (req, res) => {
    const { journeyIds, name } = req.body || {};

    if (!Array.isArray(journeyIds) || journeyIds.length < 2) {
        return res.status(400).json({ error: 'At least two journey IDs are required' });
    }
    if (journeyIds.length > MAX_COMBINE || !journeyIds.every((id) => typeof id === 'string' && id)) {
        return res.status(400).json({ error: `Combine between 2 and ${MAX_COMBINE} journeys` });
    }
    if (journeyIds.length !== new Set(journeyIds).size) {
        return res.status(400).json({ error: 'Duplicate journey IDs' });
    }
    if (name != null && (typeof name !== 'string' || name.length > 200)) {
        return res.status(400).json({ error: 'Invalid name' });
    }

    try {
        const result = await withTenantTransaction(req.userId, async (db) => {
            const { rows: routes } = await db.query(
                'SELECT * FROM routes WHERE id = ANY($1) ORDER BY start_time ASC NULLS LAST, id ASC FOR UPDATE',
                [journeyIds]
            );
            if (routes.length !== journeyIds.length) {
                const found = new Set(routes.map((r) => r.id));
                const missing = journeyIds.filter((id) => !found.has(id));
                throw new HttpError(404, `Journeys not found: ${missing.join(', ')}`);
            }

            const tracks = [];
            for (const route of routes) {
                const { track, error } = trackFromRow(route);
                if (error) throw new HttpError(409, `"${route.name}" can't be combined: ${error}`);
                tracks.push(track);
            }

            const waypointsByRoute = {};
            const photosByRoute = {};
            for (const route of routes) {
                const { rows: wps } = await db.query(
                    'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [route.id]
                );
                waypointsByRoute[route.id] = wps;
                const { rows: phs } = await db.query(
                    'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [route.id]
                );
                photosByRoute[route.id] = phs;
            }

            const primaryId = routes[0].id;
            const stats = statsFromTrack(mergeTracksByTime(tracks));
            const archiveNames = [...new Set(routes.flatMap((r) => r.archive_names || []))];
            const combinedName = (typeof name === 'string' && name.trim()) ? name.trim() : routes[0].name;

            const backupId = `backup-${crypto.randomBytes(8).toString('hex')}`;
            await db.query(
                `INSERT INTO journey_backups (id, combined_journey_id, source_journeys, created_at, combined_signature)
                 VALUES ($1, $2, $3, NOW(), $4)`,
                [
                    backupId,
                    primaryId,
                    JSON.stringify(routes.map((r) => ({ route: r, waypoints: waypointsByRoute[r.id], photos: photosByRoute[r.id] }))),
                    trackSignature(stats.coordinates),
                ]
            );

            const columns = {
                ...statsColumns(stats),
                name: combinedName,
                date: journeyDate(new Date(stats.start_time)),
                coordinates: JSON.stringify(stats.coordinates),
                profile_time_ms: JSON.stringify(stats.profile_time_ms),
                profile_dist_mi: JSON.stringify(stats.profile_dist_mi),
                profile_elev_m: JSON.stringify(stats.profile_elev_m),
                profile_speed_mph: JSON.stringify(stats.profile_speed_mph),
                travel_mode: detectTravelMode(stats.avgSpeedMph),
                archive_names: archiveNames.length ? archiveNames : null,
                cities_passed: null,
                places_passed: null,
            };
            const columnNames = Object.keys(columns);
            await db.query(
                `UPDATE routes SET ${columnNames.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`,
                [primaryId, ...columnNames.map((col) => columns[col])]
            );

            const secondaryIds = routes.slice(1).map((r) => r.id);
            await db.query('UPDATE waypoints SET route_id = $1 WHERE route_id = ANY($2)', [primaryId, secondaryIds]);
            await db.query('UPDATE photos SET route_id = $1 WHERE route_id = ANY($2)', [primaryId, secondaryIds]);
            await db.query('DELETE FROM routes WHERE id = ANY($1)', [secondaryIds]);

            return { primaryId, backupId, coordinates: stats.coordinates };
        });

        const combined = await withTenantClient(req.userId, (db) => loadRouteDetail(db, result.primaryId));
        res.json({ message: 'Journeys combined successfully', route: combined, backupId: result.backupId });

        refreshDerivedSoon(req.userId);
        recomputePassedLists(req.userId, result.primaryId, result.coordinates);
    } catch (err) {
        if (err instanceof HttpError) return sendHttpError(res, err);
        log.error('POST /api/routes/combine error:', err);
        res.status(500).json({ error: 'Failed to combine journeys' });
    }
});

// POST /api/routes/:id/undo-combine { force? }
// Later photo/waypoint changes are kept (new photos go to the earliest journey). Refused
// with 409 if the combined track was edited since, unless force is set.
router.post('/:id/undo-combine', express.json(), async (req, res) => {
    const combinedId = req.params.id;
    const force = req.body?.force === true;

    try {
        const restored = await withTenantTransaction(req.userId, async (db) => {
            const { rows: [combined] } = await db.query('SELECT * FROM routes WHERE id = $1 FOR UPDATE', [combinedId]);
            if (!combined) throw new HttpError(404, 'The combined journey no longer exists (restore it from Recently Deleted first)');

            const { rows: backups } = await db.query(
                'SELECT * FROM journey_backups WHERE combined_journey_id = $1 ORDER BY created_at DESC LIMIT 1',
                [combinedId]
            );
            if (backups.length === 0) throw new HttpError(404, 'No combine backup found for this journey');
            const backup = backups[0];
            const sources = backup.source_journeys || [];

            if (!force && backup.combined_signature && backup.combined_signature !== trackSignature(combined.coordinates)) {
                throw new HttpError(409, 'Points were deleted from this journey after it was combined; undoing would bring them back.', { code: 'edited_since_combine' });
            }

            const { rows: currentPhotos } = await db.query('SELECT * FROM photos WHERE route_id = $1', [combinedId]);
            const { rows: currentWaypoints } = await db.query('SELECT * FROM waypoints WHERE route_id = $1', [combinedId]);
            const ownerOfPhoto = new Map();
            const ownerOfWaypoint = new Map();
            for (const entry of sources) {
                for (const ph of entry.photos || []) ownerOfPhoto.set(ph.id, entry.route.id);
                for (const wp of entry.waypoints || []) ownerOfWaypoint.set(wp.id, entry.route.id);
            }
            const primaryId = sources[0]?.route?.id || combinedId;
            const ownerByTime = (ts) => {
                const ms = Number(ts);
                const match = sources.find((entry) => {
                    const start = new Date(entry.route.start_time).getTime();
                    const end = new Date(entry.route.end_time).getTime();
                    return ms >= start && ms <= end;
                });
                return match ? match.route.id : primaryId;
            };

            await db.query('DELETE FROM routes WHERE id = $1', [combinedId]);

            for (const entry of sources) {
                try {
                    await insertRoute(db, entry.route);
                } catch (err) {
                    if (err.code === '23505') {
                        throw new HttpError(409, `"${entry.route.name}" can't be restored: a journey with the same id or recording already exists`);
                    }
                    throw err;
                }
            }
            for (const wp of currentWaypoints) {
                const owner = ownerOfWaypoint.get(wp.id) || ownerByTime(wp.timestamp);
                await insertWaypoints(db, owner, [wp], newWaypointId);
            }
            for (const ph of currentPhotos) {
                await insertPhotoRow(db, ownerOfPhoto.get(ph.id) || primaryId, ph);
            }

            await db.query('DELETE FROM journey_backups WHERE id = $1', [backup.id]);

            const restoredIds = sources.map((entry) => entry.route.id);
            const { rows } = await db.query(
                `SELECT r.id, r.name, r.date, r.start_time, r.end_time, r.distance, r.duration,
                        r.watch_recorded, r.travel_mode, r.avg_speed,
                        (SELECT COUNT(*) FROM waypoints w WHERE w.route_id = r.id) AS waypoint_count,
                        (SELECT COUNT(*) FROM photos p WHERE p.route_id = r.id) AS photo_count
                 FROM routes r WHERE r.id = ANY($1)
                 ORDER BY r.start_time DESC`,
                [restoredIds]
            );
            return rows;
        });

        res.json({
            message: 'Combine undone successfully',
            restoredJourneys: restored.map(toApiSummary),
        });
        refreshDerivedSoon(req.userId);
    } catch (err) {
        if (err instanceof HttpError) return sendHttpError(res, err);
        log.error('POST /api/routes/:id/undo-combine error:', err);
        res.status(500).json({ error: 'Failed to undo combine' });
    }
});

module.exports = router;
