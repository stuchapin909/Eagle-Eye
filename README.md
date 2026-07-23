# Open Eagle Eye

[![npm version](https://img.shields.io/npm/v/openeagleeye)](https://www.npmjs.com/package/openeagleeye)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

MCP server that gives AI agents instant access to public camera feeds worldwide. One HTTP GET, sub-second captures, no browser automation, no stream decoding.

## Why

Most camera APIs require authentication, serve video streams, or hide images behind JavaScript rendering. Open Eagle Eye only indexes cameras that return a JPEG or PNG on a plain HTTP GET — the simplest possible integration. Agents don't need to render pages or decode video. They just fetch an image.

The registry is self-healing. A GitHub Action runs nightly, checks every camera, retries failures before removing them, and uses vision AI to catch cameras that return error pages instead of live feeds. Dead cameras get flagged automatically.

## Quick start

```json
{
  "mcpServers": {
    "openeagleeye": {
      "command": "npx",
      "args": ["-y", "openeagleeye"]
    }
  }
}
```

Or install globally:

```bash
npm install -g openeagleeye
openeagleeye
```

On first run, the server fetches the latest camera registry from GitHub and caches it locally in `~/.openeagleeye/`. Subsequent starts refresh the cache automatically.

## How it works

A valid camera URL is any endpoint that returns a JPEG or PNG on a plain HTTP GET. Most city traffic cameras, weather stations, and park cams expose exactly this. The server fetches the image, saves it to disk, and returns the file path.

## MCP Tools

| Tool | Description |
|---|---|
| `get_snapshot` | Fetch a live image from a camera — saves to disk, returns file path |
| `get_snapshots` | Fetch live images from up to 5 cameras in one call |
| `list_cameras` | Browse the registry with filters (city, country, location, category) and pagination |
| `search_cameras` | Search by name, city, country, location, or category |
| `get_camera_info` | Look up full metadata for one camera by ID (no snapshot) |
| `nearby_cameras` | Find cameras within a radius of a lat/lng, sorted by distance |
| `explore_cameras` | Return a random sample for discovery (optional city/country/category filter) |
| `add_local_camera` | Add a camera to your local collection |
| `list_local` | Show your locally-added cameras |
| `remove_local` | Delete a locally-added camera |
| `submit_local` | Share local cameras upstream via GitHub issue |
| `report_camera` | Report a broken or low-quality camera |
| `check_config` | Show API key configuration status |

**Resource:** `cameras://stats` — registry totals, health counts, countries, categories, top cities.  
**Prompt:** `discover-cameras` — guided workflow for finding and adding public sources.

`list_cameras` omits the full city-count map by default (keeps agent context small). Pass `include_aggregates: true` if you need it, or read `cameras://stats`.

### Upstream vs local cameras

The registry has two layers:

- **Upstream** — the global registry fetched from GitHub on every server start. These are the ~32,000 validated public cameras.
- **Local** — cameras you add yourself via `add_local_camera`. They persist in `~/.openeagleeye/local-cameras.json`, survive restarts, and appear in `list_cameras`/`search_cameras` with `source: "local"`. Share them upstream anytime with `submit_local`.

### Filtering

Every camera has a `city` field. Use `list_cameras` with `city: "Sydney"` to get a short, focused list instead of dumping all cameras into context.

### Output format

Every tool returns structured JSON. Snapshots save to disk and return the file path — the MCP server runs as a local subprocess, so the agent has filesystem access.

**Snapshot response:**
```json
{
  "success": true,
  "file_path": "/home/user/.openeagleeye/snapshots/a1b2c3d4e5f6a7b8.jpg",
  "size_bytes": 14579,
  "content_type": "image/jpeg",
  "camera": {
    "id": "nyc-bb-21-north-rdwy-at-above-south-st",
    "name": "BB-21 North Rdwy @ Above South St",
    "city": "New York",
    "location": "Manhattan, New York, USA",
    "coordinates": { "lat": 40.708, "lng": -73.999 }
  }
}
```

## Registry

<!-- TOTAL_LINE_START -->
~32k cameras across 41 country codes (32,028 in registry at last sync — counts refresh with the nightly validator):
<!-- TOTAL_LINE_END -->

![Global Coverage](docs/coverage-map.svg)

<!-- COUNTRY_TABLE_START -->
| Country | Count | Sources |
|---|---|---|
| US | 26,574 | State DOTs, 511 feeds, and municipal traffic cameras |
| CA | 1,283 | Ontario MTO, Alberta 511 |
| HK | 994 | Hong Kong Transport Department |
| ZA | 843 | i-traffic (South Africa) |
| FI | 611 | Digitraffic weather cameras (Fintraffic) |
| GB | 559 | London TfL JamCams and other UK feeds |
| NZ | 251 | NZTA nationwide highways |
| AU | 248 | Queensland DOT and other AU feeds |
| BR | 178 | CET São Paulo urban traffic |
| JP | 105 | NEXCO East expressways |
| SG | 90 | Singapore LTA |
| IE | 49 | TII motorway cams (M50 Dublin) |
| other | 243 | Smaller sources and incomplete country codes (??, ES, CH, IT, NO, DE, RU, FR, MT, SE, XX, TW, CW, MX, TH, NL, PT, AT, KE, ZM, …) |
<!-- COUNTRY_TABLE_END -->

Every camera has `country`, `city`, `location`, `timezone`, and `coordinates` (lat/lng) when the source provides them.

### Self-healing

A GitHub Action runs nightly at 3 AM UTC:
- Checks cameras not validated in the last 7 days, plus any flagged as suspect
- First failure marks as suspect, second consecutive failure removes and opens a GitHub issue
- Vision AI (GPT-4o-mini via GitHub Models) catches cameras returning error pages
- Suspect cameras that recover are cleared automatically

### Security

- **SSRF protection** — blocks private IPs, cloud metadata endpoints, non-HTTP protocols, and DNS rebinding
- **Content-type whitelist** — only `image/jpeg` and `image/png` accepted
- **Magic byte detection** — validates JPEG/PNG by file header when CDN returns wrong content-type
- **Push/PR cap** — max 500 cameras per push to prevent DoS via oversized PRs
- **Random filenames** — snapshots use random hex filenames, no camera ID in the path

## API Keys (optional)

Most cameras work out of the box. Some require a free API key. If a snapshot fails with a key error, the response tells you where to sign up and how to configure it.

Create `~/.openeagleeye/config.json`:

```json
{
  "api_keys": {
    "PROVIDER_API_KEY": "your-key-here"
  }
}
```

Use `check_config` to see which cameras need keys and whether yours are set.

## Adding cameras

1. Find a direct-image URL (must return `image/jpeg` or `image/png` on plain GET)
2. `add_local_camera` with the URL, city, location, timezone, and optional coordinates
3. `get_snapshot` to test it
4. `submit_local` to share upstream — requires the `gh` CLI (`gh auth login`)

Local cameras work immediately and don't need upstream approval to be useful.

Good sources: city DOTs, weather stations, ski resorts, national parks, ports, airports.

## File layout

All runtime data lives in `~/.openeagleeye/`:

```
~/.openeagleeye/
  cameras.json          # Upstream registry (fetched from GitHub on boot)
  local-cameras.json    # Your locally-added cameras
  .registry-state.json  # Validation state (active/suspect/offline)
  snapshots/            # Downloaded camera images
  config.json           # API keys
```

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on adding camera sources.

## Why this exists

See [WHY.md](WHY.md) for the reasoning behind the project's design decisions, how it compares to other camera services, and why agent-native and self-healing matter.

## Privacy & security

See [SECURITY.md](SECURITY.md) for answers to common questions about surveillance, data collection, private cameras, and the security architecture.

## License

MIT
