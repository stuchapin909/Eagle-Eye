#!/usr/bin/env node
/**
 * build-registry-manifest.js — Write registry-manifest.json from cameras.json
 *
 * Usage: node scripts/build-registry-manifest.js
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const camerasPath = path.join(root, "cameras.json");
const outPath = path.join(root, "registry-manifest.json");

const raw = fs.readFileSync(camerasPath);
const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
const cameras = JSON.parse(raw.toString("utf8"));
if (!Array.isArray(cameras)) {
  console.error("cameras.json is not an array");
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || "stuchapin909/Open-Eagle-Eye";
const branch = process.env.GITHUB_REF_NAME || "master";

const manifest = {
  schema_version: 1,
  artifact: "cameras.json",
  content_sha256: sha256,
  byte_size: raw.length,
  camera_count: cameras.length,
  generated_at: new Date().toISOString(),
  // Primary: raw GitHub (current). Release asset URL can override after R1 publish lands.
  download_url: `https://raw.githubusercontent.com/${repo}/${branch}/cameras.json`,
  download_url_fallback: `https://media.githubusercontent.com/media/${repo}/${branch}/cameras.json`,
};

fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Wrote registry-manifest.json: ${cameras.length} cameras, sha256=${sha256.slice(0, 12)}…, ${raw.length} bytes`
);
