'use strict';

/**
 * The in-memory RouteStore vs. the real server, driven by real tenant rows: the fixture
 * (tests/fixtures/tenants.json, made by tests/fixtures/dump-fixture.cjs) is seeded into a
 * throwaway database and the actual server answers over HTTP.
 *
 * Run: TEST_DATABASE_URL=postgres://… npm test
 * Set JOURNEY_TEST_TENANT=<schema> to pick a tenant; defaults to the largest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// First, so no server module can open a pool before the test database exists.
const h = require('../../server/tests/helpers');
const { RouteStore } = require('../src/main/data/store');

const FIXTURE = path.join(__dirname, 'fixtures', 'tenants.json');
const skip = !fs.existsSync(FIXTURE)
    ? 'tests/fixtures/tenants.json missing — run tests/fixtures/dump-fixture.cjs'
    : h.skipReason();

let seed = 0x9e3779b9;
function rand() {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return (seed >>> 0) / 0x100000000;
}

test('RouteStore answers like the server', { skip, timeout: 60 * 60 * 1000 }, async (t) => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const tenantName = process.env.JOURNEY_TEST_TENANT
        || Object.keys(fixture).sort((a, b) => fixture[b].routes.length - fixture[a].routes.length)[0];
    const tenant = fixture[tenantName];

    const env = await h.setupTestServer();
    t.after(env.teardown);
    const owner = await h.registerAdmin(env.origin);
    const { withTenantTransaction } = require('../../server/db');
    const { insertRoute, insertWaypoints, insertPhotoRow } = require('../../server/utils/routeRecords');
    const { ensureDerived } = require('../../server/utils/journeyDerived');

    const details = new Map(tenant.details.map((d) => [d.route.id, d]));
    await withTenantTransaction(owner.user.id, async (db) => {
        for (const row of tenant.routes) await insertRoute(db, details.get(row.id)?.route || row);
        for (const d of tenant.details) {
            await insertWaypoints(db, d.route.id, d.waypoints, () => `wp-${Math.random().toString(16).slice(2)}`);
            for (const ph of d.photos) await insertPhotoRow(db, d.route.id, ph);
        }
    });
    await ensureDerived(owner.user.id);
    const get = async (url) => {
        const res = await owner.get(url);
        assert.equal(res.status, 200, `${url}: ${res.text.slice(0, 200)}`);
        return res.text;
    };

    const fullText = await get('/api/alltime-map-data?maxPoints=0');
    const payload = JSON.parse(fullText);
    const store = new RouteStore();
    store.loadAllTimePayload(payload, fullText);
    t.diagnostic(`${tenantName}: ${store.routeCount} routes / ${store.totalPoints.toLocaleString()} points`);

    await t.test('full resolution round-trips exactly', () => {
        assert.ok(store.allTimeMapData({ maxPoints: '0' }) === fullText);
        const lazy = new RouteStore();
        lazy.loadAllTimePayload(payload);
        assert.ok(lazy.allTimeMapData({ maxPoints: '0' }) === fullText, 'rebuilt from typed arrays');
    });

    await t.test('overviews match the server byte for byte', async () => {
        for (const maxPoints of ['100', '1', '2', '3', '7', '50', '199', '200', '1000', '99999', '-5', 'abc', '', undefined, '12.9', '0x10']) {
            const qs = maxPoints === undefined ? '' : `?maxPoints=${encodeURIComponent(maxPoints)}`;
            const query = maxPoints === undefined ? {} : { maxPoints };
            assert.ok(store.allTimeMapData(query) === await get(`/api/alltime-map-data${qs}`), `maxPoints=${JSON.stringify(maxPoints)}`);
        }
    });

    await t.test('viewport requests return the same journeys', async () => {
        if (!payload.bounds) return;
        const [s0, w0] = payload.bounds.southwest;
        const [n0, e0] = payload.bounds.northeast;
        const pointCounts = new Map(payload.routes.map((r) => [r.id, r.coordinates.length]));
        for (let i = 0; i < 60; i++) {
            const frac = Math.pow(10, -rand() * 4);
            const hgt = (n0 - s0) * frac;
            const wid = (e0 - w0) * frac;
            const south = s0 + rand() * (n0 - s0 - hgt);
            const west = w0 + rand() * (e0 - w0 - wid);
            const maxPoints = [200, 500, 1000, 5000][i % 4];
            const bounds = `${south},${west},${south + hgt},${west + wid}`;
            const mine = JSON.parse(store.allTimeMapData({ maxPoints: String(maxPoints), bounds }));
            const server = JSON.parse(await get(`/api/alltime-map-data?maxPoints=${maxPoints}&bounds=${bounds}`));
            const serverById = new Map(server.routes.map((r) => [r.id, r]));
            for (const route of mine.routes) {
                // The server tests long journeys against a ~2 m simplified line, so it may
                // also include a journey that passes just outside the view.
                assert.ok(serverById.has(route.id), `${route.id} missing for ${bounds}`);
                if (pointCounts.get(route.id) <= maxPoints) {
                    assert.deepEqual(serverById.get(route.id).coordinates, route.coordinates, `${route.id} within budget`);
                }
            }
            for (const route of server.routes) {
                if (pointCounts.get(route.id) <= maxPoints) {
                    assert.ok(mine.routes.some((r) => r.id === route.id), `${route.id} extra on the server for ${bounds}`);
                }
            }
        }
    });

    await t.test('journey detail derives every maxPoints variant', async () => {
        for (const d of tenant.details) {
            const id = d.route.id;
            const full = await get(`/api/routes/${encodeURIComponent(id)}?maxPoints=0`);
            store.putDetail(id, full);
            assert.equal(store.routeDetail(id, {}), full);
            for (const maxPoints of ['100', '1', '2', '3', '250', '5000', '1000000', 'abc', '', '-1']) {
                const expected = await get(`/api/routes/${encodeURIComponent(id)}?maxPoints=${encodeURIComponent(maxPoints)}`);
                assert.ok(store.routeDetail(id, { maxPoints }) === expected, `detail ${id} maxPoints=${maxPoints}`);
            }
        }
        assert.equal(store.routeDetail('does-not-exist', {}), null);
    });

    await t.test('an empty store answers like an empty account', async () => {
        const empty = new RouteStore();
        empty.loadAllTimePayload({ routes: [], stats: null, bounds: null });
        const fresh = await h.registerInvited(env.origin, owner, 'empty-account');
        const res = await fresh.get('/api/alltime-map-data?maxPoints=100');
        assert.equal(empty.allTimeMapData({ maxPoints: '100' }), res.text);
    });
});
