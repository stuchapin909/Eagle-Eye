#!/usr/bin/env node
/**
 * update-counts.js — Sync camera counts in README.md (marker-based table)
 *
 * Requires markers in README.md:
 *   <!-- COUNTRY_TABLE_START -->
 *   ... table rows ...
 *   <!-- COUNTRY_TABLE_END -->
 *   <!-- TOTAL_LINE_START --> ... <!-- TOTAL_LINE_END -->
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMERAS_PATH = path.join(__dirname, "cameras.json");
const README_PATH = path.join(__dirname, "README.md");
const STATS_PATH = path.join(__dirname, "stats.json");

const cameras = JSON.parse(fs.readFileSync(CAMERAS_PATH, "utf8"));

const countryCounts = {};
const categoryCounts = {};
for (const c of cameras) {
  const cc = c.country || "??";
  countryCounts[cc] = (countryCounts[cc] || 0) + 1;
  const cat = c.category || "other";
  categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
}

const total = cameras.length;
const countryNum = Object.keys(countryCounts).length;
const sorted = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]);

const COUNTRY_SOURCES = {
  US: "State DOTs, 511 feeds, and municipal traffic cameras",
  CA: "Ontario MTO, Alberta 511",
  HK: "Hong Kong Transport Department",
  ZA: "i-traffic (South Africa)",
  FI: "Digitraffic weather cameras (Fintraffic)",
  GB: "London TfL JamCams and other UK feeds",
  NZ: "NZTA nationwide highways",
  AU: "Queensland DOT and other AU feeds",
  BR: "CET São Paulo urban traffic",
  JP: "NEXCO East expressways",
  SG: "Singapore LTA",
  IE: "TII motorway cams (M50 Dublin)",
};

const MAJOR_MIN = 40;
const majorRows = sorted.filter(([cc, n]) => n >= MAJOR_MIN && cc !== "??");
const minorRows = sorted.filter(([cc, n]) => n < MAJOR_MIN || cc === "??");
const minorTotal = minorRows.reduce((s, [, n]) => s + n, 0);

function row(cc, n, sources) {
  return `| ${cc} | ${n.toLocaleString("en-US")} | ${sources} |`;
}

const tableLines = [
  "| Country | Count | Sources |",
  "|---|---|---|",
  ...majorRows.map(([cc, n]) => row(cc, n, COUNTRY_SOURCES[cc] || "Public / community sources")),
];
if (minorTotal > 0) {
  const codes = minorRows.map(([c]) => c).slice(0, 20).join(", ");
  tableLines.push(
    row(
      "other",
      minorTotal,
      `Smaller sources and incomplete country codes (${codes}${minorRows.length > 20 ? ", …" : ""})`
    )
  );
}
const tableBody = tableLines.join("\n");

const sortedCategories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
const stats = {
  total,
  countries: countryNum,
  categories: Object.keys(categoryCounts).length,
  by_country: Object.fromEntries(sorted),
  by_category: Object.fromEntries(sortedCategories),
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2) + "\n");
console.log(`Wrote stats.json (${total} cameras, ${countryNum} countries)`);

let readme = fs.readFileSync(README_PATH, "utf8");

const totalLine = `~${Math.round(total / 1000)}k cameras across ${countryNum} country codes (${total.toLocaleString("en-US")} in registry at last sync — counts refresh with the nightly validator):`;

if (readme.includes("<!-- TOTAL_LINE_START -->")) {
  readme = readme.replace(
    /<!-- TOTAL_LINE_START -->[\s\S]*?<!-- TOTAL_LINE_END -->/,
    `<!-- TOTAL_LINE_START -->\n${totalLine}\n<!-- TOTAL_LINE_END -->`
  );
} else {
  console.warn("WARNING: TOTAL_LINE markers missing in README.md");
}

if (readme.includes("<!-- COUNTRY_TABLE_START -->")) {
  readme = readme.replace(
    /<!-- COUNTRY_TABLE_START -->[\s\S]*?<!-- COUNTRY_TABLE_END -->/,
    `<!-- COUNTRY_TABLE_START -->\n${tableBody}\n<!-- COUNTRY_TABLE_END -->`
  );
} else {
  console.error("ERROR: COUNTRY_TABLE markers missing in README.md");
  process.exit(1);
}

fs.writeFileSync(README_PATH, readme);
console.log("Updated README.md country table");
console.log(`Done. ${total.toLocaleString("en-US")} cameras across ${countryNum} countries.`);
