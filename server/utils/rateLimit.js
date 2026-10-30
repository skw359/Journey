// In-memory fixed-window counters (single process).

const SWEEP_INTERVAL_MS = 60_000;

function createRateLimiter({ windowMs, max }) {
    const windows = new Map();

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of windows) {
            if (entry.resetAt <= now) windows.delete(key);
        }
    }, SWEEP_INTERVAL_MS);
    sweep.unref();

    function current(key) {
        const now = Date.now();
        let entry = windows.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            windows.set(key, entry);
        }
        return entry;
    }

    return {
        /** ms until `key` may try again; 0 when under the limit. */
        blockedFor(key) {
            const entry = windows.get(key);
            if (!entry || entry.resetAt <= Date.now() || entry.count < max) return 0;
            return entry.resetAt - Date.now();
        },
        /** Counts an attempt; returns the wait (ms) once over the limit. */
        hit(key) {
            const entry = current(key);
            entry.count += 1;
            return entry.count > max ? entry.resetAt - Date.now() : 0;
        },
        reset(key) {
            windows.delete(key);
        },
        clear() {
            windows.clear();
        },
    };
}

function tooManyAttempts(res, waitMs, message = 'Too many attempts. Try again later.') {
    res.set('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
    return res.status(429).json({ error: message });
}

module.exports = { createRateLimiter, tooManyAttempts };
