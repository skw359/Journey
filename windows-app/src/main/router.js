'use strict';

/**
 * The single protocol.handle handler for journey://app/*. Decides, per request, between:
 *   - bundled static files (the SPA build, local fonts, the setup page),
 *   - the in-memory RouteStore (Atlas + cached journey detail — instant, no server),
 *   - the media cache (photos / avatars held in RAM),
 *   - a live proxy to the real Journey server (everything else).
 *
 * Relative URLs in the web client (`/api/...`, `/photos/...`, `/auth/...`) resolve
 * against the journey://app origin, so this handler sees exactly the paths the server
 * would, and forwards the ones it doesn't answer itself.
 */

const { jsonResponse } = require('./proxy');

// Path prefixes that must always reach the real server (never the SPA fallback).
const PROXY_PREFIXES = ['/api/', '/photos/', '/auth/', '/upload', '/database', '/ping'];

function isProxyPath(pathname) {
    if (pathname === '/upload' || pathname === '/database' || pathname === '/ping') return true;
    return PROXY_PREFIXES.some((p) => p.endsWith('/') && pathname.startsWith(p));
}

/** GET /api/routes/<id> with no trailing segment and an id we might have cached. */
const DETAIL_RE = /^\/api\/routes\/([^/]+)$/;
const DETAIL_RESERVED = new Set(['trash', 'combine']);

function createRouter({ staticApp, staticFonts, store, proxy, dataService, mediaCache, log, onAuthStatus }) {
    async function handle(request) {
        const url = new URL(request.url);
        const pathname = url.pathname || '/';
        const method = request.method.toUpperCase();

        // 1. Bundled fonts (rewritten @import targets) — always local.
        if (pathname.startsWith('/__fonts/')) {
            const res = await staticFonts.serve(pathname);
            return res || new Response('font not found', { status: 404 });
        }

        // 2. Server-bound paths.
        if (isProxyPath(pathname)) {
            return handleServerPath(request, url, pathname, method);
        }

        // 3. Everything else is a static asset or an SPA route → the bundle.
        const res = await staticApp.serve(pathname);
        if (res) return res;
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    async function handleServerPath(request, url, pathname, method) {
        // --- Atlas endpoints: served from memory when the store is warm --------------
        if (method === 'GET' && store.ready) {
            if (pathname === '/api/alltime-map-data') {
                return storeJson(store.allTimeMapData(url.searchParams));
            }
            const detail = pathname.match(DETAIL_RE);
            if (detail) {
                const id = safeDecode(detail[1]);
                if (id != null && !DETAIL_RESERVED.has(id) && store.hasDetail(id)) {
                    const text = store.routeDetail(id, url.searchParams);
                    if (text != null) return storeJson(text, 'hit');
                }
            }
        }

        // --- Photos / avatars: RAM cache in front of the proxy -----------------------
        if (method === 'GET' && (pathname.startsWith('/photos/') || pathname.startsWith('/api/auth/avatar/'))) {
            const key = pathname; // filenames are content-hashed
            const cached = mediaCache.get(key);
            if (cached) return cached;
            const res = await proxy.forward(request, url);
            if (res.status === 200) return mediaCache.store(key, res);
            return res;
        }

        // --- Auth status / login / logout: buffer so we can react to session changes -
        if (method !== 'GET' && (pathname === '/api/auth/login' || pathname === '/api/auth/logout')
            || (method === 'GET' && pathname === '/api/auth/status')) {
            return handleAuthMutating(request, url, pathname, method);
        }

        // --- Everything else: straight proxy (streamed) ------------------------------
        const res = await proxy.forward(request, url);
        // After a successful mutation, keep the store fresh.
        if (res.status >= 200 && res.status < 300 && method !== 'GET') {
            dataService.onMutation(method, pathname);
        }
        return res;
    }

    async function handleAuthMutating(request, url, pathname, method) {
        let res;
        try {
            const init = { method, headers: forwardHeaders(request) };
            if (method !== 'GET' && request.body) {
                init.body = await request.arrayBuffer();
            }
            res = await proxy.fetchUpstream(pathname + url.search, init);
        } catch (err) {
            return jsonResponse(502, { error: 'Journey server unreachable', detail: err.message });
        }
        const text = await res.text();
        // Peek at auth state to drive warming/clearing.
        try {
            if (pathname === '/api/auth/status' && res.ok) {
                onAuthStatus(JSON.parse(text));
            } else if (pathname === '/api/auth/login' && res.ok) {
                // Login response is `{ user }`; re-check status to get the full snapshot.
                queueMicrotask(() => refreshAuth());
            } else if (pathname === '/api/auth/logout') {
                onAuthStatus({ isAuthenticated: false, user: null });
            }
        } catch { /* ignore parse issues */ }

        const headers = new Headers();
        for (const [k, v] of res.headers) {
            const lk = k.toLowerCase();
            if (['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'set-cookie2', 'connection', 'strict-transport-security'].includes(lk)) continue;
            headers.append(k, v);
        }
        return new Response(text, { status: res.status, statusText: res.statusText, headers });
    }

    async function refreshAuth() {
        try {
            const res = await proxy.fetchUpstream('/api/auth/status');
            if (res.ok) onAuthStatus(JSON.parse(await res.text()));
            else if (res.body) res.body.cancel().catch(() => {});
        } catch { /* offline; ignore */ }
    }

    return { handle, refreshAuth };
}

function storeJson(text, cache = 'store') {
    return new Response(text, {
        status: 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-journey-source': cache === 'hit' ? 'store-detail' : 'store',
        },
    });
}

function forwardHeaders(request) {
    const headers = new Headers();
    for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (['host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'accept-encoding'].includes(lk)) continue;
        headers.set(k, v);
    }
    return headers;
}

function safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return null; }
}

module.exports = { createRouter, isProxyPath };
