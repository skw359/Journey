'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const h = require('./helpers');

const FIXTURES = path.join(__dirname, 'fixtures');

async function jpeg(color = '#2266aa') {
    return require('sharp')({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer();
}

// A one-second clip, made with the same ffmpeg the server converts with.
function clip(file) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
            '-t', '1', '-c:v', 'mpeg4', '-f', 'mov', file], (err) => (err ? reject(err) : resolve(fs.readFileSync(file))));
    });
}

test('chunked uploads and media conversion', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const { origin, pool, dataDir } = env;
    const owner = await h.registerAdmin(origin);
    const other = await h.registerInvited(origin, owner, 'other');
    const journey = (await h.uploadJourney(owner, h.journeyZip(h.lineRows({ count: 300 })))).data;
    const base = `/api/routes/${journey.id}/uploads`;
    const mediaDir = path.join(dataDir, 'photos', owner.user.id);
    const stored = () => (fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).sort() : []);
    const gallery = async () => (await owner.get(`/api/routes/${journey.id}/photos`)).data.photos;
    const piece = (client, id, offset, bytes) => client.put(`${base}/${id}?offset=${offset}`, {
        body: bytes, headers: { 'content-type': 'application/octet-stream' },
    });
    const settled = async (photoId, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const photo = (await gallery()).find((p) => p.id === photoId);
            if (!photo || photo.status !== 'processing') return photo;
            if (Date.now() > deadline) assert.fail(`${photoId} was still processing after ${timeoutMs / 1000}s`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    };

    await t.test('an upload has to be a photo or video for a journey of yours', async () => {
        const start = (json, client = owner, url = base) => client.post(url, { json });
        assert.equal((await start({ name: 'a.jpg' })).status, 400);
        assert.equal((await start({ name: '', size: 10, type: 'image/jpeg' })).status, 400);
        assert.equal((await start({ name: 'a.jpg', size: 0, type: 'image/jpeg' })).status, 400);
        assert.equal((await start({ name: 'a.jpg', size: 1.5, type: 'image/jpeg' })).status, 400);
        assert.equal((await start({ name: 'notes.txt', size: 10, type: 'text/plain' })).status, 400);
        assert.equal((await start({ name: 'page.html', size: 10, type: 'image/jpeg' })).status, 400, 'the extension has to match too');
        assert.equal((await start({ name: 'huge.jpg', size: 51 * 1024 * 1024, type: 'image/jpeg' })).status, 400);
        assert.equal((await start({ name: 'a.jpg', size: 10, type: 'image/jpeg' }, owner, '/api/routes/journey-nope/uploads')).status, 404);
        assert.equal((await start({ name: 'a.jpg', size: 10, type: 'image/jpeg' }, other)).status, 404, 'not someone else\'s journey');
        assert.equal((await start({ name: 'a.jpg', size: 10, type: 'image/jpeg' }, h.agent(origin))).status, 401);
        assert.deepEqual(stored(), [], 'nothing was left on disk');
        const { rows } = await pool.query('SELECT 1 FROM media_uploads');
        assert.equal(rows.length, 0);
    });

    await t.test('a photo sent in pieces is assembled and added to the journey', async () => {
        const bytes = await jpeg();
        const cut = Math.floor(bytes.length / 2);
        const started = await owner.post(base, { json: { name: 'pieces.jpg', size: bytes.length, type: 'image/jpeg', key: 'key-1' } });
        assert.equal(started.status, 201, started.text);
        assert.deepEqual(started.data, { id: started.data.id, size: bytes.length, offset: 0 });
        const { id } = started.data;
        assert.equal(stored().length, 1);
        assert.match(stored()[0], /\.jpg\.upload\.tmp$/);

        // Only the owner, only in order, and never more than was declared.
        assert.equal((await piece(other, id, 0, bytes.subarray(0, cut))).status, 404);
        const first = await piece(owner, id, 0, bytes.subarray(0, cut));
        assert.deepEqual(first.data, { id, size: bytes.length, offset: cut });
        const again = await piece(owner, id, 0, bytes.subarray(0, cut));
        assert.equal(again.status, 409, 'a repeated piece is refused');
        assert.equal(again.data.offset, cut, 'and says where to carry on from');
        assert.equal((await piece(owner, id, cut, Buffer.concat([bytes.subarray(cut), Buffer.from('extra')]))).status, 413);
        assert.equal((await owner.put(`${base}/${id}`, { body: bytes })).status, 400, 'offset is required');
        assert.deepEqual((await owner.get(`${base}/${id}`)).data, { id, size: bytes.length, offset: cut });
        assert.deepEqual(await gallery(), [], 'not in the gallery until it is whole');

        // Starting again with the same key resumes; the page was reloaded, say.
        const resumed = await owner.post(base, { json: { name: 'pieces.jpg', size: bytes.length, type: 'image/jpeg', key: 'key-1' } });
        assert.equal(resumed.status, 200);
        assert.deepEqual(resumed.data, { id, size: bytes.length, offset: cut });

        const last = await piece(owner, id, cut, bytes.subarray(cut));
        assert.equal(last.status, 200, last.text);
        assert.equal(last.data.offset, bytes.length);
        assert.equal(last.data.photos.length, 1);
        assert.equal(last.data.processing, 0);
        const photo = last.data.photos[0];
        assert.equal(photo.originalName, 'pieces.jpg');
        assert.equal(photo.status, 'ready');
        assert.deepEqual((await gallery()).map((p) => p.id), [photo.id]);
        const served = await owner.get(`/photos/${photo.filename}`, { raw: true });
        assert.equal(served.status, 200);
        assert.ok(Buffer.from(await served.arrayBuffer()).equals(bytes), 'the same bytes that were sent');
        assert.deepEqual(stored(), [path.basename(photo.filename)], 'the partial file became the photo');

        // The last response was lost: sending the piece again gets the same answer, not a second photo.
        const repeat = await piece(owner, id, bytes.length, Buffer.alloc(0));
        assert.equal(repeat.status, 200);
        assert.equal(repeat.data.photos[0].id, photo.id);
        assert.equal((await piece(owner, id, 0, bytes.subarray(0, cut))).status, 409);
        assert.equal((await owner.get(`${base}/${id}`)).data.photos[0].id, photo.id);
        assert.equal((await gallery()).length, 1);
        // A finished upload is not resumed; the same file can be added again.
        const second = await owner.post(base, { json: { name: 'pieces.jpg', size: bytes.length, type: 'image/jpeg', key: 'key-1' } });
        assert.equal(second.status, 201);
        assert.notEqual(second.data.id, id);
        assert.equal((await owner.get(`${base}/nope`)).status, 404);
    });

    await t.test('a paired phone can upload in pieces too', async () => {
        const token = (await owner.post('/api/pairing/tokens', { json: {} })).data.token;
        const phone = h.agent(origin, { bearer: token });
        const bytes = await jpeg('#aa6622');
        const started = await phone.post(base, { json: { name: 'phone.jpg', size: bytes.length, type: 'image/jpeg' } });
        assert.equal(started.status, 201, started.text);
        const done = await piece(phone, started.data.id, 0, bytes);
        assert.equal(done.status, 200, done.text);
        assert.equal(done.data.photos[0].originalName, 'phone.jpg');
    });

    await t.test('uploads nobody finishes are cleaned up', async () => {
        const before = stored().length;
        const bytes = await jpeg('#663399');
        const stale = await owner.post(base, { json: { name: 'stale.jpg', size: bytes.length, type: 'image/jpeg' } });
        const recent = await owner.post(base, { json: { name: 'recent.jpg', size: bytes.length, type: 'image/jpeg' } });
        await piece(owner, stale.data.id, 0, bytes.subarray(0, 100));
        assert.equal(stored().length, before + 2);
        await pool.query("UPDATE media_uploads SET updated_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [stale.data.id]);
        const { sweepAbandonedUploads } = require('../routes/mediaUploads');
        assert.equal(await sweepAbandonedUploads(), 1);
        assert.equal(stored().length, before + 1, 'its partial file is gone');
        assert.equal((await owner.get(`${base}/${stale.data.id}`)).status, 404);
        assert.equal((await owner.get(`${base}/${recent.data.id}`)).status, 200);

        // A partial file that disappeared (its drive was unplugged) can't be resumed.
        const { rows: [{ part_name: partName }] } = await pool.query('SELECT part_name FROM media_uploads WHERE id = $1', [recent.data.id]);
        fs.rmSync(path.join(dataDir, 'photos', partName));
        assert.equal((await piece(owner, recent.data.id, 0, bytes)).status, 404);
        const { rows } = await pool.query('SELECT 1 FROM media_uploads WHERE id = $1', [recent.data.id]);
        assert.equal(rows.length, 0);
    });

    await t.test('a journey deleted mid-upload takes the upload with it', async () => {
        const doomed = (await h.uploadJourney(owner, h.journeyZip(h.lineRows({ count: 300, lat: 44 })))).data;
        const bytes = await jpeg('#118833');
        const started = await owner.post(`/api/routes/${doomed.id}/uploads`, { json: { name: 'late.jpg', size: bytes.length, type: 'image/jpeg' } });
        const before = stored().length;
        assert.equal((await owner.delete(`/api/routes/${doomed.id}`)).status, 200);
        const done = await owner.put(`/api/routes/${doomed.id}/uploads/${started.data.id}?offset=0`, { body: bytes });
        assert.equal(done.status, 404);
        assert.equal(stored().length, before - 1, 'the file is not kept for a journey that is gone');
    });

    await t.test('a HEIC photo is converted to JPEG in the background', async () => {
        const heic = fs.readFileSync(path.join(FIXTURES, 'photo.heic'));
        const form = new FormData();
        form.append('photos', new Blob([heic], { type: 'image/heic' }), 'IMG_0001.HEIC');
        const res = await owner.post(`/api/routes/${journey.id}/photos`, { body: form });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.data.processing, 1);
        assert.equal(res.data.converted, 1);
        const uploaded = res.data.photos[0];
        assert.equal(uploaded.status, 'processing');
        assert.equal(uploaded.mimetype, 'image/heic');

        const photo = await settled(uploaded.id);
        assert.equal(photo.status, 'ready');
        assert.equal(photo.mimetype, 'image/jpeg');
        assert.match(photo.filename, /\.jpg$/);
        assert.equal(photo.originalName, 'IMG_0001.HEIC');
        const served = await owner.get(`/photos/${photo.filename}`, { raw: true });
        const meta = await require('sharp')(Buffer.from(await served.arrayBuffer())).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 640, 480]);
        assert.ok(!stored().some((name) => /\.heic$/i.test(name)), 'the original HEIC is removed once converted');
        assert.equal((await owner.get(`/photos/thumb/${photo.filename}`, { raw: true })).status, 200);
    });

    await t.test('a photo that cannot be converted is marked failed, not left processing', async () => {
        const upload = async (bytes, name) => {
            const form = new FormData();
            form.append('photos', new Blob([bytes], { type: 'image/heic' }), name);
            return (await owner.post(`/api/routes/${journey.id}/photos`, { body: form })).data.photos[0];
        };
        const garbage = await settled((await upload(crypto.randomBytes(2048), 'broken.heic')).id);
        assert.equal(garbage.status, 'failed');
        // 105 megapixels: refused before it is decoded into memory.
        const oversized = await settled((await upload(fs.readFileSync(path.join(FIXTURES, 'oversized.heic')), 'poster.heic')).id);
        assert.equal(oversized.status, 'failed');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!stored().some((name) => /\.heic$/i.test(name)), 'failed originals are removed');

        // It can still be deleted from the gallery.
        assert.equal((await owner.delete(`/api/routes/${journey.id}/photos/${garbage.id}`)).status, 200);
        assert.ok(!(await gallery()).some((p) => p.id === garbage.id));
    });

    await t.test('after a restart, conversions that were under way are picked up or failed', async () => {
        const { requeueAllProcessing } = require('../utils/mediaQueue');
        const schema = require('../db').tenantSchemaForUser(owner.user.id);
        // One whose original is still there, one whose original is gone.
        const name = `${owner.user.id}/${crypto.randomBytes(16).toString('hex')}.heic`;
        fs.copyFileSync(path.join(FIXTURES, 'photo.heic'), path.join(dataDir, 'photos', name));
        await pool.query(`
            INSERT INTO ${schema}.photos (id, route_id, filename, original_name, mimetype, size, uploaded_at, status)
            VALUES ('photo-waiting', $1, $2, 'waiting.heic', 'image/heic', 644, NOW(), 'processing'),
                   ('photo-lost', $1, $3, 'lost.heic', 'image/heic', 644, NOW(), 'processing')
        `, [journey.id, name, `${owner.user.id}/missing.heic`]);

        assert.equal(await requeueAllProcessing(), 1);
        assert.equal((await settled('photo-waiting')).status, 'ready');
        assert.equal((await settled('photo-lost')).status, 'failed');
        assert.equal(await requeueAllProcessing(), 0, 'nothing is queued twice');
    });

    await t.test('a video is converted to MP4 with a poster', async (t2) => {
        const { getCapabilities } = require('../utils/video');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-clip-'));
        t2.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        if (!(await getCapabilities()).available) {
            // No ffmpeg on this machine: the server says so up front instead of accepting the file.
            const refused = await owner.post(base, { json: { name: 'clip.mov', size: 1000, type: 'video/quicktime' } });
            assert.equal(refused.status, 400);
            assert.match(refused.data.error, /ffmpeg/);
            t2.diagnostic('ffmpeg not installed; conversion not exercised');
            return;
        }
        const bytes = await clip(path.join(tmp, 'clip.mov'));
        const started = await owner.post(base, { json: { name: 'clip.mov', size: bytes.length, type: 'video/quicktime' } });
        assert.equal(started.status, 201, started.text);
        const done = await piece(owner, started.data.id, 0, bytes);
        assert.equal(done.status, 200, done.text);
        assert.equal(done.data.processing, 1);
        assert.equal(done.data.photos[0].kind, 'video');
        assert.equal(done.data.photos[0].status, 'processing');

        const video = await settled(done.data.photos[0].id, 120_000);
        assert.equal(video.status, 'ready');
        assert.equal(video.mimetype, 'video/mp4');
        assert.match(video.filename, /\.mp4$/);
        assert.deepEqual([video.width, video.height], [320, 240]);
        assert.ok(video.durationMs >= 900 && video.durationMs <= 1200, `duration ${video.durationMs}`);
        assert.match(video.posterFilename, /\.jpg$/);
        const poster = await owner.get(`/photos/${video.posterFilename}`, { raw: true });
        assert.equal(poster.headers.get('content-type'), 'image/jpeg');
        // Seeking needs Range requests.
        const range = await owner.get(`/photos/${video.filename}`, { raw: true, headers: { range: 'bytes=0-99' } });
        assert.equal(range.status, 206);
        assert.equal((await range.arrayBuffer()).byteLength, 100);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!stored().some((name) => name.endsWith('.mov')), 'the original is removed once converted');
        assert.equal((await other.get(`/photos/${video.filename}`, { raw: true })).status, 404, 'not for another account');
    });
});
