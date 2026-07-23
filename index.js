#!/usr/bin/env node
/**
 * Open Eagle Eye — Bootstrap
 *
 * Fetches the camera registry using registry-manifest.json (checksum + URL).
 * Verifies sha256 before accepting. Falls back to cached ~/.openeagleeye/cameras.json.
 * Fail closed on first run if network unavailable and no valid cache.
 *
 * cameras.json is NOT shipped in the npm package; it is downloaded at runtime.
 * Manifest is small and is fetched from the repo (or released with the package path).
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(os.homedir(), ".openeagleeye");
const GITHUB_RAW = "https://raw.githubusercontent.com/stuchapin909/Open-Eagle-Eye/master";

fs.mkdirSync(CACHE_DIR, { recursive: true });

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fetchText(url, timeout = 30000) {
  const resp = await axios.get(url, {
    timeout,
    responseType: "arraybuffer",
    headers: { "User-Agent": "openeagleeye-bootstrap/8.0 (+https://github.com/stuchapin909/Open-Eagle-Eye)" },
    maxRedirects: 3,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return Buffer.from(resp.data);
}

async function loadManifest() {
  // Prefer packaged/repo-adjacent manifest when developing from a git checkout
  const localManifest = path.join(__dirname, "registry-manifest.json");
  if (fs.existsSync(localManifest)) {
    try {
      return JSON.parse(fs.readFileSync(localManifest, "utf8"));
    } catch {
      /* fall through to network */
    }
  }
  const buf = await fetchText(`${GITHUB_RAW}/registry-manifest.json`, 15000);
  return JSON.parse(buf.toString("utf8"));
}

async function syncCamerasJson(localPath) {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    return { status: "manifest_failed", error: e.message };
  }

  // Cache hit: matching sha256
  if (fs.existsSync(localPath)) {
    try {
      const existing = fs.readFileSync(localPath);
      if (sha256Buffer(existing) === manifest.content_sha256) {
        return { status: "cache_hit", manifest };
      }
    } catch {
      /* re-fetch */
    }
  }

  const urls = [manifest.download_url, manifest.download_url_fallback].filter(Boolean);
  let lastErr = null;
  for (const url of urls) {
    try {
      const buf = await fetchText(url, 60000);
      const hash = sha256Buffer(buf);
      if (hash !== manifest.content_sha256) {
        lastErr = `sha256 mismatch for ${url}: got ${hash.slice(0, 12)}… want ${manifest.content_sha256.slice(0, 12)}…`;
        continue;
      }
      // Validate JSON array non-empty before replacing cache
      const data = JSON.parse(buf.toString("utf8"));
      if (!Array.isArray(data) || data.length === 0) {
        lastErr = "downloaded cameras.json empty or not an array";
        continue;
      }
      const tmp = localPath + ".tmp";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, localPath);
      // Cache manifest too
      fs.writeFileSync(path.join(CACHE_DIR, "registry-manifest.json"), JSON.stringify(manifest, null, 2));
      return { status: "updated", manifest, count: data.length };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { status: "fetch_failed", error: lastErr, manifest };
}

async function bootstrap() {
  console.error("[bootstrap] Syncing camera registry (manifest + checksum)...");

  const camerasCache = path.join(CACHE_DIR, "cameras.json");
  const stateCache = path.join(CACHE_DIR, ".registry-state.json");

  const result = await syncCamerasJson(camerasCache);

  if (result.status === "cache_hit") {
    console.error(`  [=] cameras.json — cache valid (sha256 ${result.manifest.content_sha256.slice(0, 12)}…)`);
  } else if (result.status === "updated") {
    console.error(`  [+] cameras.json — updated (${result.count.toLocaleString()} cameras, verified sha256)`);
  } else {
    if (!fs.existsSync(camerasCache)) {
      console.error(`  [!] Registry sync failed: ${result.error || result.status}`);
      console.error("  [!] GitHub unreachable / checksum failed and no local cache found.");
      console.error("  [!] Cannot start: no camera data available.");
      process.exit(1);
    }
    console.error(`  [=] cameras.json — using cached (sync failed: ${result.error || result.status})`);
  }

  // Validate cache integrity
  try {
    const data = JSON.parse(fs.readFileSync(camerasCache, "utf8"));
    if (!Array.isArray(data) || data.length === 0) {
      console.error("  [!] cameras.json is empty or not an array.");
      console.error(`  [!] Delete ${camerasCache} and restart to re-fetch.`);
      process.exit(1);
    }
    console.error(`  [i] ${data.length.toLocaleString()} cameras available`);
  } catch {
    console.error("  [!] cameras.json is not valid JSON (file may be corrupt).");
    console.error(`  [!] Delete ${camerasCache} and restart to re-fetch.`);
    process.exit(1);
  }

  // Optional registry state (non-fatal)
  try {
    const content = await fetchText(`${GITHUB_RAW}/.registry-state.json`, 15000);
    fs.writeFileSync(stateCache, content);
    console.error("  [+] .registry-state.json — updated");
  } catch {
    console.error("  [-] .registry-state.json — skipped");
  }

  console.error("[bootstrap] Starting server...");
}

await bootstrap();
await import("./server.js");
