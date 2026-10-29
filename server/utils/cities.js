const GEOCODE_BASE = 'https://origin.mdoan.com';
const GEOCODE_TIMEOUT_MS = 8000;
// This many network/5xx failures in a row means the geocoder went down mid-route.
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Compute an ordered, consecutively-deduplicated list of city names
 * that a route passes through by reverse geocoding every coordinate.
 *
 * @param {Array<[number, number]>} coordinates - [[lat, lon], ...]
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - stops early (result is then null)
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @param {Map} [options.cache] - lookup cache to share across routes
 * @returns {Promise<string[]|null>} e.g. ["Seattle", "Shoreline", "Lynnwood"],
 *   or null when the geocoder was unreachable. Callers must skip persisting on
 *   null so the route stays NULL/unprocessed and a later backfill retries it,
 *   instead of durably storing a bogus or partial list.
 */
async function computeCitiesPassed(coordinates, { signal, onProgress, cache = new Map() } = {}) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];

    let okResponses = 0;
    let failures = 0;
    let consecutiveFailures = 0;

    async function geocodeCity(lat, lon) {
        const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
        if (cache.has(key)) return cache.get(key);

        try {
            const res = await fetch(`${GEOCODE_BASE}/city?lat=${lat}&lon=${lon}`, {
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
            // 'unknown' is the geocoder's nothing-here sentinel (see places.js)
            // — never store it as if it were a city named "unknown".
            const raw = data.city || null;
            const city = raw && raw !== 'unknown' ? raw : null;
            cache.set(key, city);
            return city;
        } catch {
            failures++;
            consecutiveFailures++;
            return null;
        }
    }

    const cities = [];
    let lastCity = null;

    for (let i = 0; i < coordinates.length; i++) {
        if (signal?.aborted) return null;
        const [lat, lon] = coordinates[i];
        if (lat != null && lon != null) {
            const city = await geocodeCity(lat, lon);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
            if (city && city !== lastCity) {
                cities.push(city);
                lastCity = city;
            }
        }
        onProgress?.(i + 1, coordinates.length);
    }

    // Every request failed: the API was down, not the route city-less.
    if (okResponses === 0 && failures > 0) return null;

    return cities;
}

module.exports = { computeCitiesPassed };
