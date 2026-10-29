'use strict';

/**
 * In-memory LRU for photos and avatars. The web app relies on the browser's HTTP cache
 * for `/photos/*`; custom-protocol responses are not disk-cached by Chromium, so we hold
 * successful image responses in RAM instead (filenames are content-hashed, so they never
 * change under the same URL).
 */

class MediaCache {
    constructor({ limitBytes }) {
        this.limitBytes = limitBytes;
        this.bytes = 0;
        /** @type {Map<string, {data: Uint8Array, type: string, at: number}>} */
        this.entries = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    setLimit(limitBytes) {
        this.limitBytes = limitBytes;
        this.evict();
    }

    get(key) {
        const hit = this.entries.get(key);
        if (!hit) {
            this.misses++;
            return null;
        }
        this.hits++;
        this.entries.delete(key);
        this.entries.set(key, hit);
        return new Response(hit.data, {
            status: 200,
            headers: {
                'content-type': hit.type,
                'cache-control': 'private, max-age=31536000, immutable',
                'x-journey-cache': 'hit',
            },
        });
    }

    /**
     * Cache a successful image response and return a fresh Response for the caller.
     * Non-image or non-200 responses are returned untouched.
     */
    async store(key, response) {
        const type = response.headers.get('content-type') || '';
        if (response.status !== 200 || !type.startsWith('image/')) return response;
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength <= this.limitBytes) {
            const prev = this.entries.get(key);
            if (prev) this.bytes -= prev.data.byteLength;
            this.entries.set(key, { data, type, at: Date.now() });
            this.bytes += data.byteLength;
            this.evict();
        }
        return new Response(data, {
            status: 200,
            headers: {
                'content-type': type,
                'cache-control': 'private, max-age=31536000, immutable',
                'x-journey-cache': 'miss',
            },
        });
    }

    evict() {
        while (this.bytes > this.limitBytes && this.entries.size > 0) {
            const [key, entry] = this.entries.entries().next().value;
            this.entries.delete(key);
            this.bytes -= entry.data.byteLength;
        }
    }

    clear() {
        this.entries.clear();
        this.bytes = 0;
    }

    status() {
        return { items: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses, limitBytes: this.limitBytes };
    }
}

module.exports = { MediaCache };
