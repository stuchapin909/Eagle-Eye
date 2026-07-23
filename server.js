#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { isSafeUrl, getHeadersForUrl, detectImageType } from "./src/security.js";
import { ghIssueCreate, classifyGhError, checkGhAuth, checkDuplicateUrls } from "./src/github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const CACHE_DIR = path.join(os.homedir(), ".openeagleeye");
const CAMERAS_PATH = path.join(CACHE_DIR, "cameras.json");
const LOCAL_CAMERAS_PATH = path.join(CACHE_DIR, "local-cameras.json");
const LOG_PATH = path.join(CACHE_DIR, ".registry-state.json");
const SNAPSHOTS_DIR = path.join(CACHE_DIR, "snapshots");
const MAX_SNAPSHOTS = 100;
const USER_CONFIG_PATH = path.join(CACHE_DIR, "config.json");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// --- Snapshot cleanup (LRU by mtime) ---
function cleanupSnapshots() {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR)
      .map(f => ({ name: f, mtime: fs.statSync(path.join(SNAPSHOTS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);

    while (files.length > MAX_SNAPSHOTS) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(SNAPSHOTS_DIR, oldest.name));
    }
  } catch (e) {
    console.error(`[server] Snapshot cleanup failed: ${e.message}`);
  }
}

const server = new McpServer({ name: "openeagleeye", version: VERSION });

// --- Load cameras (upstream) + local ---
let cameras = [];
try {
  cameras = JSON.parse(fs.readFileSync(CAMERAS_PATH, "utf8"));
  if (!Array.isArray(cameras)) cameras = [];
} catch (e) {
  console.error(`[server] Warning: Could not load ${CAMERAS_PATH}: ${e.message}`);
}

let localCameras = [];
try {
  localCameras = JSON.parse(fs.readFileSync(LOCAL_CAMERAS_PATH, "utf8"));
  if (!Array.isArray(localCameras)) localCameras = [];
} catch (e) {
  // No local cameras file yet — that's fine
}

// Merged view: upstream + local
const allCameras = [...cameras, ...localCameras.map(c => ({ ...c, source: "local" }))];

// Pre-compute aggregates (used by list_cameras and registry-stats resource)
const cityCounts = {};
const countryCounts = {};
const categoryCounts = {};
for (const c of allCameras) {
  const city = c.city || "Unknown"; cityCounts[city] = (cityCounts[city] || 0) + 1;
  const cc = c.country || "unknown"; countryCounts[cc] = (countryCounts[cc] || 0) + 1;
  const cat = c.category || "other"; categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
}

function saveLocalCameras() {
  fs.writeFileSync(LOCAL_CAMERAS_PATH, JSON.stringify(localCameras, null, 2));
}

// --- User Config ---
function getUserConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    }
  } catch {}
  return {};
}

function getUserApiKeys() {
  return getUserConfig().api_keys || {};
}

// --- Helpers ---
const getValidationLog = () => { try { return JSON.parse(fs.readFileSync(LOG_PATH, "utf8")); } catch (e) { return {}; } };
const saveLog = (data) => fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2));

// --- Country normalization ---
// The registry uses a mix of ISO alpha-2 codes and some non-standard values
// (e.g. "UK" instead of the ISO-correct "GB"). This map lets agents use any
// common alias and still get results.
const COUNTRY_ALIASES = {
  "uk": "gb",
  "england": "gb",
  "britain": "gb",
  "great britain": "gb",
  "united kingdom": "gb",
  "usa": "us",
  "america": "us",
  "united states": "us",
  "united states of america": "us",
  "australia": "au",
  "japan": "jp",
  "singapore": "sg",
  "hong kong": "hk",
  "ireland": "ie",
  "new zealand": "nz",
  "finland": "fi",
  "brazil": "br",
  "canada": "ca",
  "france": "fr",
  "germany": "de",
  "netherlands": "nl",
  "norway": "no",
  "sweden": "se",
  "switzerland": "ch",
  "china": "cn",
  "south korea": "kr",
  "korea": "kr",
};

// Returns the canonical lowercase country code for any input.
// Falls back to the lowercased input so unknown codes pass through unchanged.
function normalizeCountry(input) {
  if (!input) return "";
  const lower = input.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] || lower;
}

function findWebcam(idOrUrl) {
  return allCameras.find(c => c.id === idOrUrl || c.url === idOrUrl);
}

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png"];

/**
 * Extract the first JPEG frame from an MJPEG stream.
 * MJPEG (multipart/x-mixed-replace) is a sequence of JPEG frames in a single
 * HTTP response, separated by boundary markers. We connect, read until we
 * have the first complete JPEG, then close.
 *
 * Returns { buf: Buffer, contentType: "image/jpeg" } or null on failure.
 */
