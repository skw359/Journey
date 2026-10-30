const crypto = require('crypto');
const { pool, withTenantClient, toApiRoute } = require('../db');
const mediaStorage = require('./mediaStorage');
const { cancelMediaJob } = require('./mediaQueue');
const { unreferencedArchives, deleteArchiveFiles } = require('./uploadArchive');
const { insertRoute, insertWaypoints, insertPhotoRow, jsonParam } = require('./routeRecords');
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

class RestoreConflictError extends Error {
    constructor(message) {
        super(message);
        this.status = 409;
    }
}

function deletePhotoFiles(photos) {
    // Videos also have a poster image
    return mediaStorage.removeFiles((photos || []).flatMap((photo) => [photo?.filename, photo?.poster_filename]));
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
        INSERT INTO trashed_journeys (
            id, route_id, name, distance, duration, origin, reason, snapshot, deleted_at,
            archive_names, client_upload_id, content_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11)
    `, [
        trashId,
        route.id || null,
        route.name || null,
        route.distance != null ? Number(route.distance) : null,
        route.duration || null,
        origin || null,
        reason || null,
        jsonParam(snapshot),
        Array.isArray(route.archive_names) && route.archive_names.length ? route.archive_names : null,
        route.client_upload_id || null,
        route.content_fingerprint || null,
    ]);
    return trashId;
}

// Move an existing active journey into Trash. Photo FILES are intentionally kept
// on disk so a restore can re-link them; only the DB rows are removed (cascade).
async function trashExistingRoute(db, routeId, { origin = TRASH_ORIGIN.USER_DELETED, reason = null } = {}) {
    const { rows: routeRows } = await db.query('SELECT * FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
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

function newWaypointId() {
    return `wp-${crypto.randomBytes(8).toString('hex')}`;
}

// Re-insert a trashed journey (in the caller's transaction). force_visible is set so
// sub-threshold journeys reappear. Throws RestoreConflictError if it already exists.
async function restoreTrashedJourney(db, trashId) {
    const { rows } = await db.query('SELECT * FROM trashed_journeys WHERE id = $1 FOR UPDATE', [trashId]);
    if (rows.length === 0) return null;

    const entry = rows[0];
    const snapshot = entry.snapshot || {};
    const route = snapshot.route || {};

    try {
        const inserted = await insertRoute(db, {
            ...route,
            archive_names: entry.archive_names || route.archive_names || null,
            client_upload_id: entry.client_upload_id || route.client_upload_id || null,
            content_fingerprint: entry.content_fingerprint || route.content_fingerprint || null,
            force_visible: true,
        }, { ifAbsent: true });
        if (!inserted) {
            throw new RestoreConflictError('A journey with the same id already exists, so this one was left in Recently Deleted');
        }

        await insertWaypoints(db, route.id, snapshot.waypoints || [], newWaypointId);
        for (const ph of snapshot.photos || []) {
            await insertPhotoRow(db, route.id, ph);
        }
    } catch (err) {
        if (err.code === '23505') {
            throw new RestoreConflictError('This journey (or one of its photos) is already in your journeys, so it was left in Recently Deleted');
        }
        throw err;
    }

    const processingMedia = (snapshot.photos || [])
        .filter((ph) => ph.status === 'processing')
        .map((ph) => ({ id: ph.id, filename: ph.filename, mimetype: ph.mimetype }));

    await db.query('DELETE FROM trashed_journeys WHERE id = $1', [trashId]);
    // The caller re-queues processingMedia once this transaction commits.
    return { routeId: route.id, name: route.name, processingMedia };
}

// Deletes combine backups of `routeIds`, including nested ones.
async function deleteCombineBackups(db, routeIds) {
    let pending = [...new Set(routeIds.filter(Boolean))];
    const seen = new Set(pending);
    let deleted = 0;
    while (pending.length > 0) {
        const { rows } = await db.query(
            'DELETE FROM journey_backups WHERE combined_journey_id = ANY($1) RETURNING source_journeys',
            [pending]
        );
        deleted += rows.length;
        const next = [];
        for (const row of rows) {
            for (const source of row.source_journeys || []) {
                const id = source?.route?.id;
                if (id && !seen.has(id)) {
                    seen.add(id);
                    next.push(id);
                }
            }
        }
        pending = next;
    }
    return deleted;
}

// Hard delete: rows and combine backups in one transaction, then media and archive files.
async function hardDeleteTrash(db, where, params) {
    let removed = [];
    let archives = [];
    await db.query('BEGIN');
    try {
        const { rows } = await db.query(
            `DELETE FROM trashed_journeys WHERE ${where} RETURNING id, route_id, snapshot, archive_names`,
            params
        );
        removed = rows;
        if (rows.length > 0) {
            await deleteCombineBackups(db, rows.map((row) => row.route_id || row.snapshot?.route?.id));
            const names = rows.flatMap((row) => row.archive_names || row.snapshot?.route?.archive_names || []);
            archives = await unreferencedArchives(db, names);
        }
        await db.query('COMMIT');
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    }

    for (const row of removed) {
        await deletePhotoFiles(row.snapshot && row.snapshot.photos);
    }
    await deleteArchiveFiles(archives);
    return removed.length;
}

// Permanently remove a single trashed journey (and its photo files).
async function permanentlyDeleteTrash(db, trashId) {
    return (await hardDeleteTrash(db, 'id = $1', [trashId])) > 0;
}

// Permanently remove every trashed journey for the current tenant.
async function emptyTrash(db) {
    return hardDeleteTrash(db, 'TRUE', []);
}

// Purge trashed journeys older than the retention window for the current tenant.
async function purgeExpiredTrash(db) {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    return hardDeleteTrash(db, 'deleted_at < $1', [cutoff]);
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
    RestoreConflictError,
    insertTrashSnapshot,
    trashExistingRoute,
    restoreTrashedJourney,
    deleteCombineBackups,
    permanentlyDeleteTrash,
    emptyTrash,
    purgeExpiredTrash,
    listTrash,
    getTrashDetail,
    sweepAllTrash,
};
