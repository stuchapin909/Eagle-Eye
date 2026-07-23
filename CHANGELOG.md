# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- `validate-registry.js`: magic-byte content-type fallback no longer throws (`const ct` → `let ct`), matching `server.js` (#51)
- `list_cameras`: stop embedding the full city-count map (~50KB) on every response; opt in with `include_aggregates` or use `cameras://stats` (#52)

### Documentation
- README MCP tool table documents all 13 tools plus `cameras://stats` and `discover-cameras` (#53)
- README country counts resynced from current `cameras.json`

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
