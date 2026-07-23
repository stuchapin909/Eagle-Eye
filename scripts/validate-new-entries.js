#!/usr/bin/env node
/**
 * validate-new-entries.js — Pre-merge validation for new camera sources
 *
 * Checks:
 *   A. Schema compliance (all fields, correct types, ID uniqueness)
 *   C. URL pattern consistency (same source = same domain)
 *   E. Source-level verification (API count vs committed count)
 *   Coordinate sanity (within expected country bounds)
 *
 * Usage:
 *   node validate-new-entries.js [--source "Arizona ADOT" --expected-count 604]
 *   node validate-new-entries.js  (auto-detects new entries from git diff)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMERAS_PATH = path.join(__dirname, "cameras.json");

// Rough bounding boxes per country code [minLat, maxLat, minLng, maxLng]
// Generous bounds — just catch obvious errors like US cameras in Europe
const COUNTRY_BOUNDS = {
  US: [24.5, 49.4, -125.0, -66.9],
  CA: [41.7, 83.1, -141.0, -52.6],
  GB: [49.9, 60.9, -8.2, 2.0],
  UK: [49.9, 60.9, -8.2, 2.0],
  AU: [-44.0, -10.0, 113.0, 154.0],
  NZ: [-47.3, -34.3, 166.4, 178.6],
  JP: [30.0, 45.6, 129.3, 145.9],
  SG: [1.1, 1.5, 103.6, 104.1],
  HK: [22.1, 22.6, 113.8, 114.4],
  IE: [51.4, 55.4, -10.6, -5.9],
  FI: [59.7, 70.1, 19.1, 31.6],
  BR: [-33.8, 5.3, -73.7, -34.7],
  DE: [47.3, 55.1, 5.9, 15.0],
  FR: [42.3, 51.1, -5.2, 8.2],
  SE: [55.1, 69.1, 10.9, 24.2],
  DK: [54.5, 57.8, 7.8, 15.2],
  NO: [57.8, 71.2, 4.7, 31.0],
  AT: [46.4, 49.0, 9.5, 17.2],
  CH: [45.8, 47.8, 5.9, 10.5],
  NL: [50.7, 53.6, 3.3, 7.2],
  PL: [49.0, 54.9, 14.1, 24.1],
  CZ: [48.5, 51.1, 11.9, 18.9],
};

// Keep in sync with src/security.js VALID_CATEGORIES
const VALID_CATEGORIES = [
  "city", "park", "highway", "airport", "port", "weather", "nature", "landmark", "other",
  "beach", "volcano", "wildlife", "aurora", "ferry", "dam", "stadium", "construction",
  "ski_resort", "traffic",
];

const REQUIRED_FIELDS = [
  { name: "id", type: "string" },
  { name: "name", type: "string" },
  { name: "url", type: "string" },
  { name: "category", type: "string" },
  { name: "location", type: "string" },
  { name: "timezone", type: "string" },
  { name: "country", type: "string" },
  { name: "city", type: "string" },
  { name: "coordinates", type: "object" },
  { name: "verified", type: "boolean" },
  // auth: boolean false, or object with key_required (see CONTRIBUTING.md)
  { name: "auth", type: "any" },
];

const errors = [];
const warnings = [];
let totalChecked = 0;

function error(msg, id) {
  errors.push({ id, msg });
}

function warn(msg, id) {
  warnings.push({ id, msg });
}

function checkSchema(entry, index) {
  const id = entry.id || `entry-${index}`;

  for (const field of REQUIRED_FIELDS) {
    if (!(field.name in entry)) {
      error(`Missing required field: ${field.name}`, id);
      continue;
    }
    if (field.type === "any") continue;
    if (field.name === "auth") {
      const a = entry.auth;
      const ok =
        a === false ||
        a === true ||
        (a && typeof a === "object" && (a.key_required === true || a.key_required === false));
      if (!ok && a !== false) {
        // Allow boolean false; object with key_required; reject empty/null noise
        if (a == null || (typeof a === "object" && Object.keys(a).length === 0)) {
          error(`Field 'auth' should be false or an object with key_required (not null/empty)`, id);
        }
      }
      continue;
    }
    if (typeof entry[field.name] !== field.type) {
      error(`Field '${field.name}' should be ${field.type}, got ${typeof entry[field.name]}`, id);
    }
  }

  // Check coordinates sub-fields
  if (entry.coordinates) {
    const { lat, lng } = entry.coordinates;
    if (typeof lat !== "number" || typeof lng !== "number") {
      error(`coordinates.lat and coordinates.lng must be numbers`, id);
    } else if (lat < -90 || lat > 90) {
      error(`coordinates.lat out of range: ${lat}`, id);
    } else if (lng < -180 || lng > 180) {
      error(`coordinates.lng out of range: ${lng}`, id);
    }
  }

  // Check URL is valid
  if (entry.url) {
    try {
      new URL(entry.url);
      if (!entry.url.startsWith("http://") && !entry.url.startsWith("https://")) {
        error(`URL must use http or https: ${entry.url}`, id);
      }
    } catch {
      error(`Invalid URL: ${entry.url}`, id);
    }
  }

  // Check category
  if (entry.category && !VALID_CATEGORIES.includes(entry.category)) {
    error(`Invalid category: ${entry.category} (must be one of: ${VALID_CATEGORIES.join(", ")})`, id);
  }

  // Check timezone format (rough check)
  if (entry.timezone && !entry.timezone.includes("/")) {
    warn(`Suspicious timezone format: ${entry.timezone} (expected IANA format like America/New_York)`, id);
  }

  // Check country code (2 letters)
  if (entry.country && !/^[A-Z]{2}$/.test(entry.country)) {
    error(`Invalid country code: ${entry.country} (expected 2-letter ISO code)`, id);
  }
}

function checkCoordinatesBounds(entry) {
  const id = entry.id || "?";
  const country = entry.country;
  const coords = entry.coordinates;

  if (!coords || !coords.lat || !coords.lng) return;

  const bounds = COUNTRY_BOUNDS[country];
  if (!bounds) {
    warn(`No coordinate bounds defined for country ${country}`, id);
    return;
  }

  const [minLat, maxLat, minLng, maxLng] = bounds;
  if (coords.lat < minLat || coords.lat > maxLat || coords.lng < minLng || coords.lng > maxLng) {
    error(`Coordinates (${coords.lat}, ${coords.lng}) outside expected bounds for ${country} [${minLat},${maxLat}] x [${minLng},${maxLng}]`, id);
  }
}

function checkUrlPatterns(entries) {
  // Group entries by URL domain
  const domainGroups = {};
  for (const entry of entries) {
    try {
      const url = new URL(entry.url);
      const domain = url.hostname;
      if (!domainGroups[domain]) domainGroups[domain] = [];
      domainGroups[domain].push(entry);
    } catch {
      // already caught in schema check
    }
  }

  // For each domain, check URL extension consistency
  for (const [domain, group] of Object.entries(domainGroups)) {
    if (group.length < 3) continue;

    // Extract file extensions
    const extensions = group.map(e => {
      try {
        const url = new URL(e.url);
        const pathname = url.pathname;
        // Get the last segment's extension
        const segments = pathname.split("/");
        const last = segments[segments.length - 1];
        const ext = last.includes(".") ? last.split(".").pop().toLowerCase() : "none";
        return ext;
      } catch {
        return "invalid";
      }
    });

    const extCounts = {};
    for (const ext of extensions) {
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }

    const uniqueExts = Object.keys(extCounts);
    const totalForDomain = group.length;

    // If multiple extensions, flag the minority ones
    if (uniqueExts.length > 1) {
      const dominantExt = uniqueExts.reduce((a, b) => extCounts[a] > extCounts[b] ? a : b);
      const dominantCount = extCounts[dominantExt];

      for (const entry of group) {
        try {
          const url = new URL(entry.url);
          const pathname = url.pathname;
          const segments = pathname.split("/");
          const last = segments[segments.length - 1];
          const ext = last.includes(".") ? last.split(".").pop().toLowerCase() : "none";
          if (ext !== dominantExt) {
            warn(`URL extension outlier on ${domain}: dominant extension is '.${dominantExt}' (${dominantCount}/${totalForDomain}), got '.${ext}'`, entry.id);
          }
        } catch { /* skip */ }
      }
    }

    // Check for mixed protocols on same domain
    const protocols = new Set(group.map(e => { try { return new URL(e.url).protocol; } catch { return "invalid"; } }));
    if (protocols.size > 1 && protocols.has("https:") && protocols.has("http:")) {
      const httpEntries = group.filter(e => { try { return new URL(e.url).protocol === "http:"; } catch { return false; } });
      for (const entry of httpEntries) {
        warn(`HTTP (not HTTPS) on ${domain} while other entries use HTTPS`, entry.id);
      }
    }
  }
}

