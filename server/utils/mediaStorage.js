const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../db');
const { PHOTOS_DIR } = require('../config');
const { listExternalDrives } = require('./drives');
const { deleteThumbnail } = require('./photoThumbs');
const { formatBytes } = require('./format');
const log = require('./logger').scope('storage');

// Photos and videos live in one chosen location: this PC (PHOTOS_DIR) or a "journey" folder on
// an external drive. Every location uses the same layout, so a stored name like
// "user-1/abc.jpg" is valid in all of them. Reads try the chosen location first, then the
// other places files can still be: this PC (new uploads land there while the drive is
// unplugged) and earlier locations that haven't been emptied yet.
const CONFIG_KEY = 'media_storage';
const DRIVE_FOLDER = 'journey';
const MARKER_FILE = '.journey-storage.json';
const WATCH_INTERVAL_MS = 30_000;
const INVENTORY_TTL_MS = 15_000;
const SPACE_MARGIN_BYTES = 1024 ** 3;
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const INTERNAL = Object.freeze({ kind: 'internal' });
const IS_WINDOWS = process.platform === 'win32';

class StorageError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

let settings = { location: INTERNAL, fallbacks: [], paused: false };
// Reachable drive locations (key -> folder). lastDirs remembers where each drive was, so
// paths written there still map back to stored names after it disappears.
const onlineDirs = new Map();
const lastDirs = new Map();
const busyPaths = new Map();
const listeners = new Set();
let watchTimer = null;
let refreshing = null;
let inventoryCache = null;

const keyOf = (loc) => (loc.kind === 'drive' ? `drive:${loc.id}` : 'internal');
const sameLocation = (a, b) => keyOf(a) === keyOf(b);
const comparable = (p) => (IS_WINDOWS ? path.resolve(p).toLowerCase() : path.resolve(p));
const sameDir = (a, b) => comparable(a) === comparable(b);

