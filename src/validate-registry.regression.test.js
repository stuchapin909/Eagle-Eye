/**
 * Regression guards for validate-registry.js
 * Run: node --test src/validate-registry.regression.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectImageType } from "./security.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("validate-registry magic-byte path (#51)", () => {
  it("declares content-type with let so reassignment is legal", () => {
    const src = fs.readFileSync(path.join(root, "validate-registry.js"), "utf8");
    // Must use let (not const) before any `ct = detected` reassignment
    assert.match(src, /let ct = /);
    assert.doesNotMatch(
      src,
      /const ct = [\s\S]{0,300}ct = detected/
    );
  });

  it("uses safeHttpGet so redirect hops are re-validated (#55)", () => {
    const src = fs.readFileSync(path.join(root, "validate-registry.js"), "utf8");
    assert.match(src, /safeHttpGet/);
    // No blind axios auto-redirect on camera URLs
    assert.doesNotMatch(src, /axios\.get\([^)]*maxRedirects:\s*1/);
  });

  it("detectImageType recognizes JPEG when CDN content-type would lie", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.equal(detectImageType(jpeg), "image/jpeg");
  });
});
