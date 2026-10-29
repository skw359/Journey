'use strict';

/**
 * Persistent desktop settings (userData/config.json) plus build-time defaults
 * (build/build-info.json, written by scripts/build-renderer.mjs).
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const APP_ROOT = path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(APP_ROOT, 'build');

const DEFAULTS = Object.freeze({
    serverUrl: '',
    prefetchDetails: true,   // warm every journey's full detail in the background
    detailCacheMB: 768,      // ceiling for cached journey details (JSON text)
    mediaCacheMB: 512,       // ceiling for cached photos / avatars
    windowState: null,       // { x, y, width, height, maximized }
});

let buildInfo = null;
function getBuildInfo() {
    if (buildInfo) return buildInfo;
    try {
        buildInfo = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'build-info.json'), 'utf8'));
    } catch {
        buildInfo = {};
    }
    return buildInfo;
}

function configPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

let cache = null;

function load() {
    if (cache) return cache;
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch {
        stored = {};
    }
    cache = { ...DEFAULTS, ...stored };
    if (!cache.serverUrl) {
        cache.serverUrl = process.env.JOURNEY_SERVER_URL || getBuildInfo().defaultServerUrl || '';
    }
    return cache;
}

function save(partial) {
    const next = { ...load(), ...partial };
    cache = next;
    try {
        fs.mkdirSync(path.dirname(configPath()), { recursive: true });
        const tmp = configPath() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, configPath());
    } catch (err) {
        // Non-fatal: settings just won't persist across restarts.
        console.error('[config] could not save', err);
    }
    return next;
}

/**
 * Normalize what a person typed into a usable origin. Bare hosts get a scheme
 * (plain http for loopback / private ranges, https otherwise); trailing slashes go.
 */
function normalizeServerUrl(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        const host = s.split('/')[0].split(':')[0].toLowerCase();
        const isLocal = host === 'localhost' || host.endsWith('.local')
            || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
            || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        s = (isLocal ? 'http://' : 'https://') + s;
    }
    try {
        const u = new URL(s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        u.hash = '';
        u.search = '';
        let out = u.toString();
        out = out.replace(/\/+$/, '');
        return out;
    } catch {
        return '';
    }
}

module.exports = {
    APP_ROOT,
    BUILD_DIR,
    DEFAULTS,
    getBuildInfo,
    load,
    save,
    normalizeServerUrl,
};
