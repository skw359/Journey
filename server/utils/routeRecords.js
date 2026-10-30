// Shared journey row inserts (upload, flight import, restore, undo-combine).

const JSON_COLUMNS = new Set([
    'coordinates', 'profile_time_ms', 'profile_dist_mi', 'profile_elev_m', 'profile_speed_mph',
    'sounding_data', 'cities_passed', 'places_passed',
]);

const ROUTE_COLUMNS = [
    'id', 'name', 'date', 'distance', 'duration', 'top_speed', 'avg_speed',
    'top_elevation', 'lowest_elevation', 'avg_elevation',
    'start_time', 'end_time', 'coordinates',
    'elevation_gain', 'elevation_loss',
    'start_lat', 'start_lon', 'end_lat', 'end_lon',
    'source', 'watch_recorded',
    'profile_time_ms', 'profile_dist_mi', 'profile_elev_m', 'profile_speed_mph',
    'travel_mode',
    'weather_temp', 'weather_feels_like', 'weather_humidity', 'weather_wind_speed', 'weather_wind_dir',
    'weather_condition', 'weather_description', 'weather_icon',
    'weather_city', 'weather_lat', 'weather_lon',
    'sounding_data', 'cities_passed', 'places_passed',
    'force_visible', 'archive_names', 'client_upload_id', 'content_fingerprint',
];

// node-postgres needs JSON columns serialized; snapshots round-trip as parsed JS.
function jsonParam(value) {
    if (value == null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function columnValue(column, value) {
    if (column === 'force_visible') return value === true;
    if (value === undefined) return null;
    if (JSON_COLUMNS.has(column)) return jsonParam(value);
    if (column === 'archive_names') return Array.isArray(value) && value.length ? value : null;
    return value;
}

/** `route` holds snake_case columns. With ifAbsent, returns false when the id is taken. */
async function insertRoute(db, route, { ifAbsent = false } = {}) {
    const values = ROUTE_COLUMNS.map((column) => columnValue(column, route[column]));
    const placeholders = ROUTE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    const { rowCount } = await db.query(
        `INSERT INTO routes (${ROUTE_COLUMNS.join(', ')}) VALUES (${placeholders})${ifAbsent ? ' ON CONFLICT (id) DO NOTHING' : ''}`,
        values
    );
    return rowCount === 1;
}

// A colliding waypoint id (old ids were 32-bit) gets a fresh one.
async function insertWaypoints(db, routeId, waypoints, newId) {
    for (const wp of waypoints || []) {
        const params = [routeId, wp.lat, wp.lon, wp.elevation ?? null, wp.timestamp ?? null, wp.note ?? null, wp.label || null];
        const { rowCount } = await db.query(`
            INSERT INTO waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
        `, [wp.id, ...params]);
        if (rowCount === 0) {
            await db.query(`
                INSERT INTO waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [newId(), ...params]);
        }
    }
}

async function insertPhotoRow(db, routeId, ph) {
    await db.query(`
        INSERT INTO photos (
            id, route_id, filename, original_name, mimetype, size, uploaded_at,
            poster_filename, duration_ms, width, height, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
        ph.id, routeId, ph.filename, ph.original_name, ph.mimetype, ph.size, ph.uploaded_at,
        ph.poster_filename ?? null, ph.duration_ms ?? null, ph.width ?? null, ph.height ?? null, ph.status ?? null,
    ]);
}

module.exports = { ROUTE_COLUMNS, jsonParam, insertRoute, insertWaypoints, insertPhotoRow };
