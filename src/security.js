/**
 * security.js — URL safety checks, IP validation, image detection, HTTP headers,
 * safe fetch with revalidated redirects, registry schema helpers.
 */

import dns from "dns/promises";
import http from "http";
import https from "https";
import axios from "axios";

const BLOCKED_HOSTNAMES = [
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
  "metadata.amazonaws.com",
  "100.100.100.200",
  "fd00:ec2::254",
];

/** Categories allowed in the registry (keep in sync with CONTRIBUTING.md). */
export const VALID_CATEGORIES = [
  "city",
  "park",
  "highway",
  "airport",
  "port",
  "weather",
  "nature",
  "landmark",
  "other",
  // Specialty sources present in production registry
  "beach",
  "volcano",
  "wildlife",
  "aurora",
  "ferry",
  "dam",
  "stadium",
  "construction",
  "ski_resort",
  "traffic",
];

// Identify the project while remaining compatible with hotlink-sensitive CDNs.
// See SECURITY.md — operators can recognize us in access logs.
const PROJECT_UA =
  "Mozilla/5.0 (compatible; OpenEagleEye/8.0; +https://github.com/stuchapin909/Open-Eagle-Eye) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const HUMAN_HEADERS = {
  "User-Agent": PROJECT_UA,
  Accept: "image/jpeg,image/png,image/*;q=0.5,*/*;q=0.1",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
};

// Per-domain extra headers for hosts that require Referer or other special headers
const DOMAIN_HEADERS = {
  "webcams.transport.nsw.gov.au": {
    Referer: "https://www.livetraffic.com/traffic-cameras",
  },
};

export function isPrivateIP(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^\[|\]$/g, "");
  const v4 = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && b === 18) return true;
    if (a === 192 && b === 0 && Number(v4[4]) <= 2) return true;
  }
  if (clean === "::1" || clean === "::") return true;
  if (clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80")) return true;
  if (
    clean.startsWith("::ffff:127.") ||
    clean.startsWith("::ffff:10.") ||
    clean.startsWith("::ffff:192.168.")
  ) {
    return true;
  }
  return false;
}

export async function isSafeUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: `Blocked protocol: ${url.protocol}` };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "localhost.localdomain") {
    return { safe: false, reason: "Blocked: localhost" };
  }
  if (BLOCKED_HOSTNAMES.some((h) => hostname === h || hostname.endsWith("." + h))) {
    return { safe: false, reason: "Blocked: cloud metadata endpoint" };
  }
  try {
    const rawHost = hostname.replace(/^\[|\]$/g, "");
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawHost) || rawHost.includes(":")) {
      if (isPrivateIP(rawHost)) {
        return { safe: false, reason: `Blocked: private/reserved IP ${hostname}` };
      }
      return { safe: true, resolvedIPs: [rawHost] };
    }
    const addrs4 = await dns.resolve4(hostname).catch(() => []);
    const addrs6 = await dns.resolve6(hostname).catch(() => []);
    if (addrs4.length === 0 && addrs6.length === 0) {
      return { safe: false, reason: `Cannot resolve: ${hostname}` };
    }
    const allAddrs = [...addrs4, ...addrs6];
    for (const ip of allAddrs) {
      if (isPrivateIP(ip)) {
        return { safe: false, reason: `Blocked: ${hostname} resolves to private IP ${ip}` };
      }
    }
    return { safe: true, resolvedIPs: allAddrs };
  } catch (e) {
    return { safe: false, reason: `DNS error: ${e.message.substring(0, 80)}` };
  }
}

/**
 * Build a dns.lookup-compatible function that pins to previously validated IPs
 * (prevents TOCTOU DNS rebinding between check and fetch).
 *
 * Node may call as lookup(hostname, cb) or lookup(hostname, options, cb).
 * When options.all is true (common in Node 20+/axios), callback is
 *   cb(err, [{ address, family }, ...])
 * otherwise
 *   cb(err, address, family)
 */
export function buildPinnedLookup(resolvedIPs = []) {
  if (!resolvedIPs.length) return undefined;
  return (_hostname, opts, cb) => {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    const family = (opts && opts.family) || 0;
    let candidates = resolvedIPs;
    if (family === 4) candidates = resolvedIPs.filter((a) => !a.includes(":"));
    else if (family === 6) candidates = resolvedIPs.filter((a) => a.includes(":"));

    if (candidates.length === 0) {
      if (typeof cb === "function") cb(new Error(`No pinned IP found for family ${family}`));
      return;
    }

    if (opts && opts.all) {
      const list = candidates.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
      cb(null, list);
      return;
    }

    const ip = candidates[0];
    cb(null, ip, ip.includes(":") ? 6 : 4);
  };
}

export function getHeadersForUrl(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname;
    return { ...HUMAN_HEADERS, ...(DOMAIN_HEADERS[hostname] || {}) };
  } catch {
    return { ...HUMAN_HEADERS };
  }
}

export function detectImageType(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  return null;
}

