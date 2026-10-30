// Journey details kept for quick re-selection: a full-resolution journey can be 100k+
// points, so the total is capped by points as well as by count.
export const ROUTE_CACHE_LIMITS = {
  maxEntries: 40,
  maxWeight: 1_000_000,
  weigh: (route) => route?.coordinates?.length || 1,
};

/**
 * A Map-like cache that drops the least recently used entries once it holds more than
 * `maxEntries`, or more than `maxWeight` by `weigh` (the newest entry always stays).
 */
export function createLruCache({ maxEntries = 50, maxWeight = Infinity, weigh = () => 1, onEvict } = {}) {
  const map = new Map();
  const weights = new Map();
  let total = 0;

  const remove = (key) => {
    if (!map.has(key)) return false;
    total -= weights.get(key) || 0;
    weights.delete(key);
    return map.delete(key);
  };

  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      remove(key);
      const weight = Math.max(0, Number(weigh(value)) || 0);
      map.set(key, value);
      weights.set(key, weight);
      total += weight;
      while (map.size > 1 && (map.size > maxEntries || total > maxWeight)) {
        const oldest = map.keys().next().value;
        remove(oldest);
        onEvict?.(oldest);
      }
      return this;
    },
    has: (key) => map.has(key),
    delete: (key) => remove(key),
    clear() {
      map.clear();
      weights.clear();
      total = 0;
    },
    get size() {
      return map.size;
    },
  };
}
