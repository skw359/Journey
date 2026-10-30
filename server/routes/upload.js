const express = require('express');
const router = express.Router();
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { withTenantClient, withTenantTransaction } = require('../db');
const { detectTravelMode } = require('../utils/geo');
const {
    MIN_ROUTE_MILES,
    UPLOADS_DIR,
    MAX_JOURNEY_UPLOAD_MB,
    MAX_JOURNEY_CSV_MB,
    MAX_JOURNEY_ROWS,
    GEOCODE_BASE_URL,
} = require('../config');
const { fetchAndStoreWeather } = require('../utils/weather');
const { computeCitiesPassed } = require('../utils/cities');
const { computePlacesPassed } = require('../utils/places');
const { insertTrashSnapshot, TRASH_ORIGIN } = require('../utils/trash');
const { archiveUpload, deleteArchiveFiles } = require('../utils/uploadArchive');
const { IngestError, parseJourneyUpload, journeyName, journeyDate } = require('../utils/journeyIngest');
const { insertRoute, insertWaypoints } = require('../utils/routeRecords');
const { refreshDerivedSoon } = require('../utils/journeyDerived');
const log = require('../utils/logger').scope('upload');

const PARSE_TIMEOUT_MS = 60 * 1000;
const RECORDING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const receiveJourney = multer({
    dest: UPLOADS_DIR,
    limits: { fileSize: MAX_JOURNEY_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
}).single('journey');

function acceptJourneyFile(req, res, next) {
    receiveJourney(req, res, (err) => {
        if (!err) return next();
        if (req.file?.path) fs.promises.rm(req.file.path, { force: true }).catch(() => {});
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `Journey uploads must be smaller than ${MAX_JOURNEY_UPLOAD_MB} MB` });
        }
        res.status(400).json({ error: err.message || 'Invalid upload' });
    });
}

function newWaypointId() {
    return `wp-${crypto.randomBytes(8).toString('hex')}`;
}

function routeFromUpload({ stats, routeId, source, archiveName, clientUploadId, fingerprint }) {
    const start = stats.firstTs != null ? new Date(stats.firstTs) : new Date();
    return {
        id: routeId,
        name: journeyName(start),
        date: journeyDate(start),
        distance: stats.distance,
        duration: stats.duration,
        top_speed: stats.top_speed,
        avg_speed: stats.avg_speed,
        top_elevation: stats.top_elevation,
        lowest_elevation: stats.lowest_elevation,
        avg_elevation: stats.avg_elevation,
        start_time: stats.start_time || start.toISOString(),
        end_time: stats.end_time || start.toISOString(),
        coordinates: stats.coordinates,
        elevation_gain: stats.elevation_gain,
        elevation_loss: stats.elevation_loss,
        start_lat: stats.start_lat,
        start_lon: stats.start_lon,
        end_lat: stats.end_lat,
        end_lon: stats.end_lon,
        source,
        watch_recorded: source === 'watch',
        profile_time_ms: stats.profile_time_ms,
        profile_dist_mi: stats.profile_dist_mi,
        profile_elev_m: stats.profile_elev_m,
        profile_speed_mph: stats.profile_speed_mph,
        travel_mode: detectTravelMode(stats.avgSpeedMph),
        archive_names: archiveName ? [archiveName] : null,
        client_upload_id: clientUploadId,
        content_fingerprint: fingerprint,
    };
}

function savedResponse(route, waypoints, { duplicate = false } = {}) {
    return {
        accepted: true,
        saved: true,
        ...(duplicate ? { duplicate: true } : {}),
        id: route.id,
        name: route.name,
        date: route.date,
        distance: Number(route.distance).toFixed(2),
        duration: route.duration,
        topSpeed: route.top_speed != null ? Number(route.top_speed).toFixed(2) : null,
        avgSpeed: route.avg_speed != null ? Number(route.avg_speed).toFixed(2) : null,
        topElevation: route.top_elevation != null ? Number(route.top_elevation).toFixed(2) : null,
        lowestElevation: route.lowest_elevation != null ? Number(route.lowest_elevation).toFixed(2) : null,
        avgElevation: route.avg_elevation != null ? Number(route.avg_elevation).toFixed(2) : null,
        startTime: route.start_time ? new Date(route.start_time).toISOString() : null,
        endTime: route.end_time ? new Date(route.end_time).toISOString() : null,
        coordinates: route.coordinates || [],
        elevationGain: route.elevation_gain != null ? Number(route.elevation_gain) : null,
        elevationLoss: route.elevation_loss != null ? Number(route.elevation_loss) : null,
        startCoord: route.start_lat != null ? [route.start_lat, route.start_lon] : null,
        endCoord: route.end_lat != null ? [route.end_lat, route.end_lon] : null,
        source: route.source,
        watchRecorded: route.watch_recorded === true,
        profileTimeMs: route.profile_time_ms || [],
        profileDistMi: route.profile_dist_mi || [],
        profileElevM: route.profile_elev_m || [],
        profileSpeedMph: route.profile_speed_mph || [],
        waypoints: waypoints || [],
        photos: [],
        travelMode: route.travel_mode || null,
    };
}

