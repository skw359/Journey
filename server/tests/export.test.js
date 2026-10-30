'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');

test('exports', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const owner = await h.registerAdmin(env.origin);

    assert.equal((await owner.get('/database')).status, 404, 'empty account, as before');

    const ids = [];
    for (let i = 0; i < 30; i++) {
        const rows = h.lineRows({ lat: 40 + i * 0.01, count: 200 + i * 10, start: Date.UTC(2025, 0, 1 + i) });
        if (i === 3) rows[5] = { ...rows[5], waypoint: true, note: 'Tom & Jerry <cafe>' };
        const res = await h.uploadJourney(owner, h.journeyZip(rows));
        assert.equal(res.status, 201);
        ids.push(res.data.id);
    }
    await owner.patch(`/api/routes/${ids[3]}/name`, { json: { newName: 'Lunch <at> "Joe\'s" & co' } });

    await t.test('NDJSON export streams every journey with header and footer', async () => {
        const res = await owner.get('/api/export/journeys', { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-disposition'), /attachment; filename="journey-export-\d{4}-\d{2}-\d{2}\.ndjson"/);
        const lines = res.text.trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(lines[0].type, 'header');
        assert.equal(lines[0].user.username, 'owner');
        assert.deepEqual(lines.at(-1), { type: 'end', journeys: 30 });
        const journeys = lines.filter((l) => l.type === 'journey');
        assert.equal(journeys.length, 30);
        const detail = (await owner.get(`/api/routes/${ids[3]}`)).data;
        const exported = journeys.find((j) => j.id === ids[3]);
        assert.deepEqual(exported.coordinates, detail.coordinates);
        assert.deepEqual(exported.profileTimeMs, detail.profileTimeMs);
        assert.equal(exported.waypoints[0].note, 'Tom & Jerry <cafe>');
        assert.ok(Array.isArray(exported.citiesPassed));
    });

    await t.test('the raw /database dump is a streamed JSON array', async () => {
        const res = await owner.get('/database');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data));
        assert.equal(res.data.length, 30);
        assert.deepEqual(Object.keys(res.data[0]).sort(), Object.keys((await owner.get(`/api/routes/${ids[0]}`)).data)
            .filter((k) => !['totalPoints', 'isFullResolution'].includes(k)).sort());
    });

    await t.test('GPX and GeoJSON for one journey', async () => {
        const gpx = await owner.get(`/api/export/journeys/${ids[3]}.gpx`);
        assert.equal(gpx.status, 200);
        assert.match(gpx.headers.get('content-type'), /application\/gpx\+xml/);
        assert.ok(gpx.text.startsWith('<?xml'));
        assert.equal((gpx.text.match(/<trkpt /g) || []).length, 230);
        assert.ok(gpx.text.includes('<name>Lunch &lt;at&gt; &quot;Joe&apos;s&quot; &amp; co</name>'));
        assert.ok(gpx.text.includes('<name>Tom &amp; Jerry &lt;cafe&gt;</name>'));
        assert.ok(!/<at>/.test(gpx.text));

        const geo = await owner.get(`/api/export/journeys/${ids[3]}.geojson`);
        assert.equal(geo.status, 200);
        assert.equal(geo.data.type, 'FeatureCollection');
        const line = geo.data.features[0];
        assert.equal(line.geometry.type, 'LineString');
        assert.equal(line.geometry.coordinates.length, 230);
        const first = (await owner.get(`/api/routes/${ids[3]}`)).data.coordinates[0];
        assert.deepEqual(line.geometry.coordinates[0], [first[1], first[0]]);
        assert.equal(line.properties.coordTimes.length, 230);
        assert.equal((await owner.get('/api/export/journeys/nope.gpx')).status, 404);
    });

    await t.test('npm run migrate:export reads every account', async () => {
        const second = await h.registerInvited(env.origin, owner, 'second');
        await h.uploadJourney(second, h.journeyZip(h.lineRows({ lat: 45, count: 150 })));
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-export-'));
        const root = path.join(__dirname, '..', '..');
        const script = path.join(root, 'server', 'scripts', 'migrate-export.js');
        const log = execFileSync(process.execPath, [script], {
            env: { ...process.env, JOURNEY_EXPORT_DIR: out },
            encoding: 'utf8',
        });
        assert.match(log, /owner: 30 journeys/);
        assert.match(log, /second: 1 journeys/);
        const files = fs.readdirSync(out).sort();
        assert.equal(files.length, 2);
        const ownerLines = fs.readFileSync(path.join(out, files.find((f) => f.startsWith('owner'))), 'utf8').trim().split('\n');
        assert.equal(ownerLines.length, 32);
        fs.rmSync(out, { recursive: true, force: true });
    });
});
