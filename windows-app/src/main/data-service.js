'use strict';

/**
 * Owns the in-memory RouteStore lifecycle:
 *   - warms it from the server after login (`GET /api/alltime-map-data?maxPoints=0`),
 *   - prefetches every journey's full-resolution detail in the background so the
 *     Dashboard / Top Journeys detail panes open with zero network,
 *   - re-warms when the signed-in user changes,
 *   - invalidates the right slice after a mutation (point delete, combine, trash, …).
 *
 * All upstream traffic goes through the same cookie jar the renderer uses (Proxy), so
 * warming only succeeds once the session is authenticated.
 */

const { EventEmitter } = require('events');

const PREFETCH_CONCURRENCY = 5;

class DataService extends EventEmitter {
    /**
     * @param {object} opts
     * @param {import('./proxy').Proxy} opts.proxy
     * @param {import('./data/store').RouteStore} opts.store
     * @param {ReturnType<import('./log').scope>} opts.log
     * @param {() => object} opts.getConfig
     */
    constructor({ proxy, store, log, getConfig }) {
        super();
        this.proxy = proxy;
        this.store = store;
        this.log = log;
        this.getConfig = getConfig;

        this.userId = null;
        this.phase = 'idle'; // idle | warming | ready | error
        this.error = null;
        this.warmSeq = 0;

        this.routeIds = [];
        this.prefetch = {
            active: false,
            done: 0,
            total: 0,
            queue: [],
            running: 0,
            seq: 0,
        };
    }

    status() {
        return {
            phase: this.phase,
            error: this.error ? String(this.error.message || this.error) : null,
            userId: this.userId,
            store: this.store.status(),
            prefetch: { active: this.prefetch.active, done: this.prefetch.done, total: this.prefetch.total },
        };
    }

    /**
     * Called with the parsed body of every proxied `/api/auth/status` (and after login).
     * Drives warm/clear based on the authenticated user id.
     */
    onAuthStatus(body) {
        const user = body && body.isAuthenticated ? body.user : null;
        const id = user ? String(user.id) : null;
        if (id === this.userId) return;

        this.userId = id;
        this.abortPrefetch();
        this.store.clear();
        this.phase = 'idle';
        this.error = null;
        this.emit('changed', this.status());

        if (id) {
            this.warm().catch((err) => this.log.warn('warm failed:', err.message));
        }
    }

    /** Force a fresh warm of the map data + detail prefetch. */
    async warm() {
        if (!this.userId) return;
        const seq = ++this.warmSeq;
        this.phase = 'warming';
        this.error = null;
        this.emit('changed', this.status());
        const t0 = Date.now();

        let payloadText;
        try {
            const res = await this.proxy.fetchUpstream('/api/alltime-map-data?maxPoints=0');
            if (res.status === 401) { this.phase = 'idle'; return; } // not authenticated yet
            if (!res.ok) throw new Error(`alltime-map-data ${res.status}`);
            payloadText = await res.text();
        } catch (err) {
            if (seq !== this.warmSeq) return;
            this.phase = 'error';
            this.error = err;
            this.emit('changed', this.status());
            return;
        }
        if (seq !== this.warmSeq) return;

        let payload;
        try {
            payload = JSON.parse(payloadText);
        } catch (err) {
            this.phase = 'error';
            this.error = err;
            this.emit('changed', this.status());
            return;
        }

        this.store.loadAllTimePayload(payload, payloadText);
        this.routeIds = this.store.ids();
        this.phase = 'ready';
        const s = this.store.status();
        this.log.info(`warmed ${s.routes} routes / ${s.points.toLocaleString()} points in ${Date.now() - t0}ms`);
        this.emit('changed', this.status());
        this.emit('ready', this.status());

        if (this.getConfig().prefetchDetails) {
            this.startPrefetch();
        }
    }

    /* --------------------------- detail prefetch --------------------------- */

    startPrefetch() {
        this.abortPrefetch();
        const seq = ++this.prefetch.seq;
        const cfg = this.getConfig();
        this.store.detailLimitBytes = Math.max(64, Number(cfg.detailCacheMB) || 768) * 1024 * 1024;

        const queue = this.routeIds.filter((id) => !this.store.hasDetail(id));
        this.prefetch.active = queue.length > 0;
        this.prefetch.queue = queue;
        this.prefetch.total = queue.length;
        this.prefetch.done = 0;
        this.prefetch.running = 0;
        if (!this.prefetch.active) return;

        this.log.info(`prefetching ${queue.length} journey details in background`);
        for (let i = 0; i < PREFETCH_CONCURRENCY; i++) this.pumpPrefetch(seq);
    }

