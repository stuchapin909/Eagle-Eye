import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  encodeGeohash,
  buildCameraIndexes,
  queryNearby,
  querySearch,
  haversineKm,
} from "./geo-index.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "testdata/cameras.fixture.json"), "utf8")
);

describe("geo-index", () => {
  it("encodes a known geohash", () => {
    // ~ Times Square
    const h = encodeGeohash(40.758, -73.985, 5);
    assert.equal(typeof h, "string");
    assert.equal(h.length, 5);
  });

  it("nearby results are within radius and sorted", () => {
    const idx = buildCameraIndexes(fixture);
    const withCoords = fixture.filter((c) => c.coordinates?.lat != null);
    assert.ok(withCoords.length > 0);
    const origin = withCoords[0].coordinates;
    const hits = queryNearby(idx, fixture, origin.lat, origin.lng, 500, 10);
    assert.ok(hits.length >= 1);
    let prev = -1;
    for (const h of hits) {
      assert.ok(h.distance_km <= 500);
      assert.ok(h.distance_km >= prev - 1e-9);
      prev = h.distance_km;
    }
  });

  it("nearby ⊆ brute-force haversine set", () => {
    const idx = buildCameraIndexes(fixture);
    const origin = fixture.find((c) => c.coordinates?.lat)?.coordinates;
    if (!origin) return;
    const r = 200;
    const hits = queryNearby(idx, fixture, origin.lat, origin.lng, r, 50);
    for (const h of hits) {
      const c = fixture[h.index];
      const d = haversineKm(origin.lat, origin.lng, c.coordinates.lat, c.coordinates.lng);
      assert.ok(d <= r + 0.01, `distance ${d} > ${r}`);
    }
  });

  it("search finds tokens from name/city", () => {
    const idx = buildCameraIndexes(fixture);
    const sample = fixture.find((c) => c.city);
    if (!sample) return;
    const hits = querySearch(idx, fixture, sample.city, 20);
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => fixture[h.index].city === sample.city));
  });
});
