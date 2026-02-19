const express = require('express');
const router = express.Router();
const fs = require('fs');
const crypto = require('crypto');
const unzipper = require('unzipper');
const csv = require('csv-parser');
const { withTenantClient } = require('../db');
const { upload } = require('../middleware/storage');
const { haversine, detectTravelMode } = require('../utils/geo');
const { formatDuration } = require('../utils/format');
const { MIN_ROUTE_MILES } = require('../config');

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
    fs.unlinkSync(filePath);

    if (stats.count < 2 || stats.totalMiles <= 0) {
        console.log(`[Journey Rejected] Not enough data points. (Count: ${stats.count}, Miles: ${stats.totalMiles})`);
        return res.status(200).json({
            accepted: true,
            saved: false,
            reason: "insufficient_data",
            message: "Journey accepted but not saved - insufficient data points"
        });
    }

    if (stats.totalMiles < MIN_ROUTE_MILES) {
        console.log(`[Journey Rejected] Too short. Distance: ${stats.totalMiles.toFixed(2)}mi (Threshold: ${MIN_ROUTE_MILES}mi)`);
        return res.status(200).json({
            accepted: true,
            saved: false,
            reason: "short_distance",
            totalMiles: Number(stats.totalMiles.toFixed(2)),
            thresholdMiles: MIN_ROUTE_MILES,
            message: "Journey accepted but not saved - distance below threshold"
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
        console.error('[Journey Upload DB Error]', err);
        return res.status(500).json({ error: 'Failed to save journey to database' });
    }

    console.log(`[Journey Uploaded] ID: ${routeData.id} | Name: ${routeData.name} | Dist: ${routeData.distance}mi`);

    res.status(201).json({
        accepted: true,
        saved: true,
        ...routeData
    });
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
                            if (mpsFromTrack > 100) return;
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
                    console.error(`[Journey Error] CSV Parse Failed: ${e.message}`);
                    fs.unlinkSync(filePath);
                    res.status(400).json({ message: "CSV parse error", error: e.message });
                });
        });
});

module.exports = router;
