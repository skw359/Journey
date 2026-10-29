'use strict';

/**
 * RouteStore — the "lots of memory" part of the desktop app.
 *
 * Holds every journey's full-resolution coordinates in typed arrays and answers the
 * Atlas endpoints (`/api/alltime-map-data`, `/api/heatmap-grid`) byte-for-byte the way
 * `server/routes/maps.js` would — except from RAM, in a few milliseconds, instead of
 * having Postgres re-parse ~2M jsonb points on every pan.
 *
 * It also caches full-resolution journey detail responses (`GET /api/routes/:id`) as
 * JSON text and derives the down-sampled variants the Dashboard asks for, mirroring the
 * `sampleIndices` logic in `server/routes/journeys.js`.
 *
 * The store is pure logic (no Electron, no network) so it can run inside a worker
 * thread and be unit-tested against the real server handlers.
 *
 * Seed data is the server's own `GET /api/alltime-map-data?maxPoints=0` response, so
 * formatting decisions the server already made (distance strings, ISO timestamps,
 * travelMode fallback, stats, bounds) are reused verbatim rather than re-derived.
 */

const RESPONSE_CACHE_LIMIT = 16;

/* ------------------------------------------------------------------------------------ */
/* Helpers ported from server/routes/maps.js — keep these textually faithful.            */
/* ------------------------------------------------------------------------------------ */

/** Server: `downsample(coords, max)` — evenly spaced picks using Math.round. */
function pickIndicesRound(total, max) {
    if (max <= 0 || total <= max) return null; // null = "keep everything"
    if (max === 1) return [0];
    if (max === 2) return [0, total - 1];
    const result = [0];
    const step = (total - 1) / (max - 1);
    for (let i = 1; i < max - 1; i++) {
        result.push(Math.round(i * step));
    }
    result.push(total - 1);
    return result;
}

/** Server (journeys.js): `sampleIndices(total, max)` — same shape but Math.floor. */
function sampleIndicesFloor(total, max) {
    if (max <= 0 || total <= max) {
        return Array.from({ length: total }, (_, i) => i);
    }
    if (max === 1) return [0];
    if (max === 2) return [0, total - 1];
    const step = (total - 1) / (max - 1);
    const indices = [0];
    for (let i = 1; i < max - 1; i++) {
        indices.push(Math.floor(i * step));
    }
    indices.push(total - 1);
    return indices;
}

