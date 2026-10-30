const fs = require('fs');
const path = require('path');
const { pool, quoteIdent, tenantSchemaForUser, forgetTenantSchema } = require('../db');
const { AVATARS_DIR } = require('../config');
const mediaStorage = require('./mediaStorage');
const { cancelMediaJobsForUser } = require('./mediaQueue');
const { stopGeoBackfillsForUser } = require('./geoBackfill');
const { removeUserArchives } = require('./uploadArchive');
const log = require('./logger').scope('accounts');

function resolvePathWithin(baseDir, relativePath) {
    const root = path.resolve(baseDir);
    const fullPath = path.resolve(path.join(baseDir, relativePath));
    if (fullPath === root || fullPath.startsWith(`${root}${path.sep}`)) {
        return fullPath;
    }
    return null;
}

function removeAvatarFile(avatarFilename) {
    if (!avatarFilename) return;
    const avatarPath = resolvePathWithin(AVATARS_DIR, path.basename(avatarFilename));
    try {
        if (avatarPath && fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
    } catch (err) {
        log.warn(`could not delete avatar ${avatarFilename}: ${err.message}`);
    }
}

/**
 * Deletes an account and everything it owns (schema, sessions, tokens, avatar, media, archives).
 * @param {object} [options]
 * @param {(user: object) => Promise<boolean>} [options.verify] - e.g. a password check
 * @returns {Promise<{status: 'deleted'|'not_found'|'unverified'|'last_admin', isSetup?: boolean}>}
 */
async function deleteAccount(userId, { verify } = {}) {
    const tenantSchema = tenantSchemaForUser(userId);
    let avatarFilename = null;
    let photoFilenames = [];
    let isSetup = true;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 0');
        // Lock admins so concurrent removals can't leave none.
        await client.query('SELECT id FROM users WHERE is_admin FOR UPDATE');
        const { rows: users } = await client.query(
            'SELECT id, password_hash, avatar_filename, is_admin FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );
        if (users.length === 0) {
            await client.query('ROLLBACK');
            return { status: 'not_found' };
        }
        const account = users[0];
        if (verify && !(await verify(account))) {
            await client.query('ROLLBACK');
            return { status: 'unverified' };
        }
        if (account.is_admin) {
            const { rows: [counts] } = await client.query(
                `SELECT COUNT(*) FILTER (WHERE id <> $1)::int AS others,
                        COUNT(*) FILTER (WHERE id <> $1 AND is_admin)::int AS admins
                 FROM users`,
                [userId]
            );
            if (counts.others > 0 && counts.admins === 0) {
                await client.query('ROLLBACK');
                return { status: 'last_admin' };
            }
        }

        avatarFilename = account.avatar_filename || null;
        const { rows: schemaRows } = await client.query(
            'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists',
            [tenantSchema]
        );
        if (schemaRows[0]?.exists === true) {
            const q = quoteIdent(tenantSchema);
            const { rows: photos } = await client.query(`
                SELECT filename, poster_filename FROM ${q}.photos
                UNION ALL
                SELECT p->>'filename', p->>'poster_filename'
                FROM ${q}.trashed_journeys t, jsonb_array_elements(COALESCE(t.snapshot->'photos', '[]'::jsonb)) p
            `);
            photoFilenames = photos.flatMap((photo) => [photo.filename, photo.poster_filename]).filter(Boolean);
            await client.query(`DROP SCHEMA ${q} CASCADE`);
        }
        await client.query('DELETE FROM schema_migrations WHERE scope = $1', [tenantSchema]);
        await client.query("DELETE FROM session WHERE sess->>'userId' = $1", [userId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);

        const { rows: remainingUsers } = await client.query('SELECT COUNT(*)::int AS count FROM users');
        isSetup = Number(remainingUsers[0]?.count || 0) > 0;

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    forgetTenantSchema(userId);
    cancelMediaJobsForUser(userId);
    stopGeoBackfillsForUser(userId);
    removeAvatarFile(avatarFilename);
    await mediaStorage.removeFiles(photoFilenames, { dirs: [userId] });
    await removeUserArchives(userId).catch((err) => log.warn(`could not delete upload archives: ${err.message}`));
    require('./funStatsCache').forgetUser(userId);
    require('./journeyDerived').forgetUser(userId);
    return { status: 'deleted', isSetup };
}

module.exports = { deleteAccount, removeAvatarFile, resolvePathWithin };