/**
 * Normalize heterogeneous `auth` field shapes found in the wild registry.
 * Canonical forms:
 *   - false  — no API key
 *   - { key_required, provider?, signup_url?, key_type?, key_names?, config_key?, note? }
 */
export function normalizeAuth(auth) {
  if (auth === false || auth == null) return false;
  if (auth === true) {
    // Boolean true with no config is not usable — treat as no-key
    return false;
  }
  if (typeof auth !== "object") return false;

  const keys = Object.keys(auth);
  if (keys.length === 0) return false;

  // Legacy: { required: false } / { required: true } without key machinery
  if ("required" in auth && !("key_required" in auth) && !auth.provider && !auth.config_key) {
    return false;
  }

  const keyRequired = !!(auth.key_required || (auth.required === true && (auth.provider || auth.config_key || auth.key_names)));
  if (!keyRequired && !auth.provider && !auth.config_key && !auth.key_names) {
    return false;
  }

  if (!keyRequired) return false;

  const out = {
    key_required: true,
    provider: auth.provider || null,
    signup_url: auth.signup_url || null,
  };
  if (auth.key_type) out.key_type = auth.key_type;
  if (auth.key_names) out.key_names = auth.key_names;
  if (auth.config_key) out.config_key = auth.config_key;
  if (auth.note) out.note = auth.note;
  return out;
}

/**
 * Resolve a redirect Location against the current request URL.
 */
export function resolveRedirectUrl(currentUrl, locationHeader) {
  if (!locationHeader || typeof locationHeader !== "string") return null;
  try {
    return new URL(locationHeader, currentUrl).toString();
  } catch {
    return null;
  }
}

/**
 * HTTP GET with SSRF checks on the initial URL and on every redirect hop.
 * At most `maxRedirects` hops (default 1). DNS is pinned per hop.
 *
 * Returns:
 *   { ok: true, status, headers, data: Buffer, finalUrl, redirects }
 *   { ok: false, error, status? }
 */
export async function safeHttpGet(urlStr, options = {}) {
  const {
    headers = getHeadersForUrl(urlStr),
    timeout = 10000,
    maxContentLength = 5 * 1024 * 1024,
    maxRedirects = 1,
    responseType = "arraybuffer",
  } = options;

  let currentUrl = urlStr;
  const redirects = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safety = await isSafeUrl(currentUrl);
    if (!safety.safe) {
      return {
        ok: false,
        error: hop === 0 ? safety.reason : `Redirect blocked: ${safety.reason}`,
        status: 0,
        redirects,
      };
    }

    const lookup = buildPinnedLookup(safety.resolvedIPs || []);
    const axiosOpts = {
      responseType,
      timeout,
      headers,
      maxContentLength,
      maxBodyLength: maxContentLength,
      maxRedirects: 0, // we handle redirects manually after re-validation
      validateStatus: () => true, // handle 3xx ourselves
    };
    if (lookup) {
      axiosOpts.httpAgent = new http.Agent({ lookup });
      axiosOpts.httpsAgent = new https.Agent({ lookup });
    }

    let resp;
    try {
      resp = await axios.get(currentUrl, axiosOpts);
    } catch (e) {
      return {
        ok: false,
        error: e.message?.substring(0, 200) || "Request failed",
        status: e.response?.status || 0,
        redirects,
      };
    }

    const status = resp.status;
    if (status >= 300 && status < 400) {
      const loc = resp.headers?.location || resp.headers?.Location;
      const next = resolveRedirectUrl(currentUrl, loc);
      if (!next) {
        return { ok: false, error: "Redirect without valid Location", status, redirects };
      }
      if (hop >= maxRedirects) {
        return { ok: false, error: `Too many redirects (max ${maxRedirects})`, status, redirects };
      }
      redirects.push({ from: currentUrl, to: next, status });
      currentUrl = next;
      continue;
    }

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: `HTTP ${status}`,
        status,
        redirects,
      };
    }

    const data = Buffer.isBuffer(resp.data)
      ? resp.data
      : Buffer.from(resp.data ?? []);

    return {
      ok: true,
      status,
      headers: resp.headers || {},
      data,
      finalUrl: currentUrl,
      redirects,
      resolvedIPs: safety.resolvedIPs || [],
    };
  }

  return { ok: false, error: "Redirect loop limit exceeded", status: 0, redirects };
}

/**
 * Validate a redirect target before following (for raw http/https streams).
 * Returns { safe, url, resolvedIPs, reason?, lookup? }.
 */
export async function validateRedirectTarget(currentUrl, locationHeader) {
  const next = resolveRedirectUrl(currentUrl, locationHeader);
  if (!next) return { safe: false, reason: "Invalid redirect Location", url: null };
  const safety = await isSafeUrl(next);
  if (!safety.safe) return { safe: false, reason: safety.reason, url: next };
  return {
    safe: true,
    url: next,
    resolvedIPs: safety.resolvedIPs || [],
    lookup: buildPinnedLookup(safety.resolvedIPs || []),
  };
}
