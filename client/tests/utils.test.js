import test from 'node:test';
import assert from 'node:assert/strict';
import apiFetch, { onLoadingChange } from '../src/api/apiFetch.js';
import { escapeHtml } from '../src/utils/html.js';
import { createLruCache } from '../src/utils/lruCache.js';
import { heatmapWeights } from '../src/utils/heatmapWeights.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the loading indicator clears even when a response body is never read', async () => {
  const states = [];
  const off = onLoadingChange((loading) => states.push(loading));
  globalThis.fetch = async () => new Response('{"error":"nope"}', { status: 500 });

  const res = await apiFetch('/api/x');
  assert.equal(res.ok, false);
  await tick();
  assert.equal(states.at(-1), false, 'not stuck on after an unread error response');

  globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
  const ok = await apiFetch('/api/y');
  assert.deepEqual(await ok.json(), { ok: true });
  await tick();
  assert.equal(states.at(-1), false);

  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(apiFetch('/api/z'));
  assert.equal(states.at(-1), false);
  off();
});

test('tooltip text is escaped', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("Joe's & co"), 'Joe&#39;s &amp; co');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('the route cache is bounded by count and by points', () => {
  const evicted = [];
  const cache = createLruCache({ maxEntries: 3, maxWeight: 100, weigh: (r) => r.n, onEvict: (k) => evicted.push(k) });
  cache.set('a', { n: 10 }).set('b', { n: 10 }).set('c', { n: 10 });
  cache.get('a');
  cache.set('d', { n: 10 });
  assert.deepEqual(evicted, ['b'], 'least recently used goes first');
  cache.set('big', { n: 95 });
  assert.equal(cache.size, 1, 'a heavy entry pushes the rest out');
  assert.ok(cache.has('big'));
  cache.set('huge', { n: 500 });
  assert.ok(cache.has('huge'), 'the newest entry always stays');
  assert.equal(cache.size, 1);
});

test('heatmap weights spread out instead of saturating', () => {
  // Long-tailed like a real history: most cells passed a few times, a few home cells
  // thousands of times.
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const counts = Array.from({ length: 5000 }, () => Math.max(1, Math.floor(1 / Math.pow(rand() || 1e-9, 1.5))));
  const weights = heatmapWeights(counts);
  const p95 = [...counts].sort((a, b) => a - b)[Math.floor(0.95 * (counts.length - 1))];
  counts.forEach((count, i) => assert.equal(weights[i] >= 0.999, count >= p95, `count ${count}`));
  const saturated = weights.filter((w) => w >= 0.999).length / weights.length;
  assert.ok(saturated < 0.08, `few cells saturate (${(saturated * 100).toFixed(1)}%)`);
  const old = counts.filter((c) => Math.min(1, c / 1.2) >= 0.999).length / counts.length;
  assert.ok(old > 0.5, `the old weighting saturated most cells (${(old * 100).toFixed(0)}%)`);
  for (let i = 0; i < counts.length; i++) {
    for (const j of [i + 1, i + 7]) {
      if (j < counts.length && counts[j] > counts[i]) assert.ok(weights[j] >= weights[i]);
    }
  }
  assert.deepEqual(heatmapWeights([]), []);
  assert.equal(heatmapWeights([0, 0])[0], 0);
});