function pointInBounds(lat, lon, b) {
    return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Liang–Barsky clip, exactly as the server does it. */
function segmentIntersectsBounds(lat1, lon1, lat2, lon2, b) {
    if (pointInBounds(lat1, lon1, b) || pointInBounds(lat2, lon2, b)) return true;

    const minLat = Math.min(lat1, lat2);
    const maxLat = Math.max(lat1, lat2);
    const minLon = Math.min(lon1, lon2);
    const maxLon = Math.max(lon1, lon2);
    if (maxLat < b.south || minLat > b.north || maxLon < b.west || minLon > b.east) {
        return false;
    }

    const dx = lon2 - lon1;
    const dy = lat2 - lat1;
    const p = [-dx, dx, -dy, dy];
    const q = [lon1 - b.west, b.east - lon1, lat1 - b.south, b.north - lat1];

    let t0 = 0;
    let t1 = 1;

    for (let i = 0; i < 4; i++) {
        const pi = p[i];
        const qi = q[i];
        if (pi === 0) {
            if (qi < 0) return false;
            continue;
        }
        const r = qi / pi;
        if (pi < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return false;
    }

    return true;
}

/**
 * Server: `routeIntersectsBounds(coordinates, startLat, startLon, endLat, endLon)`.
 * `lat`/`lon` hold only the finite coordinate pairs, in order — the server skips
 * malformed entries without resetting its `prev` point, so a compacted array walks the
 * exact same segments.
 */
function routeIntersectsBounds(rec, b) {
    if (rec.startLat != null && rec.startLon != null && pointInBounds(rec.startLat, rec.startLon, b)) return true;
    if (rec.endLat != null && rec.endLon != null && pointInBounds(rec.endLat, rec.endLon, b)) return true;

    const n = rec.n;
    if (n === 0) return false;

    // Fast reject: the query box is disjoint from the route's bounding box, so no point
    // can be inside it and no segment can cross it.
    if (rec.maxLat < b.south || rec.minLat > b.north || rec.maxLon < b.west || rec.minLon > b.east) {
        return false;
    }

    const lat = rec.lat;
    const lon = rec.lon;
    if (pointInBounds(lat[0], lon[0], b)) return true;
    for (let i = 1; i < n; i++) {
        if (pointInBounds(lat[i], lon[i], b)) return true;
        if (segmentIntersectsBounds(lat[i - 1], lon[i - 1], lat[i], lon[i], b)) return true;
    }
    return false;
}

/** Same query-string parsing as the server (`Number.parseInt`, clamp at 0, default 100). */
function parseMaxPoints(raw, fallback) {
    const parsed = raw != null ? Number.parseInt(raw, 10) : fallback;
    return Number.isFinite(parsed) ? Math.max(parsed, 0) : fallback;
}

/** `boundsQ.split(',').map(Number)` -> `{south, west, north, east}` or null. */
function parseBounds(raw) {
    if (!raw) return null;
    const [south, west, north, east] = String(raw).split(',').map(Number);
    const ok = Number.isFinite(south) && Number.isFinite(west)
        && Number.isFinite(north) && Number.isFinite(east);
    return ok ? { south, west, north, east } : null;
}

function heatmapCellSize(zoom) {
    if (zoom >= 15) return 0.0002;
    if (zoom >= 13) return 0.0005;
    if (zoom >= 11) return 0.001;
    if (zoom >= 9) return 0.002;
    if (zoom >= 7) return 0.005;
    return 0.01;
}

/** JSON number formatting identical to JSON.stringify for finite numbers. */
function num(v) {
    return Number.isFinite(v) ? String(v) : 'null';
}

function isCleanPair(c) {
    return Array.isArray(c) && c.length === 2
        && typeof c[0] === 'number' && Number.isFinite(c[0])
        && typeof c[1] === 'number' && Number.isFinite(c[1]);
}

/* ------------------------------------------------------------------------------------ */
/* Route records                                                                         */
/* ------------------------------------------------------------------------------------ */

/**
 * Build the in-memory record for one route object from the all-time payload.
 * `raw` (the original coordinate array) is kept only when a route contains malformed
 * entries, so the exotic path stays exact without costing memory on real data.
 */
function buildRecord(route) {
    const coords = Array.isArray(route.coordinates) ? route.coordinates : [];
    let clean = true;
    for (let i = 0; i < coords.length; i++) {
        if (!isCleanPair(coords[i])) { clean = false; break; }
    }

    let n = 0;
    let lat;
    let lon;
    if (clean) {
        n = coords.length;
        lat = new Float64Array(n);
        lon = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            lat[i] = coords[i][0];
            lon[i] = coords[i][1];
        }
    } else {
        const la = [];
        const lo = [];
        for (const c of coords) {
            if (!Array.isArray(c) || c.length < 2) continue;
            const a = c[0];
            const o = c[1];
            if (!Number.isFinite(a) || !Number.isFinite(o)) continue;
            la.push(a);
            lo.push(o);
        }
        n = la.length;
        lat = Float64Array.from(la);
        lon = Float64Array.from(lo);
    }

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < n; i++) {
        const a = lat[i];
        const o = lon[i];
        if (a < minLat) minLat = a;
        if (a > maxLat) maxLat = a;
        if (o < minLon) minLon = o;
        if (o > maxLon) maxLon = o;
    }

    // Everything before "coordinates" and everything after it, pre-serialized in the
    // server's key order, so a response is a straight concatenation.
    const head = JSON.stringify({
        id: route.id,
        name: route.name,
        date: route.date,
        distance: route.distance,
        duration: route.duration,
        topSpeed: route.topSpeed,
        avgSpeed: route.avgSpeed,
        startTime: route.startTime,
        endTime: route.endTime,
    });
    const tail = JSON.stringify({
        startCoord: route.startCoord,
        endCoord: route.endCoord,
        travelMode: route.travelMode,
    });

    const startCoord = Array.isArray(route.startCoord) ? route.startCoord : null;
    const endCoord = Array.isArray(route.endCoord) ? route.endCoord : null;

    return {
        id: route.id,
        n,
        lat,
        lon,
        rawLength: coords.length,
        raw: clean ? null : coords,
        minLat, maxLat, minLon, maxLon,
        startLat: startCoord ? startCoord[0] : null,
        startLon: startCoord ? startCoord[1] : null,
        endLat: endCoord ? endCoord[0] : null,
        endLon: endCoord ? endCoord[1] : null,
        // Server: `row.start_time ? row.start_time.getTime() : null`; the ISO text
        // round-trips to the same millisecond value.
        startMs: route.startTime ? Date.parse(route.startTime) : null,
        endMs: route.endTime ? Date.parse(route.endTime) : null,
        headJson: head.slice(0, -1) + ',"coordinates":',
        tailJson: ',' + tail.slice(1),
        fullCoordsJson: null, // lazily cached full-resolution coordinate text
    };
}

