#!/usr/bin/env node
/**
 * validate-shard.js — Parallel shard validator for GitHub Actions matrix
 *
 * Each shard validates a slice of cameras and writes results to a JSON file.
 * A separate merge job collects all shard results and commits.
 *
 * Env vars:
 *   SHARD_INDEX   — Which shard this is (0-based)
 *   TOTAL_SHARDS  — Total number of shards
 *   GITHUB_TOKEN  — For vision AI checks on failures
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectImageType, safeHttpGet, getHeadersForUrl } from "./src/security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMERAS_PATH = path.join(__dirname, "cameras.json");
const SHARD_RESULTS_DIR = path.join(__dirname, ".shard-results");

const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || "0", 10);
const TOTAL_SHARDS = parseInt(process.env.TOTAL_SHARDS || "8", 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png"];
const MIN_IMAGE_SIZE = 1024;
const FETCH_TIMEOUT = 12000;
const MAX_CONCURRENT = 10;

// --- Quick HTTP check (no vision AI for speed); redirects re-validated (#55) ---
async function quickCheck(cam) {
  try {
    const fetched = await safeHttpGet(cam.url, {
      timeout: FETCH_TIMEOUT,
      headers: getHeadersForUrl(cam.url),
      maxContentLength: 5 * 1024 * 1024,
      maxRedirects: 1,
    });
    if (!fetched.ok) {
      return {
        id: cam.id,
        status: "fail",
        reason: `Security/HTTP: ${fetched.error}`,
        checked_at: new Date().toISOString(),
      };
    }
    let ct = fetched.headers["content-type"] || "";
    const data = fetched.data;
    let isImage = ALLOWED_CONTENT_TYPES.some((t) => ct.includes(t));
    if (!isImage) {
      const detected = detectImageType(data);
      if (detected) {
        isImage = true;
        ct = detected;
      }
    }
    if (!isImage) {
      return {
        id: cam.id,
        status: "fail",
        reason: `Rejected content-type: ${ct}`,
        checked_at: new Date().toISOString(),
      };
    }
    if (data.length < MIN_IMAGE_SIZE) {
      return {
        id: cam.id,
        status: "fail",
        reason: `Image too small (${data.length} bytes)`,
        checked_at: new Date().toISOString(),
      };
    }
    return { id: cam.id, status: "pass", size: data.length, checked_at: new Date().toISOString() };
  } catch (e) {
    return {
      id: cam.id,
      status: "fail",
      reason: `HTTP ${e.response?.status || 0} — ${e.message.substring(0, 80)}`,
      checked_at: new Date().toISOString(),
    };
  }
}

// --- Vision AI check for failures only ---
async function visionRecheck(cam) {
  if (!GITHUB_TOKEN) return null;
  try {
    const fetched = await safeHttpGet(cam.url, {
      timeout: 15000,
      headers: getHeadersForUrl(cam.url),
      maxContentLength: 5 * 1024 * 1024,
      maxRedirects: 1,
    });
    if (!fetched.ok) return null;
    const data = fetched.data;
    if (data.length < 500) return null;

    const b64 = data.toString('base64');
    const response = await axios.post(
      "https://models.inference.ai.azure.com/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Is this a live webcam feed showing a real outdoor public space (street, traffic, park, weather, landmark)? Or is it an error page, placeholder, logo, or login screen? Answer PASS or FAIL with one sentence." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 100
      },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }, timeout: 30000 }
    );
    const content = response.data.choices[0].message.content;
    return content.toUpperCase().includes("PASS");
  } catch {
    return null;
  }
}

// --- Concurrency limiter ---
async function runWithConcurrency(items, fn, maxConcurrent) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- Main ---
async function main() {
  const allCameras = JSON.parse(fs.readFileSync(CAMERAS_PATH, "utf8"));
  const total = allCameras.length;
  const shardSize = Math.ceil(total / TOTAL_SHARDS);
  const start = SHARD_INDEX * shardSize;
  const end = Math.min(start + shardSize, total);
  const shardCameras = allCameras.slice(start, end);

  console.log(`Shard ${SHARD_INDEX}/${TOTAL_SHARDS}: cameras ${start}-${end - 1} (${shardCameras.length})`);

  // Phase 1: Quick HTTP check with concurrency
  const startTime = Date.now();
  const results = await runWithConcurrency(shardCameras, async (cam) => {
    const result = await quickCheck(cam);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const symbol = result.status === "pass" ? "+" : "!";
    console.log(`[${elapsed}s] ${symbol} ${cam.id}: ${result.status}${result.reason ? ` — ${result.reason}` : ` (${result.size}B)`}`);
    return result;
  }, MAX_CONCURRENT);

  // Phase 2: Vision AI recheck on failures (to avoid false positives from temporary outages)
  const failures = results.filter(r => r.status === "fail");
  if (failures.length > 0 && GITHUB_TOKEN) {
    console.log(`\nRechecking ${failures.length} failures with vision AI...`);
    let rechecked = 0;
    for (const failure of failures) {
      rechecked++;
      const cam = shardCameras.find(c => c.id === failure.id);
      if (!cam) continue;

      const passed = await visionRecheck(cam);
      if (passed === true) {
        console.log(`  VISION OVERRULE: ${failure.id} — vision says PASS, keeping`);
        failure.status = "pass";
        failure.vision_override = true;
      } else if (passed === false) {
        console.log(`  VISION CONFIRMED: ${failure.id} — truly dead`);
        failure.vision_confirmed = true;
      }
      // null = vision check failed, keep original result
    }
  }

  // Write shard results
  fs.mkdirSync(SHARD_RESULTS_DIR, { recursive: true });
  const shardFile = path.join(SHARD_RESULTS_DIR, `shard-${SHARD_INDEX}.json`);
  const shardData = {
    shard_index: SHARD_INDEX,
    total_shards: TOTAL_SHARDS,
    camera_range: { start, end },
    total_cameras: shardCameras.length,
    passed: results.filter(r => r.status === "pass").length,
    failed: results.filter(r => r.status === "fail").length,
    duration_seconds: ((Date.now() - startTime) / 1000).toFixed(1),
    results,
  };
  fs.writeFileSync(shardFile, JSON.stringify(shardData, null, 2));

  console.log(`\nShard ${SHARD_INDEX} complete: ${shardData.passed} passed, ${shardData.failed} failed in ${shardData.duration_seconds}s`);
  console.log(`Results written to ${shardFile}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
