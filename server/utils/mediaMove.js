const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { pool } = require('../db');
const storage = require('./mediaStorage');
const { formatBytes } = require('./format');
const log = require('./logger').scope('storage');

// Moves attachments into the chosen location from everywhere else they are (the previous
// location, or this PC after uploads landed there while the drive was unplugged). Each file
// is copied, the copy's SHA-256 checked against the original's, and only then is the
// original deleted, so a move can stop at any point and pick up where it left off.

// Postgres advisory lock id, so the server and scripts/move-attachments.js never move at once.
const LOCK_ID = 7340118221;
const COPY_SUFFIX = '.move.tmp';
const CHUNK_BYTES = 1024 * 1024;
const BUSY_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 30_000;
const STALE_TEMP_MS = 60 * 60 * 1000;
const RETRYABLE_UNLINK = new Set(['EBUSY', 'EPERM', 'EACCES']);
const FAILURES_LISTED = 20;

class TargetGone extends Error {}

const progress = {
    phase: 'idle', // idle | moving | waiting | paused | error
    reason: null, // why it's waiting: offline | locked | busy
    error: null,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    current: null,
    failed: [],
    finishedAt: null,
};
let running = null;
let runAgain = false;
let controller = null;
let lockRetryTimer = null;

const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
    }, { once: true });
});

const keyOf = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);

async function hashFile(file, signal) {
    const hash = crypto.createHash('sha256');
    await pipeline(
        fs.createReadStream(file, { highWaterMark: CHUNK_BYTES }),
        async function digest(source) {
            for await (const chunk of source) hash.update(chunk);
        },
        { signal }
    );
    return hash.digest('hex');
}

async function copyWithHash(src, dest, { signal, onBytes }) {
    const hash = crypto.createHash('sha256');
    const tap = new Transform({
        transform(chunk, _encoding, callback) {
            hash.update(chunk);
            onBytes?.(chunk.length);
            callback(null, chunk);
        },
    });
    await pipeline(
        fs.createReadStream(src, { highWaterMark: CHUNK_BYTES }),
        tap,
        fs.createWriteStream(dest, { flush: true }),
        { signal }
    );
    return hash.digest('hex');
}

// Leaves a verified copy at `dest` (written aside and renamed, so `dest` is never partial).
async function copyVerified(src, dest, { signal, onBytes, onStep } = {}) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
        // Copied by an earlier run that stopped before deleting the original.
        onStep?.('verifying');
        const [original, copy] = await Promise.all([hashFile(src, signal), hashFile(dest, signal)]);
        if (original !== copy) throw new Error('a different file with this name is already at the destination');
        return;
    }
    const temp = dest + COPY_SUFFIX;
    try {
        onStep?.('copying');
        const { atime, mtime } = await fs.promises.stat(src);
        const originalHash = await copyWithHash(src, temp, { signal, onBytes });
        onStep?.('verifying');
        if ((await hashFile(temp, signal)) !== originalHash) throw new Error('the copy does not match the original');
        await fs.promises.utimes(temp, atime, mtime);
        await fs.promises.rename(temp, dest);
    } catch (err) {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
        throw err;
    }
}

async function unlinkWithRetry(file) {
    for (let attempt = 1; ; attempt++) {
        try {
            await fs.promises.unlink(file);
            return;
        } catch (err) {
            if (err.code === 'ENOENT') return;
            // Antivirus, the search indexer or Syncthing can hold a file open for a moment.
            if (attempt >= 8 || !RETRYABLE_UNLINK.has(err.code)) throw err;
            await sleep(250 * attempt);
        }
    }
}

async function acquireLock() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
        if (rows[0].ok) return client;
        client.release();
        return null;
    } catch (err) {
        client.release(true);
        throw err;
    }
}

async function releaseLock(client) {
    try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
        client.release();
    } catch {
        client.release(true);
    }
}

