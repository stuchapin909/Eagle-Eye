/**
 * provenance.js — source_id inference from camera id prefixes + catalog.
 */

/** Prefix → source_id (longest match wins). Keep in sync with sources/catalog.yaml */
export const SOURCE_PREFIX_RULES = [
  ["tfl-", "gb-tfl"],
  ["nyc-", "us-nyc-dot"],
  ["ny-", "us-ny-511"],
  ["fl-", "us-florida-fdot"],
  ["ga-", "us-georgia-511"],
  ["cwwp2-", "us-caltrans"],
  ["caltrans-", "us-caltrans"],
  ["cdot-", "us-colorado-cdot"],
  ["vdot-", "us-virginia-vdot"],
  ["wsdot-", "us-washington-wsdot"],
  ["ncdot-", "us-north-carolina"],
  ["penndot-", "us-pennsylvania"],
  ["adot-", "us-arizona-adot"],
  ["odot-", "us-oregon-odot"],
  ["ndot-", "us-nevada-ndot"],
  ["udot-", "us-utah-udot"],
  ["wisdot-", "us-wisconsin"],
  ["ladotd-", "us-louisiana"],
  ["modot-", "us-missouri"],
  ["us-tx-houston-", "us-houston-transtar"],
  ["us-minnesota-", "us-minnesota-mndot"],
  ["us-ohio-", "us-ohio-its"],
  ["qld-", "au-qld-dot"],
  ["nzta-", "nz-nzta"],
  ["hk-", "hk-td"],
  ["fi-", "fi-digitraffic"],
  ["digitraffic-", "fi-digitraffic"],
  ["mto-", "ca-ontario-mto"],
  ["511on-", "ca-ontario-mto"],
  ["ab-", "ca-alberta-511"],
  ["lta-", "sg-lta"],
  ["nexco-", "jp-nexco-east"],
  ["tii-", "ie-tii"],
  ["cet-", "br-cet-sp"],
  ["za-", "za-itraffic"],
  ["i-traffic-", "za-itraffic"],
];

/**
 * Infer source_id from camera id using longest matching prefix.
 */
export function inferSourceId(cameraId) {
  if (!cameraId || typeof cameraId !== "string") return null;
  const id = cameraId.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const [prefix, sourceId] of SOURCE_PREFIX_RULES) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = sourceId;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Attach source_id (and optional catalog fields) onto a camera meta object.
 */
export function attachProvenance(cam, catalog = null) {
  const source_id = cam.source_id || inferSourceId(cam.id);
  const out = { source_id: source_id || null };
  if (source_id && catalog && catalog[source_id]) {
    const e = catalog[source_id];
    out.operator = e.operator || null;
    out.terms_url = e.terms_url || null;
    out.license_note = e.license_note || null;
  }
  return out;
}

/**
 * Completeness assessment for a camera entry.
 */
export function assessCompleteness(cam) {
  const missing = [];
  if (!cam.city) missing.push("city");
  if (!cam.country) missing.push("country");
  if (!cam.timezone) missing.push("timezone");
  if (
    cam.coordinates?.lat == null ||
    cam.coordinates?.lng == null ||
    (cam.coordinates.lat === 0 && cam.coordinates.lng === 0)
  ) {
    missing.push("coordinates");
  }
  let level = "full";
  if (missing.length === 0) level = "full";
  else if (missing.length <= 2) level = "partial";
  else level = "minimal";
  return { level, missing };
}