function extractMjpegFrame(url, headers, lookupFn, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const agentOpts = lookupFn ? { lookup: lookupFn } : {};
    const agent = urlObj.protocol === "https:"
      ? new https.Agent({ ...agentOpts, keepAlive: false })
      : new http.Agent({ ...agentOpts, keepAlive: false });

    const req = mod.get(url, {
      headers: { ...headers, "Connection": "close" },
      timeout: timeoutMs,
      agent,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect
        agent.destroy();
        extractMjpegFrame(res.headers.location, headers, lookupFn, timeoutMs)
          .then(resolve).catch(() => resolve(null));
        return;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        agent.destroy();
        resolve(null);
        return;
      }

      const chunks = [];
      let foundJpegStart = false;
      let foundJpegEnd = false;
      let jpegStartIdx = 0;
      let boundaryHint = "";

      // Parse boundary from content-type if available
      const ct = res.headers["content-type"] || "";
      const bMatch = ct.match(/boundary=([^\s;]+)/);
      if (bMatch) boundaryHint = bMatch[1];

      res.on("data", (chunk) => {
        if (foundJpegEnd) return; // Already got our frame

        chunks.push(chunk);

        // Scan for JPEG start (FF D8 FF) in accumulated buffer
        if (!foundJpegStart) {
          const combined = Buffer.concat(chunks);
          for (let i = 0; i < combined.length - 1; i++) {
            if (combined[i] === 0xFF && combined[i + 1] === 0xD8 && combined[i + 2] === 0xFF) {
              foundJpegStart = true;
              jpegStartIdx = i;
              // Trim buffer to start of JPEG
              chunks.length = 0;
              chunks.push(combined.subarray(i));
              break;
            }
          }
          // If buffer grows too large without finding JPEG start, give up
          if (!foundJpegStart && Buffer.concat(chunks).length > 100000) {
            res.destroy();
            agent.destroy();
            resolve(null);
          }
          return;
        }

        // Already found JPEG start -- look for JPEG end (FF D9)
        // or the next boundary marker
        const combined = Buffer.concat(chunks);
        for (let i = 2; i < combined.length - 1; i++) {
          if (combined[i] === 0xFF && combined[i + 1] === 0xD9) {
            // Found end of JPEG -- extract frame
            const frame = combined.subarray(0, i + 2);
            res.destroy();
            agent.destroy();
            resolve({ buf: frame, contentType: "image/jpeg" });
            return;
          }
        }

        // Also check for boundary marker (next frame starting)
        if (boundaryHint) {
          const combined = Buffer.concat(chunks);
          const boundaryBuf = Buffer.from(`--${boundaryHint}`);
          const bIdx = combined.indexOf(boundaryBuf, 10); // skip past first few bytes
          if (bIdx > 0) {
            const frame = combined.subarray(0, bIdx);
            // Trim any trailing whitespace/CRLF before boundary
            res.destroy();
            agent.destroy();
            resolve({ buf: frame, contentType: "image/jpeg" });
            return;
          }
        }

        // Safety: don't buffer more than 2MB for one frame
        if (Buffer.concat(chunks).length > 2 * 1024 * 1024) {
          res.destroy();
          agent.destroy();
          resolve(null);
        }
      });

      res.on("end", () => {
        agent.destroy();
        if (!foundJpegEnd && foundJpegStart) {
          // Stream ended but we have JPEG data -- try to use it
          const combined = Buffer.concat(chunks);
          // Find FF D9 in what we have
          for (let i = 2; i < combined.length - 1; i++) {
            if (combined[i] === 0xFF && combined[i + 1] === 0xD9) {
              resolve({ buf: combined.subarray(0, i + 2), contentType: "image/jpeg" });
              return;
            }
          }
          // No end marker found -- give up
          resolve(null);
        } else {
          resolve(null);
        }
      });

      res.on("error", () => {
        agent.destroy();
        resolve(null);
      });
    });

    req.on("error", () => {
      resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function isNighttimeAt(timezone) {
  if (!timezone) return false;
  try {
    const hour = new Date().toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false });
    return parseInt(hour, 10) >= 20 || parseInt(hour, 10) < 6;
  } catch (e) { return false; }
}

// Helper: validate a camera URL returns a real image
async function validateCameraUrl(cam) {
  const result = await downloadSnapshot(cam);
  if (result.error) return { valid: false, reason: result.error };
  // Clean up temp file — we only needed to verify the URL works
  try { fs.unlinkSync(result.file_path); } catch {}
  return { valid: true, size: result.size_bytes, content_type: result.content_type };
}

/**
 * Build request config for a camera, injecting API keys if needed.
 * Returns { url, headers } or { error } if required keys are missing.
 */
function buildRequestConfig(cam) {
  const auth = cam.auth;
  if (!auth || !auth.key_required) {
    return { url: cam.url, headers: getHeadersForUrl(cam.url) };
  }

  const apiKeys = getUserApiKeys();
  const configKey = auth.config_key || auth.key_names?.[0];

  if (!configKey || !apiKeys[configKey]) {
    return {
      error: `This camera requires an API key from ${auth.provider}.\n` +
        `Sign up: ${auth.signup_url}\n` +
        `Then add to ${USER_CONFIG_PATH}:\n` +
        `{\n  "api_keys": {\n    "${configKey}": "your-key-here"\n  }\n}`
    };
  }

  const url = new URL(cam.url);
  const headers = getHeadersForUrl(cam.url);

  if (auth.key_type === "header") {
    for (const keyName of auth.key_names || [configKey]) {
      headers[keyName] = apiKeys[configKey];
    }
  } else {
    for (const keyName of auth.key_names || [configKey]) {
      url.searchParams.set(keyName, apiKeys[configKey]);
    }
  }

  return { url: url.toString(), headers };
}

