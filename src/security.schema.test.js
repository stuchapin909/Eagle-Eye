/**
 * Schema + redirect helpers for security.js
 * Run: node --test src/security.schema.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAuth,
  resolveRedirectUrl,
  VALID_CATEGORIES,
  isSafeUrl,
  detectImageType,
  buildPinnedLookup,
} from "./security.js";

describe("normalizeAuth (#54)", () => {
  it("maps false/null/undefined to false", () => {
    assert.equal(normalizeAuth(false), false);
    assert.equal(normalizeAuth(null), false);
    assert.equal(normalizeAuth(undefined), false);
  });

  it("maps empty object and {required:false} to false", () => {
    assert.equal(normalizeAuth({}), false);
    assert.equal(normalizeAuth({ required: false }), false);
  });

  it("keeps real key_required objects", () => {
    const out = normalizeAuth({
      key_required: true,
      provider: "TfL",
      signup_url: "https://example.com",
      key_type: "query_params",
      key_names: ["app_key"],
      config_key: "TFL_KEY",
    });
    assert.equal(out.key_required, true);
    assert.equal(out.provider, "TfL");
    assert.equal(out.config_key, "TFL_KEY");
  });

  it("maps boolean true without config to false", () => {
    assert.equal(normalizeAuth(true), false);
  });
});

describe("resolveRedirectUrl (#55)", () => {
  it("resolves absolute locations", () => {
    assert.equal(
      resolveRedirectUrl("https://a.example/cam.jpg", "https://cdn.example/x.jpg"),
      "https://cdn.example/x.jpg"
    );
  });

  it("resolves relative locations", () => {
    assert.equal(
      resolveRedirectUrl("https://a.example/path/cam", "/img/x.jpg"),
      "https://a.example/img/x.jpg"
    );
  });

  it("returns null for bad location", () => {
    assert.equal(resolveRedirectUrl("https://a.example/", null), null);
  });
});

describe("isSafeUrl blocks private redirect targets", () => {
  it("blocks metadata IP", async () => {
    const r = await isSafeUrl("http://169.254.169.254/latest/meta-data/");
    assert.equal(r.safe, false);
  });

  it("blocks loopback", async () => {
    const r = await isSafeUrl("http://127.0.0.1/cam.jpg");
    assert.equal(r.safe, false);
  });
});

describe("VALID_CATEGORIES includes specialty tags", () => {
  it("includes beach, volcano, ski_resort", () => {
    assert.ok(VALID_CATEGORIES.includes("beach"));
    assert.ok(VALID_CATEGORIES.includes("volcano"));
    assert.ok(VALID_CATEGORIES.includes("ski_resort"));
    assert.ok(VALID_CATEGORIES.includes("highway"));
  });
});

describe("detectImageType", () => {
  it("jpeg magic", () => {
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  });
});

describe("buildPinnedLookup (#55)", () => {
  it("supports Node opts.all callback shape", async () => {
    const lookup = buildPinnedLookup(["1.2.3.4", "2001:db8::1"]);
    const list = await new Promise((resolve, reject) => {
      lookup("example.com", { all: true, family: 0 }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
    assert.ok(Array.isArray(list));
    assert.equal(list[0].address, "1.2.3.4");
    assert.equal(list[0].family, 4);
  });

  it("supports classic (err, address, family) callback", async () => {
    const lookup = buildPinnedLookup(["8.8.8.8"]);
    const result = await new Promise((resolve, reject) => {
      lookup("example.com", { family: 4 }, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
    assert.equal(result.address, "8.8.8.8");
    assert.equal(result.family, 4);
  });
});
