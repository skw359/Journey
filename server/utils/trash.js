const crypto = require('crypto');
const { pool, withTenantClient, toApiRoute } = require('../db');
const mediaStorage = require('./mediaStorage');
const { cancelMediaJob } = require('./mediaQueue');
const log = require('../utils/logger').scope('trash');

// Journeys live in Trash for this long before they are permanently purged.
const TRASH_RETENTION_DAYS = 7;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Origins explain why a journey ended up in Trash.
const TRASH_ORIGIN = {
    USER_DELETED: 'user_deleted',
    REJECTED_SHORT: 'rejected_short',
    REJECTED_INSUFFICIENT: 'rejected_insufficient',
};

function deletePhotoFiles(photos) {
    // Videos also have a poster image
    return mediaStorage.removeFiles((photos || []).flatMap((photo) => [photo?.filename, photo?.poster_filename]));
}

// node-postgres needs JSON columns serialized; snapshots round-trip as parsed JS.
function jsonParam(value) {
    if (value == null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function expiresAtFrom(deletedAt) {
    if (!deletedAt) return null;
    const ms = (deletedAt instanceof Date ? deletedAt.getTime() : new Date(deletedAt).getTime());
    return Number.isFinite(ms) ? new Date(ms + TRASH_RETENTION_MS) : null;
}

function toTrashSummary(row) {
    const deletedAt = row.deleted_at ? new Date(row.deleted_at) : null;
    const expiresAt = expiresAtFrom(deletedAt);
    return {
        id: row.id,
        routeId: row.route_id,
        name: row.name,
        distance: row.distance != null ? Number(row.distance).toFixed(2) : null,
        duration: row.duration || '0h 0m',
        origin: row.origin,
        reason: row.reason,
        travelMode: row.travel_mode || null,
        startTime: row.start_time || null,
        citiesPassed: row.cities_passed || [],
        deletedAt: deletedAt ? deletedAt.toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
}

// Build the API-shaped detail object for a trashed journey so the frontend can
// render it with the exact same components used for active journeys.
function snapshotToDetail(snapshot, summaryRow) {
    const route = { ...(snapshot.route || {}) };
    // JSONB stores Date columns as ISO strings; toApiRoute expects Date objects.
    route.start_time = route.start_time ? new Date(route.start_time) : null;
    route.end_time = route.end_time ? new Date(route.end_time) : null;

    const waypoints = snapshot.waypoints || [];
    const photos = (snapshot.photos || []).map((photo) => ({
        ...photo,
        uploaded_at: photo.uploaded_at ? new Date(photo.uploaded_at) : null,
    }));

    const detail = toApiRoute(route, waypoints, photos);
    // The frontend keys selection on the trash id, not the original route id.
    detail.routeId = route.id;
    detail.id = summaryRow.id;
    detail.totalPoints = Array.isArray(detail.coordinates) ? detail.coordinates.length : 0;
    detail.isFullResolution = true;
    const deletedAt = summaryRow.deleted_at ? new Date(summaryRow.deleted_at) : null;
    const expiresAt = expiresAtFrom(deletedAt);
    detail.trash = {
        origin: summaryRow.origin,
        reason: summaryRow.reason,
        deletedAt: deletedAt ? deletedAt.toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
    return detail;
}

// Insert a snapshot ({ route, waypoints, photos }) directly into Trash.
async function insertTrashSnapshot(db, { snapshot, origin, reason }) {
    const trashId = `trash-${crypto.randomBytes(8).toString('hex')}`;
    const route = snapshot.route || {};
    await db.query(`
        INSERT INTO trashed_journeys (id, route_id, name, distance, duration, origin, reason, snapshot, deleted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
        trashId,
        route.id || null,
        route.name || null,
        route.distance != null ? Number(route.distance) : null,
        route.duration || null,
        origin || null,
        reason || null,
        jsonParam(snapshot),
    ]);
    return trashId;
}

// Move an existing active journey into Trash. Photo FILES are intentionally kept
// on disk so a restore can re-link them; only the DB rows are removed (cascade).
async function trashExistingRoute(db, routeId, { origin = TRASH_ORIGIN.USER_DELETED, reason = null } = {}) {
    const { rows: routeRows } = await db.query('SELECT * FROM routes WHERE id = $1', [routeId]);
    if (routeRows.length === 0) return null;
    const route = routeRows[0];

    const { rows: waypoints } = await db.query(
        'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC', [routeId]
    );
    const { rows: photos } = await db.query(
        'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC', [routeId]
    );

    // Pause its conversions; the originals stay so a restore can resume them.
    for (const photo of photos) {
        if (photo.status === 'processing') cancelMediaJob(photo.id);
    }

    const snapshot = { route, waypoints, photos };
    const trashId = await insertTrashSnapshot(db, { snapshot, origin, reason });
    await db.query('DELETE FROM routes WHERE id = $1', [routeId]);
    return { trashId, routeId, name: route.name };
}

// Re-insert a trashed journey into the active routes table. force_visible is set
// so sub-threshold journeys (e.g. backend-rejected ones) reappear in the list.
async function restoreTrashedJourney(db, trashId) {
    const { rows } = await db.query('SELECT * FROM trashed_journeys WHERE id = $1', [trashId]);
    if (rows.length === 0) return null;

    const snapshot = rows[0].snapshot || {};
    const route = snapshot.route || {};

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
            sounding_data, cities_passed, places_passed,
            force_visible
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
            $35, $36, $37,
            $38
        )
        ON CONFLICT (id) DO NOTHING
    `, [
        route.id, route.name, route.date, route.distance, route.duration, route.top_speed, route.avg_speed,
        route.top_elevation, route.lowest_elevation, route.avg_elevation,
        route.start_time, route.end_time, jsonParam(route.coordinates),
        route.elevation_gain, route.elevation_loss,
        route.start_lat, route.start_lon, route.end_lat, route.end_lon,
        route.source, route.watch_recorded,
        jsonParam(route.profile_time_ms), jsonParam(route.profile_dist_mi),
        jsonParam(route.profile_elev_m), jsonParam(route.profile_speed_mph),
        route.travel_mode,
        route.weather_temp, route.weather_feels_like, route.weather_humidity, route.weather_wind_speed,
        route.weather_wind_dir ?? null,
        route.weather_condition, route.weather_description, route.weather_icon,
        jsonParam(route.sounding_data), jsonParam(route.cities_passed), jsonParam(route.places_passed),
        true,
    ]);

    for (const wp of (snapshot.waypoints || [])) {
        await db.query(`
            INSERT INTO waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
        `, [wp.id, route.id, wp.lat, wp.lon, wp.elevation, wp.timestamp, wp.note, wp.label || null]);
    }

    const processingMedia = [];
    for (const ph of (snapshot.photos || [])) {
        await db.query(`
            INSERT INTO photos (
                id, route_id, filename, original_name, mimetype, size, uploaded_at,
                poster_filename, duration_ms, width, height, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO NOTHING
        `, [
            ph.id, route.id, ph.filename, ph.original_name, ph.mimetype, ph.size, ph.uploaded_at,
            ph.poster_filename ?? null, ph.duration_ms ?? null, ph.width ?? null, ph.height ?? null, ph.status ?? null,
        ]);
        if (ph.status === 'processing') {
            processingMedia.push({ id: ph.id, filename: ph.filename, mimetype: ph.mimetype });
        }
    }

    await db.query('DELETE FROM trashed_journeys WHERE id = $1', [trashId]);
    // The caller re-queues processingMedia once this transaction commits.
    return { routeId: route.id, name: route.name, processingMedia };
}

// Permanently remove a single trashed journey (and its photo files).
async function permanentlyDeleteTrash(db, trashId) {
    const { rows } = await db.query('SELECT snapshot FROM trashed_journeys WHERE id = $1', [trashId]);
    if (rows.length === 0) return false;
    await deletePhotoFiles(rows[0].snapshot && rows[0].snapshot.photos);
    await db.query('DELETE FROM trashed_journeys WHERE id = $1', [trashId]);
    return true;
}

// Permanently remove every trashed journey for the current tenant.
async function emptyTrash(db) {
    const { rows } = await db.query('SELECT snapshot FROM trashed_journeys');
    for (const row of rows) {
        await deletePhotoFiles(row.snapshot && row.snapshot.photos);
    }
    const { rowCount } = await db.query('DELETE FROM trashed_journeys');
    return rowCount;
}

// Purge trashed journeys older than the retention window for the current tenant.
async function purgeExpiredTrash(db) {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    const { rows } = await db.query(
        'SELECT id, snapshot FROM trashed_journeys WHERE deleted_at < $1', [cutoff]
    );
    if (rows.length === 0) return 0;
    for (const row of rows) {
        await deletePhotoFiles(row.snapshot && row.snapshot.photos);
    }
    await db.query('DELETE FROM trashed_journeys WHERE deleted_at < $1', [cutoff]);
    return rows.length;
}

// List Trash summaries for the current tenant (lightweight — does not load snapshots).
async function listTrash(db) {
    const { rows } = await db.query(`
        SELECT id, route_id, name, distance, duration, origin, reason, deleted_at,
               snapshot->'route'->>'travel_mode' AS travel_mode,
               snapshot->'route'->>'start_time' AS start_time,
               snapshot->'route'->'cities_passed' AS cities_passed
        FROM trashed_journeys
        ORDER BY deleted_at DESC
    `);
    return rows.map(toTrashSummary);
}

// Load the full API-shaped detail for a single trashed journey.
async function getTrashDetail(db, trashId) {
    const { rows } = await db.query(
        'SELECT id, origin, reason, deleted_at, snapshot FROM trashed_journeys WHERE id = $1',
        [trashId]
    );
    if (rows.length === 0) return null;
    return snapshotToDetail(rows[0].snapshot || {}, rows[0]);
}

// Purge expired trash across all users — used by the startup + interval sweeper.
async function sweepAllTrash() {
    const { rows: users } = await pool.query('SELECT id FROM users');
    let total = 0;
    for (const user of users) {
        try {
            total += await withTenantClient(user.id, (db) => purgeExpiredTrash(db));
        } catch (err) {
            log.error(`sweep failed for user ${user.id}`, err);
        }
    }
    return total;
}

module.exports = {
    TRASH_RETENTION_DAYS,
    TRASH_RETENTION_MS,
    TRASH_ORIGIN,
    insertTrashSnapshot,
    trashExistingRoute,
    restoreTrashedJourney,
    permanentlyDeleteTrash,
    emptyTrash,
    purgeExpiredTrash,
    listTrash,
    getTrashDetail,
    sweepAllTrash,
};
