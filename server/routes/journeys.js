const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { withTenantClient, toApiRoute, toApiSummary, toApiWaypoint } = require('../db');
const { detectTravelMode } = require('../utils/geo');
const { formatDuration } = require('../utils/format');
const { MIN_ROUTE_MILES, PHOTOS_DIR } = require('../config');

function resolvePhotoPath(filename) {
    const root = path.resolve(PHOTOS_DIR);
    const fullPath = path.resolve(path.join(PHOTOS_DIR, filename));
    if (fullPath === root || fullPath.startsWith(`${root}${path.sep}`)) {
        return fullPath;
    }
    return null;
}

// GET /api/routes (list view)
router.get('/', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows } = await db.query(`
                SELECT r.id, r.name, r.date, r.start_time, r.end_time, r.distance, r.duration,
                       r.watch_recorded, r.travel_mode, r.avg_speed,
                       (SELECT COUNT(*) FROM waypoints w WHERE w.route_id = r.id) AS waypoint_count,
                       (SELECT COUNT(*) FROM photos p WHERE p.route_id = r.id) AS photo_count
                FROM routes r
                WHERE r.distance >= $1
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
        console.error('GET /api/routes error:', err);
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
        console.error('GET /api/routes/:id error:', err);
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
        console.error('PATCH name error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/routes/:id/travel-mode
router.patch('/:id/travel-mode', express.json(), async (req, res) => {
    const { travelMode } = req.body;
    const validModes = ['foot', 'scooter', 'drive'];

    if (!travelMode || !validModes.includes(travelMode)) {
        return res.status(400).json({ error: "Invalid travel mode. Must be 'foot', 'scooter', or 'drive'" });
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
        console.error('PATCH travel-mode error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/routes/:id
router.delete('/:id', async (req, res) => {
    try {
        await withTenantClient(req.userId, async (db) => {
            const { rows: photos } = await db.query(
                'SELECT filename FROM photos WHERE route_id = $1', [req.params.id]
            );

            const { rowCount } = await db.query('DELETE FROM routes WHERE id = $1', [req.params.id]);
            if (rowCount === 0) {
                return res.status(404).send('Journey not found');
            }

            for (const photo of photos) {
                const photoPath = resolvePhotoPath(photo.filename);
                if (photoPath && fs.existsSync(photoPath)) {
                    fs.unlinkSync(photoPath);
                }
            }

            res.status(200).json({ message: 'Journey deleted successfully' });
        });
    } catch (err) {
        console.error('DELETE /api/routes/:id error:', err);
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
        console.error('DELETE point error:', err);
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
        console.error('PATCH waypoint error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