function isInside(root, fullPath) {
    const base = comparable(root);
    return comparable(fullPath).startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

function joinInside(root, name) {
    if (!root || !name || typeof name !== 'string') return null;
    const full = path.resolve(root, name);
    return isInside(root, full) ? full : null;
}

function rootOf(loc) {
    return loc.kind === 'internal' ? PHOTOS_DIR : onlineDirs.get(keyOf(loc)) || null;
}

function driveLocations() {
    return [settings.location, ...settings.fallbacks].filter((loc) => loc.kind === 'drive');
}

function uniqueLocations(locations) {
    const seen = new Set();
    return locations.filter((loc) => !seen.has(keyOf(loc)) && seen.add(keyOf(loc)));
}

function labelOf(loc) {
    if (loc.kind === 'internal') return 'This PC';
    return loc.letter ? `${loc.label} (${loc.letter}:)` : loc.label;
}

function describe(loc) {
    if (loc.kind === 'internal') {
        return { kind: 'internal', label: 'This PC', name: 'This PC', path: PHOTOS_DIR, online: true };
    }
    const dir = onlineDirs.get(keyOf(loc));
    return {
        kind: 'drive',
        label: loc.label,
        name: labelOf(loc),
        letter: loc.letter || null,
        volumeId: loc.volumeId || null,
        path: dir || (loc.letter ? `${loc.letter}:\\${DRIVE_FOLDER}` : null),
        online: Boolean(dir),
    };
}

// The chosen location's folder, or null while its drive is unplugged.
function locationRoot() {
    return rootOf(settings.location);
}

// Where new files go: the chosen location, or this PC while its drive is unplugged.
function writeRoot() {
    return locationRoot() || PHOTOS_DIR;
}

function readRoots() {
    const roots = [];
    for (const dir of [locationRoot(), PHOTOS_DIR, ...settings.fallbacks.map(rootOf)]) {
        if (dir && !roots.some((root) => sameDir(root, dir))) roots.push(dir);
    }
    return roots;
}

// Online places other than the chosen location that may still hold files to move.
function sourceLocations() {
    return [INTERNAL, ...settings.fallbacks]
        .filter((loc) => !sameLocation(loc, settings.location))
        .map((loc) => ({ loc, root: rootOf(loc) }))
        .filter(({ root }) => root && !(locationRoot() && sameDir(root, locationRoot())));
}

function offlineLocations() {
    return driveLocations().filter((loc) => !onlineDirs.has(keyOf(loc)));
}

function hasOfflineLocations() {
    return offlineLocations().length > 0;
}

// Absolute path of a stored media name in whichever location has it, or null.
function find(name) {
    for (const root of readRoots()) {
        const full = joinInside(root, name);
        if (full && fs.existsSync(full)) return full;
    }
    return null;
}

function toStoredName(absPath) {
    const root = [...readRoots(), ...lastDirs.values()].find((dir) => isInside(dir, absPath));
    if (!root) throw new Error('Invalid photo path');
    return path.relative(root, path.resolve(absPath)).split(path.sep).join('/');
}

function emit(change) {
    inventoryCache = null;
    for (const listener of listeners) {
        try {
            listener(change);
        } catch (err) {
            log.error('storage change handler failed', err);
        }
    }
}

function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function markOffline(loc, err) {
    if (!onlineDirs.delete(keyOf(loc))) return;
    log.warn(`${labelOf(loc)} is not reachable (${err?.code || err?.message || 'missing'})`);
    emit({ location: describe(loc), online: false });
}

function writeDir(relDir) {
    const root = writeRoot();
    const dir = path.join(root, relDir);
    try {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch (err) {
        if (root === PHOTOS_DIR) throw err;
        // Unplugged since the last check: fall back to this PC now rather than fail the upload.
        markOffline(settings.location, err);
        return writeDir(relDir);
    }
}

function userDir(userId) {
    return writeDir(userId);
}

// Folder for a converted file: the original's folder, in the current write location.
function writeDirFor(sourcePath) {
    return writeDir(path.posix.dirname(toStoredName(sourcePath)));
}

// Files being uploaded or converted, which the mover must leave alone for now.
function markBusy(filePath) {
    const key = comparable(filePath);
    busyPaths.set(key, (busyPaths.get(key) || 0) + 1);
}

function unmarkBusy(filePath) {
    const key = comparable(filePath);
    const count = (busyPaths.get(key) || 0) - 1;
    if (count > 0) busyPaths.set(key, count);
    else busyPaths.delete(key);
}

function isBusy(filePath) {
    return busyPaths.has(comparable(filePath));
}

function deleteEverywhere(names, dirs) {
    for (const root of readRoots()) {
        for (const name of names) {
            const full = joinInside(root, name);
            if (!full) continue;
            try {
                fs.unlinkSync(full);
            } catch (err) {
                if (err.code !== 'ENOENT') log.warn(`could not delete ${name}: ${err.message}`);
            }
            deleteThumbnail(full);
        }
        for (const dir of dirs) {
            const full = joinInside(root, dir);
            if (!full) continue;
            try {
                fs.rmSync(full, { recursive: true, force: true });
            } catch (err) {
                log.warn(`could not delete folder ${dir}: ${err.message}`);
            }
        }
    }
    inventoryCache = null;
}

// Deletes media (and its thumbnails) from every location that has it. Never throws for a
// file: on Windows one another process has open (e.g. ffmpeg) can't be deleted yet. While a
// drive is unplugged the names are queued and deleted from it once it's back.
async function removeFiles(names, { dirs = [] } = {}) {
    const files = names.filter((name) => typeof name === 'string' && name);
    if (files.length === 0 && dirs.length === 0) return;
    deleteEverywhere(files, dirs);
    if (!hasOfflineLocations()) return;
    const entries = [...files.map((name) => [name, false]), ...dirs.map((name) => [name, true])];
    await pool.query(
        `INSERT INTO media_pending_deletes (name, is_dir)
         SELECT * FROM unnest($1::text[], $2::boolean[])
         ON CONFLICT (name) DO NOTHING`,
        [entries.map(([name]) => name), entries.map(([, isDir]) => isDir)]
    );
}

async function applyPendingDeletes() {
    const { rows } = await pool.query('SELECT name, is_dir FROM media_pending_deletes');
    if (rows.length === 0) return 0;
    deleteEverywhere(
        rows.filter((row) => !row.is_dir).map((row) => row.name),
        rows.filter((row) => row.is_dir).map((row) => row.name)
    );
    if (hasOfflineLocations()) return 0;
    await pool.query('DELETE FROM media_pending_deletes WHERE name = ANY($1)', [rows.map((row) => row.name)]);
    log.info(`applied ${rows.length} delete${rows.length === 1 ? '' : 's'} queued while a drive was unplugged`);
    return rows.length;
}

async function* walkFiles(root, rel = '') {
    let entries;
    try {
        entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
    }
    for (const entry of entries) {
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
            yield* walkFiles(root, childRel);
        } else if (entry.isFile() && !(rel === '' && entry.name === MARKER_FILE)) {
            const abs = path.join(root, childRel);
            try {
                const { size, mtimeMs } = await fs.promises.stat(abs);
                yield { root, rel: childRel, abs, size, mtimeMs };
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        }
    }
}

const isTemp = (file) => file.rel.endsWith('.tmp');

async function diskSpace(dir) {
    const { bavail, blocks, bsize } = await fs.promises.statfs(dir);
    return { freeBytes: bavail * bsize, totalBytes: blocks * bsize, blockSize: bsize };
}

// Files waiting in places other than the chosen location.
async function inventory() {
    if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) return inventoryCache.value;
    const places = [];
    for (const loc of uniqueLocations([INTERNAL, ...settings.fallbacks])) {
        if (sameLocation(loc, settings.location)) continue;
        const root = rootOf(loc);
        const place = { ...describe(loc), files: null, bytes: null };
        if (root) {
            place.files = 0;
            place.bytes = 0;
            for await (const file of walkFiles(root)) {
                if (isTemp(file)) continue;
                place.files += 1;
                place.bytes += file.size;
            }
        }
        if (place.files !== 0) places.push(place);
    }
    const value = {
        files: places.reduce((sum, place) => sum + (place.files || 0), 0),
        bytes: places.reduce((sum, place) => sum + (place.bytes || 0), 0),
        places,
    };
    inventoryCache = { at: Date.now(), value };
    return value;
}

function invalidateInventory() {
    inventoryCache = null;
}

async function readMarker(dir) {
    try {
        return JSON.parse(await fs.promises.readFile(path.join(dir, MARKER_FILE), 'utf8'));
    } catch {
        return null;
    }
}

// A drive's folder is recognised by the id in its marker file, so another disk that later
// gets the same letter is never written to, and a re-plugged drive is found under whatever
// letter Windows gives it.
async function locateDrive(loc) {
    const letters = [loc.letter, ...DRIVE_LETTERS.filter((letter) => letter !== loc.letter)].filter(Boolean);
    for (const letter of letters) {
        const dir = `${letter}:\\${DRIVE_FOLDER}`;
        if ((await readMarker(dir))?.id === loc.id) return { dir, letter };
    }
    return null;
}

async function refresh({ silent = false } = {}) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        let lettersChanged = false;
        for (const loc of driveLocations()) {
            const key = keyOf(loc);
            const wasOnline = onlineDirs.has(key);
            const found = await locateDrive(loc);
            if (found) {
                onlineDirs.set(key, found.dir);
                lastDirs.set(key, found.dir);
                if (found.letter !== loc.letter) {
                    loc.letter = found.letter;
                    lettersChanged = true;
                }
            } else {
                onlineDirs.delete(key);
            }
            if (!silent && wasOnline !== Boolean(found)) {
                if (found) log.success(`${labelOf(loc)} connected · ${found.dir}`);
                else log.warn(`${labelOf(loc)} disconnected`);
                emit({ location: describe(loc), online: Boolean(found) });
            }
        }
        if (lettersChanged) await save();
    })().finally(() => { refreshing = null; });
    return refreshing;
}

