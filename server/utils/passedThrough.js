const { GEOCODE_BASE_URL } = require('../config');

// The cities and the named places a journey passes through, from the reverse geocoder.

const GEOCODE_TIMEOUT_MS = 8000;
// This many network/5xx failures in a row means the geocoder went down mid-route.
const MAX_CONSECUTIVE_FAILURES = 10;
// The geocoder's nothing-here answer, never a name.
const NOTHING_HERE = 'unknown';

const CITIES = {
    endpoint: 'city',
    // One lookup per grid cell: answers are cached by coordinates rounded to this many decimals.
    cellDecimals: 3,
    nameOf: (data) => data.city,
    // In travel order, repeating a city the journey comes back to.
    collect: (names) => names.filter((name, i) => name !== names[i - 1]),
};

const PLACES = {
    endpoint: 'place',
    cellDecimals: 4,
    nameOf: (data) => data.place || data.place_name || data.name,
    collect: (names) => [...new Set(names)],
};

/**
 * Reverse geocodes every coordinate of a journey and collects the names found.
 *
 * @param {Array<[number, number]>} coordinates - [[lat, lon], ...]
 * @param {object} kind - CITIES or PLACES
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - stops early (result is then null)
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @param {Map} [options.cache] - lookup cache to share across journeys (per kind)
 * @returns {Promise<string[]|null>} the names, or null when the geocoder was unreachable.
 *   Callers must skip persisting on null so the journey stays NULL/unprocessed and a later
 *   backfill retries it, instead of durably storing a bogus or partial list.
 */
async function namesAlong(coordinates, kind, { signal, onProgress, cache = new Map() } = {}) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
    // No geocoder configured: treated like one that is down, so a later backfill retries.
    if (!GEOCODE_BASE_URL) return null;

    let okResponses = 0;
    let failures = 0;
    let consecutiveFailures = 0;

    async function nameAt(lat, lon) {
        const key = `${lat.toFixed(kind.cellDecimals)},${lon.toFixed(kind.cellDecimals)}`;
        if (cache.has(key)) return cache.get(key);

        try {
            const res = await fetch(`${GEOCODE_BASE_URL}/${kind.endpoint}?lat=${lat}&lon=${lon}`, {
                signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
            });
            let name = null;
            // 4xx is the geocoder rejecting this point (bad coords), not the geocoder being down.
            if (!(res.status >= 400 && res.status < 500)) {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                name = kind.nameOf(await res.json()) || null;
                if (name === NOTHING_HERE) name = null;
            }
            okResponses++;
            consecutiveFailures = 0;
            cache.set(key, name);
            return name;
        } catch {
            failures++;
            consecutiveFailures++;
            return null;
        }
    }

    const names = [];
    for (let i = 0; i < coordinates.length; i++) {
        if (signal?.aborted) return null;
        const [lat, lon] = coordinates[i];
        if (lat != null && lon != null) {
            const name = await nameAt(lat, lon);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
            if (name) names.push(name);
        }
        onProgress?.(i + 1, coordinates.length);
    }

    // Every request failed: the geocoder was down, not the journey somewhere nameless.
    if (okResponses === 0 && failures > 0) return null;

    return kind.collect(names);
}

/** e.g. ["Seattle", "Shoreline", "Lynnwood"] */
const computeCitiesPassed = (coordinates, options) => namesAlong(coordinates, CITIES, options);
/** e.g. ["Starbucks", "Green Lake Park"] */
const computePlacesPassed = (coordinates, options) => namesAlong(coordinates, PLACES, options);

module.exports = { computeCitiesPassed, computePlacesPassed };
