'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

test('accounts, admin settings and tokens', { skip: h.skipReason() }, async (t) => {
    const env = await h.setupTestServer();
    t.after(env.teardown);
    const { origin, pool } = env;
    t.beforeEach(() => h.resetRateLimits());

    // Several sign-ups at once on an empty server: exactly one becomes the first account.
    const racers = Array.from({ length: 5 }, (_, i) => h.agent(origin));
    const results = await Promise.all(racers.map((a, i) => a.post('/api/auth/register', {
        json: { username: `racer${i}`, password: 'racer-password-1' },
    })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 403, 403, 403, 403]);
    const winner = racers[results.findIndex((r) => r.status === 201)];
    assert.equal(results.find((r) => r.status === 201).data.user.isAdmin, true);
    const admin = winner;

    await t.test('registration is invite-only after setup', async () => {
        const anon = h.agent(origin);
        const status = await anon.get('/api/auth/status');
        assert.equal(status.data.registration, 'invite-only');
        const noInvite = await anon.post('/api/auth/register', { json: { username: 'mallory', password: 'mallory-password' } });
        assert.equal(noInvite.status, 403);
        assert.equal(noInvite.data.code, 'invite_required');
        const badInvite = await anon.post('/api/auth/register', { json: { username: 'mallory', password: 'mallory-password', invite: 'nope'.repeat(10) } });
        assert.equal(badInvite.status, 403);
        const { rows } = await pool.query("SELECT 1 FROM users WHERE username = 'mallory'");
        assert.equal(rows.length, 0);
    });

    await t.test('invites are single-use, expire and can be revoked', async () => {
        const invite = await admin.post('/api/admin/invites', { json: { note: 'friend', expiresInDays: 3 } });
        assert.equal(invite.status, 201);
        assert.match(invite.data.url, /\/register\?invite=/);
        const { rows: stored } = await pool.query('SELECT token_hash FROM invites WHERE id = $1', [invite.data.id]);
        assert.notEqual(stored[0].token_hash, invite.data.token, 'only a hash is stored');

        const check = await h.agent(origin).get(`/api/auth/invite?token=${encodeURIComponent(invite.data.token)}`);
        assert.equal(check.data.valid, true);

        const first = await h.agent(origin).post('/api/auth/register', { json: { username: 'friend', password: 'friend-password', invite: invite.data.token } });
        assert.equal(first.status, 201);
        assert.equal(first.data.user.isAdmin, false);
        const reuse = await h.agent(origin).post('/api/auth/register', { json: { username: 'friend2', password: 'friend-password', invite: invite.data.token } });
        assert.equal(reuse.status, 403);

        const expiring = await admin.post('/api/admin/invites', { json: {} });
        await pool.query("UPDATE invites SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [expiring.data.id]);
        const expired = await h.agent(origin).post('/api/auth/register', { json: { username: 'late', password: 'late-password', invite: expiring.data.token } });
        assert.equal(expired.status, 403);

        const revoked = await admin.post('/api/admin/invites', { json: {} });
        assert.equal((await admin.delete(`/api/admin/invites/${revoked.data.id}`)).status, 200);
        const afterRevoke = await h.agent(origin).post('/api/auth/register', { json: { username: 'revoked', password: 'revoked-password', invite: revoked.data.token } });
        assert.equal(afterRevoke.status, 403);

        const list = await admin.get('/api/admin/invites');
        const statuses = new Map(list.data.map((i) => [i.id, i.status]));
        assert.equal(statuses.get(invite.data.id), 'used');
        assert.equal(statuses.get(expiring.data.id), 'expired');
        assert.equal(statuses.get(revoked.data.id), 'revoked');
    });

    const second = await h.registerInvited(origin, admin, 'second');

    await t.test('only the admin can change server-wide settings', async () => {
        const anon = h.agent(origin);
        const cases = [
            ['put', '/api/settings/weather', { enabled: true, provider: 'custom', customUrl: 'http://127.0.0.1:3999/w?lat={lat}&lon={lon}' }],
            ['put', '/api/settings/flights', { apiKey: 'x' }],
            ['put', '/api/ask/config', { enabled: true, url: 'http://127.0.0.1:3999' }],
            ['post', '/api/ask/config/test', { url: 'http://127.0.0.1:3999' }],
            ['get', '/api/settings/database'],
            ['put', '/api/settings/attachment-storage', { target: { kind: 'internal' } }],
            ['get', '/api/settings/attachment-storage/drives'],
            ['get', '/api/admin/invites'],
            ['post', '/api/admin/invites', {}],
            ['get', '/api/admin/users'],
        ];
        for (const [method, url, json] of cases) {
            const asSecond = await second[method](url, { json });
            assert.equal(asSecond.status, 403, `${method.toUpperCase()} ${url} as a second account`);
            const asAnon = await anon[method](url, { json });
            assert.equal(asAnon.status, 401, `${method.toUpperCase()} ${url} anonymously`);
        }
        const { rows } = await pool.query("SELECT key FROM app_config WHERE key LIKE 'weather_%' OR key LIKE 'marco_%' OR key = 'flightaware_api_key'");
        assert.equal(rows.length, 0, 'nothing was saved');

        // The runtime database switch and connection probe no longer exist.
        assert.equal((await admin.put('/api/settings/database', { json: { host: '127.0.0.1', database: 'x', username: 'x' } })).status, 404);
        assert.equal((await admin.post('/api/settings/database/test', { json: { host: '127.0.0.1', port: 22, database: 'x', username: 'x' } })).status, 404);
        const db = await admin.get('/api/settings/database');
        assert.equal(db.status, 200);
        assert.equal(db.data.source, 'DATABASE_URL');
        assert.ok(!JSON.stringify(db.data).includes('password'));

        const weather = await second.get('/api/settings/weather');
        assert.deepEqual(Object.keys(weather.data).sort(), ['canManage', 'weather_enabled', 'weather_sounding_enabled']);
        const marco = await second.get('/api/ask/config');
        assert.deepEqual(Object.keys(marco.data).sort(), ['canManage', 'enabled']);
    });

    await t.test('admin can save settings; outbound URLs must be http(s)', async () => {
        for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/{lat}', 'http://user:pw@host/{lat}']) {
            const res = await admin.put('/api/settings/weather', { json: { provider: 'custom', customUrl: bad } });
            assert.equal(res.status, 400, bad);
        }
        const ok = await admin.put('/api/settings/weather', { json: { enabled: true, provider: 'open-meteo' } });
        assert.equal(ok.status, 200);
        const marco = await admin.put('/api/ask/config', { json: { enabled: true, url: 'file:///etc' } });
        assert.equal(marco.status, 400);
    });

    await t.test('accounts cannot see each other\'s journeys', async () => {
        const up = await h.uploadJourney(admin, h.journeyZip(h.lineRows({ count: 200 })));
        assert.equal(up.status, 201);
        const id = up.data.id;
        assert.equal((await second.get('/api/routes')).data.length, 0);
        assert.equal((await second.get(`/api/routes/${id}`)).status, 404);
        assert.equal((await second.patch(`/api/routes/${id}/name`, { json: { newName: 'pwned' } })).status, 404);
        assert.equal((await second.delete(`/api/routes/${id}`)).status, 404);
        assert.equal((await second.delete(`/api/routes/${id}/points/3`)).status, 404);
        assert.equal((await second.get(`/api/export/journeys/${id}.gpx`)).status, 404);
        assert.equal((await second.get('/api/settings/weather/sounding?routeId=' + id)).status, 404);
        const atlas = await second.get('/api/alltime-map-data');
        assert.equal(atlas.data.routes.length, 0);
        const heat = await second.get('/api/heatmap-grid?zoom=12');
        assert.equal(heat.data.cells.length, 0);
        assert.equal((await second.get('/api/fun-stats')).data.empty, true);
        assert.equal((await admin.get(`/api/routes/${id}`)).status, 200);
    });

    await t.test('passwords need 8+ characters', async () => {
        const invite = await admin.post('/api/admin/invites', { json: {} });
        const res = await h.agent(origin).post('/api/auth/register', { json: { username: 'shorty', password: '1234567', invite: invite.data.token } });
        assert.equal(res.status, 400);
    });

    await t.test('sign-in issues a fresh session id and secure-capable cookie', async () => {
        const browser = h.agent(origin);
        await browser.post('/api/auth/login', { json: { username: 'second', password: 'second-password-1' } });
        const firstSid = browser.cookie;
        assert.ok(firstSid);
        await browser.post('/api/auth/login', { json: { username: 'second', password: 'second-password-1' } });
        assert.notEqual(browser.cookie, firstSid);

        const res = await fetch(`${origin}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
            body: JSON.stringify({ username: 'second', password: 'second-password-1' }),
        });
        const cookie = res.headers.get('set-cookie');
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        assert.match(cookie, /Secure/i);
    });

    await t.test('repeated failed sign-ins are rate limited', async () => {
        const attacker = h.agent(origin);
        let last;
        for (let i = 0; i < 11; i++) {
            last = await attacker.post('/api/auth/login', { json: { username: 'second', password: `wrong-${i}` } });
        }
        assert.equal(last.status, 429);
        assert.ok(Number(last.headers.get('retry-after')) > 0);
        const right = await attacker.post('/api/auth/login', { json: { username: 'second', password: 'second-password-1' } });
        assert.equal(right.status, 429, 'locked out even with the right password until the window passes');
        h.resetRateLimits();
    });

    await t.test('pairing tokens are hashed, shown once, scoped and expire', async () => {
        const created = await admin.post('/api/pairing/tokens', { json: { label: 'Test phone' } });
        assert.equal(created.status, 201);
        assert.match(created.data.token, /^[0-9a-f]{64}$/);
        const { rows } = await pool.query('SELECT token, token_hash FROM pairing_tokens WHERE id = $1', [created.data.id]);
        assert.equal(rows[0].token, null);
        assert.notEqual(rows[0].token_hash, created.data.token);
        const listed = await admin.get('/api/pairing/tokens');
        assert.ok(!JSON.stringify(listed.data).includes(created.data.token));
        assert.equal((await admin.get('/api/pairing/qr-data')).status, 410);

        const phone = h.agent(origin, { bearer: created.data.token });
        assert.equal((await phone.get('/api/routes')).status, 200);
        assert.equal((await phone.get('/api/auth/me')).data.username, admin.user?.username ?? 'racer' + results.findIndex((r) => r.status === 201));
        assert.equal((await phone.get('/api/routes/trash')).status, 403);
        assert.equal((await phone.delete('/api/routes/trash')).status, 403);
        assert.equal((await phone.post('/api/routes/combine', { json: { journeyIds: ['a', 'b'] } })).status, 403);
        assert.equal((await phone.get('/api/settings/units')).status, 401);
        assert.equal((await phone.get('/api/fun-stats')).status, 401);
        assert.equal((await phone.post('/api/pairing/tokens', { json: {} })).status, 401);

        // A QR code nobody scanned stops working.
        const unscanned = await admin.post('/api/pairing/tokens', { json: {} });
        await pool.query("UPDATE pairing_tokens SET pending_until = NOW() - INTERVAL '1 second' WHERE id = $1", [unscanned.data.id]);
        assert.equal((await h.agent(origin, { bearer: unscanned.data.token }).get('/api/routes')).status, 401);
        // A device unused for too long has to pair again.
        await pool.query("UPDATE pairing_tokens SET last_used_at = NOW() - INTERVAL '400 days' WHERE id = $1", [created.data.id]);
        assert.equal((await phone.get('/api/routes')).status, 401);
    });

    await t.test('plaintext pairing tokens from older versions are migrated to hashes', async () => {
        const legacyToken = 'a'.repeat(64);
        await pool.query("INSERT INTO pairing_tokens (id, user_id, token, label) VALUES ('pt-legacy', $1, $2, 'old')", [second.user.id, legacyToken]);
        await pool.query("DELETE FROM schema_migrations WHERE scope = 'global' AND name = '2026-10-29-hashed-pairing-tokens'");
        await require('../db').initSchema();
        const { rows } = await pool.query("SELECT token, token_hash FROM pairing_tokens WHERE id = 'pt-legacy'");
        assert.equal(rows[0].token, null);
        assert.ok(rows[0].token_hash);
        assert.equal((await h.agent(origin, { bearer: legacyToken }).get('/api/routes')).status, 200);
    });

    await t.test('avatars are re-encoded JPEGs, never HTML', async () => {
        const html = new FormData();
        html.append('avatar', new Blob(['<script>fetch("/api/routes")</script>'], { type: 'image/jpeg' }), 'avatar.html');
        const rejected = await second.post('/api/auth/avatar', { body: html });
        assert.equal(rejected.status, 400);
        assert.equal(fs.readdirSync(path.join(env.dataDir, 'avatars')).length, 0);

        const sharp = require('sharp');
        const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#33aa66' } }).png().toBuffer();
        const form = new FormData();
        form.append('avatar', new Blob([png], { type: 'image/png' }), 'me.png.html');
        const ok = await second.post('/api/auth/avatar', { body: form });
        assert.equal(ok.status, 200, ok.text);
        assert.match(ok.data.avatarUrl, /^\/api\/auth\/avatar\/user-[0-9a-f]+-\d+\.jpg$/);
        const served = await fetch(`${origin}${ok.data.avatarUrl}`);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get('content-type'), 'image/jpeg');
        assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
        const bytes = Buffer.from(await served.arrayBuffer());
        assert.equal(bytes[0], 0xff);
        assert.equal(bytes[1], 0xd8);
        assert.equal((await fetch(`${origin}/api/auth/avatar/user-1-1.html`)).status, 404);
    });

    await t.test('the last admin cannot leave other accounts without an admin', async () => {
        const res = await admin.delete('/api/auth/account', { json: { password: 'racer-password-1' } });
        assert.equal(res.status, 409);
        const demote = await admin.patch(`/api/admin/users/${results.find((r) => r.status === 201).data.user.id}`, { json: { isAdmin: false } });
        assert.equal(demote.status, 409);
    });

    await t.test('admin can remove an account and everything it owns', async () => {
        const third = await h.registerInvited(origin, admin, 'third');
        const up = await h.uploadJourney(third, h.journeyZip(h.lineRows({ count: 120, lat: 41 })));
        assert.equal(up.status, 201);
        const archiveDir = path.join(env.dataDir, 'uploads', 'archive', third.user.id);
        assert.equal(fs.readdirSync(archiveDir).length, 1);

        const removed = await admin.delete(`/api/admin/users/${third.user.id}`);
        assert.equal(removed.status, 200);
        assert.equal(fs.existsSync(archiveDir), false, 'upload archives deleted with the account');
        assert.equal((await third.get('/api/routes')).status, 401, 'its sessions are gone');
        const { rows } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [require('../db').tenantSchemaForUser(third.user.id)]);
        assert.equal(rows.length, 0);
    });

    await t.test('security headers and API 404s', async () => {
        const res = await fetch(`${origin}/api/does-not-exist`, { headers: { cookie: admin.cookie } });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('content-type')?.split(';')[0], 'application/json');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-powered-by'), null);
        assert.equal((await fetch(`${origin}/api/all-points`, { headers: { cookie: admin.cookie } })).status, 404);
        const health = await fetch(`${origin}/health`);
        assert.equal(health.status, 200);
    });
});
