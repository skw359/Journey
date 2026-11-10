'use strict';

// Pure unit tests (no database). helpers is required first so nothing can open a pool
// against pg's defaults.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

// The statistics the upload route computed before the shared module existed, kept as an
// oracle: new uploads must produce exactly the same numbers. One deliberate difference: the
// average elevation is taken over the points that have one (it used to divide by every point).
function legacyUploadStats(rows) {
    const { haversine } = require('../utils/geo');
    const s = {
        count: 0, topSpeedMps: 0, sumSpeedMps: 0, speedSamples: 0, topElevation: -Infinity,
        lowestElevation: Infinity, sumElevation: 0, elevationSamples: 0, last: null, lastTs: null, totalMiles: 0, firstTs: null,
        coords: [], elevGainM: 0, elevLossM: 0, lastEle: null, profileDistMi: [], profileSpeedMph: [],
    };
    for (const row of rows) {
        const ts = Number(row.ts);
        const lat = parseFloat(row.lat);
        const lon = parseFloat(row.lon);
        const ele = parseFloat(row.ele);
        let sp = parseFloat(row.speed);
        if (s.last) {
            const miles = haversine(s.last.lat, s.last.lon, lat, lon);
            const dt = (ts - s.lastTs) / 1000;
            if (dt > 0) {
                const mpsFromTrack = (miles * 1609.344) / dt;
                s.totalMiles += miles;
                if (!Number.isFinite(sp) || sp <= 0) sp = mpsFromTrack;
            }
        } else {
            s.firstTs = ts;
        }
        if (Number.isFinite(ele)) {
            s.topElevation = Math.max(s.topElevation, ele);
            s.lowestElevation = Math.min(s.lowestElevation, ele);
            s.sumElevation += ele;
            s.elevationSamples += 1;
            if (Number.isFinite(s.lastEle)) {
                const dEle = ele - s.lastEle;
                if (dEle > 0.5) s.elevGainM += dEle;
                else if (dEle < -0.5) s.elevLossM += Math.abs(dEle);
            }
            s.lastEle = ele;
        }
        if (Number.isFinite(sp) && sp >= 0) {
            s.topSpeedMps = Math.max(s.topSpeedMps, sp);
            s.sumSpeedMps += sp;
            s.speedSamples += 1;
        }
        s.profileDistMi.push(s.totalMiles);
        s.profileSpeedMph.push(Number.isFinite(sp) ? sp * 2.23694 : 0);
        s.last = { lat, lon };
        s.lastTs = ts;
        s.count += 1;
    }
    const avgSpeedMph = (s.speedSamples ? s.sumSpeedMps / s.speedSamples : 0) * 2.23694;
    return {
        distance: parseFloat(s.totalMiles.toFixed(2)),
        top_speed: parseFloat((s.topSpeedMps * 2.23694).toFixed(2)),
        avg_speed: parseFloat(avgSpeedMph.toFixed(2)),
        top_elevation: parseFloat((s.topElevation === -Infinity ? 0 : s.topElevation).toFixed(2)),
        lowest_elevation: parseFloat((s.lowestElevation === Infinity ? 0 : s.lowestElevation).toFixed(2)),
        avg_elevation: parseFloat((s.elevationSamples ? s.sumElevation / s.elevationSamples : 0).toFixed(2)),
        elevation_gain: Number(s.elevGainM.toFixed(2)),
        elevation_loss: Number(s.elevLossM.toFixed(2)),
        profile_dist_mi: s.profileDistMi,
        profile_speed_mph: s.profileSpeedMph,
    };
}

test('shared upload statistics match the original upload algorithm', () => {
    const { statsFromSamples } = require('../utils/journeyStats');
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 25; trial++) {
        const rows = [];
        let t = Date.UTC(2025, 0, 1) + trial * 1e7;
        let lat = 40 + rand();
        let lon = -74 + rand();
        let ele = 100;
        for (let i = 0; i < 200 + Math.floor(rand() * 800); i++) {
            t += rand() < 0.05 ? 0 : Math.round(500 + rand() * 1500);
            lat += (rand() - 0.5) * 0.0004;
            lon += (rand() - 0.5) * 0.0004;
            ele += (rand() - 0.5) * 3;
            const speed = rand() < 0.3 ? '' : rand() < 0.1 ? '-1' : String(rand() * 20);
            rows.push({ ts: t, lat, lon, ele: rand() < 0.1 ? '' : ele, speed });
        }
        const expected = legacyUploadStats(rows);
        const actual = statsFromSamples(rows.map((r) => ({
            ts: Number(r.ts), lat: r.lat, lon: r.lon, ele: parseFloat(r.ele), speedMps: parseFloat(r.speed),
        })));
        for (const key of Object.keys(expected)) {
            assert.deepEqual(actual[key], expected[key], `trial ${trial}: ${key}`);
        }
    }
});