/** Serialize the coordinates of a record, optionally at the given index picks. */
function coordsJson(rec, picks) {
    if (rec.raw) {
        // Malformed data path: operate on the raw array like the server does.
        const src = picks ? picks.map((i) => rec.raw[i]) : rec.raw;
        return JSON.stringify(src);
    }
    const lat = rec.lat;
    const lon = rec.lon;
    if (!picks) {
        if (rec.fullCoordsJson) return rec.fullCoordsJson;
        const n = rec.n;
        if (n === 0) return '[]';
        const parts = new Array(n);
        for (let i = 0; i < n; i++) {
            parts[i] = '[' + num(lat[i]) + ',' + num(lon[i]) + ']';
        }
        rec.fullCoordsJson = '[' + parts.join(',') + ']';
        return rec.fullCoordsJson;
    }
    const parts = new Array(picks.length);
    for (let k = 0; k < picks.length; k++) {
        const i = picks[k];
        parts[k] = '[' + num(lat[i]) + ',' + num(lon[i]) + ']';
    }
    return '[' + parts.join(',') + ']';
}

/* ------------------------------------------------------------------------------------ */
/* The store                                                                             */
/* ------------------------------------------------------------------------------------ */

class RouteStore {
    constructor() {
        this.generation = 0;
        this.detailLimitBytes = 768 * 1024 * 1024;
        this.clear();
    }

    clear() {
        /** @type {Array<ReturnType<typeof buildRecord>>} */
        this.records = [];
        this.byId = new Map();
        this.statsJson = 'null';
        this.boundsJson = 'null';
        this.totalPoints = 0;
        this.warmedAt = 0;
        this.generation += 1;
        this.responseCache = new Map();
        /** @type {Map<string, {text: string, bytes: number, at: number}>} */
        this.details = new Map();
        this.detailBytes = 0;
    }

    get ready() {
        return this.warmedAt > 0;
    }

    get routeCount() {
        return this.records.length;
    }

    /** Rough resident size of the coordinate arrays (bytes). */
    get pointBytes() {
        return this.totalPoints * 16;
    }

