#!/usr/bin/env node
/**
 * backfill-metadata.mjs — Source-derived metadata fills only (no fiction).
 *
 * Fills:
 *  - country from source catalog when source_id known and country missing
 *  - timezone for known source defaults (e.g. tfl → Europe/London) when missing
 *  - city regional defaults only when source policy provides them
 *  - strips (0,0) coordinates to null (invalid)
 *  - attaches source_id via prefix rules
 *  - writes completeness report JSON
 *
 * Does NOT reverse-geocode (requires network + ToS); does NOT invent cities.
 *
 * Usage: node scripts/backfill-metadata.mjs [--write]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { inferSourceId, assessCompleteness } from "../src/provenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const write = process.argv.includes("--write");

const catalog = JSON.parse(fs.readFileSync(path.join(root, "sources/catalog.json"), "utf8"));
const camerasPath = path.join(root, "cameras.json");
const cameras = JSON.parse(fs.readFileSync(camerasPath, "utf8"));

/** source_id → default timezone when all cameras share one zone */
const SOURCE_TZ = {
  "gb-tfl": "Europe/London",
  "hk-td": "Asia/Hong_Kong",
  "sg-lta": "Asia/Singapore",
  "fi-digitraffic": "Europe/Helsinki",
  "jp-nexco-east": "Asia/Tokyo",
  "ie-tii": "Europe/Dublin",
  "nz-nzta": "Pacific/Auckland",
  "au-qld-dot": "Australia/Brisbane",
  "br-cet-sp": "America/Sao_Paulo",
  "za-itraffic": "Africa/Johannesburg",
};

const report = {
  total: cameras.length,
  source_id_attached: 0,
  country_filled: 0,
  timezone_filled: 0,
  zero_coords_cleared: 0,
  unchanged: 0,
  by_method: {},
  remaining: { city: 0, country: 0, timezone: 0, coordinates: 0, verified_false: 0 },
};

function bump(method) {
  report.by_method[method] = (report.by_method[method] || 0) + 1;
}

for (const c of cameras) {
  let changed = false;

  // source_id
  if (!c.source_id) {
    const sid = inferSourceId(c.id);
    if (sid) {
      c.source_id = sid;
      report.source_id_attached++;
      bump("source_id:prefix");
      changed = true;
    }
  }

  const sid = c.source_id;
  const cat = sid ? catalog[sid] : null;

  // country from catalog
  if (!c.country && cat?.country) {
    c.country = cat.country;
    report.country_filled++;
    bump("country:catalog");
    changed = true;
  }

  // timezone from source defaults
  if (!c.timezone && sid && SOURCE_TZ[sid]) {
    c.timezone = SOURCE_TZ[sid];
    report.timezone_filled++;
    bump("timezone:source_default");
    changed = true;
  }

  // clear invalid 0,0 coords
  if (c.coordinates && c.coordinates.lat === 0 && c.coordinates.lng === 0) {
    delete c.coordinates;
    report.zero_coords_cleared++;
    bump("coordinates:clear_zero");
    changed = true;
  }

  // completeness annotation (always refresh)
  c.completeness = assessCompleteness(c);

  if (!changed) report.unchanged++;
}

for (const c of cameras) {
  if (!c.city) report.remaining.city++;
  if (!c.country) report.remaining.country++;
  if (!c.timezone) report.remaining.timezone++;
  if (!c.coordinates?.lat && !c.coordinates?.lng) report.remaining.coordinates++;
  if (c.verified === false) report.remaining.verified_false++;
}

const reportPath = path.join(root, "docs/backfill-report.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

if (write) {
  fs.writeFileSync(camerasPath, JSON.stringify(cameras, null, 2) + "\n");
  console.log("Wrote cameras.json");
} else {
  console.log("(dry run — pass --write to persist cameras.json)");
}
