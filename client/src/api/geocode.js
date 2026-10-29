const RG_BASE = 'https://origin.mdoan.com';

// A click-to-identify probe is a foreground interaction: if the geocoder is
// slow the popup must give up and say so rather than hang open on a spinner.
const BUILDING_TIMEOUT_MS = 6000;

export async function reverseGeocode(lat, lon) {
  const res = await fetch(`${RG_BASE}/lookup?lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  return res.json();
}

/**
 * Identify whatever footprint sits under a clicked point.
 *
 * Resolves to the /building payload: `found` plus `name`, `kind`
 * ('building' | 'poi'), `match` ('inside' | 'nearby'), `address`,
 * `geometry` (EPSG:4326 GeoJSON, or null when the polygon was too large to
 * ship), and the surrounding city/state/county/country/road context.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} [options]
 * @param {number} [options.radius=25] Snap tolerance in metres for a click
 *   that lands just outside a footprint. 0 answers only for points genuinely
 *   inside one.
 * @param {AbortSignal} [options.signal] Caller's cancellation, combined with
 *   the built-in timeout.
 */
export async function lookupBuilding(lat, lon, { radius = 25, signal } = {}) {
  // A map click arrives as projected metres, and unprojecting it yields values
  // like 38.98689999999999. Six decimals is ~11 cm — far finer than any
  // footprint — and keeps the request (and the geocoder's cache key) clean.
  const q = `lat=${round6(lat)}&lon=${round6(lon)}`;
  const url = `${RG_BASE}/building?${q}&radius=${radius}`;
  const res = await fetch(url, { signal: combineSignals(signal, BUILDING_TIMEOUT_MS) });

  // A deployment still running the previous build has no /building route.
  // Degrade to /lookup rather than leaving the map inert: the name is the
  // point of the feature, the outline is the bonus.
  if (res.status === 404) return legacyBuildingLookup(lat, lon, signal);
  if (!res.ok) throw new Error(`Building lookup failed: ${res.status}`);
  return res.json();
}

async function legacyBuildingLookup(lat, lon, signal) {
  const res = await fetch(`${RG_BASE}/lookup?lat=${round6(lat)}&lon=${round6(lon)}`, {
    signal: combineSignals(signal, BUILDING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Building lookup failed: ${res.status}`);
  const data = await res.json();
  const name = data.place_name && data.place_name !== 'unknown' ? data.place_name : null;
  return {
    ...data,
    found: Boolean(name),
    name,
    // /lookup widens its search until it finds a name and never says how far
    // it reached, so this can only ever be reported as an approximate hit.
    kind: name ? 'building' : null,
    match: name ? 'nearby' : null,
    inside: false,
    distance_m: null,
    address: null,
    building_type: null,
    geometry: null,
    geometry_omitted: false,
    degraded: true,
  };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  // AbortSignal.any is Baseline 2024; fall back to the caller's signal alone
  // on older engines rather than dropping their cancellation.
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}
