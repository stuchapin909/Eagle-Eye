/**
 * geo-index.js — Geohash spatial index + inverted text index for camera search.
 * Zero native deps. Built once when the registry loads.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Encode lat/lng to geohash string at given precision (default 5 ≈ ±2.4km). */
export function encodeGeohash(lat, lng, precision = 5) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = "";
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = idx * 2 + 1;
        lngMin = mid;
      } else {
        idx = idx * 2;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx = idx * 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += BASE32.charAt(idx);
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

/** Neighbor calculation for geohash cells (8 neighbors + self). */
const NEIGHBORS = {
  n: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
  s: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
  e: ["bc01fg45238967deuvhjyznpkmstqrwx", "p0r21436x8zb9dcf5h7kjnmqesgutwvy"],
  w: ["238967debc01fg45kmstqrwxuvhjyznp", "14365h7k9dcfesgujnmqp0r2twvyx8zb"],
};
const BORDERS = {
  n: ["prxz", "bcfguvyz"],
  s: ["028b", "0145hjnp"],
  e: ["bcfguvyz", "prxz"],
  w: ["0145hjnp", "028b"],
};

function adjacent(hash, dir) {
  const lastCh = hash.slice(-1);
  let parent = hash.slice(0, -1);
  const type = hash.length % 2;
  if (BORDERS[dir][type].includes(lastCh) && parent) {
    parent = adjacent(parent, dir);
  }
  return parent + BASE32.charAt(NEIGHBORS[dir][type].indexOf(lastCh));
}

export function geohashNeighbors(hash) {
  const n = adjacent(hash, "n");
  const s = adjacent(hash, "s");
  return [hash, n, s, adjacent(hash, "e"), adjacent(hash, "w"), adjacent(n, "e"), adjacent(n, "w"), adjacent(s, "e"), adjacent(s, "w")];
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Build spatial + text indexes over a camera array.
 * Cameras must have stable array indices matching the input order.
 */
export function buildCameraIndexes(cameras, { geohashPrecision = 5 } = {}) {
  const byGeohash = new Map(); // hash -> [index, ...]
  const byToken = new Map(); // token -> Map(index -> weight)
  const withCoords = [];

  for (let i = 0; i < cameras.length; i++) {
    const c = cameras[i];
    const lat = c.coordinates?.lat;
    const lng = c.coordinates?.lng;
    if (typeof lat === "number" && typeof lng === "number" && !(lat === 0 && lng === 0)) {
      const gh = encodeGeohash(lat, lng, geohashPrecision);
      if (!byGeohash.has(gh)) byGeohash.set(gh, []);
      byGeohash.get(gh).push(i);
      withCoords.push(i);
    }

    // Text tokens: name (3), city (2), location (1), category (1), country (1)
    addTokens(byToken, i, c.name, 3);
    addTokens(byToken, i, c.city, 2);
    addTokens(byToken, i, c.location, 1);
    addTokens(byToken, i, c.category, 1);
    addTokens(byToken, i, c.country, 1);
    if (c.id) addTokens(byToken, i, c.id.replace(/[-_]/g, " "), 2);
  }

  return {
    precision: geohashPrecision,
    byGeohash,
    byToken,
    withCoords,
    size: cameras.length,
  };
}

function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function addTokens(byToken, index, text, weight) {
  for (const tok of tokenize(text)) {
    if (!byToken.has(tok)) byToken.set(tok, new Map());
    const m = byToken.get(tok);
    m.set(index, (m.get(index) || 0) + weight);
  }
}

/**
 * Nearby query using geohash candidate set + haversine filter.
 * Returns array of { index, distance_km } sorted by distance.
 */
export function queryNearby(indexes, cameras, lat, lng, radiusKm, limit = 10) {
  const centerHash = encodeGeohash(lat, lng, indexes.precision);
  const cells = geohashNeighbors(centerHash);
  const candidate = new Set();
  for (const cell of cells) {
    const list = indexes.byGeohash.get(cell);
    if (list) for (const i of list) candidate.add(i);
  }

  // If sparse, fall back to all with coords (still rare for dense areas)
  const pool = candidate.size > 0 ? candidate : indexes.withCoords;
  const results = [];
  for (const i of pool) {
    const c = cameras[i];
    const d = haversineKm(lat, lng, c.coordinates.lat, c.coordinates.lng);
    if (d <= radiusKm) results.push({ index: i, distance_km: d });
  }
  results.sort((a, b) => a.distance_km - b.distance_km);
  return results.slice(0, limit);
}

/**
 * Text by inverted index. query string tokenized; scores summed.
 * Falls back to includes scan if no tokens match (short queries).
 */
export function querySearch(indexes, cameras, query, limit = 20) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scores = new Map();
  for (const tok of tokens) {
    const m = indexes.byToken.get(tok);
    if (!m) continue;
    for (const [idx, w] of m) {
      scores.set(idx, (scores.get(idx) || 0) + w);
    }
  }

  if (scores.size === 0) {
    // Fallback: substring includes for partial tokens
    const q = query.toLowerCase();
    const out = [];
    for (let i = 0; i < cameras.length && out.length < limit; i++) {
      const c = cameras[i];
      if (
        (c.name || "").toLowerCase().includes(q) ||
        (c.city || "").toLowerCase().includes(q) ||
        (c.location || "").toLowerCase().includes(q) ||
        (c.country || "").toLowerCase().includes(q) ||
        (c.category || "").toLowerCase().includes(q)
      ) {
        out.push({ index: i, score: 1 });
      }
    }
    return out;
  }

  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
