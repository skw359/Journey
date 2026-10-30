'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// ── Oracles: straightforward full scans of every point ──

function legacyDownsample(coords, max) {
    if (max <= 0 || coords.length <= max) return coords;
    if (max === 1) return [coords[0]];
    if (max === 2) return [coords[0], coords[coords.length - 1]];
    const result = [coords[0]];
    const step = (coords.length - 1) / (max - 1);
    for (let i = 1; i < max - 1; i++) result.push(coords[Math.round(i * step)]);
    result.push(coords[coords.length - 1]);
    return result;
}
const round6 = (c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

// Whether a recorded track enters a view: a point inside, or a segment crossing an edge.
function trackEntersView(coords, v) {
    const inside = (c) => c[0] >= v.south && c[0] <= v.north && c[1] >= v.west && c[1] <= v.east;
    const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const corners = [[v.south, v.west], [v.south, v.east], [v.north, v.east], [v.north, v.west]];
    return coords.some((p, i) => {
        if (inside(p)) return true;
        const q = coords[i + 1];
        if (!q) return false;
        return corners.some((a, k) => {
            const b = corners[(k + 1) % 4];
            return orient(p, q, a) !== orient(p, q, b) && orient(a, b, p) !== orient(a, b, q);
        });
    });
}

function bruteHeat(journeys, { cell, bounds, start = -Infinity, end = Infinity }) {
    const pad = cell * 5;
    const cells = new Map();
    for (const j of journeys) {
        const seen = new Set();
        j.coordinates.forEach((c, i) => {
            const t = j.profileTimeMs[i];
            if (t < start || t > end) return;
            const a = Math.round(c[0] / cell);
            const o = Math.round(c[1] / cell);
            if (bounds) {
                const cLat = a * cell;
                const cLon = o * cell;
                if (cLat < bounds.south - pad || cLat > bounds.north + pad || cLon < bounds.west - pad || cLon > bounds.east + pad) return;
            }
            const key = `${a},${o}`;
            const entry = cells.get(key) || { visits: 0, samples: 0 };
            entry.samples += 1;
            if (!seen.has(key)) { entry.visits += 1; seen.add(key); }
            cells.set(key, entry);
        });
    }
    return cells;
}

function heatAsMap(cells, cellSize) {
    const map = new Map();
    for (const [lat, lon, visits, samples] of cells) {
        map.set(`${Math.round(lat / cellSize)},${Math.round(lon / cellSize)}`, { visits, samples });
    }
    return map;
}

test('maps, heatmap and Fun Stats from derived data', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const { origin, pool } = env;
    const owner = await h.registerAdmin(origin);
    const schema = require('../db').tenantSchemaForUser(owner.user.id);

    // Journeys around two hubs, one crossing midnight UTC at the end of a month, one with a
    // long pause (so interpolated times would be wrong), and one far away.
    const specs = [];
    for (let i = 0; i < 6; i++) specs.push({ lat: 40.70 + i * 0.002, lon: -74.00 + i * 0.001, start: Date.UTC(2025, 2, 3 + i, 8), count: 400 + i * 40 });
    for (let i = 0; i < 4; i++) specs.push({ lat: 40.71 + i * 0.001, lon: -73.99, start: Date.UTC(2025, 4, 10 + i, 18), count: 300 });
    specs.push({ lat: 40.75, lon: -73.98, start: Date.UTC(2025, 4, 31, 23, 55), count: 900 }); // crosses into June
    specs.push({ lat: 34.05, lon: -118.24, start: Date.UTC(2025, 6, 4, 12), count: 500 }); // Los Angeles
    const ids = [];
    for (const spec of specs) {
        const rows = h.lineRows({ ...spec, stepDeg: 0.00008 });
        const res = await h.uploadJourney(owner, h.journeyZip(rows));
        assert.equal(res.status, 201, res.text);
        ids.push(res.data.id);
    }
    // A pause: the second half of one journey happens two hours later.
    const paused = (await owner.get(`/api/routes/${ids[7]}`)).data;
    const pausedTimes = paused.profileTimeMs.map((ts, i) => (i >= 150 ? ts + 2 * 3600 * 1000 : ts));
    await pool.query(`UPDATE ${schema}.routes SET profile_time_ms = $1, end_time = $2 WHERE id = $3`,
        [JSON.stringify(pausedTimes), new Date(pausedTimes.at(-1)).toISOString(), ids[7]]);

    const journeys = async () => {
        const out = [];
        for (const id of ids) {
            const r = await owner.get(`/api/routes/${id}`);
            if (r.status === 200) out.push(r.data);
        }
        return out;
    };

    await t.test('Atlas overview is unchanged: the same 100 evenly spaced points', async () => {
        const atlas = await owner.get('/api/alltime-map-data?maxPoints=100');
        assert.equal(atlas.status, 200);
        const all = await journeys();
        assert.equal(atlas.data.routes.length, all.length);
        const byId = new Map(atlas.data.routes.map((r) => [r.id, r]));
        let total = 0;
        for (const j of all) {
            assert.deepEqual(byId.get(j.id).coordinates, legacyDownsample(j.coordinates, 100).map(round6), j.id);
            total += j.coordinates.length;
        }
        assert.equal(atlas.data.stats.totalPoints, total);
        assert.equal(atlas.data.stats.totalRoutes, all.length);
    });

    await t.test('viewport requests return the journeys in view', async () => {
        const all = await journeys();
        const bounds = { south: 40.69, west: -74.01, north: 40.72, east: -73.995 };
        const q = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
        const res = await owner.get(`/api/alltime-map-data?maxPoints=5000&bounds=${q}`);
        assert.equal(res.status, 200);
        const inView = (c) => c[0] >= bounds.south && c[0] <= bounds.north && c[1] >= bounds.west && c[1] <= bounds.east;
        const expected = all.filter((j) => j.coordinates.some(inView)).map((j) => j.id).sort();
        assert.deepEqual(res.data.routes.map((r) => r.id).sort(), expected);
        for (const r of res.data.routes) {
            const full = all.find((j) => j.id === r.id);
            assert.deepEqual(r.coordinates, full.coordinates.map(round6), 'within budget: every recorded point');
        }
        const tight = await owner.get(`/api/alltime-map-data?maxPoints=200&bounds=${q}`);
        for (const r of tight.data.routes) assert.ok(r.coordinates.length <= 200);
        const la = await owner.get('/api/alltime-map-data?maxPoints=1000&bounds=33,-119,35,-117');
        assert.deepEqual(la.data.routes.map((r) => r.id), [ids[11]]);

        // Views over a corner of a journey's bounding box, and views ending just short of its
        // line (closer than the simplification tolerance): only the full track can decide.
        const views = [];
        for (const j of all.slice(0, 6)) {
            const lats = j.coordinates.map((c) => c[0]);
            const lons = j.coordinates.map((c) => c[1]);
            const north = Math.max(...lats);
            const west = Math.min(...lons);
            views.push({ south: north - 0.004, north: north + 0.001, west: west - 0.001, east: west + 0.004 });
            const mid = j.coordinates[Math.floor(j.coordinates.length / 2)];
            views.push({ south: mid[0] + 0.000005, north: mid[0] + 0.002, west: mid[1] - 0.002, east: mid[1] - 0.000005 });
        }
        let bboxOnly = 0;
        for (const v of views) {
            const res = await owner.get(`/api/alltime-map-data?maxPoints=5000&bounds=${v.south},${v.west},${v.north},${v.east}`);
            const expected = all.filter((j) => trackEntersView(j.coordinates, v));
            assert.deepEqual(res.data.routes.map((r) => r.id).sort(), expected.map((j) => j.id).sort(), JSON.stringify(v));
            for (const r of res.data.routes) {
                assert.deepEqual(r.coordinates, expected.find((j) => j.id === r.id).coordinates.map(round6));
            }
            bboxOnly += all.filter((j) => !expected.includes(j) && j.coordinates.some((c) => c[0] >= v.south)
                && j.coordinates.some((c) => c[0] <= v.north) && j.coordinates.some((c) => c[1] >= v.west)
                && j.coordinates.some((c) => c[1] <= v.east)).length;
        }
        assert.ok(bboxOnly >= 6, `journeys whose bounding box alone overlaps a view: ${bboxOnly}`);
    });

    const zooms = [[4, 0.01], [8, 0.005], [10, 0.002], [12, 0.001], [14, 0.0005], [16, 0.0002]];
    await t.test('heatmap cells equal a full scan (visits and samples)', async () => {
        const all = await journeys();
        for (const [zoom, cell] of zooms) {
            const bounds = { south: 40.69, west: -74.02, north: 40.80, east: -73.95 };
            const res = await owner.get(`/api/heatmap-grid?zoom=${zoom}&bounds=${bounds.south},${bounds.west},${bounds.north},${bounds.east}`);
            assert.equal(res.status, 200);
            const actual = heatAsMap(res.data.cells, cell);
            const expected = bruteHeat(all, { cell, bounds });
            assert.deepEqual(new Map([...actual].sort()), new Map([...expected].sort()), `zoom ${zoom}`);
            assert.equal(res.data.totalPoints, [...expected.values()].reduce((n, c) => n + c.samples, 0));
        }
    });

    await t.test('heatmap date filters use recorded times, point by point', async () => {
        const all = await journeys();
        const ranges = [
            [Date.UTC(2025, 4, 1), Date.UTC(2025, 4, 31, 23, 59, 59)],
            [Date.UTC(2025, 5, 1), Date.UTC(2025, 11, 31)],
            [pausedTimes[100], pausedTimes[200]],
        ];
        for (const [start, end] of ranges) {
            const res = await owner.get(`/api/heatmap-grid?zoom=12&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
            assert.equal(res.status, 200);
            const expected = bruteHeat(all, { cell: 0.001, start, end });
            assert.deepEqual(new Map([...heatAsMap(res.data.cells, 0.001)].sort()), new Map([...expected].sort()));
        }
    });

    await t.test('the heatmap grid stays exact through edits and deletes', async () => {
        await owner.delete(`/api/routes/${ids[0]}/points/10`);
        const trashed = await owner.delete(`/api/routes/${ids[1]}`);
        await owner.post('/api/routes/combine', { json: { journeyIds: [ids[2], ids[3]] } });
        await require('../utils/journeyDerived').ensureDerived(owner.user.id);
        const { rows: drift } = await pool.query(`
            WITH expected AS (
                SELECT u.l AS level, u.a AS lat_idx, u.o AS lon_idx, SUM(u.s) AS samples, COUNT(*) AS journeys
                FROM ${schema}.route_derived d, unnest(d.heat_level, d.heat_lat, d.heat_lon, d.heat_samples) AS u(l, a, o, s)
                WHERE d.visible GROUP BY 1, 2, 3
            )
            SELECT * FROM expected e FULL JOIN ${schema}.heat_cells h USING (level, lat_idx, lon_idx)
            WHERE e.samples IS DISTINCT FROM h.samples OR e.journeys IS DISTINCT FROM h.journeys
        `);
        assert.equal(drift.length, 0);
        await owner.post(`/api/routes/trash/${trashed.data.trashId}/restore`);
    });

    await t.test('restored short journeys appear everywhere the list shows them', async () => {
        const short = await h.uploadJourney(owner, h.journeyZip(h.lineRows({ count: 6, lat: 47.6, lon: -122.33 })));
        assert.equal(short.data.trashed, true);
        const entry = (await owner.get('/api/routes/trash')).data.find((e) => e.origin === 'rejected_short');
        const restored = await owner.post(`/api/routes/trash/${entry.id}/restore`);
        assert.equal(restored.status, 200);
        const list = await owner.get('/api/routes');
        assert.ok(list.data.some((r) => r.id === restored.data.routeId));
        const atlas = await owner.get('/api/alltime-map-data');
        assert.ok(atlas.data.routes.some((r) => r.id === restored.data.routeId));
        const heat = await owner.get('/api/heatmap-grid?zoom=16&bounds=47.59,-122.34,47.61,-122.32');
        assert.ok(heat.data.cells.length > 0);
        const fun = await owner.get('/api/fun-stats');
        assert.equal(fun.data.totalRoutes, list.data.length);
    });

    await t.test('Fun Stats point-derived values equal a full scan', async () => {
        const { statesForCoords } = require('../utils/states');
        const { haversine } = require('../utils/geo');
        const fun = (await owner.get('/api/fun-stats')).data;
        const all = (await owner.get('/api/routes')).data;
        const details = [];
        for (const s of all) details.push((await owner.get(`/api/routes/${s.id}`)).data);
        details.sort((a, b) => new Date(a.startTime) - new Date(b.startTime) || (a.id < b.id ? -1 : 1));
        const points = details.flatMap((d) => d.coordinates);

        assert.equal(fun.totalDataPoints, points.length);
        const coarse = new Set(points.map(([a, o]) => `${Math.round(a / 0.01)},${Math.round(o / 0.01)}`));
        const fine = new Set(points.map(([a, o]) => `${Math.round(a / 0.001)},${Math.round(o / 0.001)}`));
        assert.equal(fun.uniqueLocations, coarse.size);
        assert.equal(fun.explorationScore, Number(Math.min(100, (fine.size / points.length) * 100).toFixed(1)));
        assert.deepEqual(fun.statesVisited, statesForCoords(points));

        let north = null;
        for (const p of points) if (!north || p[0] > north[0]) north = p;
        assert.deepEqual(fun.extremePoints.north, north);

        let best = 0, bestCoord = null;
        for (const p of points) {
            const d = haversine(fun.homeCoord[0], fun.homeCoord[1], p[0], p[1]);
            if (d > best) { best = d; bestCoord = p; }
        }
        assert.equal(fun.furthestPointMiles, Number(best.toFixed(1)));
        assert.deepEqual(fun.furthestPointCoord, bestCoord);
    });

    await t.test('Fun Stats are cached until journeys change', async () => {
        const first = await owner.get('/api/fun-stats');
        const again = await owner.get('/api/fun-stats');
        assert.deepEqual(again.data, first.data);
        await h.uploadJourney(owner, h.journeyZip(h.lineRows({ lat: 25.76, lon: -80.19, count: 300 })));
        const after = await owner.get('/api/fun-stats');
        assert.equal(after.data.totalRoutes, first.data.totalRoutes + 1);
    });
});