// --- SNAPSHOT ---
server.tool(
  "get_snapshot",
  "Fetch a live image from a camera. Downloads the image to disk and returns the file path. Works on both upstream registry cameras and locally-added cameras. Use list_cameras or search_cameras first to find IDs.",
  { cam_id: z.string().describe("Camera ID (from list_cameras/search_cameras), or a direct image URL") },
  async ({ cam_id }) => {
    const cam = findWebcam(cam_id);
    if (!cam) return errResponse("Camera not found", { cam_id });
    const result = await downloadSnapshot(cam);
    if (result.error) return errResponse(result.error, { camera: cam.name, id: cam.id });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// --- Error helper ---
function errResponse(error, extra = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ error, ...extra }) }], isError: true };
}

// --- Shared snapshot download helper ---
async function downloadSnapshot(cam) {
  const config = buildRequestConfig(cam);
  if (config.error) return { error: "API key required", details: config.error };

  const safety = await isSafeUrl(config.url);
  if (!safety.safe) return { error: `Blocked: ${safety.reason}` };

  // Pin resolved IPs to prevent TOCTOU DNS rebinding attacks.
  // isSafeUrl already validated these IPs; we force axios to use them
  // instead of performing a second DNS lookup.
  const resolvedIPs = safety.resolvedIPs || [];
  const lookup = resolvedIPs.length > 0
    ? (_hostname, opts, cb) => {
        const family = opts.family || 0;
        let ip = null;
        if (family === 4) {
          ip = resolvedIPs.find(a => !a.includes(':'));
        } else if (family === 6) {
          ip = resolvedIPs.find(a => a.includes(':'));
        } else {
          // family=0: prefer IPv4, fall back to IPv6
          ip = resolvedIPs.find(a => !a.includes(':')) || resolvedIPs.find(a => a.includes(':'));
        }
        if (!ip) return cb(new Error(`No pinned IP found for family ${family}`));
        cb(null, ip, ip.includes(':') ? 6 : 4);
      }
    : undefined;

  const filename = `${crypto.randomBytes(8).toString('hex')}.jpg`;
  const fullPath = path.join(SNAPSHOTS_DIR, filename);

  // Build a lookup function for the raw HTTP MJPEG path
  const rawLookup = resolvedIPs.length > 0
    ? (_hostname, opts, cb) => {
        const family = opts.family || 0;
        let ip = null;
        if (family === 4) ip = resolvedIPs.find(a => !a.includes(':'));
        else if (family === 6) ip = resolvedIPs.find(a => a.includes(':'));
        else ip = resolvedIPs.find(a => !a.includes(':')) || resolvedIPs.find(a => a.includes(':'));
        if (!ip) return cb(new Error(`No pinned IP found for family ${family}`));
        cb(null, ip, ip.includes(':') ? 6 : 4);
      }
    : undefined;

  try {
    // Probe for MJPEG: do a short GET with streaming to check content-type
    // without buffering the whole response.
    const isMjpeg = await new Promise((resolve) => {
      const urlObj = new URL(config.url);
      const mod = urlObj.protocol === "https:" ? https : http;
      const agentOpts = rawLookup ? { lookup: rawLookup } : {};
      const agent = urlObj.protocol === "https:"
        ? new https.Agent({ ...agentOpts, keepAlive: false })
        : new http.Agent({ ...agentOpts, keepAlive: false });
      const req = mod.get(config.url, {
        headers: config.headers,
        timeout: 3000,
        agent,
      }, (res) => {
        const ct = res.headers["content-type"] || "";
        res.destroy();
        agent.destroy();
        resolve(ct.includes("multipart/x-mixed-replace") || ct.includes("multipart/mixed"));
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });

    if (isMjpeg) {
      // MJPEG stream -- extract first JPEG frame
      const frame = await extractMjpegFrame(config.url, config.headers, rawLookup, 5000);
      if (!frame || frame.buf.length < 500) {
        return { error: "MJPEG stream: could not extract a valid frame" };
      }
      fs.writeFileSync(fullPath, frame.buf);
      cleanupSnapshots();
      return {
        success: true,
        file_path: fullPath,
        size_bytes: frame.buf.length,
        content_type: "image/jpeg",
        source: "mjpeg",
        camera: { id: cam.id, name: cam.name, location: cam.location, category: cam.category }
      };
    }

    // Standard image download via axios
    const axiosOpts = {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: config.headers,
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024,
      maxRedirects: 1,
    };
    if (lookup) {
      axiosOpts.httpAgent = new http.Agent({ lookup });
      axiosOpts.httpsAgent = new https.Agent({ lookup });
    }
    const response = await axios.get(config.url, axiosOpts);
    let ct = response.headers['content-type'] || "";
    let isAllowed = ALLOWED_CONTENT_TYPES.some(t => ct.includes(t));
    const buf = Buffer.from(response.data);
    if (!isAllowed) {
      const detected = detectImageType(buf);
      if (detected) { isAllowed = true; ct = detected; }
    }
    if (!isAllowed) return { error: `Rejected content-type: ${ct}` };
    if (buf.length > 5 * 1024 * 1024) return { error: `Response too large (${(buf.length / 1024 / 1024).toFixed(1)}MB)` };
    if (buf.length < 500) return { error: `Response too small: ${buf.length} bytes (likely placeholder)` };
    fs.writeFileSync(fullPath, buf);
    cleanupSnapshots();
    return {
      success: true,
      file_path: fullPath,
      size_bytes: buf.length,
      content_type: ct.includes('png') ? 'image/png' : 'image/jpeg',
      camera: { id: cam.id, name: cam.name, location: cam.location, category: cam.category }
    };
  } catch (e) {
    return { error: `Snapshot failed: ${e.message.substring(0, 200)}` };
  }
}

// --- Haversine distance (km) ---
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Camera metadata mapper (shared across tools) ---
function mapCameraMeta(c, logs) {
  return {
    id: c.id,
    name: c.name,
    city: c.city || null,
    country: c.country || null,
    location: c.location || "Unknown",
    category: c.category || "other",
    timezone: c.timezone || null,
    coordinates: c.coordinates || null,
    status: (logs && logs[c.id]?.status) || "active",
    source: c.source || "upstream",
    auth_required: c.auth?.key_required || false,
  };
}

// --- REGISTRY ---
server.tool("list_cameras", "Browse the camera registry. Returns cameras with id, name, city, country, location, category, coordinates, and source (upstream or local). Supports filtering by city, country, location, and category. Use limit/offset for pagination — the full registry is large. City/country aggregates are omitted by default (use cameras://stats or include_aggregates) to keep agent context small.", {
  city: z.string().optional().describe("Filter by city name (e.g. 'London', 'New York', 'Sydney')"),
  country: z.string().optional().describe("Filter by country code or name (e.g. 'US', 'UK', 'Australia', 'JP')"),
  location: z.string().optional().describe("Filter by location string (e.g. 'Manhattan', 'Borough')"),
  category: z.string().optional().describe("Filter by category: city, park, highway, airport, port, weather, nature, landmark, other"),
  limit: z.number().int().min(1).max(100).optional().describe("Max cameras to return (default 20, max 100)"),
  offset: z.number().int().min(0).optional().describe("Skip this many cameras (for pagination, default 0)"),
  include_aggregates: z.boolean().optional().describe("If true, include full city count map (large). Prefer cameras://stats for rollups. Default false.")
}, async ({ city, country, location, category, limit, offset, include_aggregates }) => {
  if (allCameras.length === 0) return { content: [{ type: "text", text: JSON.stringify({ version: VERSION, total: 0, cameras: [], message: "Registry is empty." }) }] };

  const logs = getValidationLog();
  let filtered = allCameras;
  if (city) filtered = filtered.filter(c => (c.city || "").toLowerCase() === city.toLowerCase());
  if (country) {
    const normCountry = normalizeCountry(country);
    filtered = filtered.filter(c => normalizeCountry(c.country) === normCountry);
  }
  if (location) filtered = filtered.filter(c => (c.location || "").toLowerCase().includes(location.toLowerCase()));
  if (category) filtered = filtered.filter(c => (c.category || "") === category);

  const totalFiltered = filtered.length;
  const effectiveLimit = Math.min(limit || 20, 100);
  const effectiveOffset = offset || 0;
  const paged = filtered.slice(effectiveOffset, effectiveOffset + effectiveLimit);
  const result = paged.map(c => mapCameraMeta(c, logs));

  // Default: omit full cities map (~2.8k keys / ~50KB) — agents should use cameras://stats (#52)
  const payload = {
    version: VERSION,
    total: allCameras.length,
    filtered: totalFiltered,
    offset: effectiveOffset,
    limit: effectiveLimit,
    cameras: result,
  };
  if (include_aggregates) {
    payload.cities = cityCounts;
    payload.countries = countryCounts;
    payload.categories = categoryCounts;
  }

  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
});

server.tool("search_cameras", "Search cameras by text. Matches against name, city, country, location, and category. Use when looking for cameras in a specific place or of a specific type.", {
  query: z.string().describe("Search term — matches camera name, city, country, location, and category"),
  limit: z.number().int().min(1).max(100).optional().describe("Max results to return (default 20, max 100)")
}, async ({ query, limit }) => {
  const q = query.toLowerCase();
  const results = allCameras.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.city || "").toLowerCase().includes(q) ||
    (c.country || "").toLowerCase().includes(q) ||
    (c.location || "").toLowerCase().includes(q) ||
    (c.category || "").toLowerCase().includes(q)
  );
  if (results.length === 0) return { content: [{ type: "text", text: JSON.stringify({ query, total: 0, cameras: [] }) }] };
  const logs = getValidationLog();
  const mapped = results.slice(0, limit || 20).map(c => mapCameraMeta(c, logs));
  return { content: [{ type: "text", text: JSON.stringify({ query, total: results.length, returned: mapped.length, cameras: mapped }, null, 2) }] };
});

