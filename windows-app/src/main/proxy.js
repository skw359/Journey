'use strict';

/**
 * Forwards journey://app/<api path> requests to the real Journey server through
 * Chromium's network stack (net.fetch) with the session cookie jar, streaming bodies in
 * both directions. Marco's Server-Sent Events, multipart photo uploads and 50 MB files
 * all pass through untouched.
 */

const { net } = require('electron');
const { EventEmitter } = require('events');

// Never forwarded upstream.
const DROP_REQUEST_HEADERS = new Set([
    'host', 'origin', 'referer', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade', 'proxy-connection', 'content-length', 'cookie',
    'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'sec-ch-ua',
    'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept-encoding',
]);

// Never relayed back to the renderer: bodies arrive already decoded and the cookie is
// stored by the network stack (it is httpOnly anyway).
const DROP_RESPONSE_HEADERS = new Set([
    'content-encoding', 'content-length', 'transfer-encoding', 'connection',
    'keep-alive', 'set-cookie', 'set-cookie2', 'strict-transport-security',
    'alt-svc', 'trailer', 'upgrade',
]);

class Proxy extends EventEmitter {
    /**
     * @param {object} opts
     * @param {() => string} opts.getServerUrl
     * @param {import('electron').Session} opts.session
     * @param {ReturnType<import('./log').scope>} opts.log
     */
    constructor({ getServerUrl, session, log }) {
        super();
        this.getServerUrl = getServerUrl;
        this.session = session;
        this.log = log;
        this.inflight = 0;
        // Prefer the window session's fetch (shares its cookie jar); fall back to the
        // default-session net.fetch when session.fetch is unavailable.
        this._fetch = (session && typeof session.fetch === 'function')
            ? session.fetch.bind(session)
            : net.fetch;
    }

    targetFor(pathname, search) {
        const base = this.getServerUrl();
        if (!base) return null;
        return base + pathname + (search || '');
    }

    /**
     * Forward a request. Resolves to a Response suitable for protocol.handle.
     * @param {Request} request   the incoming journey:// request
     * @param {URL} url           parsed request URL
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     */
    async forward(request, url, opts = {}) {
        const target = this.targetFor(url.pathname, url.search);
        if (!target) {
            return jsonResponse(503, { error: 'No Journey server configured' });
        }

        const headers = new Headers();
        for (const [k, v] of request.headers) {
            if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
        }
        // Ask for identity encoding: JSON payloads in the tens of megabytes decode faster
        // than they gzip on a LAN, and the client never asked for compression either.
        headers.set('accept-encoding', 'identity');

        const method = request.method.toUpperCase();
        const init = {
            method,
            headers,
            credentials: 'include',     // send + store the journey.sid session cookie
            redirect: 'follow',
            bypassCustomProtocolHandlers: true,
        };
        if (method !== 'GET' && method !== 'HEAD' && request.body) {
            init.body = request.body;
            init.duplex = 'half';
        }
        const controller = new AbortController();
        init.signal = controller.signal;
        const onAbort = () => controller.abort();
        if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });

        this.inflight++;
        let upstream;
        try {
            upstream = await this._fetch(target, init);
        } catch (err) {
            this.inflight--;
            this.log.warn(`upstream ${method} ${url.pathname} failed: ${err.message}`);
            this.emit('network-error', { pathname: url.pathname, error: err });
            return jsonResponse(502, {
                error: 'Journey server unreachable',
                detail: err.message,
                server: this.getServerUrl(),
            });
        }

        const outHeaders = new Headers();
        for (const [k, v] of upstream.headers) {
            if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders.append(k, v);
        }

        const body = upstream.body
            ? passthrough(upstream.body, () => { this.inflight--; }, () => { controller.abort(); this.inflight--; })
            : null;
        if (!body) this.inflight--;

        return new Response(body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: outHeaders,
        });
    }

    /**
     * Convenience for the app's own upstream calls (data warming, prefetch, setup page
     * probes). Same cookie jar, same headers policy.
     */
    async fetchUpstream(pathAndQuery, init = {}) {
        const base = this.getServerUrl();
        if (!base) throw new Error('No Journey server configured');
        const headers = new Headers(init.headers || {});
        if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain, */*');
        headers.set('accept-encoding', 'identity');
        return this._fetch(base + pathAndQuery, {
            ...init,
            headers,
            credentials: 'include',
            bypassCustomProtocolHandlers: true,
        });
    }
}

/**
 * Pipe an upstream body through a stream we control, so a renderer-side abort (e.g.
 * Marco's Stop button) cancels the upstream request too and the server can stop
 * generating.
 */
function passthrough(source, onDone, onCancel) {
    const reader = source.getReader();
    let finished = false;
    return new ReadableStream({
        async pull(controller) {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    finished = true;
                    controller.close();
                    onDone();
                    return;
                }
                controller.enqueue(value);
            } catch (err) {
                if (!finished) {
                    finished = true;
                    onDone();
                }
                controller.error(err);
            }
        },
        cancel() {
            if (!finished) {
                finished = true;
                onCancel();
            }
            reader.cancel().catch(() => {});
        },
    });
}

function jsonResponse(status, obj, extraHeaders = {}) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
    });
}

module.exports = { Proxy, jsonResponse };
