'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

// Distance along the track, counting only steps forward in time (as uploads do).
function pathMiles(coords, times) {
    const { haversine } = require('../utils/geo');
    let miles = 0;
    for (let i = 1; i < coords.length; i++) {
        if (times && !(times[i] > times[i - 1])) continue;
        miles += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    }
    return miles;
}

async function jpeg() {
    return require('sharp')({ create: { width: 16, height: 16, channels: 3, background: '#2266aa' } }).jpeg().toBuffer();
}

async function uploadPhoto(client, routeId, name = 'photo.jpg') {
    const form = new FormData();
    form.append('photos', new Blob([await jpeg()], { type: 'image/jpeg' }), name);
    const res = await client.post(`/api/routes/${routeId}/photos`, { body: form });
    assert.equal(res.status, 200, res.text);
    return res.data.photos[0];
}

test('journey editing and lifecycle', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const { origin, pool, dataDir } = env;
    const owner = await h.registerAdmin(origin);
    const schema = require('../db').tenantSchemaForUser(owner.user.id);
    const archiveDir = path.join(dataDir, 'uploads', 'archive', owner.user.id);
    const archiveFiles = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).sort() : []);
    let lat = 30;
    const upload = async (opts = {}) => {
        lat += 0.5;
        const res = await h.uploadJourney(owner, h.journeyZip(h.lineRows({ lat, ...opts })));
        assert.equal(res.status, 201, res.text);
        return res.data;
    };

    await t.test('deleting a GPS spike recomputes distance and speed', async () => {
        const rows = h.lineRows({ count: 600, stepDeg: 0.00003985, lat: 40.0 });
        for (const row of rows) row.lon = -74;
        rows[300] = { ...rows[300], lat: rows[300].lat + 0.05 };
        const up = await h.uploadJourney(owner, h.journeyZip(rows));
        assert.equal(up.status, 201);
        assert.ok(Math.abs(Number(up.data.distance) - 8.56) < 0.05, `spiked distance ${up.data.distance}`);
        assert.ok(Number(up.data.topSpeed) > 1000, 'the spike makes an impossible speed');

        const res = await owner.delete(`/api/routes/${up.data.id}/points/300`);
        assert.equal(res.status, 200, res.text);
        const route = res.data.route;
        assert.equal(route.coordinates.length, 599);
        assert.ok(Math.abs(Number(route.distance) - 1.65) < 0.01, `distance after delete ${route.distance}`);
        assert.ok(Math.abs(Number(route.distance) - pathMiles(route.coordinates)) < 0.006, 'distance is the sum of the remaining segments');
        assert.ok(Math.abs(route.profileDistMi.at(-1) - pathMiles(route.coordinates)) < 1e-9);
        assert.ok(Number(route.topSpeed) < 25, `top speed after delete ${route.topSpeed}`);
        for (const series of ['profileTimeMs', 'profileDistMi', 'profileElevM', 'profileSpeedMph']) {
            assert.equal(route[series].length, 599, series);
        }

        for (const bad of ['-1', 'abc', '1.5', '599', '100000']) {
            assert.equal((await owner.delete(`/api/routes/${up.data.id}/points/${bad}`)).status, 400, bad);
        }
    });

    await t.test('concurrent and batched point deletes stay consistent', async () => {
        const j = await upload({ count: 300 });
        const results = await Promise.all([1, 2, 3].map(() => owner.delete(`/api/routes/${j.id}/points/10`)));
        assert.ok(results.every((r) => r.status === 200));
        const multi = await owner.post(`/api/routes/${j.id}/points/delete`, { json: { indices: [0, 5, 6, 7] } });
        assert.equal(multi.status, 200);
        const route = (await owner.get(`/api/routes/${j.id}`)).data;
        assert.equal(route.coordinates.length, 293);
        assert.equal(route.profileTimeMs.length, 293);
        assert.equal(route.startTime, new Date(route.profileTimeMs[0]).toISOString());
    });

    let big;
    await t.test('very long journeys can be edited and combined', async () => {
        big = await upload({ count: 140_000, stepDeg: 0.000002 });
        const del = await owner.delete(`/api/routes/${big.id}/points/70000`);
        assert.equal(del.status, 200, del.text);
        assert.equal(del.data.route.coordinates.length, 139_999);
        const other = await upload({ count: 20_000, stepDeg: 0.000002, start: Date.UTC(2025, 10, 2) });
        const combined = await owner.post('/api/routes/combine', { json: { journeyIds: [big.id, other.id] } });
        assert.equal(combined.status, 200, combined.text);
        assert.equal(combined.data.route.coordinates.length, 159_999);
        const undo = await owner.post(`/api/routes/${combined.data.route.id}/undo-combine`);
        assert.equal(undo.status, 200, undo.text);
    });

    await t.test('combining overlapping journeys interleaves points by time', async () => {
        const start = Date.UTC(2025, 5, 1, 8);
        const a = await upload({ count: 200, start });
        const b = await upload({ count: 200, start: start + 100_000 });
        const res = await owner.post('/api/routes/combine', { json: { journeyIds: [b.id, a.id], name: 'Both' } });
        assert.equal(res.status, 200, res.text);
        const route = res.data.route;
        assert.equal(route.id, a.id, 'the earliest journey is kept');
        assert.equal(route.name, 'Both');
        assert.ok(route.profileTimeMs.every((ts, i) => i === 0 || ts >= route.profileTimeMs[i - 1]));
        assert.ok(Math.abs(Number(route.distance) - pathMiles(route.coordinates, route.profileTimeMs)) < 0.006);
    });

    await t.test('undo-combine keeps later photo and waypoint changes', async () => {
        const rowsB = h.lineRows({ count: 200, lat: 50, start: Date.UTC(2025, 6, 2) });
        rowsB[20] = { ...rowsB[20], waypoint: true, note: 'cafe' };
        const a = await upload({ count: 200, start: Date.UTC(2025, 6, 1) });
        const bRes = await h.uploadJourney(owner, h.journeyZip(rowsB));
        const b = bRes.data;
        const keptPhoto = await uploadPhoto(owner, a.id, 'kept.jpg');
        const doomedPhoto = await uploadPhoto(owner, a.id, 'doomed.jpg');

        const combined = (await owner.post('/api/routes/combine', { json: { journeyIds: [a.id, b.id] } })).data.route;
        const lateBytes = await uploadPhoto(owner, combined.id, 'late.jpg');
        assert.equal((await owner.delete(`/api/routes/${combined.id}/photos/${doomedPhoto.id}`)).status, 200);
        const wp = combined.waypoints[0];
        assert.equal((await owner.patch(`/api/routes/${combined.id}/waypoints/${wp.id}`, { json: { label: 'Best cafe' } })).status, 200);

        const undo = await owner.post(`/api/routes/${combined.id}/undo-combine`);
        assert.equal(undo.status, 200, undo.text);
        const restoredA = (await owner.get(`/api/routes/${a.id}`)).data;
        const restoredB = (await owner.get(`/api/routes/${b.id}`)).data;
        assert.deepEqual(restoredA.photos.map((p) => p.id).sort(), [keptPhoto.id, lateBytes.id].sort());
        assert.equal(restoredB.waypoints[0].label, 'Best cafe');
        assert.equal(restoredA.coordinates.length, 200);
        assert.equal(restoredB.coordinates.length, 200);
    });

    await t.test('undo-combine refuses to bring back deleted points unless forced', async () => {
        const a = await upload({ count: 120, start: Date.UTC(2025, 7, 1) });
        const b = await upload({ count: 120, start: Date.UTC(2025, 7, 2) });
        const combined = (await owner.post('/api/routes/combine', { json: { journeyIds: [a.id, b.id] } })).data.route;
        assert.equal((await owner.delete(`/api/routes/${combined.id}/points/5`)).status, 200);
        const refused = await owner.post(`/api/routes/${combined.id}/undo-combine`);
        assert.equal(refused.status, 409);
        assert.equal(refused.data.code, 'edited_since_combine');
        const forced = await owner.post(`/api/routes/${combined.id}/undo-combine`, { json: { force: true } });
        assert.equal(forced.status, 200);
    });

    await t.test('restoring onto an existing journey reports a conflict', async () => {
        const j = await upload({ count: 150 });
        const trashed = await owner.delete(`/api/routes/${j.id}`);
        assert.equal(trashed.status, 200);
        await pool.query(`INSERT INTO ${schema}.routes (id, name, distance) VALUES ($1, 'squatter', 5)`, [j.id]);
        const res = await owner.post(`/api/routes/trash/${trashed.data.trashId}/restore`);
        assert.equal(res.status, 409);
        const trash = (await owner.get('/api/routes/trash')).data;
        assert.ok(trash.some((entry) => entry.id === trashed.data.trashId), 'still in Recently Deleted');
        await pool.query(`DELETE FROM ${schema}.routes WHERE id = $1`, [j.id]);
        assert.equal((await owner.post(`/api/routes/trash/${trashed.data.trashId}/restore`)).status, 200);
    });

    await t.test('hard deletes remove upload archives and combine backups', async () => {
        const before = archiveFiles();

        // Delete → restorable (archive kept) → permanent delete (archive gone).
        const j = await upload({ count: 150 });
        const added = archiveFiles().filter((f) => !before.includes(f));
        assert.equal(added.length, 1);
        const trashed = await owner.delete(`/api/routes/${j.id}`);
        assert.ok(archiveFiles().includes(added[0]), 'kept while restorable');
        assert.equal((await owner.delete(`/api/routes/trash/${trashed.data.trashId}`)).status, 200);
        assert.ok(!archiveFiles().includes(added[0]));

        // Combined journey emptied from Trash: every source archive and the backup go.
        const now = archiveFiles();
        const a = await upload({ count: 150, start: Date.UTC(2025, 8, 1) });
        const b = await upload({ count: 150, start: Date.UTC(2025, 8, 2) });
        const sources = archiveFiles().filter((f) => !now.includes(f));
        assert.equal(sources.length, 2);
        const combined = (await owner.post('/api/routes/combine', { json: { journeyIds: [a.id, b.id] } })).data.route;
        const { rows: backups } = await pool.query(`SELECT 1 FROM ${schema}.journey_backups WHERE combined_journey_id = $1`, [combined.id]);
        assert.equal(backups.length, 1);
        await owner.delete(`/api/routes/${combined.id}`);
        assert.equal((await owner.delete('/api/routes/trash')).status, 200);
        assert.deepEqual(archiveFiles().filter((f) => sources.includes(f)), []);
        const { rows: left } = await pool.query(`SELECT 1 FROM ${schema}.journey_backups WHERE combined_journey_id = $1`, [combined.id]);
        assert.equal(left.length, 0);

        // Expiry after 7 days.
        const k = await upload({ count: 150 });
        const kFile = archiveFiles().filter((f) => !now.includes(f) && !sources.includes(f));
        const kTrash = await owner.delete(`/api/routes/${k.id}`);
        await pool.query(`UPDATE ${schema}.trashed_journeys SET deleted_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [kTrash.data.trashId]);
        await require('../utils/trash').sweepAllTrash();
        assert.deepEqual(archiveFiles().filter((f) => kFile.includes(f)), []);

        // A rejected (too short) upload's archive goes when it leaves Recently Deleted.
        const shortRes = await h.uploadJourney(owner, h.journeyZip(h.lineRows({ count: 4, lat: 60 })));
        assert.equal(shortRes.data.trashed, true);
        const trashList = (await owner.get('/api/routes/trash')).data;
        const { rows: [shortEntry] } = await pool.query(
            `SELECT id, archive_names FROM ${schema}.trashed_journeys WHERE origin LIKE 'rejected_%' ORDER BY deleted_at DESC LIMIT 1`
        );
        assert.ok(trashList.length > 0);
        assert.equal(shortEntry.archive_names.length, 1);
        assert.ok(archiveFiles().includes(path.posix.basename(shortEntry.archive_names[0])));
        await owner.delete(`/api/routes/trash/${shortEntry.id}`);
        assert.ok(!archiveFiles().includes(path.posix.basename(shortEntry.archive_names[0])));
    });

    await t.test('archive prune only deletes archives no journey could own', async () => {
        const { findOrphanArchives, deleteArchiveFiles } = require('../utils/uploadArchive');
        const start = Date.UTC(2025, 10, 3, 8);
        assert.equal((await h.uploadJourney(owner, h.journeyZip(h.lineRows({ count: 150, start, lat: 51 })))).status, 201);
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const put = (name, buffer, { old = true } = {}) => {
            fs.writeFileSync(path.join(archiveDir, name), buffer);
            if (old) fs.utimesSync(path.join(archiveDir, name), twoDaysAgo, twoDaysAgo);
            return `${owner.user.id}/${name}`;
        };
        // The journey's own recording with two leading rows it doesn't have, so start times differ.
        put('lead.zip', h.journeyZip(h.lineRows({ count: 152, start: start - 2000, lat: 51 - 0.0002, lon: -73.985428 - 0.0002 })));
        const orphan = put('orphan.zip', h.journeyZip(h.lineRows({ count: 30, start: Date.UTC(2019, 0, 1) })));
        put('fresh.zip', h.journeyZip(h.lineRows({ count: 30, start: Date.UTC(2019, 1, 1) })), { old: false });
        put('junk.zip', Buffer.from('not a zip'));

        const mine = (await findOrphanArchives()).find((account) => account.owner?.id === owner.user.id);
        assert.deepEqual(mine.orphans, [orphan]);
        assert.ok(mine.overlapping >= 1 && mine.recent >= 1 && mine.unreadable >= 1, JSON.stringify(mine));
        await deleteArchiveFiles(mine.orphans);
        assert.deepEqual(['fresh.zip', 'junk.zip', 'lead.zip', 'orphan.zip'].filter((f) => archiveFiles().includes(f)), ['fresh.zip', 'junk.zip', 'lead.zip']);
    });
});
