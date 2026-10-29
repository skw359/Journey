import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Overlay from 'ol/Overlay';
import PointerInteraction from 'ol/interaction/Pointer';
import { Style, Stroke, Fill, Circle as CircleStyle, Text } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';

// Same radius the server uses when it totals a journey's distance, so a
// measurement across the whole route agrees with the journey's own stat.
const EARTH_RADIUS_MI = 3958.8;

// While dragging, the route next to the grabbed handle wins unless another
// stretch is this many screen pixels closer to the pointer.
const DRAG_STICKY_PX = 10;

const MEASURE_COLOR = '#ffc83d';
const MEASURE_INK = '#141414';
const CASING = 'rgba(0, 0, 0, 0.55)';

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Flattens a route into typed arrays for fast snapping: projected x/y per
 * point plus cumulative miles along the route.
 *
 * Cumulative distance comes from the recorded `profileDistMi` whenever it
 * lines up with the coordinates. That is the series the server built the
 * journey's distance from (with GPS glitch jumps already filtered out), and the
 * preview payload keeps its values exact at every sampled point, so a
 * measurement agrees across preview and full resolution. Routes recorded
 * without a profile fall back to summing great-circle hops.
 */
export function buildTrack(route) {
  const coords = Array.isArray(route?.coordinates) ? route.coordinates : [];
  const n = coords.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const lats = new Float64Array(n);
  const lons = new Float64Array(n);

  // An unparseable point takes its neighbour's position rather than being
  // dropped, so indices stay aligned with the profile series.
  let firstValid = coords.findIndex(c => Number.isFinite(Number(c?.[0])) && Number.isFinite(Number(c?.[1])));
  if (firstValid < 0) firstValid = 0;
  let prevLat = Number(coords[firstValid]?.[0]) || 0;
  let prevLon = Number(coords[firstValid]?.[1]) || 0;
  for (let i = 0; i < n; i++) {
    let lat = Number(coords[i]?.[0]);
    let lon = Number(coords[i]?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { lat = prevLat; lon = prevLon; }
    const [x, y] = fromLonLat([lon, lat]);
    xs[i] = x; ys[i] = y; lats[i] = lat; lons[i] = lon;
    prevLat = lat; prevLon = lon;
  }

  const cum = new Float64Array(n);
  const profile = route?.profileDistMi;
  const profileUsable = Array.isArray(profile) && profile.length === n && n > 0 &&
    profile.every(v => Number.isFinite(Number(v)));
  if (profileUsable) {
    let last = Number(profile[0]);
    for (let i = 0; i < n; i++) {
      // Rounded flight profiles can tie; never let a reading run backwards.
      last = Math.max(last, Number(profile[i]));
      cum[i] = last;
    }
  } else {
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1] + haversineMiles(lats[i - 1], lons[i - 1], lats[i], lons[i]);
    }
  }

  return { n, xs, ys, lats, lons, cum, fromProfile: profileUsable };
}

function positionAt(track, i, t) {
  const { n, xs, ys, cum } = track;
  if (i >= n - 1) return { i: n - 1, t: 0, x: xs[n - 1], y: ys[n - 1], cum: cum[n - 1] };
  return {
    i,
    t,
    x: xs[i] + (xs[i + 1] - xs[i]) * t,
    y: ys[i] + (ys[i + 1] - ys[i]) * t,
    cum: cum[i] + (cum[i + 1] - cum[i]) * t,
  };
}

function nearestOnSegment(track, i, px, py) {
  const { xs, ys } = track;
  const ax = xs[i], ay = ys[i];
  const dx = xs[i + 1] - ax, dy = ys[i + 1] - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t, y = ay + dy * t;
  return { t, d2: (px - x) ** 2 + (py - y) ** 2 };
}

/**
 * Nearest point on the route to a projected coordinate, or null when nothing
 * lies within `maxDist` (map units).
 *
 * `prefer` is the handle's current position while it is being dragged. A
 * candidate on the stretch of route next to it wins unless something elsewhere
 * is more than `preferSlack` (map units) closer, so dragging along an
 * out-and-back walk stays on the leg the user grabbed instead of hopping to the
 * parallel one, while a deliberate move onto the other leg still switches.
 */
