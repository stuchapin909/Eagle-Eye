# Privacy & Security

## Is this surveillance?

No. Open Eagle Eye only indexes camera feeds that are already publicly accessible. Every camera in the registry is operated by a government agency, transport authority, or organization that has chosen to make the feed publicly available on the internet. We don't operate any cameras. We don't host any camera infrastructure. We maintain a directory of public feeds.

## Can I view private cameras?

No. The server has multiple layers of protection:

- **SSRF blocking** -- Private IP addresses (10.x, 172.16-31.x, 192.168.x, 127.x), cloud metadata endpoints (AWS, GCP), and non-HTTP protocols are rejected
- **DNS rebinding protection** -- IP addresses are resolved once and pinned for the actual request, preventing a hostname from resolving to a private IP on the second lookup
- **Content validation** -- Only `image/jpeg` and `image/png` are accepted, verified by both content-type header and file magic bytes
- **Vision AI screening** -- On push events, GPT-4o-mini analyzes submitted images to confirm they show real webcam feeds, not error pages, ads, or logos

## Can the server access my webcam?

No. The MCP server runs as a local subprocess on your machine. It has no access to your hardware, microphone, or webcam. It only makes outbound HTTP requests to the camera URLs in the registry.

## Do cameras have audio?

No. The registry only contains still image feeds (JPEG and PNG). We deliberately exclude audio because capturing audio from public spaces raises privacy concerns that still images don't.

## How do you know feeds are public?

Three ways:

1. **Source verification** -- Each camera source is researched and documented (see `sources/` directory). We verify that the operating agency intends the feed to be public.
2. **Nightly validation** -- Every camera is checked daily. If a URL starts requiring authentication, returning error pages, or serving private content, it gets flagged and eventually removed.
3. **Community reporting** -- Anyone can use the `report_camera` tool to flag a camera that shouldn't be in the registry.

## What data does the server collect?

The server doesn't collect any data. It runs locally on your machine. It makes HTTP requests to camera URLs and saves images to `~/.openeagleeye/snapshots/`. No telemetry, no analytics, no phone-home. The source code is open -- you can verify this yourself.

## What about the GitHub-hosted registry?

The `cameras.json` file on GitHub contains camera metadata: IDs, names, URLs, cities, coordinates, categories. No personal data. No user data. No images. Anyone can download it -- it's a public repository.

The GitHub Actions validator that runs nightly fetches camera URLs to check they're alive. These are the same public URLs that anyone on the internet can access. No private networks are accessed.

## Can someone track which cameras I'm viewing?

If you're running the MCP server locally, no. The server makes requests from your IP address directly to the camera source. Nothing routes through our infrastructure because there is no central infrastructure -- it's a local tool that reads a public JSON file.

The camera sources themselves (DOTs, transport authorities) may log requests from your IP. This is the same as visiting their website directly. We have no control over their logging.

## Who can add cameras to the registry?

Anyone can add cameras to their local collection using `add_local_camera`. Sharing cameras upstream requires a pull request or a GitHub issue, both of which are publicly visible and reviewed. The GitHub Action validates all new entries before they're merged.

## What if I find a camera that shouldn't be here?

Use the `report_camera` tool with status `broken_link` (URL doesn't work) or `low_quality` (camera shows something inappropriate). Reports create a public GitHub issue. Local cameras reported as broken are automatically removed.

## How are offline/dead cameras handled?

The nightly validator checks every camera. A camera that fails once gets marked as "suspect" and is given another chance the next night. A camera that fails twice in a row is removed from the registry. Cameras that recover are cleared automatically. This two-strike system prevents temporary outages from removing working cameras.

## Security architecture

For developers and security reviewers:

| Layer | Mechanism |
|---|---|
| Private IP blocking | 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, ULA, CGN, link-local |
| Cloud metadata blocking | AWS 169.254.169.254, GCP metadata.google.internal |
| Protocol restriction | HTTP and HTTPS only |
| DNS rebinding protection | Resolve-then-pin IP addresses across security check and fetch (per hop) |
| Content-type whitelist | Only `image/jpeg` and `image/png` |
| Magic byte validation | JPEG `FF D8 FF`, PNG `89 50 4E 47` |
| Response size limit | 5MB max per snapshot |
| Redirect limit | At most one hop; **each hop re-runs `isSafeUrl` + DNS pin** before follow (no blind axios auto-redirect) |
| Client identity | User-Agent identifies OpenEagleEye + project URL (operators can recognize us in logs) |
| Registry integrity | Bootstrap verifies `registry-manifest.json` sha256 before accepting cameras.json |
| Per-host rate limit | Token bucket on snapshot fetches (configurable in `~/.openeagleeye/config.json`) |
| Plain HTTP | Default allowed; set `allow_insecure_http: false` to require HTTPS |

## Reporting a feed that should not be listed

Use the `report_camera` tool or open a GitHub issue with label context. For sensitive cases, use [GitHub Security Advisories](https://github.com/stuchapin909/Open-Eagle-Eye/security/advisories/new). We only index feeds that are already public; we will remove entries that are private, non-consensual, or mis-classified.
| Snapshot filenames | Random hex (8 bytes), no camera ID in path |

The security implementation is in `src/security.js` and is shared between the server and the validator to prevent code drift.