// --- GET CAMERA INFO ---
server.tool("get_camera_info", "Look up camera metadata by ID. Returns full details for a single camera without fetching a snapshot. Use this to check if an ID is valid or to get current metadata for a known camera.", {
  cam_id: z.string().describe("Camera ID to look up")
}, async ({ cam_id }) => {
  const cam = findWebcam(cam_id);
  if (!cam) return errResponse("Camera not found", { cam_id });
  const logs = getValidationLog();
  return { content: [{ type: "text", text: JSON.stringify({ ...mapCameraMeta(cam, logs), url: cam.url }, null, 2) }] };
});

// --- NEARBY CAMERAS (geographic search) ---
server.tool("nearby_cameras", "Find cameras within a geographic radius. Returns cameras sorted by distance from the given point. Use for spatial queries like 'webcams near Times Square' or 'cameras within 10km of the Opera House'.", {
  lat: z.number().min(-90).max(90).describe("Latitude of the center point"),
  lng: z.number().min(-180).max(180).describe("Longitude of the center point"),
  radius_km: z.number().min(1).max(500).optional().describe("Search radius in kilometers (default 25, max 500)"),
  limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10, max 50)"),
  category: z.string().optional().describe("Filter by category: city, park, highway, airport, port, weather, nature, landmark, other")
}, async ({ lat, lng, radius_km, limit, category }) => {
  const radius = Math.min(radius_km || 25, 500);
  const maxResults = Math.min(limit || 10, 50);
  const logs = getValidationLog();

  let candidates = allCameras.filter(c => c.coordinates?.lat != null && c.coordinates?.lng != null);
  if (category) candidates = candidates.filter(c => (c.category || "") === category);

  const withDist = candidates.map(c => ({
    cam: c,
    distance: haversineKm(lat, lng, c.coordinates.lat, c.coordinates.lng)
  })).filter(d => d.distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, maxResults);

  const results = withDist.map(d => ({
    ...mapCameraMeta(d.cam, logs),
    distance_km: Math.round(d.distance * 10) / 10
  }));

  return { content: [{ type: "text", text: JSON.stringify({
    query: { lat, lng, radius_km: radius },
    total: results.length,
    cameras: results
  }, null, 2) }] };
});