export function snapToTrack(track, px, py, { maxDist = Infinity, prefer = null, preferSlack = 0 } = {}) {
  if (!track || track.n === 0) return null;
  const { n, xs, ys } = track;
  const max2 = maxDist * maxDist;

  if (n === 1) {
    const d2 = (px - xs[0]) ** 2 + (py - ys[0]) ** 2;
    return d2 <= max2 ? positionAt(track, 0, 0) : null;
  }

  let bestI = -1, bestT = 0, bestD2 = Infinity;
  const bounded = Number.isFinite(maxDist);
  for (let i = 0; i < n - 1; i++) {
    if (bounded) {
      const ax = xs[i], bx = xs[i + 1], ay = ys[i], by = ys[i + 1];
      if ((ax < px - maxDist && bx < px - maxDist) || (ax > px + maxDist && bx > px + maxDist) ||
          (ay < py - maxDist && by < py - maxDist) || (ay > py + maxDist && by > py + maxDist)) continue;
    }
    const { t, d2 } = nearestOnSegment(track, i, px, py);
    if (d2 < bestD2) { bestD2 = d2; bestI = i; bestT = t; }
  }
  if (bestI < 0 || bestD2 > max2) return null;

  if (prefer) {
    // Walk outward from the grabbed spot until the path covered is well past
    // how far the pointer has moved; anything beyond that is another leg.
    const reach = Math.hypot(px - prefer.x, py - prefer.y) * 2 + Math.sqrt(bestD2) * 2 + 1;
    let localI = -1, localT = 0, localD2 = Infinity;
    const start = Math.min(prefer.i, n - 2);
    for (const dir of [1, -1]) {
      let walked = 0;
      for (let i = dir === 1 ? start : start - 1; i >= 0 && i < n - 1 && walked <= reach; i += dir) {
        const { t, d2 } = nearestOnSegment(track, i, px, py);
        if (d2 < localD2) { localD2 = d2; localI = i; localT = t; }
        walked += Math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]);
      }
    }
    const allowed = Math.sqrt(bestD2) + preferSlack;
    if (localI >= 0 && localD2 <= allowed * allowed) return positionAt(track, localI, localT);
  }

  return positionAt(track, bestI, bestT);
}

/** Position `miles` along the route, clamped to its ends. */
export function positionAtDistance(track, miles) {
  const { n, cum } = track;
  if (n === 1 || miles <= cum[0]) return positionAt(track, 0, 0);
  if (miles >= cum[n - 1]) return positionAt(track, n - 1, 0);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= miles) lo = mid; else hi = mid;
  }
  const span = cum[lo + 1] - cum[lo];
  return positionAt(track, lo, span > 0 ? (miles - cum[lo]) / span : 0);
}

function isBefore(a, b) {
  return a.i < b.i || (a.i === b.i && a.t <= b.t);
}

/** Flat XY coordinates of the route between two positions, in route order. */
export function pathBetween(track, a, b) {
  const [lo, hi] = isBefore(a, b) ? [a, b] : [b, a];
  const flat = [lo.x, lo.y];
  for (let k = lo.i + 1; k <= hi.i; k++) flat.push(track.xs[k], track.ys[k]);
  flat.push(hi.x, hi.y);
  return flat;
}

/**
 * Great-circle arc between two lat/lon points as flat projected coordinates.
 * Web Mercator draws a flight's straight-line distance as a curve; drawing a
 * ruler-straight segment instead would misrepresent the path being measured.
 */
export function greatCircleFlat(lat1, lon1, lat2, lon2, steps = 64) {
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad, l1 = lon1 * toRad, p2 = lat2 * toRad, l2 = lon2 * toRad;
  const delta = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
  ));
  if (!(delta > 1e-9)) {
    const [x1, y1] = fromLonLat([lon1, lat1]);
    const [x2, y2] = fromLonLat([lon2, lat2]);
    return [x1, y1, x2, y2];
  }
  const flat = [];
  let prevLon = null;
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const A = Math.sin((1 - f) * delta) / Math.sin(delta);
    const B = Math.sin(f * delta) / Math.sin(delta);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    const lat = Math.atan2(z, Math.hypot(x, y)) / toRad;
    let lon = Math.atan2(y, x) / toRad;
    // Keep the line continuous across the antimeridian instead of letting it
    // streak back across the whole map.
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    flat.push(...fromLonLat([lon, lat]));
  }
  return flat;
}

function latLonOf(position) {
  const [lon, lat] = toLonLat([position.x, position.y]);
  return { lat, lon };
}