    /**
     * Load (or reload) the store from a parsed `GET /api/alltime-map-data?maxPoints=0`
     * payload. Replaces everything atomically. Cached details are kept.
     *
     * When the raw response `text` is also given, each route's full-resolution
     * coordinate text is sliced straight out of it (V8 keeps a reference, no copy), so a
     * later `maxPoints=0` request costs a concatenation instead of re-serializing
     * millions of numbers.
     */
    loadAllTimePayload(payload, text) {
        const routes = Array.isArray(payload?.routes) ? payload.routes : [];
        const records = new Array(routes.length);
        const byId = new Map();
        let totalPoints = 0;
        let cursor = typeof text === 'string' ? text.indexOf('{"routes":[') : -1;
        for (let i = 0; i < routes.length; i++) {
            const rec = buildRecord(routes[i]);
            records[i] = rec;
            byId.set(String(rec.id), rec);
            totalPoints += rec.n;
            if (cursor >= 0 && !rec.raw) {
                // `"coordinates":` can only occur as a key (quotes inside string values
                // are escaped), and a numeric array cannot contain `,"startCoord":`.
                const keyIdx = text.indexOf('"coordinates":', cursor);
                const start = keyIdx >= 0 ? keyIdx + 14 : -1;
                const end = start >= 0 ? text.indexOf(',"startCoord":', start) : -1;
                if (start >= 0 && end > start && text.charCodeAt(start) === 91 /* [ */ && text.charCodeAt(end - 1) === 93 /* ] */) {
                    rec.fullCoordsJson = text.slice(start, end);
                    cursor = end;
                } else {
                    cursor = -1; // give up on slicing; lazy path still works
                }
            }
        }
        this.records = records;
        this.byId = byId;
        this.totalPoints = totalPoints;
        this.statsJson = JSON.stringify(payload?.stats ?? null);
        this.boundsJson = JSON.stringify(payload?.bounds ?? null);
        this.warmedAt = Date.now();
        this.generation += 1;
        this.responseCache.clear();
    }

    /** Forget the map data (details are kept until explicitly dropped). */
    invalidateMapData() {
        this.records = [];
        this.byId = new Map();
        this.statsJson = 'null';
        this.boundsJson = 'null';
        this.totalPoints = 0;
        this.warmedAt = 0;
        this.generation += 1;
        this.responseCache.clear();
    }

    /** Ids currently held, in server order. */
    ids() {
        return this.records.map((r) => r.id);
    }

    /* ---------------------------- /api/alltime-map-data ---------------------------- */

    /**
     * @param {URLSearchParams|Record<string,string>} query
     * @returns {string} JSON text identical to the server's `res.json(...)` output
     */
    allTimeMapData(query) {
        const q = toQueryObject(query);
        const cacheKey = 'a|' + (q.maxPoints ?? '') + '|' + (q.bounds ?? '');
        const cached = this.responseCache.get(cacheKey);
        if (cached) return cached;

        const maxPoints = parseMaxPoints(q.maxPoints, 100);
        const bounds = parseBounds(q.bounds);

        let text;
        if (this.records.length === 0) {
            text = JSON.stringify({
                routes: [],
                stats: {
                    totalRoutes: 0,
                    totalDistance: 0,
                    totalTime: 0,
                    earliestDate: null,
                    latestDate: null,
                },
                bounds: null,
            });
        } else {
            const chunks = [];
            for (const rec of this.records) {
                if (bounds && !routeIntersectsBounds(rec, bounds)) continue;
                const picks = maxPoints === 0 ? null : pickIndicesRound(rec.rawLength, maxPoints);
                chunks.push(rec.headJson + coordsJson(rec, picks) + rec.tailJson);
            }
            text = '{"routes":[' + chunks.join(',') + '],"stats":' + this.statsJson + ',"bounds":' + this.boundsJson + '}';
        }

        this.remember(cacheKey, text);
        return text;
    }

    /* ------------------------------ /api/heatmap-grid ------------------------------ */