// --- EXPLORE CAMERAS (random discovery) ---
server.tool("explore_cameras", "Get random cameras from the registry for discovery. Returns a surprise selection. Filter by city, country, or category to narrow the pool, or leave empty for a truly random pick.", {
  city: z.string().optional().describe("Filter pool to this city (e.g. 'Tokyo', 'Paris')"),
  country: z.string().optional().describe("Filter pool to this country (e.g. 'JP', 'France')"),
  category: z.string().optional().describe("Filter by category: city, park, highway, airport, port, weather, nature, landmark, other"),
  count: z.number().int().min(1).max(10).optional().describe("How many random cameras to return (default 3, max 10)")
}, async ({ city, country, category, count }) => {
  const num = Math.min(count || 3, 10);
  const logs = getValidationLog();

  let pool = allCameras;
  if (city) pool = pool.filter(c => (c.city || "").toLowerCase() === city.toLowerCase());
  if (country) {
    const normCountry = normalizeCountry(country);
    pool = pool.filter(c => normalizeCountry(c.country) === normCountry);
  }
  if (category) pool = pool.filter(c => (c.category || "") === category);

  if (pool.length === 0) return errResponse("No cameras match the filters", { filters: { city, country, category }, pool_size: 0 });

  // Fisher-Yates partial shuffle for true random without bias
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0 && i > shuffled.length - num - 1; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(shuffled.length - num);

  const results = picked.map(c => mapCameraMeta(c, logs));
  return { content: [{ type: "text", text: JSON.stringify({
    pool_size: pool.length,
    cameras: results
  }, null, 2) }] };
});

// --- BATCH SNAPSHOTS ---
server.tool("get_snapshots", "Fetch live images from multiple cameras in one call. Returns all snapshot file paths. Use to compare several cameras at once or to monitor a set of favorites. Max 5 cameras per call.", {
  cam_ids: z.array(z.string()).min(1).max(5).describe("Array of camera IDs (from list_cameras/search_cameras). Max 5.")
}, async ({ cam_ids }) => {
  const results = [];
  for (const cam_id of cam_ids) {
    const cam = findWebcam(cam_id);
    if (!cam) {
      results.push({ cam_id, error: "Camera not found" });
      continue;
    }
    const snap = await downloadSnapshot(cam);
    results.push({ cam_id, ...snap });
  }

  const successes = results.filter(r => r.success).length;
  return { content: [{ type: "text", text: JSON.stringify({ requested: cam_ids.length, succeeded: successes, failed: cam_ids.length - successes, snapshots: results }, null, 2) }] };
});