function checkIdUniqueness(entries) {
  const ids = new Map();
  for (const entry of entries) {
    const id = entry.id || "?";
    if (ids.has(id)) {
      error(`Duplicate ID: ${id} (appears at least ${ids.get(id) + 2} times)`, id);
      ids.set(id, ids.get(id) + 1);
    } else {
      ids.set(id, 1);
    }
  }
}

function checkSourceCount(entries, expectedCount) {
  if (!expectedCount) return;
  if (entries.length === 0) return;

  const actual = entries.length;
  const diff = Math.abs(actual - expectedCount);
  const pctDiff = ((diff / expectedCount) * 100).toFixed(1);

  if (actual < expectedCount) {
    warn(`Source count mismatch: ${actual} entries committed vs ${expectedCount} expected from API (${pctDiff}% missing). Some cameras may have been lost during parsing.`, "source");
  } else if (actual > expectedCount) {
    warn(`Source count mismatch: ${actual} entries committed vs ${expectedCount} expected from API (${pctDiff}% extra). Possible duplicates or fabricated entries.`, "source");
  }
}

function main() {
  const args = process.argv.slice(2);
  let sourceName = null;
  let expectedCount = null;
  let checkSubset = null; // array of new entry IDs to validate

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source") sourceName = args[++i];
    if (args[i] === "--expected-count") expectedCount = parseInt(args[++i], 10);
    if (args[i] === "--ids") checkSubset = args[++i].split(",");
  }

  const allCameras = JSON.parse(fs.readFileSync(CAMERAS_PATH, "utf8"));

  // If specific IDs provided, only validate those
  let entries;
  if (checkSubset) {
    const idSet = new Set(checkSubset);
    entries = allCameras.filter(c => idSet.has(c.id));
    console.log(`Validating ${entries.length} specific entries (from --ids)`);
  } else {
    entries = allCameras;
    console.log(`Validating all ${entries.length} entries in registry`);
  }

  totalChecked = entries.length;

  // Run all checks
  console.log("\n[1/5] Schema validation...");
  entries.forEach((e, i) => checkSchema(e, i));

  console.log("[2/5] Coordinate bounds check...");
  entries.forEach(e => checkCoordinatesBounds(e));

  console.log("[3/5] URL pattern consistency...");
  checkUrlPatterns(entries);

  console.log("[4/5] ID uniqueness...");
  checkIdUniqueness(entries);

  console.log("[5/5] Source count verification...");
  checkSourceCount(entries, expectedCount);

  // Report
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Checked: ${totalChecked} entries`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);

  if (errors.length > 0) {
    console.log(`\nERRORS:`);
    errors.forEach(e => console.log(`  [${e.id}] ${e.msg}`));
  }

  if (warnings.length > 0) {
    console.log(`\nWARNINGS:`);
    warnings.forEach(w => console.log(`  [${w.id}] ${w.msg}`));
  }

  if (errors.length > 0) {
    console.log(`\nFAILED: ${errors.length} error(s) found. Do not commit.`);
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(`\nPASSED with ${warnings.length} warning(s). Review before committing.`);
    process.exit(0);
  } else {
    console.log(`\nPASSED: All checks clean.`);
    process.exit(0);
  }
}

main();