    heatmapGrid(query) {
        const q = toQueryObject(query);
        const cacheKey = 'h|' + (q.start ?? '') + '|' + (q.end ?? '') + '|' + (q.zoom ?? '') + '|' + (q.bounds ?? '');
        const cached = this.responseCache.get(cacheKey);
        if (cached) return cached;

        let text;
        if (this.records.length === 0) {
            text = JSON.stringify({ cells: [], totalPoints: 0 });
        } else {
            const startQ = q.start ? Date.parse(q.start) : null;
            const endQ = q.end ? Date.parse(q.end) : null;
            const zoom = parseInt(q.zoom) || 4; // mirrors the server (no radix, `|| 4`)
            const CELL_SIZE = heatmapCellSize(zoom);
            const bounds = q.bounds ? parseBounds(q.bounds) : null;
            const dateFiltered = startQ != null || endQ != null;

            // Padded query box, as on the server. Routes whose bbox misses it entirely are
            // skipped without touching their points.
            let pSouth = -Infinity, pNorth = Infinity, pWest = -Infinity, pEast = Infinity;
            if (bounds) {
                const pad = CELL_SIZE * 5;
                pSouth = bounds.south - pad;
                pNorth = bounds.north + pad;
                pWest = bounds.west - pad;
                pEast = bounds.east + pad;
            }

            const grid = new Map();
            let totalPoints = 0;
            const KY_OFF = 1 << 20;
            const KX_OFF = 1 << 21;
            const KX_SPAN = 1 << 22;

            for (const rec of this.records) {
                if (rec.rawLength === 0) continue;

                const startMs = rec.startMs;
                const endMs = rec.endMs;
                const timed = startMs != null && endMs != null && endMs >= startMs;

                if (dateFiltered) {
                    if (timed) {
                        if (startQ != null && endMs < startQ) continue;
                        if (endQ != null && startMs > endQ) continue;
                    } else {
                        continue;
                    }
                }

                if (bounds && (rec.maxLat < pSouth || rec.minLat > pNorth || rec.maxLon < pWest || rec.minLon > pEast)) {
                    continue;
                }

                const perPointDate = timed && dateFiltered;
                const denom = Math.max(rec.rawLength - 1, 1);

                if (rec.raw) {
                    // Malformed data path: the literal server loop over the raw array.
                    const coords = rec.raw;
                    for (let i = 0; i < coords.length; i++) {
                        if (perPointDate) {
                            const ts = startMs + Math.floor((endMs - startMs) * (i / denom));
                            if (startQ != null && ts < startQ) continue;
                            if (endQ != null && ts > endQ) continue;
                        }
                        const c = coords[i];
                        if (!Array.isArray(c)) continue; // the server would throw here (500)
                        const lat = c[0];
                        const lon = c[1];
                        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                        if (bounds && (lat < pSouth || lat > pNorth || lon < pWest || lon > pEast)) continue;
                        const ky = Math.round(lat / CELL_SIZE);
                        const kx = Math.round(lon / CELL_SIZE);
                        const key = (ky + KY_OFF) * KX_SPAN + (kx + KX_OFF);
                        grid.set(key, (grid.get(key) || 0) + 1);
                        totalPoints++;
                    }
                    continue;
                }

                const lat = rec.lat;
                const lon = rec.lon;
                const n = rec.n;
                for (let i = 0; i < n; i++) {
                    if (perPointDate) {
                        const ts = startMs + Math.floor((endMs - startMs) * (i / denom));
                        if (startQ != null && ts < startQ) continue;
                        if (endQ != null && ts > endQ) continue;
                    }
                    const a = lat[i];
                    const o = lon[i];
                    if (bounds && (a < pSouth || a > pNorth || o < pWest || o > pEast)) continue;
                    const ky = Math.round(a / CELL_SIZE);
                    const kx = Math.round(o / CELL_SIZE);
                    const key = (ky + KY_OFF) * KX_SPAN + (kx + KX_OFF);
                    grid.set(key, (grid.get(key) || 0) + 1);
                    totalPoints++;
                }
            }

            const parts = new Array(grid.size);
            let k = 0;
            for (const [key, weight] of grid) {
                const ky = Math.floor(key / KX_SPAN) - KY_OFF;
                const kx = (key % KX_SPAN) - KX_OFF;
                // Same expression as the server: Math.round(v / CELL) * CELL, then a
                // String->Number round trip, which is exact for shortest-repr doubles.
                parts[k++] = '[' + num(ky * CELL_SIZE) + ',' + num(kx * CELL_SIZE) + ',' + weight + ']';
            }
            text = '{"cells":[' + parts.join(',') + '],"totalPoints":' + totalPoints + '}';
        }

        this.remember(cacheKey, text);
        return text;
    }

