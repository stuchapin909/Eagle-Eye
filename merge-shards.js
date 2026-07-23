#!/usr/bin/env node
/**
 * merge-shards.js — Collect shard results and update cameras.json
 *
 * Reads all .shard-results/shard-N.json files, applies removals,
 * updates .registry-state.json, and prepares for commit.
 *
 * Env vars:
 *   MAX_CONSECUTIVE_FAILURES — Failures before removal (default: 2)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMERAS_PATH = path.join(__dirname, "cameras.json");
const LOG_PATH = path.join(__dirname, ".registry-state.json");
const SHARD_RESULTS_DIR = path.join(__dirname, ".shard-results");

const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES || "2", 10);

function main() {
  const allCameras = JSON.parse(fs.readFileSync(CAMERAS_PATH, "utf8"));
  const log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));

  // Collect all shard results
  // actions/download-artifact@v4 creates subdirectories per artifact:
  //   .shard-results/shard-0/shard-0.json
  // Handle both flat (.shard-results/shard-0.json) and nested structures
  const allEntries = fs.readdirSync(SHARD_RESULTS_DIR, { withFileTypes: true });
  let shardFiles = [];

  for (const entry of allEntries) {
    if (entry.isFile() && entry.name.startsWith("shard-") && entry.name.endsWith(".json")) {
      // Flat structure: .shard-results/shard-0.json
      shardFiles.push(entry.name);
    } else if (entry.isDirectory() && entry.name.startsWith("shard-")) {
      // Nested structure: .shard-results/shard-0/shard-0.json
      const inner = fs.readdirSync(path.join(SHARD_RESULTS_DIR, entry.name));
      const jsonFile = inner.find(f => f.startsWith("shard-") && f.endsWith(".json"));
      if (jsonFile) {
        shardFiles.push(path.join(entry.name, jsonFile));
      }
    }
  }

  shardFiles.sort((a, b) => {
    const ai = parseInt(a.match(/\d+/)[0], 10);
    const bi = parseInt(b.match(/\d+/)[0], 10);
    return ai - bi;
  });

  if (shardFiles.length === 0) {
    console.log("No shard results found. Nothing to merge.");
    process.exit(0);
  }

  console.log(`Merging ${shardFiles.length} shard results...`);

  let totalChecked = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let removedCount = 0;
  const failedIds = [];

  for (const file of shardFiles) {
    const shard = JSON.parse(fs.readFileSync(path.join(SHARD_RESULTS_DIR, file), "utf8"));
    console.log(`  ${file}: ${shard.passed} passed, ${shard.failed} failed (${shard.duration_seconds}s)`);
    totalChecked += shard.total_cameras;
    totalPassed += shard.passed;
    totalFailed += shard.failed;

    for (const result of shard.results) {
      const logEntry = log[result.id] || {};
      logEntry.last_checked = result.checked_at;

      if (result.status === "pass") {
        logEntry.status = "active";
        logEntry.consecutive_failures = 0;
        logEntry.last_failure_reason = undefined;
      } else {
        logEntry.consecutive_failures = (logEntry.consecutive_failures || 0) + 1;
        logEntry.last_failure_reason = result.reason;

        if (logEntry.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
          const idx = allCameras.findIndex(c => c.id === result.id);
          if (idx !== -1) {
            allCameras.splice(idx, 1);
            removedCount++;
            failedIds.push({ id: result.id, reason: result.reason });
          }
          logEntry.status = "offline";
        } else {
          logEntry.status = "suspect";
        }
      }

      log[result.id] = logEntry;
    }
  }

  // Prune registry-state: keep live camera IDs + IDs removed this run (offline trail).
  // Drops ghost keys for cameras long gone from the registry (#54).
  const keepIds = new Set(allCameras.map((c) => c.id));
  for (const f of failedIds) keepIds.add(f.id);
  let prunedGhosts = 0;
  const prunedLog = {};
  for (const [id, entry] of Object.entries(log)) {
    if (keepIds.has(id)) {
      prunedLog[id] = entry;
    } else {
      prunedGhosts++;
    }
  }

  // Write updated files
  fs.writeFileSync(CAMERAS_PATH, JSON.stringify(allCameras, null, 2));
  fs.writeFileSync(LOG_PATH, JSON.stringify(prunedLog, null, 2));

  // Clean up shard results (recursively — artifact download creates subdirs)
  fs.rmSync(SHARD_RESULTS_DIR, { recursive: true, force: true });

  // Report
  console.log(`\n=== Merge Summary ===`);
  console.log(`Shards merged: ${shardFiles.length}`);
  console.log(`Cameras checked: ${totalChecked}`);
  console.log(`Passed: ${totalPassed}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Removed (${MAX_CONSECUTIVE_FAILURES}+ consecutive failures): ${removedCount}`);
  console.log(`Registry-state ghost keys pruned: ${prunedGhosts}`);
  console.log(`Remaining in registry: ${allCameras.length}`);

  if (failedIds.length > 0) {
    console.log(`\nRemoved cameras:`);
    failedIds.forEach(f => console.log(`  - ${f.id}: ${f.reason}`));
  }

  // Write summary for GitHub Actions to use
  const summary = {
    total_checked: totalChecked,
    passed: totalPassed,
    failed: totalFailed,
    removed: removedCount,
    remaining: allCameras.length,
    removed_ids: failedIds.map(f => f.id),
  };
  fs.writeFileSync(path.join(__dirname, ".validation-summary.json"), JSON.stringify(summary, null, 2));
}

main();