// --- LOCAL CAMERAS ---
server.tool("add_local_camera", "Add a camera to your local collection. Local cameras persist in ~/.openeagleeye/local-cameras.json and survive restarts and registry updates. They appear in list_cameras and search_cameras with source 'local'. Share upstream anytime with submit_local.", {
  name: z.string().describe("Human-readable camera name"),
  url: z.string().url().describe("Direct image URL — must return JPEG or PNG on HTTP GET"),
  city: z.string().describe("City name (e.g. 'London', 'New York', 'Sydney')"),
  location: z.string().describe("Location description (e.g. 'Manhattan, New York, USA')"),
  timezone: z.string().describe("IANA timezone (e.g. 'America/New_York', 'Europe/London')"),
  category: z.enum(["city", "park", "highway", "airport", "port", "weather", "nature", "landmark", "other"]).optional().describe("Camera category"),
  lat: z.number().min(-90).max(90).optional().describe("Latitude of the camera"),
  lng: z.number().min(-180).max(180).optional().describe("Longitude of the camera"),
  auth_provider: z.string().optional().describe("Provider name if API key is needed (e.g. 'Transport for London')"),
  auth_signup_url: z.string().optional().describe("URL to register for API key"),
  auth_key_required: z.boolean().optional().describe("Whether the image URL requires an API key at fetch time"),
  auth_key_type: z.enum(["query_params", "header"]).optional().describe("How to inject the key"),
  auth_key_names: z.array(z.string()).optional().describe("Query param or header names for the key"),
  auth_config_key: z.string().optional().describe("Key name to use in ~/.openeagleeye/config.json"),
  auth_note: z.string().optional().describe("Notes about authentication"),
}, async (params) => {
  const { auth_provider, auth_signup_url, auth_key_required, auth_key_type, auth_key_names, auth_config_key, auth_note, lat, lng, ...camFields } = params;

  const id = `local-${Date.now()}`;

  const entry = {
    ...camFields,
    id,
    verified: false,
    added_at: new Date().toISOString(),
  };

  if (lat !== undefined && lng !== undefined) {
    entry.coordinates = { lat, lng };
  }

  if (auth_provider) {
    entry.auth = {
      provider: auth_provider,
      signup_url: auth_signup_url || null,
      key_required: auth_key_required ?? true,
      ...(auth_key_type && { key_type: auth_key_type }),
      ...(auth_key_names && { key_names: auth_key_names }),
      ...(auth_config_key && { config_key: auth_config_key }),
      ...(auth_note && { note: auth_note }),
    };
  }

  localCameras.push(entry);
  allCameras.push({ ...entry, source: "local" });
  saveLocalCameras();
  return { content: [{ type: "text", text: JSON.stringify({ success: true, id, name: camFields.name, url: camFields.url, source: "local", auth_required: entry.auth?.key_required || false, message: "Camera added locally. Test with get_snapshot, share upstream with submit_local." }) }] };
});

// LIST LOCAL
server.tool("list_local", "Show your locally-added cameras. These persist in ~/.openeagleeye/local-cameras.json and survive restarts and registry updates. They appear in list_cameras and search_cameras with source 'local'. Returns camera IDs, names, URLs, coordinates, and auth requirements.", {}, async () => {
  if (localCameras.length === 0) return { content: [{ type: "text", text: JSON.stringify({ total: 0, cameras: [], message: "No local cameras. Use add_local_camera to add cameras." }) }] };
  const result = localCameras.map(c => ({
    id: c.id,
    name: c.name,
    url: c.url,
    city: c.city || null,
    location: c.location || "Unknown",
    category: c.category || "other",
    timezone: c.timezone || null,
    coordinates: c.coordinates || null,
    auth_required: c.auth?.key_required || false,
    added_at: c.added_at || null,
  }));
  return { content: [{ type: "text", text: JSON.stringify({ total: localCameras.length, cameras: result }, null, 2) }] };
});

// REMOVE LOCAL
server.tool("remove_local", "Delete a locally-added camera by ID. Removes it from ~/.openeagleeye/local-cameras.json and the in-memory merged view. The camera is also auto-removed from the merged list. Use after sharing upstream via submit_local, or when a URL stops working.", {
  cam_id: z.string().describe("Local camera ID to remove (starts with 'local-')")
}, async ({ cam_id }) => {
  const idx = localCameras.findIndex(c => c.id === cam_id);
  if (idx === -1) return errResponse("Local camera not found", { cam_id });

  const removed = localCameras.splice(idx, 1)[0];
  const mergedIdx = allCameras.findIndex(c => c.id === cam_id);
  if (mergedIdx !== -1) allCameras.splice(mergedIdx, 1);
  saveLocalCameras();
  return { content: [{ type: "text", text: JSON.stringify({ success: true, removed: { id: removed.id, name: removed.name } }) }] };
});

