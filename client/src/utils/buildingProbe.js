import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import { Style, Stroke, Fill } from 'ol/style';
import { toLonLat } from 'ol/proj';
import { lookupBuilding } from '../api/geocode';
import { escapeHtml } from './html';

// Rounding the cache key to ~1 m means dragging the cursor a few pixels and
// clicking the same doorway twice costs one request, not two.
const CACHE_PRECISION = 5;
const CACHE_MAX = 300;

// Shared across every map in the session: the Dashboard and the Atlas ask
// about the same buildings constantly.
const cache = new Map();

function cacheKey(lat, lon, radius) {
  return `${lat.toFixed(CACHE_PRECISION)},${lon.toFixed(CACHE_PRECISION)},${radius}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

// OSM names are third-party data and land in innerHTML, so every interpolated
// value goes through here.
const DEFAULT_ACCENT = '#02d87f';

// The accent differs per theme (#02d87f dark, #059669 light), so the fill is
// derived from whichever accent is live rather than hard-coded to one of them.
function translucent(color, alpha) {
  const hex = color.trim().replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return `rgba(2, 216, 127, ${alpha})`;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const esc = escapeHtml;

function titleCase(tag) {
  return String(tag).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCity(data) {
  const city = data.city && data.city !== 'unknown' ? data.city : null;
  if (!city) return null;
  const region = data.state_code || data.country_code || null;
  // Only reached when there is no composed address to show instead, so the
  // postcode is worth appending here rather than being lost.
  return [city, [region, data.postcode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

function row(label, value) {
  if (!value) return '';
  return `<div class="bp-row"><span class="bp-label">${esc(label)}</span>` +
         `<span class="bp-value">${esc(value)}</span></div>`;
}

function coordsRow(lat, lon) {
  return `<div class="bp-row"><span class="bp-label">Coordinates</span>` +
         `<span class="bp-value bp-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</span></div>`;
}

function shell(headline, subtitle, body) {
  return `
    <button type="button" class="bp-close" aria-label="Close">&times;</button>
    <div class="bp-headline">${headline}</div>
    ${subtitle ? `<div class="bp-subtitle">${subtitle}</div>` : ''}
    ${body ? `<div class="bp-body">${body}</div>` : ''}
  `;
}

function renderLoading(lat, lon) {
  return shell(
    '<span class="bp-pending">Identifying…</span>',
    '',
    coordsRow(lat, lon),
  );
}

function renderError(lat, lon, offline) {
  // The desktop app serves the Atlas from an in-memory store, so the map keeps
  // working with no connection and a click can fail for a reason that has
  // nothing to do with the geocoder. Saying which one it was saves the user
  // wondering whether the feature is broken.
  return shell(
    `<span class="bp-muted">${offline ? 'Offline' : 'Lookup unavailable'}</span>`,
    offline ? 'Building names need a connection' : 'Could not reach the geocoder',
    coordsRow(lat, lon),
  );
}

function renderResult(data, lat, lon) {
  const cityLine = formatCity(data);

  if (!data.found) {
    return shell(
      '<span class="bp-muted">No building here</span>',
      cityLine ? esc(cityLine) : '',
      row('Road', data.road) + coordsRow(lat, lon),
    );
  }

  // For a house the address IS its name, so an unnamed footprint leads with the
  // full address rather than the raw OSM tag ("House"). The type still appears
  // as the subtitle, and the type is only the headline when nothing else exists.
  const address = data.address_full || data.address || null;
  const title = data.name || address ||
    (data.building_type ? titleCase(data.building_type) : 'Unnamed building');

  const bits = [];
  if (data.building_type) bits.push(titleCase(data.building_type));
  else if (data.kind === 'poi') bits.push('Area');
  if (data.match === 'nearby') {
    bits.push(data.distance_m != null ? `~${Math.round(data.distance_m)} m away` : 'nearby');
  }

  // The composed address already carries city, state and postcode, so showing
  // a City row alongside it would just repeat them. The City row is the
  // fallback for footprints OSM has no address for at all.
  const body =
    (data.name && address ? row('Address', address) : '') +
    (address ? '' : row('City', cityLine)) +
    row('Road', data.road) +
    coordsRow(lat, lon);

  return shell(esc(title), esc(bits.join(' · ')), body);
}