const handleStyles = new Map();
function handleStyle(letter, ghost) {
  const key = `${letter}${ghost ? '-ghost' : ''}`;
  if (!handleStyles.has(key)) {
    handleStyles.set(key, new Style({
      image: new CircleStyle({
        radius: ghost ? 9 : 11,
        fill: new Fill({ color: ghost ? 'rgba(255, 200, 61, 0.6)' : MEASURE_COLOR }),
        stroke: new Stroke({ color: ghost ? 'rgba(20, 20, 20, 0.55)' : MEASURE_INK, width: 2 }),
      }),
      text: new Text({
        text: letter,
        font: `700 ${ghost ? 10 : 11}px Montserrat, -apple-system, "Segoe UI", sans-serif`,
        fill: new Fill({ color: MEASURE_INK }),
        offsetY: 1,
      }),
      zIndex: ghost ? 1 : 2,
    }));
  }
  return handleStyles.get(key);
}

const routePathStyle = [
  new Stroke({ color: CASING, width: 10, lineCap: 'round', lineJoin: 'round' }),
  new Stroke({ color: MEASURE_COLOR, width: 5, lineCap: 'round', lineJoin: 'round' }),
].map(stroke => new Style({ stroke }));

const airPathStyle = [
  new Stroke({ color: CASING, width: 7, lineCap: 'round' }),
  new Stroke({ color: MEASURE_COLOR, width: 3.5, lineCap: 'butt', lineDash: [10, 8] }),
].map(stroke => new Style({ stroke }));

/**
 * Two-point distance measuring for a single journey on an OpenLayers map.
 *
 * The caller owns the map wiring, like the building probe: add `layer` to the
 * map's layers, `overlay` to its overlays and `interaction` to its
 * interactions; forward clicks to `click()` and pointer moves to `hover()`
 * while measuring; call `setRoute()` whenever the route data changes.
 *
 * @param {object} options
 * @param {HTMLElement} options.labelElement Element backing the distance label.
 * @param {(info: object) => void} options.onChange Receives the measurement
 *   whenever it changes: `{ count, routeMi, airMi }`.
 */