function bruteDbscan(points, eps, minPts) {
    const { haversine } = require('../utils/geo');
    const n = points.length;
    const labels = new Int32Array(n).fill(-1);
    let id = 0;
    const region = (i) => {
        const out = [];
        for (let k = 0; k < n; k++) if (haversine(points[i][0], points[i][1], points[k][0], points[k][1]) <= eps) out.push(k);
        return out;
    };
    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;
        const nb = region(i);
        if (nb.length < minPts) { labels[i] = -2; continue; }
        labels[i] = id;
        const seed = new Set(nb);
        seed.delete(i);
        const queue = [...seed];
        while (queue.length) {
            const q = queue.pop();
            if (labels[q] === -2) labels[q] = id;
            if (labels[q] !== -1) continue;
            labels[q] = id;
            const qn = region(q);
            if (qn.length >= minPts) for (const x of qn) if ((labels[x] === -1 || labels[x] === -2) && !seed.has(x)) { seed.add(x); queue.push(x); }
        }
        id++;
    }
    return labels;
}

test('grid DBSCAN matches the full O(n²) scan', () => {
    const { dbscan } = require('../routes/funstats');
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 10; trial++) {
        const hubs = Array.from({ length: 4 }, () => [30 + rand() * 20, -120 + rand() * 40]);
        const points = Array.from({ length: 400 }, () => {
            const hub = hubs[Math.floor(rand() * hubs.length)];
            return [hub[0] + (rand() - 0.5) * 0.02, hub[1] + (rand() - 0.5) * 0.02];
        });
        assert.deepEqual([...dbscan(points, 0.345, 3)], [...bruteDbscan(points, 0.345, 3)], `trial ${trial}`);
    }
});

test('box distance bound is never below a point inside the box', () => {
    const { maxDistanceToBox } = require('../routes/funstats');
    const { haversine } = require('../utils/geo');
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 300; trial++) {
        const lat0 = -80 + rand() * 150;
        const lon0 = -179 + rand() * 330;
        const box = { min_lat: lat0, max_lat: lat0 + rand() * 9, min_lon: lon0, max_lon: Math.min(180, lon0 + rand() * 40) };
        const home = [-89 + rand() * 178, -180 + rand() * 360];
        const bound = maxDistanceToBox(home, box);
        for (let k = 0; k < 200; k++) {
            const p = [box.min_lat + rand() * (box.max_lat - box.min_lat), box.min_lon + rand() * (box.max_lon - box.min_lon)];
            assert.ok(haversine(home[0], home[1], p[0], p[1]) <= bound, `trial ${trial}`);
        }
    }
});


test('average elevation ignores points that have no elevation', () => {
    const { statsFromSamples, statsFromTrack } = require('../utils/journeyStats');
    const samples = Array.from({ length: 300 }, (_, i) => ({
        ts: Date.UTC(2025, 5, 1) + i * 1000, lat: 40 + i * 0.0001, lon: -74, ele: i < 150 ? 100 : NaN, speedMps: 5,
    }));
    const stats = statsFromSamples(samples);
    assert.equal(stats.avg_elevation, 100);
    const track = { times: stats.profile_time_ms, coords: stats.coordinates, elevations: stats.profile_elev_m, speedsMph: stats.profile_speed_mph };
    assert.equal(statsFromTrack(track).avg_elevation, 100);
    assert.equal(statsFromTrack(track, { removed: new Set([0, 1, 2]) }).avg_elevation, 100);
    assert.equal(statsFromSamples(samples.map((s) => ({ ...s, ele: NaN }))).avg_elevation, 0);
});

test('rows without a real timestamp are skipped', () => {
    const { sampleFromRow } = require('../utils/journeyIngest');
    const row = (ts_ms) => ({ ts_ms, lat: '40.5', lon: '-74.25', ele_m: '12', speed_ms: '3', waypoint: '0', note: '' });
    const good = sampleFromRow(row(String(Date.UTC(2025, 9, 29, 9, 0, 0))));
    assert.deepEqual({ ts: good.ts, lat: good.lat, lon: good.lon }, { ts: Date.UTC(2025, 9, 29, 9, 0, 0), lat: 40.5, lon: -74.25 });
    // Number('') is 0: a blank cell must not become 1 Jan 1970.
    for (const bad of ['', '   ', '0', '-5', 'abc', '1e300', '86400000', undefined]) {
        assert.equal(sampleFromRow(row(bad)), null, `ts_ms ${JSON.stringify(bad)}`);
    }
    assert.equal(sampleFromRow({ ...row('1761728800000'), lat: '91' }), null);
});

