# Contributing to Open Eagle Eye

The most impactful contribution is new camera sources. This guide walks through the full process using a real example.

## Quick start: add a single camera

The fastest path uses the MCP tools directly:

1. `add_local_camera` with the URL, city, location, timezone, and optional coordinates
2. `get_snapshot` to verify it works
3. `submit_local` to share upstream (requires `gh` CLI)

Local cameras are usable immediately -- they don't need upstream approval.

## Adding a new source (bulk)

This is the process for integrating an entire camera network -- a city DOT, transport authority, weather service, etc. The example below follows the Queensland DOT integration.

### Step 1: Find a candidate source

Good places to look:
- City and state department of transport websites
- National traffic management centers
- Weather station networks
- Port and airport authorities
- Ski resort and national park webcams

**What works:** APIs that return direct JPEG or PNG image URLs. The URL itself must return an image on a plain HTTP GET.

**What doesn't work:**
- YouTube streams or video URLs
- Webcam aggregator page URLs (EarthCam, WebcamTaxi, SkylineWebcams)
- RTSP, HLS, or DASH streams
- Pages requiring JavaScript to load the image
- URLs behind CAPTCHAs, cookie consent, or authentication
- Feeds that require specific browser headers (Sec-Fetch-Dest) -- these break for programmatic access

### Step 2: Verify the images

```bash
# Must return 200 with image/jpeg or image/png
curl -s -o /tmp/test.jpg -w "%{http_code} %{content_type} %{size_download}" \
  -L --max-time 8 "https://example.com/camera/image.jpg"

# Verify it's live (file should change between fetches)
curl -s -o /tmp/test1.jpg "URL"
sleep 5
curl -s -o /tmp/test2.jpg "URL"
diff /tmp/test1.jpg /tmp/test2.jpg && echo "STATIC" || echo "LIVE"
```

Red flags:
- Content-type is `text/html` (probably an error page behind JS rendering)
- File size is suspiciously consistent across cameras (could be an offline placeholder -- some DOTs serve a branded PNG for dead cameras)
- Status 403 (WAF or authentication)
- Requires `Referer` or `Sec-Fetch-*` headers (CDN hotlink protection -- works for humans, breaks for agents)

### Step 3: Get the listing

You need a way to enumerate all cameras, not just find individual URLs. Common patterns:

**Pattern A: JSON API**
```bash
curl -s "https://api.example.com/cameras" | head
```

**Pattern B: DataTables (common for US state 511 sites)**
```bash
curl -s -X POST "https://www.example.com/List/GetData/Cameras" \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{"draw":1,"start":0,"length":100,"columns":[{"data":"sortOrder","name":"sortOrder"}]}'
```
Most cap at 100 per request -- paginate by incrementing `start`.

**Pattern C: GeoJSON**
```bash
curl -s "https://data.example.com/cameras.geojson" | head
```

**Pattern D: KML (XML)**
```bash
curl -s "https://www.example.com/cameras/kml.aspx" | head
```

**Pattern E: CSV**
```bash
curl -s "https://data.example.com/camera-locations.csv" | head
```

If the API paginates, check the total count first, then loop until you've fetched everything.

### Step 4: Parse and build entries

Each camera in `cameras.json` follows this schema:

```json
{
  "id": "qld-1-archerfield",
  "name": "Archerfield - Ipswich Motorway & Granard Rd - North",
  "url": "https://cameras.qldtraffic.qld.gov.au/Metropolitan/Archerfield_Ipswich_Mwy_sth.jpg",
  "country": "AU",
  "city": "Brisbane",
  "category": "highway",
  "location": "Archerfield, Queensland, Australia",
  "timezone": "Australia/Brisbane",
  "coordinates": { "lat": -27.555, "lng": 153.009 },
  "verified": true,
  "auth": false
}
```

**Required fields:** `id`, `name`, `url`, `country`, `city`, `location`, `timezone`, `coordinates`, `verified`, `auth`

**`id` format:** `{source_prefix}-{numeric_id}-{slug}`. Must be unique across the entire registry. Check existing IDs before choosing a prefix.

