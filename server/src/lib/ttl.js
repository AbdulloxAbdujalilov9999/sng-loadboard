/**
 * Tiny TTL cache that stores PROMISES, so concurrent callers for the same key share one in-flight
 * load (single-flight) instead of stampeding the database. ttlMs = 0 disables caching entirely.
 */
export class TtlCache {
  constructor({ ttlMs, max = 1000 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  getOrLoad(key, loader) {
    if (this.ttlMs <= 0) return loader();
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && hit.exp > now) return hit.promise;
    const promise = Promise.resolve().then(loader).catch((err) => { this.map.delete(key); throw err; });
    this.map.set(key, { exp: now + this.ttlMs, promise });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); // evict oldest
    return promise;
  }

  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
