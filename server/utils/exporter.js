const { pool, ensureTenantSchema, quoteIdent, toApiRoute } = require('../db');

const BATCH = 25;
const FORMAT_VERSION = 1;

// One journey as exported: the API detail shape plus fields the API leaves out.
function exportedJourney(row, waypoints, photos) {
    return {
        ...toApiRoute(row, waypoints, photos),
        citiesPassed: row.cities_passed || [],
        placesPassed: row.places_passed || [],
        forceVisible: row.force_visible === true,
        soundingData: row.sounding_data || null,
    };
}

/**
 * Streams every journey of `userId` to `onJourney(journey)` (awaited, for backpressure),
 * oldest first, reading BATCH journeys at a time through a cursor so memory stays flat.
 * @returns {Promise<number>} journeys exported
 */
async function forEachJourney(userId, onJourney) {
    const schema = await ensureTenantSchema(userId);
    const client = await pool.connect();
    let count = 0;
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
        await client.query('DECLARE journey_export NO SCROLL CURSOR FOR SELECT * FROM routes ORDER BY start_time ASC NULLS LAST, id ASC');
        for (;;) {
            const { rows } = await client.query(`FETCH ${BATCH} FROM journey_export`);
            if (rows.length === 0) break;
            const ids = rows.map((row) => row.id);
            const { rows: waypoints } = await client.query(
                'SELECT * FROM waypoints WHERE route_id = ANY($1) ORDER BY "timestamp" ASC', [ids]
            );
            const { rows: photos } = await client.query(
                'SELECT * FROM photos WHERE route_id = ANY($1) ORDER BY uploaded_at ASC', [ids]
            );
            for (const row of rows) {
                await onJourney(exportedJourney(
                    row,
                    waypoints.filter((wp) => wp.route_id === row.id),
                    photos.filter((ph) => ph.route_id === row.id),
                ));
                count += 1;
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return count;
}

/** Writes to a stream, waiting while its buffer is full. */
function writer(stream) {
    return (chunk) => new Promise((resolve, reject) => {
        if (stream.destroyed) return reject(new Error('export stream closed'));
        if (stream.write(chunk)) return resolve();
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error('export stream closed')); };
        const cleanup = () => {
            stream.off('drain', onDrain);
            stream.off('close', onClose);
        };
        stream.once('drain', onDrain);
        stream.once('close', onClose);
    });
}

/**
 * Newline-delimited JSON: a header line, one line per journey, and an end line with the
 * count (so a truncated file is detectable).
 */
async function writeNdjson(userId, stream, { user } = {}) {
    const write = writer(stream);
    await write(`${JSON.stringify({
        type: 'header',
        format: 'journey-export',
        version: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        user: user || null,
    })}\n`);
    const count = await forEachJourney(userId, (journey) => write(`${JSON.stringify({ type: 'journey', ...journey })}\n`));
    await write(`${JSON.stringify({ type: 'end', journeys: count })}\n`);
    return count;
}

function xml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function alignedTimes(journey) {
    const times = journey.profileTimeMs;
    return Array.isArray(times) && times.length === journey.coordinates.length ? times : null;
}

function toGpx(journey) {
    const times = alignedTimes(journey);
    const elevations = journey.profileElevM?.length === journey.coordinates.length ? journey.profileElevM : null;
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Journey" xmlns="http://www.topografix.com/GPX/1/1">',
        `  <metadata><name>${xml(journey.name)}</name>${journey.startTime ? `<time>${journey.startTime}</time>` : ''}</metadata>`,
    ];
    for (const wp of journey.waypoints || []) {
        lines.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}">${wp.elevation != null ? `<ele>${wp.elevation}</ele>` : ''}`
            + `${wp.timestamp != null ? `<time>${new Date(wp.timestamp).toISOString()}</time>` : ''}`
            + `<name>${xml(wp.label || wp.note || 'Waypoint')}</name></wpt>`);
    }
    lines.push(`  <trk><name>${xml(journey.name)}</name>${journey.travelMode ? `<type>${xml(journey.travelMode)}</type>` : ''}<trkseg>`);
    journey.coordinates.forEach((coord, i) => {
        if (!Array.isArray(coord) || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) return;
        const ele = elevations && Number.isFinite(elevations[i]) ? `<ele>${elevations[i]}</ele>` : '';
        const time = times && Number.isFinite(times[i]) ? `<time>${new Date(times[i]).toISOString()}</time>` : '';
        lines.push(`    <trkpt lat="${coord[0]}" lon="${coord[1]}">${ele}${time}</trkpt>`);
    });
    lines.push('  </trkseg></trk>', '</gpx>', '');
    return lines.join('\n');
}

function toGeoJson(journey) {
    const times = alignedTimes(journey);
    const points = journey.coordinates.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    const { coordinates, profileTimeMs, profileDistMi, profileElevM, profileSpeedMph, waypoints, photos, ...properties } = journey;
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: points.map(([lat, lon]) => [lon, lat]) },
                properties: {
                    ...properties,
                    ...(times ? { coordTimes: times.map((t) => new Date(t).toISOString()) } : {}),
                    elevationsM: profileElevM,
                    speedsMph: profileSpeedMph,
                },
            },
            ...(waypoints || []).map((wp) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [wp.lon, wp.lat] },
                properties: { kind: 'waypoint', label: wp.label || null, note: wp.note || '', timestamp: wp.timestamp, elevation: wp.elevation },
            })),
        ],
    };
}

module.exports = { forEachJourney, writer, writeNdjson, toGpx, toGeoJson, exportedJourney };
