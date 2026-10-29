'use strict';

/**
 * Serves bundled files (the Vite build of the web client, bundled fonts, the setup
 * page) for the journey:// scheme. Files are read once and kept in memory — the whole
 * client bundle is a few megabytes and custom-protocol responses bypass Chromium's disk
 * cache, so this keeps navigation instant.
 */

const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json',
};

function sniffMime(file) {
    const ext = path.extname(file).toLowerCase();
    if (MIME[ext]) return MIME[ext];
    // The web client ships favicon.ico that is really a PNG; browsers sniff it anyway.
    return 'application/octet-stream';
}

/**
 * @param {object} opts
 * @param {string} opts.root      directory to serve
 * @param {boolean} [opts.spa]    fall back to index.html for extension-less paths
 * @param {string} [opts.prefix]  URL prefix to strip (e.g. '/__fonts')
 */
function createStaticServer({ root, spa = false, prefix = '' }) {
    const cache = new Map();
    const absRoot = path.resolve(root);

    async function readCached(file) {
        const hit = cache.get(file);
        if (hit) return hit;
        try {
            const data = await fs.promises.readFile(file);
            const entry = { data, type: sniffMime(file) };
            cache.set(file, entry);
            return entry;
        } catch {
            return null;
        }
    }

    function resolveSafe(pathname) {
        let rel = pathname;
        if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
        try {
            rel = decodeURIComponent(rel);
        } catch {
            return null;
        }
        const file = path.resolve(absRoot, '.' + (rel.startsWith('/') ? rel : '/' + rel));
        if (file !== absRoot && !file.startsWith(absRoot + path.sep)) return null;
        return file;
    }

    function headersFor(file, type) {
        const headers = {
            'content-type': type,
            'x-content-type-options': 'nosniff',
        };
        // Vite emits content-hashed assets; everything else is revalidated on reload.
        if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(file) || file.includes(`${path.sep}__fonts${path.sep}`) || file.endsWith('.woff2')) {
            headers['cache-control'] = 'public, max-age=31536000, immutable';
        } else {
            headers['cache-control'] = 'no-cache';
        }
        return headers;
    }

    /**
     * @param {string} pathname  URL path (already without query)
     * @returns {Promise<Response|null>} null when nothing matches
     */
    async function serve(pathname) {
        let file = resolveSafe(pathname);
        if (!file) return null;

        let entry = null;
        const hasExt = path.extname(file) !== '';
        if (hasExt || !spa) {
            entry = await readCached(file);
            if (!entry && !hasExt && !spa) {
                entry = await readCached(path.join(file, 'index.html'));
            }
        }
        if (!entry && spa) {
            // SPA fallback: any extension-less path renders the app shell so deep links
            // (journey://app/atlas) and reloads work like the server's catch-all.
            if (hasExt) return null;
            file = path.join(absRoot, 'index.html');
            entry = await readCached(file);
        }
        if (!entry) return null;

        return new Response(entry.data, { status: 200, headers: headersFor(file, entry.type) });
    }

    function has(pathname) {
        const file = resolveSafe(pathname);
        return !!file && fs.existsSync(file);
    }

    return { serve, has, root: absRoot };
}

module.exports = { createStaticServer, MIME };