**`country`:** ISO 3166-1 alpha-2 code (US, CA, GB, AU, NZ, JP, SG, HK, FI, BR, IE, etc.)

**`category`:** One of: `city`, `park`, `highway`, `airport`, `port`, `weather`, `nature`, `landmark`, `other`, `beach`, `volcano`, `wildlife`, `aurora`, `ferry`, `dam`, `stadium`, `construction`, `ski_resort`, `traffic`

**`auth`:** Prefer boolean `false` when no API key is needed. If a key is required, use an object:

```json
{
  "key_required": true,
  "provider": "Example DOT",
  "signup_url": "https://example.com/signup",
  "key_type": "query_params",
  "key_names": ["api_key"],
  "config_key": "EXAMPLE_API_KEY"
}
```

Do not use empty objects `{}`, `null`, or `{ "required": false }` — those are normalized to `false`.

**`coordinates`:** Always nested as `{"lat": number, "lng": number}`. Never flat top-level fields.

### Common pitfalls

**GeoJSON coordinate order:** GeoJSON uses `[lng, lat]`. The registry uses `{lat, lng}`. Swap them.

**WKT coordinate format:** Some APIs store coords as `POINT (lng lat)` in a `wellKnownText` field. Parse with regex and swap.

**Pagination wraparound:** Some APIs return results from the beginning when you paginate past the total. Stop when `start >= recordsTotal`, not when `data` is empty.

**Offline placeholders:** Some DOTs serve a branded PNG for dead cameras (same file size for every offline camera). The nightly validator catches these, but avoid adding known-offline cameras in the first place.

**Control characters in JSON:** Some APIs return null bytes or carriage returns in JSON responses. Strip with `raw.replace(b'\x00', b'').replace(b'\r', b'')` before parsing.

**Content-type lies:** Some CDNs return `application/octet-stream` or `binary/octet-stream` for valid JPEGs. The server's magic byte detection handles this, but be aware when testing with curl.

**City consolidation:** If a source covers many small towns with 1-2 cameras each, consolidate them into a region name (e.g., "Regional Queensland" instead of 100 individual towns). Keep the real town in the `location` field.

**Null coordinates:** Exclude cameras with null, zero, or missing GPS coordinates. `POINT (0 0)` is not valid.

### Step 5: Validate before submitting

Test at least 3-5 cameras from different parts of the source:
- Different cities/regions
- Different image URL patterns (if the source has multiple)
- One from the beginning, middle, and end of the listing

```bash
# Quick validation script
for url in "URL1" "URL2" "URL3"; do
  result=$(curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}" \
    -L --max-time 8 "$url")
  echo "$url -> $result"
done
```

### Step 6: Submit

**Option A: Pull request** (recommended for bulk additions)
1. Fork the repo
2. Add entries to `cameras.json` (append to the array, deduplicate by ID)
3. Commit and push
4. Open a PR
5. The GitHub Action validates all new entries and comments on the PR

**Option B: GitHub issue** (for small additions or first-time contributors)
1. Use `submit_local` if you have `gh` CLI set up
2. Or open a manual issue with camera details (URL, city, country, coordinates)
3. A maintainer will validate and add them

### What happens after you submit

The GitHub Action runs on every push:
- Validates schema for all new entries
- Verifies each URL returns a valid image (HTTP status, content-type, magic bytes)
- Uses vision AI to confirm images show real webcam feeds (not error pages, ads, or logos)
- Rejects invalid entries and comments on PRs with details
- On merge, the nightly validator takes over long-term health monitoring

## Source research notes

The `sources/` directory contains per-source API documentation for every camera source in the registry. Each file covers the API endpoint, pagination, coordinate format, image URL pattern, and known pitfalls. These are the best reference for understanding how a source works before integrating it.

## Code contributions

Bug fixes, improvements, and new features welcome. Open an issue first if the change is substantial.

## License

Contributions are licensed under MIT. By submitting a PR you agree to license your changes under the same terms.
