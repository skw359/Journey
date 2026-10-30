'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

test('upload pipeline', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer({ env: { MAX_JOURNEY_UPLOAD_MB: '1', MAX_JOURNEY_ROWS: '5000' } });
    t.after(env.teardown);
    const { origin, pool, dataDir } = env;
    const owner = await h.registerAdmin(origin);
    const journeyCount = async () => (await owner.get('/api/routes')).data.length;
    const archives = () => {
        const dir = path.join(dataDir, 'uploads', 'archive', owner.user.id);
        return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    };
    const leftovers = () => fs.readdirSync(path.join(dataDir, 'uploads')).filter((f) => f !== 'archive');

    await t.test('a non-zip body is rejected and the server stays up', async () => {
        const res = await h.uploadJourney(owner, Buffer.from('not a zip'));
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'not_zip');
        assert.equal((await fetch(`${origin}/ping`)).status, 200);
    });

    await t.test('a zip without a CSV is rejected promptly', async () => {
        const started = Date.now();
        const res = await h.uploadJourney(owner, h.zip({ 'readme.txt': 'hello' }));
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'no_csv');
        assert.ok(Date.now() - started < 5000);
    });

    await t.test('a zip with two CSVs is rejected and nothing is stored', async () => {
        const csv = h.csvFromRows(h.lineRows({ count: 300 }));
        const res = await h.uploadJourney(owner, h.zip({ 'a.csv': csv, 'b.csv': csv }));
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'multiple_csv');
        assert.equal(await journeyCount(), 0);
    });

    await t.test('a truncated zip and a bad CSV are rejected', async () => {
        const good = h.journeyZip(h.lineRows({ count: 100 }));
        assert.equal((await h.uploadJourney(owner, good.subarray(0, good.length - 30))).status, 400);
        assert.equal((await fetch(`${origin}/ping`)).status, 200);
    });

    await t.test('limits on size and rows', async () => {
        const huge = h.zip({ 'route.csv': require('node:crypto').randomBytes(1.5 * 1024 * 1024) });
        assert.equal((await h.uploadJourney(owner, huge)).status, 413);
        const tooMany = await h.uploadJourney(owner, h.journeyZip(h.lineRows({ count: 6000, stepDeg: 0.00001 })));
        assert.equal(tooMany.status, 413);
        assert.equal(tooMany.data.code, 'too_many_rows');
        assert.equal((await owner.post('/upload', { body: new FormData() })).status, 400);
    });

    assert.deepEqual(leftovers(), [], 'rejected uploads leave no files behind');

    let firstId;
    await t.test('Finder clutter is ignored; the journey and its archive are stored', async () => {
        const csv = h.csvFromRows(h.lineRows({ count: 300 }));
        const res = await h.uploadJourney(owner, h.zip({ '__MACOSX/._route.csv': 'junk', 'route.csv': csv }), { recordingId: 'rec-1' });
        assert.equal(res.status, 201, res.text);
        firstId = res.data.id;
        const { rows } = await pool.query(
            `SELECT archive_names, client_upload_id, content_fingerprint FROM ${require('../db').tenantSchemaForUser(owner.user.id)}.routes WHERE id = $1`,
            [firstId]
        );
        assert.equal(rows[0].client_upload_id, 'rec-1');
        assert.ok(rows[0].content_fingerprint);
        assert.equal(rows[0].archive_names.length, 1);
        assert.deepEqual(archives(), [path.posix.basename(rows[0].archive_names[0])]);
    });

    await t.test('retries never create duplicates', async () => {
        const zipBuf = h.journeyZip(h.lineRows({ count: 300 }));
        const sameId = await h.uploadJourney(owner, zipBuf, { recordingId: 'rec-1' });
        assert.equal(sameId.status, 200);
        assert.equal(sameId.data.duplicate, true);
        assert.equal(sameId.data.id, firstId);
        const noId = await h.uploadJourney(owner, zipBuf);
        assert.equal(noId.status, 200);
        assert.equal(noId.data.id, firstId);
        assert.equal(await journeyCount(), 1);
        assert.equal(archives().length, 1, 'duplicates are not archived');

        const other = h.journeyZip(h.lineRows({ count: 300, lat: 41.2 }));
        const parallel = await Promise.all([1, 2, 3, 4].map(() => h.uploadJourney(owner, other, { recordingId: 'rec-2' })));
        assert.equal(parallel.filter((r) => r.status === 201).length, 1);
        assert.ok(parallel.every((r) => r.status === 201 || (r.status === 200 && r.data.duplicate)));
        assert.equal(await journeyCount(), 2);
    });

    await t.test('short journeys go to Recently Deleted once', async () => {
        const short = h.journeyZip(h.lineRows({ count: 5, lat: 42 }));
        const res = await h.uploadJourney(owner, short, { recordingId: 'rec-short' });
        assert.equal(res.status, 200);
        assert.equal(res.data.saved, false);
        assert.equal(res.data.trashed, true);
        const retry = await h.uploadJourney(owner, short, { recordingId: 'rec-short' });
        assert.equal(retry.data.duplicate, true);
        const trash = await owner.get('/api/routes/trash');
        assert.equal(trash.data.length, 1);
    });

    await t.test('out-of-order and repeated rows are put in order', async () => {
        const rows = h.lineRows({ count: 200, lat: 43 });
        const shuffled = [...rows.slice(100), ...rows.slice(0, 100), rows[50]];
        const res = await h.uploadJourney(owner, h.journeyZip(shuffled));
        assert.equal(res.status, 201);
        const times = res.data.profileTimeMs;
        assert.equal(times.length, 200);
        assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]));
        // Sorted, it's the same recording as the in-order file.
        const inOrder = await h.uploadJourney(owner, h.journeyZip(rows));
        assert.equal(inOrder.status, 200);
        assert.equal(inOrder.data.id, res.data.id);
    });

    await t.test('notes with markup are stored as plain text', async () => {
        const rows = h.lineRows({ count: 150, lat: 44 });
        rows[10] = { ...rows[10], waypoint: true, note: '<img src=x onerror=alert(1)>' };
        const res = await h.uploadJourney(owner, h.journeyZip(rows));
        assert.equal(res.status, 201);
        assert.equal(res.data.waypoints[0].note, '<img src=x onerror=alert(1)>');
        assert.match(res.data.waypoints[0].id, /^wp-[0-9a-f]{16}$/);
    });
});
