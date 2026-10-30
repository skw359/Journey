// URLs the server fetches on an admin's behalf must be plain http(s).

class OutboundUrlError extends Error {}

/** Validates a URL or {placeholder} template; returns it trimmed. */
function assertHttpUrl(raw, { label = 'URL' } = {}) {
    const value = String(raw ?? '').trim();
    if (!value) throw new OutboundUrlError(`${label} is required`);
    if (value.length > 2048) throw new OutboundUrlError(`${label} is too long`);
    const sample = value.replace(/\{[a-z_]+\}/gi, '0');
    let parsed;
    try {
        parsed = new URL(sample);
    } catch {
        throw new OutboundUrlError(`${label} is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new OutboundUrlError(`${label} must start with http:// or https://`);
    }
    if (parsed.username || parsed.password) {
        throw new OutboundUrlError(`${label} must not contain a username or password`);
    }
    return value;
}

module.exports = { assertHttpUrl, OutboundUrlError };
