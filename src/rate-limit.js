/**
 * rate-limit.js — Per-host token bucket for outbound snapshot fetches.
 */

/**
 * @param {{ ratePerSec?: number, burst?: number }} opts
 */
export function createHostRateLimiter({ ratePerSec = 2, burst = 4 } = {}) {
  /** @type {Map<string, { tokens: number, last: number }>} */
  const buckets = new Map();

  function getHost(urlStr) {
    try {
      return new URL(urlStr).hostname;
    } catch {
      return "unknown";
    }
  }

  /**
   * Wait until a token is available for this URL's host, then consume one.
   */
  async function acquire(urlStr) {
    const host = getHost(urlStr);
    let b = buckets.get(host);
    const now = Date.now();
    if (!b) {
      b = { tokens: burst, last: now };
      buckets.set(host, b);
    }

    // Refill
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(burst, b.tokens + elapsed * ratePerSec);
    b.last = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { host, waited_ms: 0 };
    }

    const need = 1 - b.tokens;
    const waitMs = Math.ceil((need / ratePerSec) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    b.tokens = Math.max(0, b.tokens + (waitMs / 1000) * ratePerSec - 1);
    b.last = Date.now();
    return { host, waited_ms: waitMs };
  }

  function snapshot() {
    return {
      ratePerSec,
      burst,
      hosts: buckets.size,
    };
  }

  return { acquire, snapshot, getHost };
}
