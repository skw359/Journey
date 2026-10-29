const GEOCODE_BASE = 'https://origin.mdoan.com';
const GEOCODE_TIMEOUT_MS = 8000;
// This many network/5xx failures in a row means the geocoder went down mid-route.
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Compute a deduplicated list of place names that a route passes through
 * by reverse geocoding every coordinate via the /place endpoint.
 *
 * @param {Array<[number, number]>} coordinates - [[lat, lon], ...]
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - stops early (result is then null)
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @param {Map} [options.cache] - lookup cache to share across routes
 * @returns {Promise<string[]|null>} e.g. ["Starbucks", "Green Lake Park"],
 *   or null when the geocoder was unreachable. Callers must skip persisting on
 *   null so the route stays NULL/unprocessed and a later backfill retries it,
 *   instead of durably storing a bogus or partial list.
 */
async function computePlacesPassed(coordinates, { signal, onProgress, cache = new Map() } = {}) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];

    let okResponses = 0;
    let failures = 0;
    let consecutiveFailures = 0;

    async function geocodePlace(lat, lon) {
        const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
        if (cache.has(key)) return cache.get(key);

        try {
            const res = await fetch(`${GEOCODE_BASE}/place?lat=${lat}&lon=${lon}`, {
                signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
            });
            // 4xx is the geocoder rejecting this point (bad coords), not the geocoder being down.
            if (res.status >= 400 && res.status < 500) {
                okResponses++;
                consecutiveFailures = 0;
                cache.set(key, null);
                return null;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            okResponses++;
            consecutiveFailures = 0;
            const place = data.place || data.place_name || data.name || null;
            if (!place || place === 'unknown') { cache.set(key, null); return null; }
            cache.set(key, place);
            return place;
        } catch {
            failures++;
            consecutiveFailures++;
            return null;
        }
    }

    const places = new Set();

    for (let i = 0; i < coordinates.length; i++) {
        if (signal?.aborted) return null;
        const [lat, lon] = coordinates[i];
        if (lat != null && lon != null) {
            const place = await geocodePlace(lat, lon);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
            if (place) places.add(place);
        }
        onProgress?.(i + 1, coordinates.length);
    }

    // Every request failed: the API was down, not the route featureless.
    if (okResponses === 0 && failures > 0) return null;

    return [...places];
}

module.exports = { computePlacesPassed };
