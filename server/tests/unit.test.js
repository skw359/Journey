'use strict';

// Pure unit tests (no database). helpers is required first so nothing can open a pool
// against pg's defaults.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

// The statistics the upload route computed before the shared module existed, kept as an
// oracle: new uploads must produce exactly the same numbers.
function legacyUploadStats(rows) {
    const { haversine } = require('../utils/geo');
    const s = {
        count: 0, topSpeedMps: 0, sumSpeedMps: 0, speedSamples: 0, topElevation: -Infinity,
        lowestElevation: Infinity, sumElevation: 0, last: null, lastTs: null, totalMiles: 0, firstTs: null,
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
        avg_elevation: parseFloat((s.count ? s.sumElevation / s.count : 0).toFixed(2)),
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