// Files to move this pass: everything outside the chosen location except temp files and
// files still being uploaded or converted.
async function collect(skip) {
    const pending = [];
    let busy = 0;
    for (const { root } of storage.sourceLocations()) {
        for await (const file of storage.walkFiles(root)) {
            const key = keyOf(file.abs);
            if (skip.has(key)) continue;
            if (file.rel.endsWith('.tmp')) {
                if (Date.now() - file.mtimeMs > STALE_TEMP_MS) await fs.promises.rm(file.abs, { force: true });
                continue;
            }
            if (storage.isBusy(file.abs)) {
                busy += 1;
                continue;
            }
            pending.push({ ...file, key });
        }
    }
    return { pending, busy };
}

async function ensureSpace(target, items) {
    const { freeBytes, blockSize } = await storage.diskSpace(target);
    const needed = items.reduce((sum, item) => sum + Math.ceil(item.size / blockSize) * blockSize, 0);
    if (needed > freeBytes) {
        throw new Error(`Not enough space on ${storage.currentLocation().name}: ` +
            `${formatBytes(needed)} needed, ${formatBytes(freeBytes)} free`);
    }
}

async function moveItem(item, target, { signal, skip, report }) {
    const name = item.rel.split(path.sep).join('/');
    const dest = path.join(target, item.rel);
    progress.current = { name, bytes: item.size, bytesDone: 0, step: 'copying' };
    report();
    try {
        await copyVerified(item.abs, dest, {
            signal,
            onBytes: (bytes) => { progress.current.bytesDone += bytes; },
            onStep: (step) => {
                progress.current.step = step;
                report();
            },
        });
        if (fs.existsSync(item.abs)) {
            await unlinkWithRetry(item.abs);
        } else if (fs.existsSync(item.root)) {
            // Deleted (e.g. the photo was removed) while it was being copied.
            await fs.promises.rm(dest, { force: true });
        }
        progress.filesDone += 1;
        progress.bytesDone += item.size;
    } catch (err) {
        if (signal.aborted) return;
        if (!fs.existsSync(target)) throw new TargetGone(err.message, { cause: err });
        if (err.code === 'ENOSPC') throw new Error(`${storage.currentLocation().name} is full`);
        skip.add(item.key);
        progress.failed.push({ name, error: err.message });
        log.error(`could not move ${name}: ${err.message}`);
    } finally {
        progress.current = null;
        report();
    }
}

// Deletes now-empty folders below `dir`; resolves to whether `dir` itself is empty.
async function pruneEmptyDirs(dir, isRoot = true) {
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    let empty = true;
    for (const entry of entries) {
        if (entry.isDirectory() && await pruneEmptyDirs(path.join(dir, entry.name), false)) continue;
        empty = false;
    }
    if (empty && !isRoot) {
        try {
            await fs.promises.rmdir(dir);
        } catch {
            return false;
        }
    }
    return empty;
}

async function cleanUp() {
    for (const { loc, root } of storage.sourceLocations()) {
        await pruneEmptyDirs(root);
        if (loc.kind !== 'drive') continue;
        let hasFiles = false;
        for await (const file of storage.walkFiles(root)) {
            hasFiles = Boolean(file);
            break;
        }
        if (hasFiles) continue;
        // An earlier drive that's been emptied is forgotten, and its folder removed.
        await fs.promises.rm(path.join(root, storage.MARKER_FILE), { force: true });
        await fs.promises.rmdir(root).catch(() => {});
        await storage.forgetFallback(loc);
    }
}

function finish(phase, { reason = null, error = null } = {}) {
    Object.assign(progress, { phase, reason, error, current: null, finishedAt: Date.now() });
    return status();
}

function retryLockLater() {
    clearTimeout(lockRetryTimer);
    lockRetryTimer = setTimeout(kick, LOCK_RETRY_MS);
    lockRetryTimer.unref();
}

