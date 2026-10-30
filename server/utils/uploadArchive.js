const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, MAX_JOURNEY_CSV_MB, MAX_JOURNEY_ROWS } = require('../config');
const log = require('./logger').scope('archive');

// Original upload zips, kept for re-processing. Each belongs to its journey
// (routes/trashed_journeys.archive_names) and is deleted when that is hard-deleted.
const ARCHIVE_DIR = path.join(UPLOADS_DIR, 'archive');

function userArchiveDirName(userId) {
    return String(userId || 'unscoped').replace(/[^\w-]/g, '_');
}

// "<user dir>/<file>.zip" -> absolute path, or null if outside ARCHIVE_DIR.
function archivePath(name) {
    if (typeof name !== 'string' || !name) return null;
    const root = path.resolve(ARCHIVE_DIR);
    const full = path.resolve(root, name);
    return full.startsWith(root + path.sep) ? full : null;
}

function stampFor(ms) {
    return new Date(ms != null ? ms : Date.now()).toISOString().replace(/[:.]/g, '-');
}

// Returns the stored name, or null (and deletes the file) if it couldn't be archived.
async function archiveUpload(filePath, userId, firstTs) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const dirName = userArchiveDirName(userId);
    const name = `${dirName}/${stampFor(firstTs)}_${path.basename(filePath)}.zip`;
    try {
        await fs.promises.mkdir(path.join(ARCHIVE_DIR, dirName), { recursive: true });
        await fs.promises.rename(filePath, archivePath(name));
        return name;
    } catch (err) {
        log.error(`could not archive upload ${path.basename(filePath)}; discarding it`, err);
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        return null;
    }
}

// Archives in `names` no journey or Trash entry refers to. Run in the deleting
// transaction; delete the files after it commits.
async function unreferencedArchives(db, names) {
    const unique = [...new Set((names || []).filter((name) => typeof name === 'string' && name))];
    if (unique.length === 0) return [];
    const { rows } = await db.query(`
        SELECT n.name FROM unnest($1::text[]) AS n(name)
        WHERE NOT EXISTS (SELECT 1 FROM routes r WHERE n.name = ANY(r.archive_names))
          AND NOT EXISTS (SELECT 1 FROM trashed_journeys t WHERE n.name = ANY(t.archive_names))
    `, [unique]);
    return rows.map((row) => row.name);
}

async function deleteArchiveFiles(names) {
    let deleted = 0;
    for (const name of names || []) {
        const full = archivePath(name);
        if (!full) continue;
        try {
            await fs.promises.unlink(full);
            deleted += 1;
        } catch (err) {
            if (err.code !== 'ENOENT') log.warn(`could not delete ${name}: ${err.message}`);
        }
    }
    return deleted;
}

async function removeUserArchives(userId) {
    const dir = path.join(ARCHIVE_DIR, userArchiveDirName(userId));
    await fs.promises.rm(dir, { recursive: true, force: true });
}

