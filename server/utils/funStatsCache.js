// Last Fun Stats result per account, keyed by the tenant's data_version and the date
// (several stats depend on "today").
const cache = new Map();

function get(userId, key) {
    const entry = cache.get(userId);
    return entry && entry.key === key ? entry.value : null;
}

function set(userId, key, value) {
    cache.set(userId, { key, value });
}

function forgetUser(userId) {
    cache.delete(userId);
}

module.exports = { get, set, forgetUser };
