'use strict';

// The resumable upload route, as the iOS app and the web app's large-file path use it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('./helpers');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('resumable media uploads', { skip: h.skipReason() }, async (t) => {
    const { origin, dataDir, pool, teardown } = await h.setupTestServer();
    t.after(teardown);

    const owner = await h.registerAdmin(origin);
    const other = await h.registerInvited(origin, owner, 'someone-else');
    const created = await h.uploadJourney(owner, h.journeyZip(h.lineRows()));
    assert.ok(created.status < 300, `journey upload failed: ${created.text}`);
    const routeId = (await owner.get('/api/routes')).data[0].id;
    const { data: { token } } = await owner.post('/api/pairing/tokens', { json: { label: 'phone' } });
    const phone = h.agent(origin, { bearer: token });
    const base = `/api/routes/${routeId}/uploads`;

    const start = (bytes, key = crypto.randomUUID(), agent = phone) => agent.post(base, {
        json: { name: 'IMG.jpg', size: bytes.length, type: 'image/jpeg', key },
    });
    const put = (id, offset, body, agent = phone) => agent.put(`${base}/${id}?offset=${offset}`, {
        body, headers: { 'content-type': 'application/octet-stream' },
    });
    const partFiles = () => {
        const found = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.upload.tmp')) found.push(full);
            }
        };
        walk(path.join(dataDir, 'photos'));
        return found;
    };
    const storedFile = (filename) => {
        let match = null;
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (full.endsWith(filename)) match = full;
            }
        };
        walk(path.join(dataDir, 'photos'));
        return match;
    };
    const photoCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM photos')).rows[0].n;

    await t.test('a paired device can send a file in pieces and it arrives intact', async () => {
        const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
        const begun = await start(bytes);
        assert.equal(begun.status, 201);
        assert.equal(begun.data.offset, 0);

        const pieceSize = 1024 * 1024;
        let offset = 0;
        let last;
        while (offset < bytes.length) {
            const piece = bytes.subarray(offset, offset + pieceSize);
            last = await put(begun.data.id, offset, piece);
            assert.equal(last.status, 200);
            offset = last.data.offset;
        }
        assert.equal(last.data.photos.length, 1);
        assert.deepEqual(last.data.skipped, []);
        assert.equal(sha(fs.readFileSync(storedFile(last.data.photos[0].filename))), sha(bytes));
        assert.deepEqual(partFiles(), [], 'no partial file left behind');
    });

    await t.test('the same key resumes where the server got to, without a new upload', async () => {
        const bytes = crypto.randomBytes(2 * 1024 * 1024);
        const key = crypto.randomUUID();
        const first = await start(bytes, key);
        await put(first.data.id, 0, bytes.subarray(0, 1024 * 1024));

        const second = await start(bytes, key);
        assert.equal(second.status, 200);
        assert.equal(second.data.id, first.data.id);
        assert.equal(second.data.offset, 1024 * 1024);

        const done = await put(second.data.id, second.data.offset, bytes.subarray(second.data.offset));
        assert.equal(sha(fs.readFileSync(storedFile(done.data.photos[0].filename))), sha(bytes));
    });

    await t.test('a piece at the wrong offset is refused and says where to continue', async () => {
        const bytes = crypto.randomBytes(1024 * 1024);
        const begun = await start(bytes);
        await put(begun.data.id, 0, bytes.subarray(0, 1000));
        const wrong = await put(begun.data.id, 5000, bytes.subarray(5000, 6000));
        assert.equal(wrong.status, 409);
        assert.equal(wrong.data.offset, 1000);
        const status = await phone.get(`${base}/${begun.data.id}`);
        assert.equal(status.data.offset, 1000, 'nothing from the refused piece was stored');
    });

    await t.test('a connection that drops mid-piece keeps its bytes and the file still comes out right', async () => {
        const bytes = crypto.randomBytes(4 * 1024 * 1024);
        const begun = await start(bytes);

        // Declares the whole file, sends some of it, then hangs up
        await new Promise((resolve) => {
            const url = new URL(`${origin}${base}/${begun.data.id}?offset=0`);
            const req = http.request(url, {
                method: 'PUT',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/octet-stream',
                    'content-length': bytes.length,
                },
            });
            req.on('error', () => resolve());
            req.on('close', () => resolve());
            req.write(bytes.subarray(0, 1024 * 1024), () => setTimeout(() => req.destroy(), 100));
        });

        let status;
        for (let i = 0; i < 50; i += 1) {
            status = await phone.get(`${base}/${begun.data.id}`);
            const retry = await put(begun.data.id, status.data.offset, Buffer.alloc(0));
            if (retry.status === 200) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const offset = status.data.offset;
        assert.ok(offset > 0 && offset < bytes.length, `kept part of the piece, got ${offset}`);

        const done = await put(begun.data.id, offset, bytes.subarray(offset));
        assert.equal(done.status, 200);
        assert.equal(sha(fs.readFileSync(storedFile(done.data.photos[0].filename))), sha(bytes));
    });

    await t.test('when the final response is lost, asking again does not store it twice', async () => {
        const bytes = crypto.randomBytes(1024 * 1024);
        const begun = await start(bytes);
        const done = await put(begun.data.id, 0, bytes);
        assert.equal(done.status, 200);
        const count = await photoCount();

        const status = await phone.get(`${base}/${begun.data.id}`);
        assert.equal(status.status, 200);
        assert.equal(status.data.photos[0].id, done.data.photos[0].id);

        const repeated = await put(begun.data.id, bytes.length, Buffer.alloc(0));
        assert.equal(repeated.status, 200);
        assert.equal(repeated.data.photos[0].id, done.data.photos[0].id);

        assert.equal(await photoCount(), count);
    });

    await t.test('an empty piece at the end completes a file stored in full', async () => {
        const bytes = crypto.randomBytes(1000);
        const begun = await start(bytes);
        // As the server leaves it when adding the finished file to the journey fails
        const { rows } = await pool.query('SELECT part_name FROM media_uploads WHERE id = $1', [begun.data.id]);
        const part = storedFile(path.basename(rows[0].part_name));
        fs.writeFileSync(part, bytes);
        const status = await phone.get(`${base}/${begun.data.id}`);
        assert.equal(status.data.offset, bytes.length);
        assert.equal(status.data.photos, undefined);

        const finished = await put(begun.data.id, bytes.length, Buffer.alloc(0));
        assert.equal(finished.status, 200);
        assert.equal(finished.data.photos.length, 1);
    });

    await t.test('a finished upload does not swallow the same file sent again on purpose', async () => {
        const bytes = crypto.randomBytes(1000);
        const key = crypto.randomUUID();
        const first = await start(bytes, key);
        await put(first.data.id, 0, bytes);
        const second = await start(bytes, key);
        assert.equal(second.status, 201);
        assert.notEqual(second.data.id, first.data.id);
        assert.equal(second.data.offset, 0);
    });

    await t.test('more bytes than declared are refused', async () => {
        const bytes = crypto.randomBytes(1000);
        const begun = await start(bytes);
        const res = await put(begun.data.id, 0, crypto.randomBytes(1001));
        assert.equal(res.status, 413);
    });

    await t.test('a piece sent as JSON is not treated as bytes', async () => {
        // Why the client has to set application/octet-stream on pieces
        const bytes = crypto.randomBytes(200 * 1024);
        const begun = await start(bytes);
        const res = await phone.put(`${base}/${begun.data.id}?offset=0`, {
            body: bytes, headers: { 'content-type': 'application/json' },
        });
        assert.notEqual(res.status, 200);
        const status = await phone.get(`${base}/${begun.data.id}`);
        assert.equal(status.data.offset, 0);
    });

    await t.test("another account can't see or add to an upload", async () => {
        const bytes = crypto.randomBytes(1000);
        const begun = await start(bytes);
        assert.equal((await other.get(`${base}/${begun.data.id}`)).status, 404);
        assert.equal((await put(begun.data.id, 0, bytes, other)).status, 404);
        assert.equal((await start(bytes, crypto.randomUUID(), other)).status, 404, 'nor start one on their journey');
    });

    await t.test('a missing journey, an unknown upload and no credentials are all refused', async () => {
        const bytes = crypto.randomBytes(10);
        const missing = await phone.post('/api/routes/no-such-journey/uploads', {
            json: { name: 'IMG.jpg', size: 10, type: 'image/jpeg', key: 'k' },
        });
        assert.equal(missing.status, 404);
        assert.equal((await phone.get(`${base}/no-such-upload`)).status, 404);
        assert.equal((await put('no-such-upload', 0, bytes)).status, 404);
        assert.equal((await h.agent(origin).get(`${base}/anything`)).status, 401);
    });

    await t.test('abandoned uploads are swept with their partial files', async () => {
        const { sweepAbandonedUploads } = require('../routes/mediaUploads');
        const bytes = crypto.randomBytes(1000);
        const begun = await start(bytes);
        await put(begun.data.id, 0, bytes.subarray(0, 100));
        assert.ok(partFiles().length > 0);
        await pool.query("UPDATE media_uploads SET updated_at = NOW() - INTERVAL '25 hours'");
        assert.ok(await sweepAbandonedUploads() >= 1);
        assert.equal((await phone.get(`${base}/${begun.data.id}`)).status, 404);
        assert.deepEqual(partFiles(), []);
    });
});
