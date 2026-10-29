'use strict';

/**
 * Byte-for-byte equivalence: the in-memory RouteStore vs. the REAL server handlers in
 * `server/routes/maps.js` and `server/routes/journeys.js`, driven by real tenant rows.
 *
 * The server modules are loaded with their database layer stubbed out (module cache
 * injection), so the exact production code runs against fixture rows — no Postgres, no
 * writes. Fixture: tests/fixtures/tenants.json (create with tests/fixtures/dump-fixture.cjs).
 *
 * Run: node --test --test-concurrency=1 tests/
 * Set JOURNEY_TEST_TENANT=<schema> to pick a tenant; defaults to the largest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { RouteStore } = require('../src/main/data/store');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const FIXTURE = path.join(__dirname, 'fixtures', 'tenants.json');

if (!fs.existsSync(FIXTURE)) {
    test('fixture present', { skip: 'tests/fixtures/tenants.json missing — run tests/fixtures/dump-fixture.cjs' }, () => {});
    return;
}

/* ------------------------------ load fixture ------------------------------ */

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const tenantName = process.env.JOURNEY_TEST_TENANT
    || Object.keys(fixture).sort((a, b) => fixture[b].routes.length - fixture[a].routes.length)[0];
const tenant = fixture[tenantName];

/** pg returns timestamptz columns as Date objects; the server code relies on that. */
function reviveRow(row) {
    const r = { ...row };
    for (const k of ['start_time', 'end_time', 'uploaded_at', 'created_at', 'deleted_at']) {
        if (r[k] != null) r[k] = new Date(r[k]);
    }
    return r;
}

const rows = tenant.routes.map(reviveRow);
const details = tenant.details.map((d) => ({
    route: reviveRow(d.route),
    waypoints: d.waypoints.map(reviveRow),
    photos: d.photos.map(reviveRow),
}));

/* ------------------------- load real server modules ----------------------- */

const detailById = new Map(details.map((d) => [d.route.id, d]));

