'use strict';

// Integration test harness. Each test file runs in its own process (node --test) and calls
// setupTestServer() before requiring any server module: it creates a throwaway database
// (journey_test_*) on the server named by TEST_DATABASE_URL and a temp data folder, and
// never reads the project's .env. Without TEST_DATABASE_URL the tests are skipped.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ADMIN_URL = process.env.TEST_DATABASE_URL;
// Anything that opens a pool before setupTestServer() gets an address that can't resolve,
// never pg's defaults (a local server and maybe a real database).
process.env.DATABASE_URL = 'postgres://not-configured.invalid:1/call_setupTestServer_first';

function skipReason() {
    return ADMIN_URL ? false : 'TEST_DATABASE_URL not set (a Postgres server the tests may create databases on)';
}

// Outbound HTTP the server makes (weather, geocoding, Ollama) goes here instead of the
// network. Tests set `outbound.handler` and inspect `outbound.calls`.
const outbound = {
    calls: [],
    handler: null,
};

function installFetchStub(serverOrigin) {
    const realFetch = global.fetch;
    global.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(serverOrigin)) return realFetch(input, init);
        outbound.calls.push(url);
        if (outbound.handler) {
            const result = await outbound.handler(url, init);
            if (result) return result;
        }
        return new Response(JSON.stringify({ error: 'offline in tests' }), { status: 503 });
    };
    return realFetch;
}

async function setupTestServer({ env = {} } = {}) {
    if (require.cache[require.resolve('../db')]) {
        throw new Error('A server module was loaded before setupTestServer(); its pool would not use the test database');
    }
    const { Client } = require('pg');
    const dbName = `journey_test_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const dbUrl = new URL(ADMIN_URL);
    dbUrl.pathname = `/${dbName}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-test-'));

    Object.assign(process.env, {
        DATABASE_URL: dbUrl.toString(),
        JOURNEY_DATA_DIR: dataDir,
        GEOCODE_BASE_URL: '',
        PUBLIC_URL: '',
        JOURNEY_LOG_LEVEL: process.env.JOURNEY_LOG_LEVEL || 'silent',
        JOURNEY_LOG_HTTP: '0',
        NODE_ENV: 'test',
        ...env,
    });

    const { initSchema, pool } = require('../db');
    await initSchema();
    const { createApp } = require('../app');
    const app = createApp({ sessionSecret: crypto.randomBytes(32).toString('hex') });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    server.requestTimeout = 0;
    const origin = `http://127.0.0.1:${server.address().port}`;
    const realFetch = installFetchStub(origin);

    async function teardown() {
        await require('../utils/journeyDerived').flushDerived();
        global.fetch = realFetch;
        await new Promise((resolve) => server.close(resolve));
        server.closeAllConnections?.();
        await pool.end().catch(() => {});
        const cleanup = new Client({ connectionString: ADMIN_URL });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await cleanup.end();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    return { app, server, origin, dataDir, dbName, pool, teardown };
}

// A cookie-keeping HTTP client: one per signed-in browser/account.
function agent(origin, { bearer } = {}) {
    let cookie = null;
    async function request(method, url, { json, body, headers = {}, raw = false } = {}) {
        const init = { method, headers: { ...headers }, redirect: 'manual' };
        if (cookie) init.headers.cookie = cookie;
        if (bearer) init.headers.authorization = `Bearer ${bearer}`;
        if (json !== undefined) {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(json);
        } else if (body !== undefined) {
            init.body = body;
        }
        const res = await fetch(`${origin}${url}`, init);
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        if (raw) return res;
        const text = await res.text();
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        return { status: res.status, headers: res.headers, data, text };
    }
    return {
        get: (url, opts) => request('GET', url, opts),
        post: (url, opts) => request('POST', url, opts),
        put: (url, opts) => request('PUT', url, opts),
        patch: (url, opts) => request('PATCH', url, opts),
        delete: (url, opts) => request('DELETE', url, opts),
        get cookie() { return cookie; },
        set cookie(value) { cookie = value; },
    };
}

// ── Synthetic journey uploads ────────────────────────────────────────────

const CSV_HEADER = 'ts_ms,lat,lon,ele_m,speed_ms,waypoint,note';

/** Rows along a line heading north-east at roughly `speedMps`, one per second. */
function lineRows({ count = 300, start = Date.UTC(2025, 9, 29, 9, 26, 40), lat = 40.748817, lon = -73.985428, stepDeg = 0.0001, speed = '' } = {}) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({ ts: start + i * 1000, lat: lat + i * stepDeg, lon: lon + i * stepDeg, ele: 10 + (i % 7), speed });
    }
    return rows;
}

function csvFromRows(rows) {
    return [CSV_HEADER, ...rows.map((r) => [
        r.ts, r.lat, r.lon, r.ele ?? '', r.speed ?? '', r.waypoint ? '1' : '0', r.note ?? '',
    ].map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))].join('\n');
}

// Minimal zip writer (stored, deflated) for test fixtures.
function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
}

function zip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const compressed = zlib.deflateRawSync(data);
        const nameBuf = Buffer.from(name);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + compressed.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

function journeyZip(rows, name = 'route.csv') {
    return zip({ [name]: csvFromRows(rows) });
}

async function uploadJourney(client, zipBuffer, { recordingId, source = 'iphone', filename = 'route_1.zip' } = {}) {
    const form = new FormData();
    form.append('source', source);
    if (recordingId) form.append('recordingId', recordingId);
    form.append('journey', new Blob([zipBuffer], { type: 'application/zip' }), filename);
    return client.post('/upload', { body: form });
}

/** Registers the first (admin) account and returns its agent. */
async function registerAdmin(origin, username = 'owner', password = 'owner-password-1') {
    const owner = agent(origin);
    const res = await owner.post('/api/auth/register', { json: { username, password, firstName: 'Own', lastName: 'Er' } });
    if (res.status !== 201) throw new Error(`admin registration failed: ${res.status} ${res.text}`);
    owner.user = res.data.user;
    return owner;
}

/** Registers another account through an invite from `admin`. */
async function registerInvited(origin, admin, username, password = 'second-password-1') {
    const invite = await admin.post('/api/admin/invites', { json: { note: username } });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${invite.text}`);
    const user = agent(origin);
    const res = await user.post('/api/auth/register', { json: { username, password, invite: invite.data.token } });
    if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${res.text}`);
    user.user = res.data.user;
    return user;
}

function resetRateLimits() {
    require('../routes/auth').resetRateLimits();
}

module.exports = {
    skipReason,
    outbound,
    setupTestServer,
    agent,
    lineRows,
    csvFromRows,
    zip,
    journeyZip,
    uploadJourney,
    registerAdmin,
    registerInvited,
    resetRateLimits,
};