// SUBMIT LOCAL
server.tool("submit_local", "Share your locally-added cameras with the upstream Open Eagle Eye registry by filing a GitHub issue. Validates each camera URL, checks for duplicates, and embeds a snapshot preview. Requires the 'gh' CLI installed and authenticated (gh auth login). Your local cameras are not removed — use remove_local after they are accepted.", {}, async () => {
  if (localCameras.length === 0) return errResponse("No local cameras to submit. Use add_local_camera to add cameras first.");

  // Check gh auth with detailed error
  const authCheck = checkGhAuth();
  if (!authCheck.ok) {
    return errResponse(authCheck.message, { error_type: authCheck.type, fix: authCheck.fix, message: "Local cameras are saved. Fix gh CLI, then retry." });
  }

  // Pre-flight validation: fetch each camera and verify it returns a real image
  const validations = [];
  for (const cam of localCameras) {
    const v = await validateCameraUrl(cam);
    validations.push({ id: cam.id, name: cam.name, url: cam.url, ...v });
  }
  const validCams = localCameras.filter((_, i) => validations[i].valid);
  const invalidCams = validations.filter(v => !v.valid);

  if (validCams.length === 0) {
    return errResponse("No valid cameras to submit — all URLs failed validation", {
      failed: invalidCams.map(v => ({ name: v.name, url: v.url, reason: v.reason })),
      message: "Fix the broken URLs with remove_local + add_local_camera, then retry."
    });
  }

  // Duplicate detection: check open submission issues for same URLs
  const urlsToCheck = validCams.map(c => c.url);
  const duplicates = checkDuplicateUrls(urlsToCheck);
  const dupUrls = new Set(duplicates.map(d => d.url));
  const camsToSubmit = validCams.filter(c => !dupUrls.has(c.url));

  if (camsToSubmit.length === 0) {
    return errResponse("All cameras already have open submission issues", {
      duplicates: duplicates.map(d => ({ url: d.url, issue: `#${d.issue_number}`, title: d.issue_title }))
    });
  }

  // Strip local-internal fields for submission
  const cleanCameras = camsToSubmit.map(c => {
    const { added_at, ...clean } = c;
    return clean;
  });

  // Snapshot previews (up to 5, embedded as markdown images in the issue)
  const previewCams = camsToSubmit.slice(0, 5);
  const snapshots = [];
  for (const cam of previewCams) {
    try {
      const result = await downloadSnapshot(cam);
      if (result && result.success) {
        snapshots.push({ cam });
      }
    } catch (_) {
      // Skip failed snapshots gracefully
    }
  }

  // Build issue body
  const bodyParts = [
    "## New Camera Submission",
    "",
    `${camsToSubmit.length} camera(s) submitted via Open Eagle Eye MCP server.`,
  ];

  // Warnings section
  const warnings = [];
  if (invalidCams.length > 0) {
    warnings.push(`**${invalidCams.length} camera(s) skipped** (failed validation): ${invalidCams.map(v => `${v.name} — ${v.reason}`).join("; ")}`);
  }
  if (duplicates.length > 0) {
    warnings.push(`**${duplicates.length} camera(s) skipped** (duplicate open issue): ${duplicates.map(d => `[${d.url}](${d.url}) — see #${d.issue_number}`).join("; ")}`);
  }
  if (warnings.length > 0) {
    bodyParts.push("", "> [!WARNING]", ...warnings.map(w => `> ${w}`));
  }

  bodyParts.push("", "```json", JSON.stringify(cleanCameras, null, 2), "```");

  // Embed snapshot previews
  if (snapshots.length > 0) {
    bodyParts.push("", "### Snapshot Previews");
    for (const snap of snapshots) {
      bodyParts.push("", `**${snap.cam.name}** — ${snap.cam.location || snap.cam.city || "Unknown"}`, `![${snap.cam.name}](${snap.cam.url})`);
    }
  }

  bodyParts.push("", "---", `*Submitted automatically from openeagleeye v${VERSION}*`);

  const body = bodyParts.join("\n");
  const title = `New camera submission: ${camsToSubmit.length} camera(s) from ${camsToSubmit[0]?.city || "unknown"}`;

  try {
    const result = ghIssueCreate(title, body, "webcam-submission");
    return { content: [{ type: "text", text: JSON.stringify({
      success: true,
      submitted: camsToSubmit.length,
      skipped_invalid: invalidCams.length,
      skipped_duplicates: duplicates.length,
      snapshots_embedded: snapshots.length,
      issue_url: result,
      message: `Submitted ${camsToSubmit.length} camera(s) with ${snapshots.length} snapshot preview(s). Your local cameras are unchanged — use remove_local after they are accepted upstream.`
    }) }] };
  } catch (e) {
    const errInfo = classifyGhError(e);
    return errResponse("Failed to create GitHub issue", { error_type: errInfo.type, details: errInfo.message, fix: errInfo.fix });
  }
});

// REPORT CAMERA
server.tool("report_camera", "Report a broken or low-quality camera. Files a GitHub issue with a snapshot showing the current state, and saves the report locally. If the camera is local with a broken link, it is automatically removed. Requires 'gh' CLI for GitHub issue creation.", {
  cam_id: z.string().describe("Camera ID to report"),
  status: z.enum(["offline", "broken_link", "low_quality"]).describe("Type of issue"),
  notes: z.string().optional().describe("Additional details about the issue")
}, async ({ cam_id, status, notes }) => {
  const cam = findWebcam(cam_id);
  if (!cam) return errResponse("Camera not found", { cam_id });
  if (cam.source === "local" && isNighttimeAt(cam.timezone)) return errResponse("Report blocked: nighttime at camera location", { camera: cam.name, timezone: cam.timezone });

  // Save locally regardless
  const logs = getValidationLog();
  logs[cam_id] = { status, notes, timestamp: new Date().toISOString() };
  saveLog(logs);

  // If it's a local camera marked broken_link, auto-remove
  if (cam.source === "local" && status === "broken_link") {
    const idx = localCameras.findIndex(c => c.id === cam_id);
    if (idx !== -1) {
      localCameras.splice(idx, 1);
      const mergedIdx = allCameras.findIndex(c => c.id === cam_id);
      if (mergedIdx !== -1) allCameras.splice(mergedIdx, 1);
      saveLocalCameras();
    }
  }

  // Check gh auth
  const authCheck = checkGhAuth();
  if (!authCheck.ok) {
    return { content: [{ type: "text", text: JSON.stringify({
      success: true, saved_locally: true,
      github_error: authCheck.message, error_type: authCheck.type,
      fix: authCheck.fix,
      message: "Report saved locally. Fix gh CLI to also file a GitHub issue."
    }) }] };
  }

  // Attempt to fetch a snapshot for the report
  let snapshotSection = "";
  const snap = await downloadSnapshot(cam);
  if (snap.success) {
    try { fs.unlinkSync(snap.file_path); } catch {}
    snapshotSection = [
      "", "### Current Snapshot", "",
      `![${cam.name}](${cam.url})`, "",
      `*Image fetched at report time: ${new Date().toISOString()} (${snap.size_bytes} bytes, ${snap.content_type})*`
    ].join("\n");
  } else {
    snapshotSection = [
      "", "### Snapshot Attempt", "",
      `*Failed to fetch snapshot: ${snap.error} — this confirms the reported issue.*`
    ].join("\n");
  }

  const body = [
    "## Webcam Issue Report", "",
    `**Camera:** ${cam.name} (\`${cam.id}\`)`,
    `**Status:** ${status}`,
    `**Location:** ${cam.location || "Unknown"}`,
    `**URL:** ${cam.url}`,
    notes ? `**Notes:** ${notes}` : "",
    snapshotSection, "",
    "---",
    `*Reported via openeagleeye v${VERSION}*`
  ].filter(Boolean).join("\n");

  const title = `Camera issue [${status}]: ${cam.name}`;

  try {
    const result = ghIssueCreate(title, body, "webcam-report");
    return { content: [{ type: "text", text: JSON.stringify({
      success: true, saved_locally: true,
      issue_url: result,
      camera: { id: cam.id, name: cam.name },
      status,
      snapshot_embedded: snap.success,
      message: "Report saved locally and filed as a GitHub issue with snapshot."
    }) }] };
  } catch (e) {
    const errInfo = classifyGhError(e);
    return errResponse("Failed to create GitHub issue", { error_type: errInfo.type, details: errInfo.message, fix: errInfo.fix });
  }
});

// --- CONFIG ---
server.tool("check_config", "Show API key configuration status. Lists all cameras in the registry that require authentication, the provider name, whether a key is configured in ~/.openeagleeye/config.json, and the signup URL for each. Use when a snapshot fails with an API key error to see which keys are missing.", {}, async () => {
  const config = getUserConfig();
  const apiKeys = getUserApiKeys();

  const authCams = cameras.filter(c => c.auth?.key_required);
  const status = authCams.map(c => {
    const configKey = c.auth.config_key || c.auth.key_names?.[0];
    const hasKey = configKey && apiKeys[configKey];
    return {
      camera: c.name,
      id: c.id,
      provider: c.auth.provider,
      config_key: configKey,
      key_set: !!hasKey,
      signup_url: c.auth.signup_url,
    };
  });

  return { content: [{ type: "text", text: JSON.stringify({
    config_path: USER_CONFIG_PATH,
    api_keys_configured: Object.keys(apiKeys).length,
    auth_required_cameras: status.length,
    cameras: status,
  }, null, 2) }] };
});

// --- MCP Resources ---
server.resource("registry-stats", "cameras://stats", async () => {
  const logs = getValidationLog();
  let active = 0, suspect = 0, offline = 0;
  for (const c of allCameras) {
    const status = (logs[c.id]?.status) || "active";
    if (status === "active") active++;
    else if (status === "suspect") suspect++;
    else offline++;
  }
  const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const stats = {
    version: VERSION,
    total: allCameras.length,
    upstream: cameras.length,
    local: localCameras.length,
    health: { active, suspect, offline },
    countries: countryCounts,
    categories: categoryCounts,
    top_cities: topCities,
  };
  return { contents: [{ uri: "cameras://stats", mimeType: "application/json", text: JSON.stringify(stats, null, 2) }] };
});

// --- MCP Prompts ---
server.prompt("discover-cameras", "Guide for finding and adding new public webcam sources to Open Eagle Eye", async () => {
  return {
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "Find publicly accessible webcam sources and add them to Open Eagle Eye.",
          "",
          "A valid webcam URL must return a JPEG or PNG image on a plain HTTP GET — no JavaScript rendering, no authentication, no streams.",
          "",
          "**Good sources to check:**",
          "- City/state DOT traffic camera APIs (search: '[city] traffic camera API')",
          "- Weather station webcams (Weather Underground, PWSWeather)",
          "- Ski resort cameras",
          "- National park webcams",
          "- Port authority cameras",
          "- Airport perimeter cameras",
          "- University campus cameras",
          "",
          "**To verify a URL:**",
          "1. `curl -I -s URL | grep content-type` — must return `image/`",
          "2. Fetch twice, 5 seconds apart — file size should change for live cameras",
          "3. Must be accessible without cookies, sessions, or CAPTCHAs",
          "",
          "**To add cameras:**",
          "1. Use `add_local_camera` with the URL, city, location, timezone",
          "2. Test with `get_snapshot`",
          "3. Share upstream with `submit_local`",
          "",
          "**Invalid sources (will not work):**",
          "- YouTube streams, EarthCam/SkylineWebcams page URLs",
          "- RTSP, HLS, or DASH streams",
          "- Pages requiring JavaScript rendering",
          "- URLs behind Cloudflare challenges or cookie consent",
        ].join("\n"),
      },
    }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Open Eagle Eye v${VERSION}`);
}

main().catch(console.error);
