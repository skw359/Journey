const fs = require('fs');
const path = require('path');

// Real US state boundaries, so "states visited" means the point is actually
// inside the state. The previous bounding-box test credited a point to every
// state whose lat/lon rectangle contained it, which put Las Vegas in
// California (CA's rectangle reaches east to -114.13) and every trip around
// the Beltway in both Maryland and Virginia at once.
//
// us-states.geojson is Census TIGER-derived (public domain), trimmed to the
// 50 states + DC and rounded to 5 decimal places (~1 m).

const GEOJSON_PATH = path.join(__dirname, '..', 'data', 'us-states.geojson');

// Candidate lookup grid. States are indexed into 1-degree cells so a point
// test compares against the handful of states near it instead of all 51.
const GRID_DEG = 1;

// Ray casting only ever counts edges that straddle the point's latitude, so
// each ring buckets its edges into latitude bands. Testing a point against
// Maryland then means ~50 edges instead of its whole ~2,000-vertex outline.
const BAND_DEG = 0.05;

// Coordinates within ~110 m of each other resolve to the same state, so the
// aggregate helper tests one point per cell — the same trade cities.js and
// places.js make when caching geocoder answers. Cell keys are packed into a
// single integer rather than a string: over a full history the dedupe key is
// built millions of times, and toFixed() there costs more than every
// point-in-polygon test combined.
const CELL_SCALE = 1000;                     // 3 decimal places, ~110 m
const CELL_LON_SPAN = 360 * CELL_SCALE + 1;  // stride, so lat and lon can't collide

let _index = null;

function gridKey(latCell, lonCell) {
    return `${latCell}|${lonCell}`;
}

function cellKey(lat, lon) {
    return (Math.round(lat * CELL_SCALE) + 90 * CELL_SCALE) * CELL_LON_SPAN
        + Math.round(lon * CELL_SCALE) + 180 * CELL_SCALE;
}

function ringBbox(ring) {
    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    for (const [lon, lat] of ring) {
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
    }
    return [south, west, north, east];
}

/**
 * Index one ring: its bbox, and its edges bucketed by latitude band.
 * Horizontal edges are dropped — they can never cross a horizontal ray.
 */
function buildRing(ring) {
    const bbox = ringBbox(ring);
    const minBand = Math.floor(bbox[0] / BAND_DEG);
    const maxBand = Math.floor(bbox[2] / BAND_DEG);
    const bands = [];
    for (let b = minBand; b <= maxBand; b++) bands.push([]);

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi === yj) continue;
        const lo = Math.floor(Math.min(yi, yj) / BAND_DEG);
        const hi = Math.floor(Math.max(yi, yj) / BAND_DEG);
        const edge = [xi, yi, xj, yj];
        for (let b = lo; b <= hi; b++) bands[b - minBand].push(edge);
    }

    return { bbox, minBand, bands };
}

/**
 * Build the shape list and the 1-degree candidate grid. One "shape" is one
 * polygon of one state: its outer ring plus any holes.
 */
function buildIndex() {
    const fc = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
    const shapes = [];

    for (const feature of fc.features) {
        const { code } = feature.properties;
        const { type, coordinates } = feature.geometry;
        const polygons = type === 'Polygon' ? [coordinates] : coordinates;
        for (const rings of polygons) {
            if (!rings.length) continue;
            shapes.push({
                code,
                outer: buildRing(rings[0]),
                holes: rings.slice(1).map(buildRing),
            });
        }
    }

    const grid = new Map();
    for (const shape of shapes) {
        const [south, west, north, east] = shape.outer.bbox;
        for (let lat = Math.floor(south / GRID_DEG); lat <= Math.floor(north / GRID_DEG); lat++) {
            for (let lon = Math.floor(west / GRID_DEG); lon <= Math.floor(east / GRID_DEG); lon++) {
                const key = gridKey(lat, lon);
                const bucket = grid.get(key);
                if (bucket) bucket.push(shape);
                else grid.set(key, [shape]);
            }
        }
    }

    return { shapes, grid };
}

function getIndex() {
    if (!_index) _index = buildIndex();
    return _index;
}

/**
 * Even-odd ray casting against an indexed ring. Coordinates inside the ring
 * are stored GeoJSON order — [lon, lat].
 */
function pointInRing(lat, lon, ring) {
    const [south, west, north, east] = ring.bbox;
    if (lat < south || lat > north || lon < west || lon > east) return false;

    const band = ring.bands[Math.floor(lat / BAND_DEG) - ring.minBand];
    if (!band) return false;

    let inside = false;
    for (const [xi, yi, xj, yj] of band) {
        if ((yi > lat) !== (yj > lat)
            && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function pointInShape(lat, lon, shape) {
    if (!pointInRing(lat, lon, shape.outer)) return false;
    return !shape.holes.some((hole) => pointInRing(lat, lon, hole));
}

/**
 * The USPS code of the state containing a coordinate.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {string|null} e.g. "NV", or null outside the 50 states + DC
 *   (ocean, Canada, Mexico, territories).
 */
function stateForPoint(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const { grid } = getIndex();
    const candidates = grid.get(gridKey(Math.floor(lat / GRID_DEG), Math.floor(lon / GRID_DEG)));
    if (!candidates) return null;
    for (const shape of candidates) {
        if (pointInShape(lat, lon, shape)) return shape.code;
    }
    return null;
}

/**
 * The set of states a list of coordinates passes through.
 *
 * @param {Array<[number, number]>} coordinates - [[lat, lon], ...]
 * @param {{ sampleEvery?: number }} [options] - test every Nth coordinate
 *   (default 1). A 1 Hz track at driving speed is ~13 m per point, so
 *   sampling stays far finer than a state.
 * @returns {string[]} sorted USPS codes, e.g. ["MD", "NV", "UT"].
 */
function statesForCoords(coordinates, { sampleEvery = 1 } = {}) {
    const found = new Set();
    if (!Array.isArray(coordinates)) return [];

    const seen = new Map();
    const step = Math.max(1, Math.floor(sampleEvery));

    for (let i = 0; i < coordinates.length; i += step) {
        const coord = coordinates[i];
        if (!Array.isArray(coord) || coord.length < 2) continue;
        const [lat, lon] = coord;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const key = cellKey(lat, lon);
        let state = seen.get(key);
        if (state === undefined) {
            state = stateForPoint(lat, lon);
            seen.set(key, state);
        }
        if (state) found.add(state);
    }

    return [...found].sort();
}

module.exports = { stateForPoint, statesForCoords };