function trashedResponse({ reason, totalMiles, duplicate = false }) {
    return {
        accepted: true,
        saved: false,
        trashed: true,
        ...(duplicate ? { duplicate: true } : {}),
        reason,
        ...(reason === 'short_distance' ? { totalMiles: Number(totalMiles.toFixed(2)), thresholdMiles: MIN_ROUTE_MILES } : {}),
        message: 'Journey not added — moved to Recently Deleted',
    };
}

// Journey or Trash entry already made from this recording (by recording id or content).
async function findExistingUpload(db, { clientUploadId, fingerprint }) {
    const { rows: routes } = await db.query(`
        SELECT * FROM routes
        WHERE ($1::text IS NOT NULL AND client_upload_id = $1)
           OR ($2::text IS NOT NULL AND content_fingerprint = $2)
        LIMIT 1
    `, [clientUploadId, fingerprint]);
    if (routes[0]) {
        const { rows: waypoints } = await db.query(
            'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [routes[0].id]
        );
        return { route: routes[0], waypoints };
    }
    const { rows: trashed } = await db.query(`
        SELECT origin, distance FROM trashed_journeys
        WHERE ($1::text IS NOT NULL AND client_upload_id = $1)
           OR ($2::text IS NOT NULL AND content_fingerprint = $2)
        LIMIT 1
    `, [clientUploadId, fingerprint]);
    if (trashed[0]) return { trashed: trashed[0] };
    return null;
}

function respondExisting(res, existing) {
    if (existing.route) {
        const waypoints = existing.waypoints.map((wp) => ({
            id: wp.id, lat: wp.lat, lon: wp.lon, timestamp: Number(wp.timestamp), note: wp.note || '',
            elevation: wp.elevation != null ? Number(wp.elevation) : null,
        }));
        return res.status(200).json(savedResponse(existing.route, waypoints, { duplicate: true }));
    }
    const reason = existing.trashed.origin === TRASH_ORIGIN.REJECTED_SHORT ? 'short_distance'
        : existing.trashed.origin === TRASH_ORIGIN.REJECTED_INSUFFICIENT ? 'insufficient_data' : 'deleted';
    return res.status(200).json(trashedResponse({
        reason, totalMiles: Number(existing.trashed.distance) || 0, duplicate: true,
    }));
}

// Fire-and-forget. A null result (geocoder unreachable) leaves the column NULL for the backfill.
function computePassedLists(userId, routeId, coordinates) {
    if (!GEOCODE_BASE_URL || !coordinates || coordinates.length < 2) return;
    computeCitiesPassed(coordinates)
        .then((cities) => {
            if (cities === null) {
                log.scope('cities').error(`geocoder unreachable — journey #${routeId} left for backfill`);
                return;
            }
            return withTenantClient(userId, (client) =>
                client.query('UPDATE routes SET cities_passed = $1 WHERE id = $2', [JSON.stringify(cities), routeId])
            ).then(() => log.scope('cities').debug(`computed for journey #${routeId}`));
        })
        .catch((err) => log.scope('cities').error('computation failed', err));

    computePlacesPassed(coordinates)
        .then((places) => {
            if (places === null) {
                log.scope('places').error(`geocoder unreachable — journey #${routeId} left for backfill`);
                return;
            }
            return withTenantClient(userId, (client) =>
                client.query('UPDATE routes SET places_passed = $1 WHERE id = $2', [JSON.stringify(places), routeId])
            ).then(() => log.scope('places').debug(`computed for journey #${routeId}`));
        })
        .catch((err) => log.scope('places').error('computation failed', err));
}