// Stub `server/db.js` before anything requires it.
const dbPath = require.resolve(path.join(SERVER, 'db.js'));
const realDbSource = fs.readFileSync(dbPath, 'utf8');
// toApiRoute/toApiWaypoint/toApiPhoto/toApiSummary are pure — extract them from the real
// module by evaluating it with `pg` and friends stubbed out.
const Module = require('node:module');
function loadPureDbHelpers() {
    const m = new Module(dbPath, module);
    m.filename = dbPath;
    m.paths = Module._nodeModulePaths(path.dirname(dbPath));
    const patched = realDbSource
        .replace(/require\(['"]pg['"]\)/, '({ Pool: class { constructor() {} on() {} } })')
        .replace(/require\(['"]bcrypt['"]\)/, '({})');
    m._compile(patched, dbPath);
    return m.exports;
}
const pureDb = loadPureDbHelpers();

const fakeClient = {
    async query(sql, params) {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (/FROM routes WHERE distance >= \$1/.test(text)) {
            const min = params[0];
            const cols = text.match(/SELECT (.+?) FROM routes/)[1].split(',').map((s) => s.trim());
            return { rows: rows.filter((r) => Number(r.distance) >= min).map((r) => pick(r, cols)) };
        }
        if (text === 'SELECT * FROM routes WHERE id = $1') {
            const d = detailById.get(params[0]);
            return { rows: d ? [d.route] : [] };
        }
        if (/FROM waypoints WHERE route_id = \$1/.test(text)) {
            const d = detailById.get(params[0]);
            return { rows: d ? d.waypoints : [] };
        }
        if (/FROM photos WHERE route_id = \$1/.test(text)) {
            const d = detailById.get(params[0]);
            return { rows: d ? d.photos : [] };
        }
        throw new Error('unexpected SQL in test stub: ' + text);
    },
};

function pick(row, cols) {
    const out = {};
    for (const c of cols) out[c] = row[c];
    return out;
}

require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        ...pureDb,
        pool: { query: async () => ({ rows: [] }) },
        queryTenant: async (userId, sql, params) => fakeClient.query(sql, params),
        withTenantClient: async (userId, cb) => cb(fakeClient),
    },
};

// Silence the server logger.
const loggerPath = require.resolve(path.join(SERVER, 'utils', 'logger.js'));
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop, success: noop, step: noop, scope: () => silent };
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: silent };

// Trash utilities touch the filesystem/pool on require; journeys.js only needs the names.
const trashPath = require.resolve(path.join(SERVER, 'utils', 'trash.js'));
require.cache[trashPath] = { id: trashPath, filename: trashPath, loaded: true, exports: new Proxy({}, { get: () => noop }) };

const mapsRouter = require(path.join(SERVER, 'routes', 'maps.js'));
const journeysRouter = require(path.join(SERVER, 'routes', 'journeys.js'));

function findHandler(router, method, routePath) {
    const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`);
    const stack = layer.route.stack.filter((s) => s.method === method);
    return stack[stack.length - 1].handle;
}

/** Invoke an Express handler and capture what `res.json` would have serialized. */
async function runServer(handler, { query = {}, params = {} } = {}) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(obj) { resolve({ status: this.statusCode, text: JSON.stringify(obj) }); },
            send(body) { resolve({ status: this.statusCode, text: String(body) }); },
        };
        Promise.resolve(handler({ query, params, userId: 'test-user' }, res)).catch(reject);
    });
}

const serverAllTime = findHandler(mapsRouter, 'get', '/alltime-map-data');
const serverHeatmap = findHandler(mapsRouter, 'get', '/heatmap-grid');
const serverDetail = findHandler(journeysRouter, 'get', '/:id');

/* ------------------------------ deterministic RNG ------------------------- */

let seed = 0x9e3779b9;
function rand() {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return (seed >>> 0) / 0x100000000;
}

/* --------------------------------- tests ---------------------------------- */

let store;
let overall; // bounds of all data, from the server payload

test(`warm store from server payload (${tenantName}, ${rows.length} routes)`, async () => {
    const full = await runServer(serverAllTime, { query: { maxPoints: '0' } });
    assert.equal(full.status, 200);
    const payload = JSON.parse(full.text);
    overall = payload.bounds;
    store = new RouteStore();
    const t0 = performance.now();
    store.loadAllTimePayload(payload, full.text);
    const ms = performance.now() - t0;
    assert.equal(store.routeCount, payload.routes.length);
    console.log(`  loaded ${store.routeCount} routes / ${store.totalPoints.toLocaleString()} points in ${ms.toFixed(0)}ms, payload ${(full.text.length / 1e6).toFixed(1)}MB`);

    // The full-resolution request must round-trip exactly (sliced-text fast path).
    const t1 = performance.now();
    const mine = store.allTimeMapData({ maxPoints: '0' });
    console.log(`  maxPoints=0 served from memory in ${(performance.now() - t1).toFixed(0)}ms (sliced)`);
    assert.equal(mine.length, full.text.length);
    assert.ok(mine === full.text, 'full payload differs');

    // ...and without the raw text (lazy re-serialization path) as well.
    const lazy = new RouteStore();
    lazy.loadAllTimePayload(payload);
    const t2 = performance.now();
    const rebuilt = lazy.allTimeMapData({ maxPoints: '0' });
    console.log(`  maxPoints=0 rebuilt from typed arrays in ${(performance.now() - t2).toFixed(0)}ms`);
    assert.ok(rebuilt === full.text, 'rebuilt full payload differs');
});

test('alltime-map-data: maxPoints variants without bounds', async () => {
    for (const maxPoints of ['100', '1', '2', '3', '7', '50', '199', '200', '1000', '99999', '-5', 'abc', '', undefined, '12.9', '0x10']) {
        const query = maxPoints === undefined ? {} : { maxPoints };
        const expected = await runServer(serverAllTime, { query });
        const actual = store.allTimeMapData(query);
        assert.ok(actual === expected.text, `mismatch for maxPoints=${JSON.stringify(maxPoints)}`);
    }
});

test('alltime-map-data: random bounded detail requests match', async () => {
    const [s0, w0] = overall.southwest;
    const [n0, e0] = overall.northeast;
    const latSpan = n0 - s0;
    const lonSpan = e0 - w0;
    let served = 0;
    let totalMs = 0;
    for (let i = 0; i < 60; i++) {
        // Window sizes from continental to street level.
        const frac = Math.pow(10, -rand() * 4); // 1 .. 0.0001 of the span
        const h = latSpan * frac;
        const w = lonSpan * frac;
        const south = s0 + rand() * (latSpan - h);
        const west = w0 + rand() * (lonSpan - w);
        const bounds = `${south},${west},${south + h},${west + w}`;
        const maxPoints = String([200, 500, 1000, 5000, 0][i % 5]);
        const query = { maxPoints, bounds };
        const expected = await runServer(serverAllTime, { query });
        const t0 = performance.now();
        const actual = store.allTimeMapData(query);
        totalMs += performance.now() - t0;
        served++;
        assert.ok(actual === expected.text, `mismatch for ${JSON.stringify(query)}`);
    }
    // Degenerate / edge inputs.
    for (const bounds of ['0,0,0,0', ',,,', '1,2,3', 'a,b,c,d', `${s0},${w0},${n0},${e0}`, `${n0},${e0},${s0},${w0}`]) {
        const query = { maxPoints: '300', bounds };
        const expected = await runServer(serverAllTime, { query });
        assert.ok(store.allTimeMapData(query) === expected.text, `mismatch for bounds=${bounds}`);
    }
    console.log(`  ${served} bounded queries, avg ${(totalMs / served).toFixed(1)}ms from memory`);
});

test('heatmap-grid: zoom/bounds/date variants match', async () => {
    const [s0, w0] = overall.southwest;
    const [n0, e0] = overall.northeast;
    const latSpan = n0 - s0;
    const lonSpan = e0 - w0;

    const earliest = rows.reduce((m, r) => (r.start_time && (!m || r.start_time < m) ? r.start_time : m), null);
    const latest = rows.reduce((m, r) => (r.end_time && (!m || r.end_time > m) ? r.end_time : m), null);
    const dayMs = 86400000;
    const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

    const queries = [];
    // Whole-world requests at each cell-size tier.
    for (const zoom of ['2', '4', '7', '9', '11', '13', '15', '17', '0', 'x']) queries.push({ zoom, bounds: `${s0},${w0},${n0},${e0}` });
    // No bounds at all.
    queries.push({ zoom: '5' });
    queries.push({});
    // Random viewport windows.
    for (let i = 0; i < 30; i++) {
        const zoom = 3 + Math.floor(rand() * 15);
        const frac = Math.pow(0.5, zoom - 2);
        const h = Math.max(latSpan * frac, 0.002);
        const w = Math.max(lonSpan * frac, 0.002);
        const south = s0 + rand() * Math.max(latSpan - h, 0);
        const west = w0 + rand() * Math.max(lonSpan - w, 0);
        const q = { zoom: String(zoom), bounds: `${south},${west},${south + h},${west + w}` };
        if (earliest && latest && i % 3 === 0) {
            const a = earliest.getTime() + rand() * (latest.getTime() - earliest.getTime());
            const b = a + rand() * 90 * dayMs;
            q.start = isoDay(a);
            q.end = `${isoDay(b)}T23:59:59`; // exactly how Atlas formats `end`
        }
        if (i % 7 === 0) q.start = '2020-13-45'; // invalid date -> NaN semantics
        queries.push(q);
    }
    // Date-only filters.
    if (earliest && latest) {
        queries.push({ zoom: '6', start: isoDay(earliest.getTime()) });
        queries.push({ zoom: '6', end: `${isoDay(latest.getTime())}T23:59:59` });
        queries.push({ zoom: '6', start: isoDay(latest.getTime() + dayMs) }); // nothing matches
    }

    let totalMs = 0;
    for (const query of queries) {
        const expected = await runServer(serverHeatmap, { query });
        const t0 = performance.now();
        const actual = store.heatmapGrid(query);
        totalMs += performance.now() - t0;
        assert.ok(actual === expected.text, `mismatch for ${JSON.stringify(query)}\n  expected ${expected.text.slice(0, 200)}\n  actual   ${actual.slice(0, 200)}`);
    }
    console.log(`  ${queries.length} heatmap queries, avg ${(totalMs / queries.length).toFixed(1)}ms from memory`);
});

test('route detail: cached full text derives every maxPoints variant', async () => {
    assert.ok(details.length > 0, 'fixture has detail rows');
    for (const d of details) {
        const id = d.route.id;
        const full = await runServer(serverDetail, { params: { id }, query: { maxPoints: '0' } });
        assert.equal(full.status, 200);
        store.putDetail(id, full.text);
        assert.equal(store.routeDetail(id, { maxPoints: '0' }), full.text);
        assert.equal(store.routeDetail(id, {}), full.text);
        for (const maxPoints of ['100', '1', '2', '3', '250', '5000', '1000000', 'abc', '', '-1']) {
            const expected = await runServer(serverDetail, { params: { id }, query: { maxPoints } });
            const actual = store.routeDetail(id, { maxPoints });
            assert.ok(actual === expected.text, `detail mismatch id=${id} maxPoints=${maxPoints}`);
        }
    }
    assert.equal(store.routeDetail('does-not-exist', {}), null);
    console.log(`  ${details.length} routes x 12 variants matched`);
});

test('empty store answers like an empty tenant', async () => {
    const empty = new RouteStore();
    empty.loadAllTimePayload({ routes: [], stats: null, bounds: null });
    assert.equal(
        empty.allTimeMapData({ maxPoints: '100' }),
        JSON.stringify({ routes: [], stats: { totalRoutes: 0, totalDistance: 0, totalTime: 0, earliestDate: null, latestDate: null }, bounds: null }),
    );
    assert.equal(empty.heatmapGrid({ zoom: '4' }), JSON.stringify({ cells: [], totalPoints: 0 }));
});

test('malformed coordinate entries follow the server exactly', async () => {
    // Synthetic route with a short entry, a 3-element entry and a non-numeric pair mixed
    // in. (A `null` entry is not covered: the server itself throws on it and returns 500.)
    const dirty = {
        routes: [{
            id: 'dirty', name: 'Dirty', date: 'Jan 1, 2025', distance: '1.00', duration: '5m', topSpeed: '1.00', avgSpeed: '1.00',
            startTime: '2025-01-01T00:00:00.000Z', endTime: '2025-01-01T00:05:00.000Z',
            coordinates: [[10, 10], [10.1], [10.2, 10.2, 999], ['x', 'y'], [10.3, 10.3], [10.4, 10.4]],
            startCoord: [10, 10], endCoord: [10.4, 10.4], travelMode: 'foot',
        }],
        stats: { totalRoutes: 1 },
        bounds: { southwest: [10, 10], northeast: [10.4, 10.4] },
    };
    // Reference: run the server's own code path over equivalent DB rows.
    const dirtyRows = [{
        id: 'dirty', name: 'Dirty', date: 'Jan 1, 2025', distance: 1, duration: '5m', top_speed: 1, avg_speed: 1,
        start_time: new Date('2025-01-01T00:00:00.000Z'), end_time: new Date('2025-01-01T00:05:00.000Z'),
        coordinates: dirty.routes[0].coordinates, start_lat: 10, start_lon: 10, end_lat: 10.4, end_lon: 10.4, travel_mode: 'foot',
    }];
    const saved = rows.slice();
    rows.length = 0; rows.push(...dirtyRows);
    try {
        const s = new RouteStore();
        const full = await runServer(serverAllTime, { query: { maxPoints: '0' } });
        s.loadAllTimePayload(JSON.parse(full.text));
        for (const query of [
            { maxPoints: '0' }, { maxPoints: '3' }, { maxPoints: '5' },
            { maxPoints: '2', bounds: '10.15,10.15,10.25,10.25' },
            { maxPoints: '0', bounds: '50,50,51,51' },
        ]) {
            const expected = await runServer(serverAllTime, { query });
            assert.ok(s.allTimeMapData(query) === expected.text, `dirty mismatch ${JSON.stringify(query)}`);
        }
        for (const query of [{ zoom: '4' }, { zoom: '15', bounds: '10.15,10.15,10.25,10.25' }, { zoom: '9', start: '2025-01-01', end: '2025-01-01T00:02:00' }]) {
            const expected = await runServer(serverHeatmap, { query });
            // The server destructures `coords[i]` for every entry and throws on `null`,
            // returning a 500. We only need to agree when the server succeeds.
            if (expected.status === 200) {
                assert.ok(s.heatmapGrid(query) === expected.text, `dirty heatmap mismatch ${JSON.stringify(query)}`);
            }
        }
    } finally {
        rows.length = 0; rows.push(...saved);
    }
});
