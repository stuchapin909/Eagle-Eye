import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferSourceId, assessCompleteness, attachProvenance } from "./provenance.js";

describe("provenance", () => {
  it("infers tfl and fl prefixes", () => {
    assert.equal(inferSourceId("tfl-00001.09731"), "gb-tfl");
    assert.equal(inferSourceId("fl-1-0517n-75-alligator-alley-m052"), "us-florida-fdot");
  });

  it("assesses completeness levels", () => {
    const full = assessCompleteness({
      city: "London",
      country: "GB",
      timezone: "Europe/London",
      coordinates: { lat: 51.5, lng: -0.1 },
    });
    assert.equal(full.level, "full");
    assert.deepEqual(full.missing, []);

    const partial = assessCompleteness({
      city: "X",
      country: "US",
      timezone: null,
      coordinates: { lat: 1, lng: 2 },
    });
    assert.equal(partial.level, "partial");
    assert.ok(partial.missing.includes("timezone"));
  });

  it("attachProvenance uses catalog", () => {
    const p = attachProvenance(
      { id: "tfl-1" },
      { "gb-tfl": { operator: "TfL", terms_url: "https://example.com" } }
    );
    assert.equal(p.source_id, "gb-tfl");
    assert.equal(p.operator, "TfL");
  });
});
