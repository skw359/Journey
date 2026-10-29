const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const csv = require('csv-parser');
const { withTenantClient } = require('../db');
const { upload } = require('../middleware/storage');
const { haversine, detectTravelMode } = require('../utils/geo');
const { formatDuration } = require('../utils/format');
const { MIN_ROUTE_MILES, UPLOADS_DIR } = require('../config');
const { fetchAndStoreWeather } = require('../utils/weather');
const { computeCitiesPassed } = require('../utils/cities');
const { computePlacesPassed } = require('../utils/places');
const { insertTrashSnapshot, TRASH_ORIGIN } = require('../utils/trash');
const log = require('../utils/logger').scope('upload');

const ARCHIVE_DIR = path.join(UPLOADS_DIR, 'archive');

// Raw uploads are never deleted: anything the parser drops can be re-processed
// from the archive. Named by recording start so a journey's file is easy to find.
function archiveUpload(filePath, userId, firstTs) {
    if (!fs.existsSync(filePath)) return;
    try {
        const dir = path.join(ARCHIVE_DIR, String(userId || 'unscoped').replace(/[^\w-]/g, '_'));
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date(firstTs != null ? firstTs : Date.now()).toISOString().replace(/[:.]/g, '-');
        fs.renameSync(filePath, path.join(dir, `${stamp}_${path.basename(filePath)}.zip`));
    } catch (err) {
        log.error(`could not archive upload; left in place at ${filePath}`, err);
    }
}

