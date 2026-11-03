import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { RateLimiter } from "./ratelimit.mjs";

const assert = NodeAssert;
const { describe, it } = NodeTest;

describe("RateLimiter", () => {
  it("allows `limit` hits per window and reports the wait", () => {
    const limiter = new RateLimiter({ limit: 3, windowSeconds: 60 });
    assert.deepEqual(
      [limiter.hit("a", 100), limiter.hit("a", 101), limiter.hit("a", 102)],
      [0, 0, 0],
    );
    assert.equal(limiter.hit("a", 103), 57);
    assert.equal(limiter.hit("b", 103), 0);
    assert.equal(limiter.hit("a", 160), 0);
  });

  it("does not extend the block with denied hits", () => {
    const limiter = new RateLimiter({ limit: 1, windowSeconds: 10 });
    limiter.hit("a", 0);
    for (let t = 1; t < 10; t += 1) assert.ok(limiter.hit("a", t) > 0);
    assert.equal(limiter.hit("a", 10), 0);
  });

  it("separates checking from recording, and sweeps idle keys", () => {
    const limiter = new RateLimiter({ limit: 2, windowSeconds: 10 });
    assert.equal(limiter.retryAfter("a", 0), 0);
    limiter.record("a", 0);
    limiter.record("a", 1);
    assert.equal(limiter.retryAfter("a", 2), 8);
    limiter.sweep(100);
    assert.equal(limiter.hits.size, 0);
  });

  it("bounds the number of tracked keys", () => {
    const limiter = new RateLimiter({ limit: 1, windowSeconds: 10, maxKeys: 3 });
    for (let i = 0; i < 10; i += 1) limiter.record(`k${i}`, 0);
    assert.equal(limiter.hits.size, 3);
  });
});