function parseLocation(raw) {
    if (raw?.kind !== 'drive' || typeof raw.id !== 'string' || !raw.id) return INTERNAL;
    return {
        kind: 'drive',
        id: raw.id,
        label: String(raw.label || 'External drive'),
        volumeId: typeof raw.volumeId === 'string' ? raw.volumeId : null,
        letter: /^[A-Z]$/.test(raw.letter) ? raw.letter : null,
    };
}

async function load() {
    const { rows } = await pool.query('SELECT value FROM app_config WHERE key = $1', [CONFIG_KEY]);
    if (!rows[0]?.value) return;
    try {
        const raw = JSON.parse(rows[0].value);
        settings = {
            location: parseLocation(raw.location),
            fallbacks: uniqueLocations((raw.fallbacks || []).map(parseLocation).filter((loc) => loc.kind === 'drive')),
            paused: raw.paused === true,
        };
    } catch (err) {
        log.error('saved attachment location is unreadable; using this PC', err);
    }
}

async function save() {
    await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [CONFIG_KEY, JSON.stringify(settings)]
    );
}

async function init() {
    await load();
    await refresh({ silent: true });
}

function startWatching() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
        refresh().catch((err) => log.error('drive check failed', err));
    }, WATCH_INTERVAL_MS);
    watchTimer.unref();
}

