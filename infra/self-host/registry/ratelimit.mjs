// Sliding-window counters keyed by client IP or device id. Spec: research/self-host-device-keys.md Q5.
// The clock is injected so tests never sleep.

export class RateLimiter {
  /**
   * @param {{limit: number, windowSeconds: number, maxKeys?: number}} options
   */
  constructor({ limit, windowSeconds, maxKeys = 50_000 }) {
    this.limit = limit;
    this.windowSeconds = windowSeconds;
    this.maxKeys = maxKeys;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  #recent(key, now) {
    const stamps = this.hits.get(key);
    if (stamps === undefined) return [];
    const floor = now - this.windowSeconds;
    let start = 0;
    while (start < stamps.length && stamps[start] <= floor) start += 1;
    if (start > 0) stamps.splice(0, start);
    if (stamps.length === 0) this.hits.delete(key);
    return stamps;
  }

  /** Seconds to wait before the key is allowed again; 0 when it is under the limit. Does not count. */
  retryAfter(key, now) {
    const stamps = this.#recent(key, now);
    if (stamps.length < this.limit) return 0;
    return Math.max(1, stamps[stamps.length - this.limit] + this.windowSeconds - now);
  }

  /** Records one hit. */
  record(key, now) {
    const stamps = this.#recent(key, now);
    if (stamps.length === 0 && !this.hits.has(key)) {
      if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
      this.hits.set(key, [now]);
    } else {
      stamps.push(now);
    }
  }

  /** Counts the hit when it is allowed; otherwise returns the wait and leaves the window alone. */
  hit(key, now) {
    const wait = this.retryAfter(key, now);
    if (wait === 0) this.record(key, now);
    return wait;
  }

  sweep(now) {
    for (const key of this.hits.keys()) this.#recent(key, now);
  }
}
