// A session's expiry is pushed back on every request, which is a database write per
// thumbnail. The stored expiry only has to be roughly right, so each session is written at
// most once per interval.

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 10_000;

function throttleTouch(store, { intervalMs = TOUCH_INTERVAL_MS, now = Date.now } = {}) {
    const lastTouched = new Map();
    const touch = store.touch.bind(store);
    store.touch = (sid, sess, callback) => {
        const time = now();
        if (lastTouched.has(sid) && time - lastTouched.get(sid) < intervalMs) return callback?.();
        if (lastTouched.size >= MAX_TRACKED_SESSIONS) lastTouched.clear();
        lastTouched.set(sid, time);
        return touch(sid, sess, callback);
    };
    return store;
}

module.exports = { throttleTouch, TOUCH_INTERVAL_MS };