    /* ------------------------------ GET /api/routes/:id ---------------------------- */

    /** Store the server's full-resolution (`maxPoints=0`) detail response text. */
    putDetail(id, text) {
        const key = String(id);
        const prev = this.details.get(key);
        if (prev) this.detailBytes -= prev.bytes;
        const bytes = Buffer.byteLength(text);
        this.details.set(key, { text, bytes, at: Date.now() });
        this.detailBytes += bytes;
        this.evictDetails();
    }

    hasDetail(id) {
        return this.details.has(String(id));
    }

    dropDetail(id) {
        const key = String(id);
        const prev = this.details.get(key);
        if (prev) {
            this.detailBytes -= prev.bytes;
            this.details.delete(key);
        }
    }

    clearDetails() {
        this.details.clear();
        this.detailBytes = 0;
    }

    evictDetails() {
        if (this.detailBytes <= this.detailLimitBytes) return;
        // Oldest first (Map preserves insertion order; reads re-insert to keep hot ones).
        for (const [key, entry] of this.details) {
            this.details.delete(key);
            this.detailBytes -= entry.bytes;
            if (this.detailBytes <= this.detailLimitBytes) break;
        }
    }

    /**
     * Produce the response for `GET /api/routes/:id?maxPoints=...` from the cached full
     * detail. Returns null when the route is not cached.
     */
    routeDetail(id, query) {
        const key = String(id);
        const entry = this.details.get(key);
        if (!entry) return null;
        // Touch for LRU order.
        this.details.delete(key);
        this.details.set(key, entry);

        const q = toQueryObject(query);
        const parsedMaxPoints = q.maxPoints != null ? Number.parseInt(q.maxPoints, 10) : null;
        const maxPoints = Number.isFinite(parsedMaxPoints) ? Math.max(parsedMaxPoints, 0) : null;

        if (maxPoints == null || maxPoints === 0) return entry.text;

        const route = JSON.parse(entry.text);
        const fullCoords = Array.isArray(route.coordinates) ? route.coordinates : [];
        if (!(fullCoords.length > maxPoints)) return entry.text;

        const keep = sampleIndicesFloor(fullCoords.length, maxPoints);
        const projectSeries = (series) => {
            if (!Array.isArray(series) || series.length === 0) return [];
            return keep.map((idx) => {
                const sourceIdx = Math.min(idx, series.length - 1);
                return series[sourceIdx];
            });
        };

        route.coordinates = keep.map((idx) => fullCoords[idx]);
        route.profileTimeMs = projectSeries(route.profileTimeMs);
        route.profileDistMi = projectSeries(route.profileDistMi);
        route.profileElevM = projectSeries(route.profileElevM);
        route.profileSpeedMph = projectSeries(route.profileSpeedMph);
        route.isFullResolution = false;
        return JSON.stringify(route);
    }

    /* ------------------------------------ misc ------------------------------------- */

    remember(key, text) {
        if (this.responseCache.size >= RESPONSE_CACHE_LIMIT) {
            const oldest = this.responseCache.keys().next().value;
            this.responseCache.delete(oldest);
        }
        this.responseCache.set(key, text);
    }

    status() {
        return {
            ready: this.ready,
            routes: this.records.length,
            points: this.totalPoints,
            pointBytes: this.pointBytes,
            warmedAt: this.warmedAt,
            generation: this.generation,
            details: this.details.size,
            detailBytes: this.detailBytes,
        };
    }
}

function toQueryObject(query) {
    if (!query) return {};
    if (typeof query.get === 'function') {
        const out = {};
        for (const [k, v] of query) {
            if (!(k in out)) out[k] = v; // first value wins (Express would build an array)
        }
        return out;
    }
    return query;
}

module.exports = {
    RouteStore,
    // exported for tests
    pickIndicesRound,
    sampleIndicesFloor,
    parseMaxPoints,
    parseBounds,
    heatmapCellSize,
    routeIntersectsBounds,
};