export function createRouteMeasure({ labelElement, onChange }) {
  const source = new VectorSource();
  const pathFeature = new Feature();
  pathFeature.set('kind', 'path');
  const handleFeatures = ['A', 'B'].map((letter, idx) => {
    const f = new Feature();
    f.set('kind', 'handle');
    f.set('idx', idx);
    f.setStyle(handleStyle(letter, false));
    return f;
  });
  const ghostFeature = new Feature();
  ghostFeature.set('kind', 'ghost');
  source.addFeatures([pathFeature, ...handleFeatures, ghostFeature]);

  let mode = 'route';
  pathFeature.setStyle(() => (mode === 'air' ? airPathStyle : routePathStyle));

  const layer = new VectorLayer({
    source,
    properties: { routeMeasure: true },
    // Redraw mid-drag so the highlighted stretch follows the handle live.
    updateWhileInteracting: true,
    updateWhileAnimating: true,
  });

  const overlay = new Overlay({
    element: labelElement,
    positioning: 'bottom-center',
    offset: [0, -16],
    stopEvent: false,
  });

  let track = null;
  let routeId = null;
  let points = [];
  let dragIdx = -1;
  let lastInfo = null;

  const emit = () => {
    const [a, b] = points;
    let info = { count: points.length, routeMi: null, airMi: null };
    if (a && b) {
      const pa = latLonOf(a), pb = latLonOf(b);
      info = {
        count: 2,
        routeMi: Math.abs(b.cum - a.cum),
        airMi: haversineMiles(pa.lat, pa.lon, pb.lat, pb.lon),
      };
    }
    if (lastInfo && lastInfo.count === info.count && lastInfo.routeMi === info.routeMi &&
        lastInfo.airMi === info.airMi) return;
    lastInfo = info;
    onChange?.(info);
  };

  const render = () => {
    handleFeatures.forEach((f, idx) => {
      const p = points[idx];
      f.setGeometry(p ? new Point([p.x, p.y]) : undefined);
    });

    const [a, b] = points;
    if (a && b && track) {
      let flat;
      let labelAt;
      if (mode === 'air') {
        const pa = latLonOf(a), pb = latLonOf(b);
        flat = greatCircleFlat(pa.lat, pa.lon, pb.lat, pb.lon);
        const mid = (flat.length / 2) & ~1;
        labelAt = [flat[mid], flat[mid + 1]];
      } else {
        flat = pathBetween(track, a, b);
        const mid = positionAtDistance(track, (a.cum + b.cum) / 2);
        labelAt = [mid.x, mid.y];
      }
      pathFeature.setGeometry(new LineString(flat, 'XY'));
      overlay.setPosition(labelAt);
    } else {
      pathFeature.setGeometry(undefined);
      overlay.setPosition(undefined);
    }
    emit();
  };

  const clearGhost = () => { ghostFeature.setGeometry(undefined); };

  const handleAtPixel = (map, pixel) => {
    let hit = -1;
    map.forEachFeatureAtPixel(pixel, (feature) => {
      if (feature.get('kind') !== 'handle' || !feature.getGeometry()) return false;
      hit = feature.get('idx');
      return true;
    }, { layerFilter: l => l === layer, hitTolerance: 6 });
    return hit;
  };

  const interaction = new PointerInteraction({
    handleDownEvent(evt) {
      if (!track || points.length === 0) return false;
      const idx = handleAtPixel(evt.map, evt.pixel);
      if (idx < 0) return false;
      dragIdx = idx;
      clearGhost();
      evt.map.getTargetElement().style.cursor = 'grabbing';
      // Claiming the down event keeps DragPan from panning the map instead.
      return true;
    },
    handleDragEvent(evt) {
      if (dragIdx < 0 || !track) return;
      const [x, y] = evt.coordinate;
      const next = snapToTrack(track, x, y, {
        prefer: points[dragIdx],
        preferSlack: evt.map.getView().getResolution() * DRAG_STICKY_PX,
      });
      if (next) {
        points[dragIdx] = next;
        render();
      }
    },
    handleUpEvent(evt) {
      dragIdx = -1;
      evt.map.getTargetElement().style.cursor = 'grab';
      return false;
    },
  });
  interaction.setActive(false);

  return {
    layer,
    overlay,
    interaction,

    setActive(active) {
      interaction.setActive(active);
      if (!active) {
        points = [];
        dragIdx = -1;
        clearGhost();
        render();
      }
    },

    setMode(nextMode) {
      mode = nextMode === 'air' ? 'air' : 'route';
      render();
    },

    /**
     * Rebuild the snapping index for new route data. Points already placed on
     * the same journey are carried over: when the full-resolution track
     * replaces the 100-point preview, each point keeps its distance along the
     * route and lands on the real track instead of the preview's chord.
     */
    setRoute(route) {
      const next = route?.coordinates?.length ? buildTrack(route) : null;
      const sameRoute = route?.id != null && route.id === routeId;
      if (!next || !sameRoute) {
        points = [];
      } else if (points.length && track) {
        const byDistance = track.fromProfile && next.fromProfile;
        points = points.map(p => (byDistance
          ? positionAtDistance(next, p.cum)
          : snapToTrack(next, p.x, p.y)));
      }
      track = next;
      routeId = route?.id ?? null;
      dragIdx = -1;
      clearGhost();
      render();
    },

    /**
     * Place the next point where the user clicked, if the click was close
     * enough to the route. Returns 'placed', 'miss', or 'handle' (a click on
     * an existing handle, which is the tail end of a grab, not a new point).
     */
    click(map, coordinate, pixel, tolerancePx) {
      if (!track) return 'miss';
      if (handleAtPixel(map, pixel) >= 0) return 'handle';
      const resolution = map.getView().getResolution();
      const hit = snapToTrack(track, coordinate[0], coordinate[1], { maxDist: resolution * tolerancePx });
      if (!hit) return 'miss';
      // A third click starts a fresh measurement from the new spot.
      if (points.length >= 2) points = [];
      points.push(hit);
      clearGhost();
      render();
      return 'placed';
    },

    /** Preview where the next click would land. Returns the cursor to show. */
    hover(map, coordinate, pixel, tolerancePx) {
      if (dragIdx >= 0) return 'grabbing';
      if (handleAtPixel(map, pixel) >= 0) {
        clearGhost();
        return 'grab';
      }
      const resolution = map.getView().getResolution();
      const hit = track && points.length < 2
        ? snapToTrack(track, coordinate[0], coordinate[1], { maxDist: resolution * tolerancePx })
        : null;
      if (hit) {
        ghostFeature.setGeometry(new Point([hit.x, hit.y]));
        ghostFeature.setStyle(handleStyle(points.length === 0 ? 'A' : 'B', true));
        return 'pointer';
      }
      clearGhost();
      return 'crosshair';
    },

    clearHover: clearGhost,

    getPoints() { return points.slice(); },
    setPoints(next) { points = next.slice(0, 2); render(); },

    destroy() {
      source.clear();
      overlay.setPosition(undefined);
    },
  };
}