// POST /upload
router.post('/', upload.single('journey'), (req, res) => {
    const filePath = req.file.path;
    const uploadSource = (req.body && req.body.source === 'watch') ? 'watch' : 'iphone';
    const stats = {
        count: 0,
        topSpeedMps: 0,
        sumSpeedMps: 0,
        speedSamples: 0,
        topElevation: -Infinity,
        lowestElevation: Infinity,
        sumElevation: 0,
        last: null,
        lastTs: null,
        totalMiles: 0,
        firstTs: null,
        coords: [],
        elevGainM: 0,
        elevLossM: 0,
        lastEle: null,
        firstCoord: null,
        profileTimeMs: [],
        profileDistMi: [],
        profileElevM: [],
        profileSpeedMph: [],
        waypoints: []
    };
    async function finalize() {
    archiveUpload(filePath, req.userId, stats.firstTs);

    // Build a snake_case route snapshot (same shape restore expects) from the
    // parsed stats, so a rejected journey can be preserved in Trash.
    function buildRejectedSnapshot() {
        const durationSec = (stats.lastTs != null && stats.firstTs != null)
            ? (stats.lastTs - stats.firstTs) / 1000 : 0;
        const start = stats.firstTs != null ? new Date(stats.firstTs) : new Date();
        const end = stats.lastTs != null ? new Date(stats.lastTs) : start;
        const avgSpeedMph = (stats.speedSamples ? (stats.sumSpeedMps / stats.speedSamples) : 0) * 2.23694;
        const routeId = `journey-${crypto.randomBytes(8).toString('hex')}`;
        const route = {
            id: routeId,
            name: `Journey - ${start.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })} - ${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
            date: start.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
            distance: Number(stats.totalMiles.toFixed(2)),
            duration: formatDuration(durationSec),
            top_speed: Number((stats.topSpeedMps * 2.23694).toFixed(2)),
            avg_speed: Number(avgSpeedMph.toFixed(2)),
            top_elevation: Number((stats.topElevation === -Infinity ? 0 : stats.topElevation).toFixed(2)),
            lowest_elevation: Number((stats.lowestElevation === Infinity ? 0 : stats.lowestElevation).toFixed(2)),
            avg_elevation: Number((stats.count ? (stats.sumElevation / stats.count) : 0).toFixed(2)),
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            coordinates: stats.coords,
            elevation_gain: Number(stats.elevGainM.toFixed(2)),
            elevation_loss: Number(stats.elevLossM.toFixed(2)),
            start_lat: stats.firstCoord ? stats.firstCoord[0] : null,
            start_lon: stats.firstCoord ? stats.firstCoord[1] : null,
            end_lat: stats.last ? stats.last.lat : (stats.firstCoord ? stats.firstCoord[0] : null),
            end_lon: stats.last ? stats.last.lon : (stats.firstCoord ? stats.firstCoord[1] : null),
            source: uploadSource,
            watch_recorded: uploadSource === 'watch',
            profile_time_ms: stats.profileTimeMs,
            profile_dist_mi: stats.profileDistMi,
            profile_elev_m: stats.profileElevM,
            profile_speed_mph: stats.profileSpeedMph,
            travel_mode: detectTravelMode(avgSpeedMph),
            weather_temp: null, weather_feels_like: null, weather_humidity: null, weather_wind_speed: null,
            weather_wind_dir: null,
            weather_condition: null, weather_description: null, weather_icon: null,
            sounding_data: null, cities_passed: null, places_passed: null,
        };
        const waypoints = (stats.waypoints || []).map((wp) => ({
            id: wp.id, route_id: routeId, lat: wp.lat, lon: wp.lon,
            elevation: wp.elevation, timestamp: wp.timestamp, note: wp.note, label: null,
        }));
        return { route, waypoints, photos: [] };
    }

    // Preserve a rejected journey in Trash so the user can restore it. Skipped
    // only when there is no usable data at all (nothing to keep or restore).
    async function trashRejected(origin, reason) {
        if (stats.count < 1 || stats.firstTs == null) return false;
        try {
            const snapshot = buildRejectedSnapshot();
            await withTenantClient(req.userId, (db) => insertTrashSnapshot(db, { snapshot, origin, reason }));
            return true;
        } catch (err) {
            log.error('could not move rejected journey to Trash', err);
            return false;
        }
    }

    if (stats.count < 2 || stats.totalMiles <= 0) {
        const trashed = await trashRejected(TRASH_ORIGIN.REJECTED_INSUFFICIENT, 'Not enough GPS data to form a journey');
        log.warn(`journey rejected · only ${stats.count} points (${stats.totalMiles}mi)${trashed ? ' → Trash' : ''}`);
        return res.status(200).json({
            accepted: true,
            saved: false,
            trashed,
            reason: "insufficient_data",
            message: trashed
                ? "Journey not added — moved to Recently Deleted"
                : "Journey accepted but not saved - insufficient data points"
        });
    }

    if (stats.totalMiles < MIN_ROUTE_MILES) {
        const trashed = await trashRejected(TRASH_ORIGIN.REJECTED_SHORT, `Below minimum distance (${stats.totalMiles.toFixed(2)} mi of ${MIN_ROUTE_MILES} mi)`);
        log.warn(`journey rejected · too short: ${stats.totalMiles.toFixed(2)}mi < ${MIN_ROUTE_MILES}mi${trashed ? ' → Trash' : ''}`);
        return res.status(200).json({
            accepted: true,
            saved: false,
            trashed,
            reason: "short_distance",
            totalMiles: Number(stats.totalMiles.toFixed(2)),
            thresholdMiles: MIN_ROUTE_MILES,
            message: trashed
                ? "Journey not added — moved to Recently Deleted"
                : "Journey accepted but not saved - distance below threshold"
        });
    }

    const durationSec = (stats.lastTs - stats.firstTs) / 1000;
    const start = new Date(stats.firstTs);
    const end = new Date(stats.lastTs);
    const avgSpeedMps = stats.speedSamples ? (stats.sumSpeedMps / stats.speedSamples) : 0;
    const avgSpeedMph = avgSpeedMps * 2.23694;

    const routeId = `journey-${crypto.randomBytes(8).toString('hex')}`;
    const routeData = {
        id: routeId,
        name: `Journey - ${start.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })} - ${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
        date: start.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
        distance: stats.totalMiles.toFixed(2),
        duration: formatDuration(durationSec),
        topSpeed: (stats.topSpeedMps * 2.23694).toFixed(2),
        avgSpeed: avgSpeedMph.toFixed(2),
        topElevation: (stats.topElevation === -Infinity ? 0 : stats.topElevation).toFixed(2),
        lowestElevation: (stats.lowestElevation === Infinity ? 0 : stats.lowestElevation).toFixed(2),
        avgElevation: (stats.count ? (stats.sumElevation / stats.count) : 0).toFixed(2),
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        coordinates: stats.coords,
        elevationGain: Number(stats.elevGainM.toFixed(2)),
        elevationLoss: Number(stats.elevLossM.toFixed(2)),
        startCoord: stats.firstCoord,
        endCoord: stats.last ? [stats.last.lat, stats.last.lon] : stats.firstCoord,
        source: uploadSource,
        watchRecorded: uploadSource === 'watch',
        profileTimeMs: stats.profileTimeMs,
        profileDistMi: stats.profileDistMi,
        profileElevM: stats.profileElevM,
        profileSpeedMph: stats.profileSpeedMph,
        waypoints: stats.waypoints,
        photos: [],
        travelMode: detectTravelMode(avgSpeedMph)
    };

    try {
        await withTenantClient(req.userId, async (client) => {
            await client.query('BEGIN');
            try {
                const startCoord = routeData.startCoord || [null, null];
                const endCoord = routeData.endCoord || [null, null];

                await client.query(`
                    INSERT INTO routes (
                        id, name, date, distance, duration, top_speed, avg_speed,
                        top_elevation, lowest_elevation, avg_elevation,
                        start_time, end_time, coordinates,
                        elevation_gain, elevation_loss,
                        start_lat, start_lon, end_lat, end_lon,
                        source, watch_recorded,
                        profile_time_ms, profile_dist_mi, profile_elev_m, profile_speed_mph,
                        travel_mode
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10,
                        $11, $12, $13,
                        $14, $15,
                        $16, $17, $18, $19,
                        $20, $21,
                        $22, $23, $24, $25,
                        $26
                    )
                `, [
                    routeData.id,
                    routeData.name,
                    routeData.date,
                    parseFloat(routeData.distance),
                    routeData.duration,
                    parseFloat(routeData.topSpeed),
                    parseFloat(routeData.avgSpeed),
                    parseFloat(routeData.topElevation),
                    parseFloat(routeData.lowestElevation),
                    parseFloat(routeData.avgElevation),
                    routeData.startTime,
                    routeData.endTime,
                    JSON.stringify(routeData.coordinates),
                    routeData.elevationGain,
                    routeData.elevationLoss,
                    startCoord[0],
                    startCoord[1],
                    endCoord[0],
                    endCoord[1],
                    routeData.source,
                    routeData.watchRecorded,
                    JSON.stringify(routeData.profileTimeMs),
                    JSON.stringify(routeData.profileDistMi),
                    JSON.stringify(routeData.profileElevM),
                    JSON.stringify(routeData.profileSpeedMph),
                    routeData.travelMode,
                ]);

                for (const wp of routeData.waypoints) {
                    await client.query(`
                        INSERT INTO waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    `, [wp.id, routeId, wp.lat, wp.lon, wp.elevation, wp.timestamp, wp.note, wp.label || null]);
                }

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        });
    } catch (err) {
        log.error('database write failed during upload', err);
        return res.status(500).json({ error: 'Failed to save journey to database' });
    }

    log.success(`journey uploaded · ${routeData.name} · ${routeData.distance}mi · #${routeData.id}`);

    res.status(201).json({
        accepted: true,
        saved: true,
        ...routeData
    });

    // Fetch and store weather data (fire-and-forget, non-blocking)
    if (routeData.startCoord && routeData.startCoord[0] != null) {
        fetchAndStoreWeather(req.userId, routeData.id, routeData.startCoord[0], routeData.startCoord[1], routeData.startTime)
            .catch(err => log.scope('weather').error('upload fetch failed', err));
    }

    // Compute cities passed through (fire-and-forget, non-blocking).
    // A null result means the geocoder was unreachable — leave the column
    // NULL so the backfill can retry, instead of persisting a bogus [].
    if (routeData.coordinates && routeData.coordinates.length >= 2) {
        computeCitiesPassed(routeData.coordinates)
            .then(cities => {
                if (cities === null) {
                    log.scope('cities').error(`geocoder unreachable — journey #${routeData.id} left for backfill`);
                    return;
                }
                return withTenantClient(req.userId, client =>
                    client.query('UPDATE routes SET cities_passed = $1 WHERE id = $2', [JSON.stringify(cities), routeData.id])
                ).then(() => log.scope('cities').debug(`computed for journey #${routeData.id}`));
            })
            .catch(err => log.scope('cities').error('computation failed', err));

        computePlacesPassed(routeData.coordinates)
            .then(places => {
                if (places === null) {
                    log.scope('places').error(`geocoder unreachable — journey #${routeData.id} left for backfill`);
                    return;
                }
                return withTenantClient(req.userId, client =>
                    client.query('UPDATE routes SET places_passed = $1 WHERE id = $2', [JSON.stringify(places), routeData.id])
                ).then(() => log.scope('places').debug(`computed for journey #${routeData.id}`));
            })
            .catch(err => log.scope('places').error('computation failed', err));
    }
}
    fs.createReadStream(filePath)
        .pipe(unzipper.Parse())
        .on('entry', (entry) => {
            if (!entry.path.toLowerCase().endsWith('.csv')) return entry.autodrain();
            entry
                .pipe(csv())
                .on('data', (row) => {
                    const ts = Number(row.ts_ms);
                    const lat = parseFloat(row.lat);
                    const lon = parseFloat(row.lon);
                    const ele = parseFloat(row.ele_m);
                    let sp = parseFloat(row.speed_ms);
                    const isWaypoint = row.waypoint === '1';
                    const note = row.note || '';
                    if (!Number.isFinite(ts) || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
                    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
                    if (isWaypoint) {
                        stats.waypoints.push({
                            id: `wp-${crypto.randomBytes(4).toString('hex')}`,
                            lat: lat,
                            lon: lon,
                            timestamp: ts,
                            note: note,
                            elevation: Number.isFinite(ele) ? ele : null
                        });
                    }
                    if (!stats.firstCoord) stats.firstCoord = [lat, lon];
                    if (stats.last) {
                        const miles = haversine(stats.last.lat, stats.last.lon, lat, lon);
                        const dt = (ts - stats.lastTs) / 1000;
                        if (dt > 0) {
                            const mpsFromTrack = (miles * 1609.344) / dt;
                            // Disabled: the 100 m/s (~224 mph) spike cap was dropping every in-flight point.
                            // if (mpsFromTrack > 100) return;
                            stats.totalMiles += miles;
                            if (!Number.isFinite(sp) || sp <= 0) sp = mpsFromTrack;
                        }
                    } else {
                        stats.firstTs = ts;
                    }
                    if (Number.isFinite(ele)) {
                        stats.topElevation = Math.max(stats.topElevation, ele);
                        stats.lowestElevation = Math.min(stats.lowestElevation, ele);
                        stats.sumElevation += ele;
                        if (Number.isFinite(stats.lastEle)) {
                            const dEle = ele - stats.lastEle;
                            if (dEle > 0.5) stats.elevGainM += dEle;
                            else if (dEle < -0.5) stats.elevLossM += Math.abs(dEle);
                        }
                        stats.lastEle = ele;
                    }
                    if (Number.isFinite(sp) && sp >= 0) {
                        stats.topSpeedMps = Math.max(stats.topSpeedMps, sp);
                        stats.sumSpeedMps += sp;
                        stats.speedSamples += 1;
                    }
                    const mph = Number.isFinite(sp) ? (sp * 2.23694) : 0;
                    stats.profileTimeMs.push(ts);
                    stats.profileDistMi.push(stats.totalMiles);
                    stats.profileElevM.push(Number.isFinite(ele) ? ele : null);
                    stats.profileSpeedMph.push(mph);
                    stats.last = { lat, lon };
                    stats.lastTs = ts;
                    stats.coords.push([lat, lon]);
                    stats.count += 1;
                })
                .on('end', finalize)
                .on('error', (e) => {
                    log.error('CSV parse failed', e);
                    archiveUpload(filePath, req.userId, stats.firstTs);
                    res.status(400).json({ message: "CSV parse error", error: e.message });
                });
        });
});

module.exports = router;
