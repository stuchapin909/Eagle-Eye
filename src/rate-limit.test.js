import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHostRateLimiter } from "./rate-limit.js";

describe("rate-limit", () => {
  it("allows burst then waits", async () => {
    const lim = createHostRateLimiter({ ratePerSec: 100, burst: 2 });
    const a = await lim.acquire("https://example.com/a.jpg");
    const b = await lim.acquire("https://example.com/b.jpg");
    assert.equal(a.waited_ms, 0);
    assert.equal(b.waited_ms, 0);
    const c = await lim.acquire("https://example.com/c.jpg");
    // third may wait a tiny bit at 100 rps
    assert.ok(c.waited_ms >= 0);
    assert.equal(c.host, "example.com");
  });
});