// One full move into the chosen location. Used by kick() in the server and directly by the script.
async function drain({ onProgress } = {}) {
    const report = () => onProgress?.(status());
    if (storage.isPaused()) return finish('paused');
    const target = storage.locationRoot();
    if (!target) return finish('waiting', { reason: 'offline' });

    const lock = await acquireLock();
    if (!lock) {
        retryLockLater();
        return finish('waiting', { reason: 'locked' });
    }

    controller = new AbortController();
    const { signal } = controller;
    Object.assign(progress, {
        phase: 'moving', reason: null, error: null, current: null, failed: [], finishedAt: null,
        filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0,
    });
    const counted = new Set();
    const skip = new Set();

    try {
        for (;;) {
            const { pending, busy } = await collect(skip);
            for (const item of pending) {
                if (counted.has(item.key)) continue;
                counted.add(item.key);
                progress.filesTotal += 1;
                progress.bytesTotal += item.size;
            }
            if (pending.length === 0) {
                if (busy === 0 || signal.aborted) break;
                Object.assign(progress, { phase: 'waiting', reason: 'busy' });
                report();
                await sleep(BUSY_WAIT_MS, signal);
                Object.assign(progress, { phase: 'moving', reason: null });
                continue;
            }
            await ensureSpace(target, pending);
            for (const item of pending) {
                if (signal.aborted) break;
                if (storage.isBusy(item.abs)) continue;
                await moveItem(item, target, { signal, skip, report });
            }
            if (signal.aborted) break;
        }

        storage.invalidateInventory();
        if (signal.aborted) return finish(storage.isPaused() ? 'paused' : 'idle');
        await cleanUp();
        if (progress.failed.length > 0) {
            const count = progress.failed.length;
            return finish('error', { error: `${count} file${count === 1 ? '' : 's'} could not be moved` });
        }
        if (progress.filesDone > 0) {
            log.success(`moved ${progress.filesDone} file${progress.filesDone === 1 ? '' : 's'} ` +
                `(${formatBytes(progress.bytesDone)}) to ${storage.currentLocation().name}`);
        }
        return finish('idle');
    } catch (err) {
        storage.invalidateInventory();
        if (err instanceof TargetGone) {
            storage.markLocationOffline(err.cause);
            return finish('waiting', { reason: 'offline' });
        }
        log.error('moving attachments stopped', err);
        return finish('error', { error: err.message });
    } finally {
        controller = null;
        await releaseLock(lock);
    }
}

// Starts a move in the background if there's anything to move; safe to call any time.
function kick() {
    if (running) {
        runAgain = true;
        return running;
    }
    clearTimeout(lockRetryTimer);
    running = drain()
        .catch((err) => log.error('moving attachments failed', err))
        .finally(() => {
            running = null;
            if (runAgain) {
                runAgain = false;
                kick();
            }
        });
    return running;
}

// Stops a running move after its current file and waits for it to let go.
async function interrupt() {
    runAgain = false;
    controller?.abort();
    await running;
}

async function pause() {
    await storage.setPaused(true);
    await interrupt();
    finish('paused');
}

async function resume() {
    await storage.setPaused(false);
    if (progress.phase === 'paused' || progress.phase === 'error') {
        Object.assign(progress, { phase: 'idle', reason: null, error: null });
    }
    kick();
}

function status() {
    let { phase, reason } = progress;
    if (phase !== 'moving' && storage.isPaused()) {
        phase = 'paused';
        reason = null;
    } else if (phase !== 'moving' && phase !== 'error' && !storage.locationRoot()) {
        phase = 'waiting';
        reason = 'offline';
    }
    return {
        phase,
        reason,
        error: progress.error,
        filesTotal: progress.filesTotal,
        filesDone: progress.filesDone,
        bytesTotal: progress.bytesTotal,
        bytesDone: progress.bytesDone,
        current: progress.current && { ...progress.current },
        failed: progress.failed.slice(0, FAILURES_LISTED),
        failedCount: progress.failed.length,
        finishedAt: progress.finishedAt,
    };
}

module.exports = { drain, kick, interrupt, pause, resume, status, copyVerified };