// POST /upload — multipart: journey (zip), source ('watch' | 'iphone'), recordingId (optional)
router.post('/', acceptJourneyFile, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No journey file uploaded (field "journey")' });
    }
    const filePath = req.file.path;
    const discardUpload = () => fs.promises.rm(filePath, { force: true }).catch(() => {});
    const source = req.body?.source === 'watch' ? 'watch' : 'iphone';
    const rawRecordingId = typeof req.body?.recordingId === 'string' ? req.body.recordingId.trim() : '';
    if (rawRecordingId && !RECORDING_ID.test(rawRecordingId)) {
        await discardUpload();
        return res.status(400).json({ error: 'Invalid recordingId' });
    }
    const clientUploadId = rawRecordingId || null;

    let parsed;
    try {
        parsed = await parseJourneyUpload(filePath, {
            maxCsvBytes: MAX_JOURNEY_CSV_MB * 1024 * 1024,
            maxRows: MAX_JOURNEY_ROWS,
            timeoutMs: PARSE_TIMEOUT_MS,
        });
    } catch (err) {
        await discardUpload();
        if (err instanceof IngestError) {
            log.warn(`journey rejected · ${err.message}`);
            return res.status(err.status).json({ error: err.message, code: err.code });
        }
        log.error('could not read journey upload', err);
        return res.status(500).json({ error: 'Failed to read the journey upload' });
    }

    const { stats, waypoints, fingerprint } = parsed;
    try {
        const existing = await withTenantClient(req.userId, (db) => findExistingUpload(db, { clientUploadId, fingerprint }));
        if (existing) {
            await discardUpload();
            log.info(`duplicate upload ignored · already ${existing.route ? `journey #${existing.route.id}` : 'in Recently Deleted'}`);
            return respondExisting(res, existing);
        }
    } catch (err) {
        await discardUpload();
        log.error('duplicate check failed during upload', err);
        return res.status(500).json({ error: 'Failed to save journey to database' });
    }

    if (stats.count < 1 || stats.firstTs == null) {
        await discardUpload();
        log.warn(`journey rejected · no usable GPS points`);
        return res.status(200).json({
            accepted: true,
            saved: false,
            trashed: false,
            reason: 'insufficient_data',
            message: 'Journey accepted but not saved - insufficient data points',
        });
    }

    const routeId = `journey-${crypto.randomBytes(8).toString('hex')}`;
    const archiveName = await archiveUpload(filePath, req.userId, stats.firstTs);
    const route = routeFromUpload({ stats, routeId, source, archiveName, clientUploadId, fingerprint });

    const rejection = stats.count < 2 || stats.totalMiles <= 0
        ? { origin: TRASH_ORIGIN.REJECTED_INSUFFICIENT, reason: 'insufficient_data', note: 'Not enough GPS data to form a journey' }
        : stats.totalMiles < MIN_ROUTE_MILES
            ? {
                origin: TRASH_ORIGIN.REJECTED_SHORT,
                reason: 'short_distance',
                note: `Below minimum distance (${stats.totalMiles.toFixed(2)} mi of ${MIN_ROUTE_MILES} mi)`,
            }
            : null;

    if (rejection) {
        const snapshot = {
            route: {
                ...route,
                weather_temp: null, weather_feels_like: null, weather_humidity: null, weather_wind_speed: null,
                weather_wind_dir: null, weather_condition: null, weather_description: null, weather_icon: null,
                sounding_data: null, cities_passed: null, places_passed: null,
            },
            waypoints: waypoints.map((wp) => ({ ...wp, route_id: routeId, label: null })),
            photos: [],
        };
        try {
            await withTenantClient(req.userId, (db) => insertTrashSnapshot(db, {
                snapshot, origin: rejection.origin, reason: rejection.note,
            }));
        } catch (err) {
            await deleteArchiveFiles([archiveName]);
            log.error('could not move rejected journey to Trash', err);
            return res.status(500).json({ error: 'Failed to save journey to database' });
        }
        log.warn(`journey rejected · ${rejection.note} → Trash`);
        return res.status(200).json(trashedResponse({ reason: rejection.reason, totalMiles: stats.totalMiles }));
    }

    try {
        await withTenantTransaction(req.userId, async (db) => {
            await insertRoute(db, route);
            await insertWaypoints(db, routeId, waypoints, newWaypointId);
        });
    } catch (err) {
        await deleteArchiveFiles([archiveName]);
        if (err.code === '23505') {
            // A concurrent upload of the same recording won.
            const existing = await withTenantClient(req.userId, (db) => findExistingUpload(db, { clientUploadId, fingerprint }))
                .catch(() => null);
            if (existing) return respondExisting(res, existing);
        }
        log.error('database write failed during upload', err);
        return res.status(500).json({ error: 'Failed to save journey to database' });
    }

    log.success(`journey uploaded · ${route.name} · ${route.distance}mi · #${routeId}`);
    res.status(201).json(savedResponse(route, waypoints));

    if (route.start_lat != null) {
        fetchAndStoreWeather(req.userId, routeId, route.start_lat, route.start_lon, route.start_time)
            .catch((err) => log.scope('weather').error('upload fetch failed', err));
    }
    refreshDerivedSoon(req.userId);
    computePassedLists(req.userId, routeId, route.coordinates);
});

module.exports = router;
module.exports.computePassedLists = computePassedLists;
