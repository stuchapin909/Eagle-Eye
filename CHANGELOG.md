# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- `validate-registry.js`: magic-byte content-type fallback no longer throws (`const ct` → `let ct`), matching `server.js` (#51)
- `list_cameras`: stop embedding the full city-count map (~50KB) on every response; opt in with `include_aggregates` or use `cameras://stats` (#52)
- Redirect hops re-validated with `isSafeUrl` + DNS pin via shared `safeHttpGet` (server, validators, MJPEG path) (#55)
- Registry `auth` field normalized to boolean `false` or real `key_required` objects; empty/`null`/`{required:false}` removed (#54)
- `.registry-state.json` ghost keys pruned; merge-shards prunes on every nightly merge (#54)
- Snapshot responses include `city` and `coordinates` (parity with README examples)
- `update-counts.js` rewrites README country **table** via markers (was expecting bullet list → silent drift) (R6)

### Added
- Shared `VALID_CATEGORIES` includes specialty tags (`beach`, `volcano`, `ski_resort`, …) (#54)
- `normalizeAuth`, `safeHttpGet`, `validateRedirectTarget`, `buildPinnedLookup` in `src/security.js`
- **R1:** `registry-manifest.json` + checksum-verified bootstrap (`index.js`)
- **R2:** completeness policy, `completeness` on camera meta, `list_cameras` filter, `scripts/backfill-metadata.mjs`
- **R3:** geohash spatial index + inverted text index (`src/geo-index.js`) for nearby/search
- **R4:** expanded unit tests + `testdata/cameras.fixture.json` + CI `test.yml` + `scripts/bench-search.mjs`
- **R5:** issue/PR templates, CODE_OF_CONDUCT, topics (via PR notes)
- **R7:** `sources/catalog.json` + prefix `source_id` inference + provenance on tool meta
- **R8:** `docs/demo.md`, example MCP configs, `traffic-check` / `weather-check` prompts
- **R9:** per-host rate limit, `allow_insecure_http` config, SECURITY abuse path
- Unit tests for auth, redirects, geo-index, provenance, rate-limit

### Changed
- User-Agent identifies OpenEagleEye + project URL while remaining CDN-compatible
- Nightly validator also rebuilds `registry-manifest.json` + `stats.json`

### Documentation
- README MCP tool table documents all 13 tools plus `cameras://stats` and `discover-cameras` (#53)
- README country counts resynced from current `cameras.json`
- CONTRIBUTING: expanded categories, auth shape, completeness + provenance policy
- SECURITY: redirect re-validation, client identity, rate limit, checksum bootstrap

## [8.0.0] - 2026-03-31

### Added
- Expanded MCP surface: `get_snapshots`, `get_camera_info`, `nearby_cameras`, `explore_cameras`
- Parallel nightly validation shards with vision recheck
- Local camera layer (`add_local_camera` / `list_local` / `remove_local` / `submit_local`)
- Shared `src/security.js` SSRF + magic-byte checks with unit tests

### Notes
- Registry (`cameras.json`) is fetched at runtime from GitHub; not shipped in the npm tarball
- npm package name: `openeagleeye`

## [1.0.0] - 2026-03-30

Initial public release (then branded Open Public Cam) — MCP server over a curated public-camera registry.
