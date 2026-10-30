const express = require('express');
const zlib = require('zlib');
const { pipeline } = require('stream');
const router = express.Router();
const { pool, queryTenant, withTenantClient } = require('../db');
const { forEachJourney, writer, writeNdjson, toGpx, toGeoJson, exportedJourney } = require('../utils/exporter');
const log = require('../utils/logger').scope('export');

function today() {
    return new Date().toISOString().slice(0, 10);
}

// The response body, gzipped when the client accepts it.
function openBody(req, res) {
    res.vary('Accept-Encoding');
    if (!req.acceptsEncodings('gzip')) return res;
    res.set('Content-Encoding', 'gzip');
    const gzip = zlib.createGzip();
    pipeline(gzip, res, () => {});
    return gzip;
}

function failMidStream(res, body, err) {
    log.error('export failed', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Export failed' });
    // Already streaming: cut the connection so the file is visibly incomplete.
    body.destroy(err);
    res.destroy(err);
}

// GET /api/export/journeys — every journey as newline-delimited JSON, streamed
router.get('/journeys', async (req, res) => {
    let body = res;
    try {
        const { rows: [user] } = await pool.query('SELECT username, display_name FROM users WHERE id = $1', [req.userId]);
        res.set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="journey-export-${today()}.ndjson"`,
            'Cache-Control': 'no-store',
        });
        body = openBody(req, res);
        const count = await writeNdjson(req.userId, body, {
            user: user ? { username: user.username, displayName: user.display_name } : null,
        });
        body.end();
        log.info(`exported ${count} journey${count === 1 ? '' : 's'}`);
    } catch (err) {
        failMidStream(res, body, err);
    }
});

async function loadJourney(userId, id) {
    return withTenantClient(userId, async (db) => {
        const { rows: [row] } = await db.query('SELECT * FROM routes WHERE id = $1', [id]);
        if (!row) return null;
        const { rows: waypoints } = await db.query('SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [id]);
        const { rows: photos } = await db.query('SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [id]);
        return exportedJourney(row, waypoints, photos);
    });
}

function fileName(journey, ext) {
    const base = String(journey.name || journey.id).replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'journey';
    return `${base}.${ext}`;
}

// GET /api/export/journeys/:id.gpx | :id.geojson
router.get(/^\/journeys\/([^/]+)\.(gpx|geojson)$/, async (req, res) => {
    try {
        const journey = await loadJourney(req.userId, req.params[0]);
        if (!journey) return res.status(404).json({ error: 'Journey not found' });
        const gpx = req.params[1] === 'gpx';
        res.set({
            'Content-Type': gpx ? 'application/gpx+xml; charset=utf-8' : 'application/geo+json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileName(journey, req.params[1])}"`,
            'Cache-Control': 'no-store',
        });
        res.send(gpx ? toGpx(journey) : JSON.stringify(toGeoJson(journey)));
    } catch (err) {
        log.error('journey export failed', err);
        res.status(500).json({ error: 'Export failed' });
    }
});

// GET /database — the original raw dump (a JSON array of journeys), now streamed so it
// works at any size.
async function legacyDatabaseDump(req, res) {
    let body = res;
    try {
        const { rows: [count] } = await queryTenant(req.userId, 'SELECT COUNT(*)::int AS n FROM routes');
        if (count.n === 0) return res.status(404).json({ error: 'Database file does not exist yet.' });

        res.type('json');
        body = openBody(req, res);
        const write = writer(body);
        let first = true;
        await write('[');
        await forEachJourney(req.userId, (journey) => {
            const { citiesPassed, placesPassed, forceVisible, soundingData, ...route } = journey;
            const chunk = `${first ? '' : ','}${JSON.stringify(route)}`;
            first = false;
            return write(chunk);
        });
        await write(']');
        body.end();
    } catch (err) {
        failMidStream(res, body, err);
    }
}

module.exports = { router, legacyDatabaseDump };