test('journey names and dates follow the given time zone', () => {
    const { journeyName, journeyDate } = require('../utils/journeyIngest');
    const { parseTimeZone, zoneParts, shiftDateKey, shiftMonthKey } = require('../utils/timeZone');
    // Friday 6 pm in Los Angeles is already Saturday in UTC.
    const start = new Date('2025-10-25T01:00:00Z');
    assert.equal(journeyDate(start, 'America/Los_Angeles'), 'Oct 24, 2025');
    assert.equal(journeyName(start, 'America/Los_Angeles'), 'Journey - Oct 24, 2025 - 18:00');
    assert.equal(journeyName(start, 'UTC'), 'Journey - Oct 25, 2025 - 01:00');
    assert.equal(parseTimeZone('America/Los_Angeles'), 'America/Los_Angeles');
    for (const bad of ['Mars/Olympus', '', '  ', 42, null, 'x'.repeat(200)]) assert.equal(parseTimeZone(bad), null);

    const la = zoneParts(start, 'America/Los_Angeles');
    assert.deepEqual(la, { dateKey: '2025-10-24', monthKey: '2025-10', year: 2025, month: 9, dow: 5, hour: 18, minute: 0, second: 0 });
    assert.equal(zoneParts(start, 'UTC').dow, 6);
    assert.equal(zoneParts(new Date('2025-01-01T00:30:00Z'), 'America/Los_Angeles').dateKey, '2024-12-31');
    assert.equal(zoneParts(new Date('2025-06-01T07:00:00Z'), 'America/Los_Angeles').hour, 0, 'midnight is hour 0, not 24');
    assert.equal(shiftDateKey('2025-03-01', -1), '2025-02-28');
    assert.equal(shiftDateKey('2025-12-31', 1), '2026-01-01');
    assert.equal(shiftMonthKey('2025-01', -1), '2024-12');
    assert.equal(shiftMonthKey('2025-12', 1), '2026-01');
});

test('MIN_ROUTE_MILES falls back to the default unless it is a distance', () => {
    const { parseMinRouteMiles } = require('../config');
    assert.equal(parseMinRouteMiles(undefined), 0.25);
    assert.equal(parseMinRouteMiles(''), 0.25);
    assert.equal(parseMinRouteMiles('0.5'), 0.5);
    assert.equal(parseMinRouteMiles('0'), 0);
    const warn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
        // NaN in SQL compares greater than every distance, which hid every journey.
        for (const bad of ['a quarter', 'O.5', '-1', 'NaN', 'Infinity']) assert.equal(parseMinRouteMiles(bad), 0.25, bad);
    } finally {
        console.warn = warn;
    }
    assert.equal(warnings.length, 5);
});

test('session touches are written at most once per interval', () => {
    const { throttleTouch } = require('../utils/sessionStore');
    let clock = 1_000_000;
    const written = [];
    const store = throttleTouch({ touch: (sid, sess, done) => { written.push(sid); done(); } }, { intervalMs: 60_000, now: () => clock });
    let answered = 0;
    const touch = (sid) => store.touch(sid, {}, () => { answered += 1; });

    touch('a');
    touch('a');
    touch('b');
    clock += 59_000;
    touch('a');
    assert.deepEqual(written, ['a', 'b'], 'the first touch of each session is written');
    clock += 2_000;
    touch('a');
    touch('a');
    assert.deepEqual(written, ['a', 'b', 'a'], 'and again once the interval has passed');
    assert.equal(answered, 6, 'every touch calls back, written or not');
});

test('an export is cut off when the client stops reading, and only a few run at once', async () => {
    const { EventEmitter } = require('node:events');
    const { writer, beginExport } = require('../utils/exporter');

    const stuck = Object.assign(new EventEmitter(), { destroyed: false, write: () => false });
    await assert.rejects(writer(stuck, { stallMs: 30 })('chunk'), /abandoned/);
    assert.equal(stuck.listenerCount('drain') + stuck.listenerCount('close'), 0, 'no listeners left behind');

    const slow = Object.assign(new EventEmitter(), { destroyed: false, write: () => false });
    const pending = writer(slow, { stallMs: 1000 })('chunk');
    setTimeout(() => slow.emit('drain'), 20);
    await pending;

    const first = beginExport();
    const second = beginExport();
    assert.equal(beginExport(), null, 'a third export has to wait');
    first();
    first();
    const third = beginExport();
    assert.ok(third, 'a finished export frees its slot, once');
    assert.equal(beginExport(), null);
    second();
    third();
});