async function setPaused(paused) {
    settings.paused = paused;
    await save();
}

function isPaused() {
    return settings.paused;
}

function forgetFallback(loc) {
    settings.fallbacks = settings.fallbacks.filter((fallback) => !sameLocation(fallback, loc));
    onlineDirs.delete(keyOf(loc));
    return save();
}

async function prepareDriveFolder(drive) {
    const dir = `${drive.letter}:\\${DRIVE_FOLDER}`;
    let id = (await readMarker(dir))?.id;
    if (!id) {
        const existing = await fs.promises.readdir(dir).catch((err) => {
            if (err.code === 'ENOENT') return null;
            throw err;
        });
        if (existing && existing.length > 0) {
            throw new StorageError(`${dir} already exists and has other files in it. Rename it or pick another drive.`);
        }
        await fs.promises.mkdir(dir, { recursive: true });
        id = crypto.randomUUID();
        const marker = { app: 'journey', id, createdAt: new Date().toISOString() };
        await fs.promises.writeFile(path.join(dir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    }
    return { loc: { kind: 'drive', id, label: drive.label, volumeId: drive.id, letter: drive.letter }, dir };
}

async function resolveTarget(target, { refresh = true } = {}) {
    if (target?.kind === 'internal') return { loc: INTERNAL, dir: PHOTOS_DIR };
    if (target?.kind !== 'drive' || typeof target.volumeId !== 'string') {
        throw new StorageError('Choose This PC or a connected drive');
    }
    const drive = (await listExternalDrives({ refresh })).find((d) => d.id === target.volumeId);
    if (!drive) throw new StorageError('That drive is no longer connected');
    if (!drive.healthy) {
        throw new StorageError(`${drive.label} reports "${drive.status}". Repair it in Windows before storing attachments on it.`);
    }
    return { drive };
}

// What moving everything to `dir` involves. Sizes are rounded up to the target's cluster
// size: exFAT drives use large clusters, so small files take more room than their size.
async function planMove(dir) {
    const sources = [];
    for (const root of readRoots()) {
        if (sameDir(root, dir)) continue;
        const source = { root, files: 0, bytes: 0, sizes: [] };
        for await (const file of walkFiles(root)) {
            if (isTemp(file)) continue;
            source.files += 1;
            source.bytes += file.size;
            source.sizes.push(file.size);
        }
        sources.push(source);
    }
    let spaceDir = dir;
    while (!fs.existsSync(spaceDir) && path.dirname(spaceDir) !== spaceDir) spaceDir = path.dirname(spaceDir);
    const { freeBytes, blockSize } = await diskSpace(spaceDir);
    const footprint = sources
        .flatMap((source) => source.sizes)
        .reduce((sum, size) => sum + Math.ceil(size / blockSize) * blockSize, 0);
    return {
        files: sources.reduce((sum, source) => sum + source.files, 0),
        bytes: sources.reduce((sum, source) => sum + source.bytes, 0),
        sources: sources.map(({ root, files, bytes }) => ({ path: root, files, bytes })),
        neededBytes: footprint + SPACE_MARGIN_BYTES,
        freeBytes,
    };
}

async function planMoveTo(target) {
    const resolved = await resolveTarget(target, { refresh: false });
    const dir = resolved.dir || `${resolved.drive.letter}:\\${DRIVE_FOLDER}`;
    return { path: dir, ...(await planMove(dir)) };
}

// Makes `target` ({ kind: 'internal' } or { kind: 'drive', volumeId }) the place attachments
// are stored. New files go there right away; existing ones are moved by mediaMove.
async function selectLocation(target) {
    const resolved = await resolveTarget(target);
    if (resolved.drive) {
        const known = driveLocations().find((loc) => loc.volumeId === resolved.drive.id);
        if (known && sameLocation(known, settings.location)) return describe(settings.location);
    } else if (sameLocation(resolved.loc, settings.location)) {
        return describe(settings.location);
    }

    const destDir = resolved.dir || `${resolved.drive.letter}:\\${DRIVE_FOLDER}`;
    const plan = await planMove(destDir);
    if (plan.freeBytes < plan.neededBytes) {
        throw new StorageError(
            `Not enough space: moving needs ${formatBytes(plan.neededBytes)}, but only ${formatBytes(plan.freeBytes)} is free`
        );
    }

    const { loc, dir } = resolved.drive ? await prepareDriveFolder(resolved.drive) : resolved;
    if (loc.kind === 'internal') await fs.promises.mkdir(PHOTOS_DIR, { recursive: true });
    const previous = settings.location;
    settings = {
        location: loc,
        fallbacks: uniqueLocations([previous, ...settings.fallbacks]
            .filter((fallback) => fallback.kind === 'drive' && !sameLocation(fallback, loc))),
        paused: false,
    };
    if (loc.kind === 'drive') {
        onlineDirs.set(keyOf(loc), dir);
        lastDirs.set(keyOf(loc), dir);
    }
    inventoryCache = null;
    await save();
    log.success(`attachments are now stored on ${labelOf(loc)} · ${dir}`);
    return describe(loc);
}

function currentLocation() {
    return describe(settings.location);
}

async function status() {
    const location = describe(settings.location);
    const root = locationRoot();
    const space = root ? await diskSpace(root).catch(() => null) : null;
    return {
        location: { ...location, freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null },
        writingTo: describe(root ? settings.location : INTERNAL),
        waiting: await inventory(),
        paused: settings.paused,
    };
}

async function internalSpace() {
    await fs.promises.mkdir(PHOTOS_DIR, { recursive: true });
    const { freeBytes, totalBytes } = await diskSpace(PHOTOS_DIR);
    return { ...describe(INTERNAL), freeBytes, totalBytes };
}

module.exports = {
    StorageError,
    MARKER_FILE,
    init,
    startWatching,
    refresh,
    onChange,
    find,
    toStoredName,
    userDir,
    writeDirFor,
    locationRoot,
    readRoots,
    sourceLocations,
    hasOfflineLocations,
    markLocationOffline: (err) => markOffline(settings.location, err),
    markBusy,
    unmarkBusy,
    isBusy,
    removeFiles,
    applyPendingDeletes,
    walkFiles,
    diskSpace,
    planMove,
    planMoveTo,
    selectLocation,
    setPaused,
    isPaused,
    forgetFallback,
    invalidateInventory,
    inventory,
    status,
    currentLocation,
    labelOf,
    internalSpace,
};