    async pumpPrefetch(seq) {
        if (seq !== this.prefetch.seq) return;
        // Respect the memory ceiling: stop pulling new work once the detail cache is near
        // its cap (the store still evicts, but there's no point thrashing).
        if (this.store.detailBytes >= this.store.detailLimitBytes) {
            this.finishPrefetchWorker(seq);
            return;
        }
        const id = this.prefetch.queue.shift();
        if (id === undefined) {
            this.finishPrefetchWorker(seq);
            return;
        }
        this.prefetch.running++;
        try {
            if (!this.store.hasDetail(id)) {
                const res = await this.proxy.fetchUpstream(`/api/routes/${encodeURIComponent(id)}?maxPoints=0`);
                if (seq === this.prefetch.seq && res.ok) {
                    this.store.putDetail(id, await res.text());
                } else if (res.body) {
                    res.body.cancel().catch(() => {});
                }
            }
        } catch {
            // Ignore individual prefetch failures — detail will just fall back to a live
            // proxy fetch when the user opens that journey.
        } finally {
            this.prefetch.running--;
            this.prefetch.done++;
        }
        if (seq !== this.prefetch.seq) return;
        if (this.prefetch.done % 100 === 0 || this.prefetch.queue.length === 0) {
            this.emit('changed', this.status());
        }
        // Yield so a burst of prefetch never starves a user-driven request.
        setImmediate(() => this.pumpPrefetch(seq));
    }

    finishPrefetchWorker(seq) {
        if (seq !== this.prefetch.seq) return;
        if (this.prefetch.running === 0 && this.prefetch.queue.length === 0) {
            this.prefetch.active = false;
            const s = this.store.status();
            this.log.info(`prefetch complete · ${s.details} details cached · ${(s.detailBytes / 1e6).toFixed(0)}MB`);
            this.emit('changed', this.status());
        }
    }

    abortPrefetch() {
        this.prefetch.seq++;
        this.prefetch.active = false;
        this.prefetch.queue = [];
        this.prefetch.running = 0;
    }

    /* ----------------------------- invalidation ---------------------------- */

    /**
     * React to a successful mutating request the renderer just made, keeping the store
     * from serving stale Atlas/detail data. Called with the request method + pathname
     * after the upstream response returns 2xx.
     */
    onMutation(method, pathname) {
        const m = method.toUpperCase();
        if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;

        // /api/routes/:id/points/:index, /:id/name, /:id/travel-mode, DELETE /:id, /combine …
        const routeMatch = pathname.match(/^\/api\/routes\/([^/]+)(?:\/|$)/);
        const affectsRoutes = /^\/api\/(routes|flights)\b/.test(pathname) || pathname === '/upload';
        if (!affectsRoutes) return;

        // Drop the specific route's cached detail so the next open re-fetches it.
        if (routeMatch) {
            const id = decodeURIComponent(routeMatch[1]);
            if (!['trash', 'combine', 'cities-status', 'places-status', 'reindex-cities',
                'reindex-places', 'backfill-cities', 'backfill-places', 'undo-combine'].includes(id)) {
                this.store.dropDetail(id);
            }
        }

        // Anything that can change geometry / route membership invalidates the Atlas map
        // data. Photos and waypoints-label edits don't, so skip those to avoid churn.
        const photoOnly = /^\/api\/routes\/[^/]+\/photos(?:\/|$)/.test(pathname);
        const waypointLabel = /^\/api\/routes\/[^/]+\/waypoints\//.test(pathname);
        if (photoOnly || waypointLabel) return;

        this.scheduleRewarm();
    }

    scheduleRewarm() {
        if (!this.userId) return;
        clearTimeout(this._rewarmTimer);
        // Debounce: a combine or multi-point edit fires several requests in a row.
        this._rewarmTimer = setTimeout(() => {
            this.warm().catch((err) => this.log.warn('re-warm failed:', err.message));
        }, 400);
    }

    dispose() {
        this.abortPrefetch();
        clearTimeout(this._rewarmTimer);
    }
}

module.exports = { DataService };
