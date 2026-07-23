#!/usr/bin/env node
import fs from "fs";
import { buildCameraIndexes, queryNearby, querySearch, haversineKm } from "../src/geo-index.js";

const cameras = JSON.parse(fs.readFileSync(new URL("../cameras.json", import.meta.url)));
const t0 = performance.now();
const idx = buildCameraIndexes(cameras);
const buildMs = performance.now() - t0;

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const nearbyTimes = [];
const searchTimes = [];
for (let i = 0; i < 100; i++) {
  const c = cameras[Math.floor(Math.random() * cameras.length)];
  const lat = c.coordinates?.lat ?? 40.7;
  const lng = c.coordinates?.lng ?? -74.0;
  const a = performance.now();
  queryNearby(idx, cameras, lat, lng, 25, 10);
  nearbyTimes.push(performance.now() - a);
  const b = performance.now();
  querySearch(idx, cameras, c.city || c.name?.split(" ")[0] || "london", 20);
  searchTimes.push(performance.now() - b);
}

// correctness sample: nearby ⊆ brute force
let ok = 0, fail = 0;
for (let i = 0; i < 20; i++) {
  const c = cameras.find(x => x.coordinates?.lat);
  if (!c) break;
  const lat = c.coordinates.lat, lng = c.coordinates.lng, r = 15;
  const hits = queryNearby(idx, cameras, lat, lng, r, 50);
  const brute = new Set();
  for (let j = 0; j < cameras.length; j++) {
    const cam = cameras[j];
    if (!cam.coordinates?.lat) continue;
    if (haversineKm(lat, lng, cam.coordinates.lat, cam.coordinates.lng) <= r) brute.add(cameras[j].id);
  }
  const allIn = hits.every(h => brute.has(cameras[h.index].id));
  if (allIn) ok++; else fail++;
}

console.log(JSON.stringify({
  cameras: cameras.length,
  build_ms: Math.round(buildMs),
  nearby_p50_ms: +pct(nearbyTimes, 50).toFixed(3),
  nearby_p95_ms: +pct(nearbyTimes, 95).toFixed(3),
  search_p50_ms: +pct(searchTimes, 50).toFixed(3),
  search_p95_ms: +pct(searchTimes, 95).toFixed(3),
  correctness_ok: ok,
  correctness_fail: fail,
}, null, 2));