async function listUserArchives(userId) {
    const dirName = userArchiveDirName(userId);
    try {
        const entries = await fs.promises.readdir(path.join(ARCHIVE_DIR, dirName), { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => `${dirName}/${entry.name}`);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

// "<stamp>_<upload name>.zip" -> recording start in ms.
function archiveStartMs(name) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(path.posix.basename(name));
    if (!match) return null;
    const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    return Number.isFinite(ms) ? ms : null;
}

// Links pre-existing archives to journeys/Trash entries by recording start. Never deletes.
async function linkExistingArchives(db, userId) {
    const files = await listUserArchives(userId);
    if (files.length === 0) return 0;
    const byStart = new Map();
    for (const name of files) {
        const startMs = archiveStartMs(name);
        if (startMs == null) continue;
        if (!byStart.has(startMs)) byStart.set(startMs, []);
        byStart.get(startMs).push(name);
    }
    const namesFor = (startTime) => {
        const ms = startTime ? new Date(startTime).getTime() : NaN;
        return Number.isFinite(ms) ? byStart.get(ms) || [] : [];
    };

    let linked = 0;
    const { rows: routes } = await db.query('SELECT id, start_time FROM routes WHERE archive_names IS NULL');
    const routeNames = new Map();
    for (const route of routes) routeNames.set(route.id, [...namesFor(route.start_time)]);

    // Combined sources' archives belong to the combined journey.
    const { rows: backups } = await db.query('SELECT combined_journey_id, source_journeys FROM journey_backups');
    for (const backup of backups) {
        if (!routeNames.has(backup.combined_journey_id)) continue;
        for (const entry of backup.source_journeys || []) {
            routeNames.get(backup.combined_journey_id).push(...namesFor(entry?.route?.start_time));
        }
    }

    for (const [id, names] of routeNames) {
        const unique = [...new Set(names)];
        if (unique.length === 0) continue;
        await db.query('UPDATE routes SET archive_names = $2 WHERE id = $1 AND archive_names IS NULL', [id, unique]);
        linked += unique.length;
    }

    const { rows: trashed } = await db.query(
        "SELECT id, snapshot->'route'->>'start_time' AS start_time FROM trashed_journeys WHERE archive_names IS NULL"
    );
    for (const entry of trashed) {
        const names = namesFor(entry.start_time);
        if (names.length === 0) continue;
        await db.query('UPDATE trashed_journeys SET archive_names = $2 WHERE id = $1 AND archive_names IS NULL', [entry.id, names]);
        linked += names.length;
    }
    return linked;
}

// Runs linkExistingArchives once per account (recorded in schema_migrations).
async function linkAllArchivesOnce() {
    const { pool, runOnce, tenantSchemaForUser, quoteIdent } = require('../db');
    const { rows: users } = await pool.query('SELECT id FROM users');
    let linked = 0;
    for (const user of users) {
        const schema = tenantSchemaForUser(user.id);
        await runOnce(schema, 'archive-links-v1', async (db) => {
            await db.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
            linked += await linkExistingArchives(db, user.id);
        });
    }
    return linked;
}

// Kept although nothing refers to them: archives whose recording overlaps a journey, Trash entry
// or combined source (linking by start time misses journeys whose first points were dropped),
// archives under a day old (an upload may still be linking one), and unreadable ones.
const PRUNE_MARGIN_MS = 60 * 60 * 1000;
const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

async function findOrphanArchives({ now = Date.now() } = {}) {
    const { pool, withTenantClient } = require('../db');
    const { parseJourneyUpload } = require('./journeyIngest');
    const limits = { maxCsvBytes: MAX_JOURNEY_CSV_MB * 1024 * 1024, maxRows: MAX_JOURNEY_ROWS, timeoutMs: 5 * 60 * 1000 };
    const { rows: users } = await pool.query('SELECT id, username FROM users');
    const owners = new Map(users.map((user) => [userArchiveDirName(user.id), user]));
    const dirs = fs.existsSync(ARCHIVE_DIR)
        ? fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];

    const accounts = [];
    for (const dir of dirs) {
        const owner = owners.get(dir) || null;
        const files = await listUserArchives(dir);
        let candidates = files;
        let spans = [];
        if (owner) {
            await withTenantClient(owner.id, async (db) => {
                candidates = await unreferencedArchives(db, files);
                const { rows } = await db.query(`
                    SELECT start_time AS s, end_time AS e FROM routes
                    UNION ALL
                    SELECT (snapshot->'route'->>'start_time')::timestamptz, (snapshot->'route'->>'end_time')::timestamptz
                    FROM trashed_journeys
                    UNION ALL
                    SELECT (src->'route'->>'start_time')::timestamptz, (src->'route'->>'end_time')::timestamptz
                    FROM journey_backups, jsonb_array_elements(source_journeys) AS src
                `);
                spans = rows.filter((span) => span.s);
            });
        }
        const account = { dir, owner, total: files.length, unreferenced: candidates.length, overlapping: 0, recent: 0, unreadable: 0, orphans: [], bytes: 0 };
        for (const name of candidates) {
            const stat = await fs.promises.stat(archivePath(name));
            if (now - stat.mtimeMs < PRUNE_MIN_AGE_MS) {
                account.recent += 1;
                continue;
            }
            if (owner) {
                let stats;
                try {
                    ({ stats } = await parseJourneyUpload(archivePath(name), limits));
                } catch {
                    account.unreadable += 1;
                    continue;
                }
                const overlaps = stats.count > 0 && spans.some(({ s, e }) =>
                    s.getTime() - PRUNE_MARGIN_MS <= stats.lastTs && (e || s).getTime() + PRUNE_MARGIN_MS >= stats.firstTs);
                if (overlaps) {
                    account.overlapping += 1;
                    continue;
                }
            }
            account.orphans.push(name);
            account.bytes += stat.size;
        }
        accounts.push(account);
    }
    return accounts;
}

module.exports = {
    ARCHIVE_DIR,
    userArchiveDirName,
    archivePath,
    archiveUpload,
    unreferencedArchives,
    deleteArchiveFiles,
    removeUserArchives,
    listUserArchives,
    archiveStartMs,
    linkExistingArchives,
    linkAllArchivesOnce,
    findOrphanArchives,
};
