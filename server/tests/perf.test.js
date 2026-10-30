'use strict';

// Performance budget: with a few hundred thousand points stored, viewport requests and
// Fun Stats must answer quickly without blocking the event loop. Sizes and budgets can be
// raised locally (PERF_JOURNEYS, PERF_POINTS) for a closer look.

const test = require('node:test');
const assert = require('node:assert/strict');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const h = require('./helpers');

const JOURNEYS = Number(process.env.PERF_JOURNEYS) || 300;
const POINTS = Number(process.env.PERF_POINTS) || 1000;
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS) || 1500;
const BLOCK_BUDGET_MS = Number(process.env.PERF_BLOCK_BUDGET_MS) || 300;

async function measure(fn) {
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const started = performance.now();
    const result = await fn();
    const ms = performance.now() - started;
    loop.disable();
    return { result, ms, blockedMs: loop.max / 1e6 };
}

test('viewport requests and Fun Stats stay within budget', { skip: h.skipReason(), timeout: 15 * 60 * 1000 }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const owner = await h.registerAdmin(env.origin);
    const { withTenantTransaction } = require('../db');
    const { insertRoute } = require('../utils/routeRecords');
    const { statsFromSamples } = require('../utils/journeyStats');
    const { ensureDerived } = require('../utils/journeyDerived');

    // Smooth random walks around three hubs, at 1 Hz.
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const hubs = [[40.75, -73.98], [40.65, -73.95], [42.36, -71.06]];
    await withTenantTransaction(owner.user.id, async (db) => {
        for (let j = 0; j < JOURNEYS; j++) {
            const hub = hubs[j % 3 === 2 ? 2 : j % 2];
            let lat = hub[0] + (rand() - 0.5) * 0.05;
            let lon = hub[1] + (rand() - 0.5) * 0.05;
            let heading = rand() * Math.PI * 2;
            const start = Date.UTC(2024, 0, 1) + j * 86_400_000 / 2;
            const samples = [];
            for (let i = 0; i < POINTS; i++) {
                heading += (rand() - 0.5) * 0.2;
                lat += Math.cos(heading) * 0.0001;
                lon += Math.sin(heading) * 0.0001;
                samples.push({ ts: start + i * 1000, lat, lon, ele: 20 + Math.sin(i / 50) * 5, speedMps: 8 });
            }
            const s = statsFromSamples(samples);
            await insertRoute(db, {
                id: `perf-${j}`, name: `Perf ${j}`, date: 'Jan 01, 2024', ...s,
                start_time: s.start_time, end_time: s.end_time, travel_mode: 'drive', source: 'iphone',
            });
        }
    });

    const backfill = await measure(() => ensureDerived(owner.user.id));
    const results = [['derived backfill (one-off)', backfill]];

    const nyc = '40.70,-74.05,40.80,-73.90';
    const street = '40.745,-73.99,40.755,-73.975';
    const requests = [
        ['Atlas first load (maxPoints=100)', '/api/alltime-map-data?maxPoints=100'],
        ['Atlas detail refresh, metro view', `/api/alltime-map-data?maxPoints=750&bounds=${nyc}`],
        ['Atlas detail refresh, street view', `/api/alltime-map-data?maxPoints=5000&bounds=${street}`],
        ['Heatmap, metro (zoom 12)', `/api/heatmap-grid?zoom=12&bounds=${nyc}`],
        ['Heatmap, street (zoom 16)', `/api/heatmap-grid?zoom=16&bounds=${street}`],
        ['Heatmap, one month', `/api/heatmap-grid?zoom=12&bounds=${nyc}&start=2024-02-01T00:00:00Z&end=2024-02-29T23:59:59Z`],
        ['Fun Stats (cold)', '/api/fun-stats'],
        ['Fun Stats (cached)', '/api/fun-stats'],
    ];
    for (const [label, url] of requests) {
        const m = await measure(() => owner.get(url));
        assert.equal(m.result.status, 200, `${label}: ${m.result.text?.slice(0, 200)}`);
        results.push([label, m]);
    }

    t.diagnostic(`${JOURNEYS} journeys × ${POINTS} points = ${(JOURNEYS * POINTS).toLocaleString()} points`);
    for (const [label, m] of results) {
        t.diagnostic(`${label.padEnd(36)} ${m.ms.toFixed(0).padStart(6)} ms   event loop blocked ≤ ${m.blockedMs.toFixed(0)} ms`);
    }
    for (const [label, m] of results.slice(1)) {
        assert.ok(m.ms < BUDGET_MS, `${label} took ${m.ms.toFixed(0)} ms (budget ${BUDGET_MS})`);
        assert.ok(m.blockedMs < BLOCK_BUDGET_MS, `${label} blocked the event loop ${m.blockedMs.toFixed(0)} ms (budget ${BLOCK_BUDGET_MS})`);
    }
});