/**
 * Click-to-identify for an OpenLayers map: names the footprint under a click,
 * outlines it, and shows the surrounding location context.
 *
 * The caller owns the map wiring — add `layer` to the map's layers and
 * `overlay` to its overlays, call `probe()` from a click handler when the
 * click did not hit one of the map's own features, and `destroy()` on unmount.
 *
 * @param {HTMLElement} popupElement Element backing the popup overlay.
 * @param {number} [radius] Snap tolerance in metres for near-miss clicks.
 */
export function createBuildingProbe(popupElement, { radius = 25 } = {}) {
  const source = new VectorSource();
  const format = new GeoJSON();

  const layer = new VectorLayer({
    source,
    // Sits above the basemap but must never intercept a hit test aimed at a
    // journey line, so it stays out of every layerFilter the pages use.
    style: (feature) => {
      const accent = feature.get('accent') || DEFAULT_ACCENT;
      return new Style({
        stroke: new Stroke({ color: accent, width: 2 }),
        fill: new Fill({ color: translucent(accent, 0.18) }),
      });
    },
    // Keeps the outline from being picked up by forEachFeatureAtPixel calls
    // that do not pass a layerFilter.
    properties: { buildingProbe: true },
  });

  const overlay = new Overlay({
    element: popupElement,
    offset: [0, -14],
    positioning: 'bottom-center',
    // The popup has a close button and selectable coordinates, so it must
    // swallow its own pointer events instead of passing them to the map.
    stopEvent: true,
    autoPan: { animation: { duration: 200 }, margin: 16 },
  });

  let seq = 0;
  let inFlight = null;
  let open = false;

  const hide = () => {
    if (!open) return;
    open = false;
    seq++;                     // invalidate any response still on the wire
    inFlight?.abort();
    inFlight = null;
    source.clear();
    overlay.setPosition(undefined);
    popupElement.style.display = 'none';
  };

  const show = (html, coordinate) => {
    popupElement.innerHTML = html;
    popupElement.style.display = 'block';
    overlay.setPosition(coordinate);
    popupElement.querySelector('.bp-close')?.addEventListener('click', hide);
  };

  const drawFootprint = (geometry) => {
    source.clear();
    if (!geometry) return;
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-primary').trim() || '#02d87f';
    const features = format.readFeatures(
      { type: 'Feature', geometry, properties: {} },
      { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' },
    );
    features.forEach((f) => f.set('accent', accent));
    source.addFeatures(features);
  };

  const onKeyDown = (evt) => { if (evt.key === 'Escape') hide(); };
  document.addEventListener('keydown', onKeyDown);

  /**
   * Identify whatever is under a projected map coordinate.
   * @param {import('ol/coordinate').Coordinate} coordinate EPSG:3857 click point.
   */
  const probe = (coordinate) => {
    const [lon, lat] = toLonLat(coordinate);

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const mySeq = ++seq;
    open = true;

    const key = cacheKey(lat, lon, radius);
    const cached = cacheGet(key);
    if (cached !== undefined) {
      // Answer synchronously so a repeat click never flashes a spinner.
      inFlight = null;
      show(renderResult(cached, lat, lon), coordinate);
      drawFootprint(cached.geometry);
      return;
    }

    source.clear();
    show(renderLoading(lat, lon), coordinate);

    lookupBuilding(lat, lon, { radius, signal: controller.signal })
      .then((data) => {
        if (mySeq !== seq) return;   // superseded by a newer click
        inFlight = null;
        cacheSet(key, data);
        show(renderResult(data, lat, lon), coordinate);
        drawFootprint(data.geometry);
      })
      .catch((err) => {
        if (mySeq !== seq || err?.name === 'AbortError') return;
        inFlight = null;
        show(renderError(lat, lon, navigator.onLine === false), coordinate);
      });
  };

  return {
    layer,
    overlay,
    probe,
    clear: hide,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      inFlight?.abort();
      inFlight = null;
      source.clear();
    },
  };
}
