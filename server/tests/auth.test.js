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

    await t.test('repeated failed sign-ins are rate limited without locking the owner out', async () => {
        // Behind the reverse proxy each client has its own address.
        const from = (address) => ({ headers: { 'x-forwarded-for': address } });
        const attacker = h.agent(origin);
        let last;
        for (let i = 0; i < 11; i++) {
            last = await attacker.post('/api/auth/login', { json: { username: 'second', password: `wrong-${i}` }, ...from('203.0.113.9') });
        }
        assert.equal(last.status, 429);
        assert.ok(Number(last.headers.get('retry-after')) > 0);
        const guessed = await attacker.post('/api/auth/login', { json: { username: 'second', password: 'second-password-1' }, ...from('203.0.113.9') });
        assert.equal(guessed.status, 429, 'the guessing address stays blocked, even with the right password');
        const capitals = await attacker.post('/api/auth/login', { json: { username: 'SECOND', password: 'x' }, ...from('203.0.113.9') });
        assert.equal(capitals.status, 429, 'capitals do not get a fresh allowance');

        const owner = await h.agent(origin).post('/api/auth/login', { json: { username: 'second', password: 'second-password-1' }, ...from('198.51.100.7') });
        assert.equal(owner.status, 200, 'the owner signs in from their own address meanwhile');
        h.resetRateLimits();
    });

    await t.test('registration answers the same for taken and free usernames without an invite', async () => {
        const taken = await h.agent(origin).post('/api/auth/register', { json: { username: 'second', password: 'whatever-123' } });
        const free = await h.agent(origin).post('/api/auth/register', { json: { username: 'nobody-here', password: 'whatever-123' } });
        assert.equal(taken.status, 403);
        assert.deepEqual(taken.data, free.data);

        // With an invite, a name that differs only by capitals is taken, and the invite survives.
        const invite = await admin.post('/api/admin/invites', { json: {} });
        const lookalike = await h.agent(origin).post('/api/auth/register', { json: { username: 'Second', password: 'whatever-123', invite: invite.data.token } });
        assert.equal(lookalike.status, 409);
        const fresh = await h.agent(origin).post('/api/auth/register', { json: { username: 'fourth', password: 'whatever-123', invite: invite.data.token } });
        assert.equal(fresh.status, 201, 'the invite was not spent on the refused name');
        const { rows } = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_users_username_lower'");
        assert.match(rows[0].indexdef, /UNIQUE/);
    });

    await t.test('changing a password needs the current one and signs out other sessions', async () => {
        const user = await h.registerInvited(origin, admin, 'changer', 'old-password-1');
        const elsewhere = h.agent(origin);
        assert.equal((await elsewhere.post('/api/auth/login', { json: { username: 'changer', password: 'old-password-1' } })).status, 200);
        const paired = await user.post('/api/pairing/tokens', { json: { label: 'phone' } });

        assert.equal((await h.agent(origin).post('/api/auth/password', { json: { currentPassword: 'old-password-1', newPassword: 'new-password-2' } })).status, 401);
        assert.equal((await user.post('/api/auth/password', { json: { currentPassword: 'wrong', newPassword: 'new-password-2' } })).status, 401);
        assert.equal((await user.post('/api/auth/password', { json: { currentPassword: 'old-password-1', newPassword: 'short' } })).status, 400);
        assert.equal((await user.post('/api/auth/password', { json: { newPassword: 'new-password-2' } })).status, 400);
        assert.equal((await elsewhere.get('/api/routes')).status, 200, 'nothing changed yet');

        const changed = await user.post('/api/auth/password', { json: { currentPassword: 'old-password-1', newPassword: 'new-password-2' } });
        assert.equal(changed.status, 200, changed.text);
        assert.equal(changed.data.sessionsEnded, 1);
        assert.equal((await user.get('/api/routes')).status, 200, 'this session stays signed in');
        assert.equal((await elsewhere.get('/api/routes')).status, 401, 'other sessions are signed out');
        assert.equal((await h.agent(origin, { bearer: paired.data.token }).get('/api/routes')).status, 200, 'paired devices keep working');
        assert.equal((await h.agent(origin).post('/api/auth/login', { json: { username: 'changer', password: 'old-password-1' } })).status, 401);
        assert.equal((await h.agent(origin).post('/api/auth/login', { json: { username: 'changer', password: 'new-password-2' } })).status, 200);

        // A session can't be used to guess the current password without limit.
        let guess;
        for (let i = 0; i < 11; i++) {
            guess = await user.post('/api/auth/password', { json: { currentPassword: `guess-${i}`, newPassword: 'another-password-3' } });
        }
        assert.equal(guess.status, 429);
        h.resetRateLimits();
    });

    await t.test('an admin can reset another account\'s password', async () => {
        const forgetful = await h.registerInvited(origin, admin, 'forgetful', 'forgotten-password');
        assert.equal((await second.post(`/api/admin/users/${forgetful.user.id}/reset-password`)).status, 403);
        assert.equal((await admin.post('/api/admin/users/user-nope/reset-password')).status, 404);
        const adminId = results.find((r) => r.status === 201).data.user.id;
        assert.equal((await admin.post(`/api/admin/users/${adminId}/reset-password`)).status, 400);

        const reset = await admin.post(`/api/admin/users/${forgetful.user.id}/reset-password`);
        assert.equal(reset.status, 200, reset.text);
        assert.ok(reset.data.temporaryPassword.length >= 16);
        assert.equal((await forgetful.get('/api/routes')).status, 401, 'signed out everywhere');
        assert.equal((await h.agent(origin).post('/api/auth/login', { json: { username: 'forgetful', password: 'forgotten-password' } })).status, 401);
        const back = h.agent(origin);
        assert.equal((await back.post('/api/auth/login', { json: { username: 'forgetful', password: reset.data.temporaryPassword } })).status, 200);
        assert.equal((await back.post('/api/auth/password', { json: { currentPassword: reset.data.temporaryPassword, newPassword: 'my-own-password-9' } })).status, 200);
        const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [forgetful.user.id]);
        assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/, 'stored as a bcrypt hash');
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

        // Express matches paths case-insensitively and ignores a trailing slash, so the
        // restriction has to hold for every spelling of a web-only path.
        const doomed = await h.uploadJourney(admin, h.journeyZip(h.lineRows({ count: 150, lat: 52 })));
        assert.equal(doomed.status, 201);
        assert.equal((await phone.delete(`/api/routes/${doomed.data.id}`)).status, 200, 'a device may move a journey to Trash');
        for (const spelling of ['TRASH', 'Trash', 'trash/', 'TRASH/']) {
            assert.equal((await phone.get(`/api/routes/${spelling}`)).status, 403, `GET ${spelling}`);
            assert.equal((await phone.delete(`/api/routes/${spelling}`)).status, 403, `DELETE ${spelling}`);
        }
        assert.equal((await phone.get('/api/routes/Cities-Status')).status, 403);
        assert.equal((await phone.post('/api/routes/COMBINE', { json: { journeyIds: ['a', 'b'] } })).status, 403);
        const trash = await admin.get('/api/routes/trash');
        assert.equal(trash.data.length, 1, 'Recently Deleted was not emptied');
        assert.equal((await phone.delete(`/api/routes/trash/${trash.data[0].id}`)).status, 403);
        assert.equal((await admin.get('/api/routes/trash')).data.length, 1);

        // A QR code nobody scanned stops working.
        const unscanned = await admin.post('/api/pairing/tokens', { json: {} });
        await pool.query("UPDATE pairing_tokens SET pending_until = NOW() - INTERVAL '1 second' WHERE id = $1", [unscanned.data.id]);
        assert.equal((await h.agent(origin, { bearer: unscanned.data.token }).get('/api/routes')).status, 401);
        // A device unused for too long has to pair again.
        await pool.query("UPDATE pairing_tokens SET last_used_at = NOW() - INTERVAL '400 days' WHERE id = $1", [created.data.id]);
        assert.equal((await phone.get('/api/routes')).status, 401);
    });

    await t.test('scanning a pairing code marks it as paired', async () => {
        const created = await admin.post('/api/pairing/tokens', { json: { label: 'iPhone' } });
        const statusOf = async () => (await admin.get('/api/pairing/tokens')).data.find((token) => token.id === created.data.id);
        assert.equal((await statusOf()).status, 'pending');

        // A ping without a token, or with one that isn't ours, changes nothing.
        assert.equal((await fetch(`${origin}/ping`)).status, 200);
        const stranger = await fetch(`${origin}/ping`, { headers: { authorization: `Bearer ${'f'.repeat(64)}` } });
        assert.equal(await stranger.text(), 'pong');
        assert.equal((await statusOf()).status, 'pending');

        // The first thing the iOS app does after scanning is ping with its new token.
        const ping = await fetch(`${origin}/ping`, { headers: { authorization: `Bearer ${created.data.token}` } });
        assert.equal(ping.status, 200);
        assert.equal(await ping.text(), 'pong');
        const paired = await statusOf();
        assert.equal(paired.status, 'active');
        assert.equal(paired.pending_until, null);
        assert.ok(paired.last_used_at);

        // So it no longer lapses when the pending window passes without another request.
        await pool.query("UPDATE pairing_tokens SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [created.data.id]);
        assert.equal((await h.agent(origin, { bearer: created.data.token }).get('/api/routes')).status, 200);
    });

    await t.test('every journeys route is web-only unless listed here', () => {
        // A new route under /api/routes has to be added to this list or take webOnly.
        const deviceRoutes = new Set(['GET /', 'GET /:id', 'PATCH /:id/name', 'PATCH /:id/travel-mode', 'DELETE /:id']);
        const journeys = require('../routes/journeys');
        const seen = new Set();
        for (const layer of journeys.stack) {
            assert.ok(layer.route, 'the journeys router only holds routes, so nothing runs ahead of webOnly');
            for (const method of Object.keys(layer.route.methods)) {
                const name = `${method.toUpperCase()} ${layer.route.path}`;
                seen.add(name);
                const guarded = layer.route.stack[0].handle === journeys.webOnly;
                assert.equal(guarded, !deviceRoutes.has(name), `${name} ${guarded ? 'should be open to devices' : 'is missing webOnly'}`);
            }
        }
        for (const name of deviceRoutes) assert.ok(seen.has(name), `${name} no longer exists`);
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

        const policy = res.headers.get('content-security-policy');
        assert.match(policy, /default-src 'self'/);
        assert.match(policy, /script-src 'self'(;|$)/, 'no inline or remote scripts');
        assert.match(policy, /object-src 'none'/);
        // HSTS only when the request came over HTTPS, as the reverse proxy reports it.
        assert.equal(res.headers.get('strict-transport-security'), null);
        const overHttps = await fetch(`${origin}/api/auth/status`, { headers: { 'x-forwarded-proto': 'https' } });
        assert.match(overHttps.headers.get('strict-transport-security'), /^max-age=\d+$/);
    });

    await t.test('a session in use is renewed instead of lapsing 30 days after sign-in', async () => {
        const browser = h.agent(origin);
        await browser.post('/api/auth/login', { json: { username: 'second', password: 'second-password-1' } });
        const res = await fetch(`${origin}/api/routes`, { headers: { cookie: browser.cookie } });
        assert.equal(res.status, 200);
        const renewed = res.headers.get('set-cookie');
        assert.match(renewed, /journey\.sid=/, 'the cookie is re-sent on a later request');
        const expires = new Date(/Expires=([^;]+)/i.exec(renewed)[1]).getTime();
        assert.ok(expires > Date.now() + 29 * 86400000, 'another 30 days from this request');
        // Nothing to renew, and no cookie, for a request without a session.
        assert.equal((await fetch(`${origin}/api/auth/status`)).headers.get('set-cookie'), null);
    });
});
