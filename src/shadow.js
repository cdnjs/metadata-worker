// Shadow comparison against the legacy speedcdnjs origin.
//
// Origin is per-environment via the SHADOW_ORIGIN var on env
// (e.g. https://metadata.speedcdnjs.com for production,
//  https://metadata-staging.speedcdnjs.com for staging).
//
// Goal: confirm the new KV-backed worker returns the same data as the
// existing speedcdnjs origin, without affecting the user response.
//
// Each unique path is compared at most once:
//   - matches go into the Cache API with a 24h TTL
//   - mismatches go into D1 (env.SHADOW_DB) and stay there until manually cleared
//
// All work runs in ctx.waitUntil so user latency is unaffected.

const CHECKED_CACHE_BASE = "https://shadow-checked.internal";
const CHECKED_TTL_SECONDS = 24 * 60 * 60; // 24h
// Above this size, skip JSON.parse + deep-equal and just byte-compare.
// SRIs are flat maps populated by iterating KV in lexicographic order, so
// byte order is stable; deep-equal is only useful for small endpoints whose
// JSON key ordering might differ between sources.
const BYTE_COMPARE_THRESHOLD = 500 * 1024; // 500 KB

// Classify a pathname into a coarse endpoint type for grouping.
function classify(pathname) {
  if (pathname === "/packages") return "packages";
  if (/^\/packages\/[^/]+$/.test(pathname)) return "package";
  if (/^\/packages\/[^/]+\/all$/.test(pathname)) return "aggregated";
  if (/^\/packages\/[^/]+\/versions$/.test(pathname)) return "versions";
  if (/^\/packages\/[^/]+\/versions\/[^/]+$/.test(pathname)) return "version";
  if (/^\/packages\/[^/]+\/sris(\/[^/]+)?$/.test(pathname)) return "sris";
  return "other";
}

function sampleRate(env) {
  // SHADOW_SAMPLE_RATE is provided as a string var. Default to 0 (off) if missing
  // or malformed so a misconfigured deploy can't accidentally double traffic.
  try {
    const v = parseFloat(env.SHADOW_SAMPLE_RATE ?? "0");
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v > 1 ? 1 : v;
  } catch {
    return 0;
  }
}

function shadowEnabled(env) {
  // D1 binding must exist, otherwise we silently no-op.
  return env && env.SHADOW_DB != null;
}

// Return the origin to shadow-compare against, or null if not configured.
// Configured per environment via the SHADOW_ORIGIN var.
function shadowOrigin(env) {
  const origin = env && env.SHADOW_ORIGIN;
  if (!origin) return null;
  // Strip a trailing slash so we can concatenate the pathname directly.
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

// Compare two responses. Returns one of:
//   { match: true,  statusNew, statusOld }
//   { match: false, statusNew, statusOld, diffKind: "status"|"body"|"missing_new"|"missing_old" }
//   { skip: true }   // origin error or other unverifiable state
async function compare(newResp, oldResp, endpointType) {
  const statusNew = newResp.status;
  const statusOld = oldResp.status;

  // Origin error: we can't trust the comparison, leave path uncached so we
  // try again on the next request.
  if (statusOld >= 500) return { skip: true };

  // Missing on one side only.
  if (statusNew === 404 && statusOld === 200) {
    return { match: false, statusNew, statusOld, diffKind: "missing_new" };
  }
  if (statusNew === 200 && statusOld === 404) {
    return { match: false, statusNew, statusOld, diffKind: "missing_old" };
  }

  // Status disagreement that isn't a missing-vs-present case.
  if (statusNew !== statusOld) {
    return { match: false, statusNew, statusOld, diffKind: "status" };
  }

  // Status matches. If both 404, that's a match.
  if (statusNew === 404) return { match: true, statusNew, statusOld };

  // Both 200: compare bodies.
  //
  // Strategy:
  //   - /all: raw byte compare (gzipped binary).
  //   - Anything else above BYTE_COMPARE_THRESHOLD: raw byte compare to avoid
  //     unbounded JSON.parse + deep-equal CPU cost on huge SRI maps (a single
  //     react /sris response is ~4.7 MB / 26k keys). Byte-equal is safe because
  //     both sides iterate KV in lexicographic order, so key ordering is stable.
  //   - Smaller JSON: parse and deep-equal so we tolerate key-order or
  //     whitespace differences if the sources ever diverge in formatting.
  const newBuf = await newResp.arrayBuffer();
  const oldBuf = await oldResp.arrayBuffer();

  if (endpointType === "aggregated") {
    return bytesEqual(newBuf, oldBuf)
      ? { match: true, statusNew, statusOld }
      : { match: false, statusNew, statusOld, diffKind: "body" };
  }

  if (
    newBuf.byteLength > BYTE_COMPARE_THRESHOLD ||
    oldBuf.byteLength > BYTE_COMPARE_THRESHOLD
  ) {
    return bytesEqual(newBuf, oldBuf)
      ? { match: true, statusNew, statusOld }
      : { match: false, statusNew, statusOld, diffKind: "body" };
  }

  const decoder = new TextDecoder();
  const newText = decoder.decode(newBuf);
  const oldText = decoder.decode(oldBuf);

  let newJson, oldJson;
  try {
    newJson = JSON.parse(newText);
    oldJson = JSON.parse(oldText);
  } catch {
    return newText === oldText
      ? { match: true, statusNew, statusOld }
      : { match: false, statusNew, statusOld, diffKind: "body" };
  }

  return deepEqual(newJson, oldJson)
    ? { match: true, statusNew, statusOld }
    : { match: false, statusNew, statusOld, diffKind: "body" };
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

async function markChecked(pathname) {
  const cache = caches.default;
  const key = `${CHECKED_CACHE_BASE}${pathname}`;
  const resp = new Response("ok", {
    headers: { "Cache-Control": `max-age=${CHECKED_TTL_SECONDS}` },
  });
  await cache.put(key, resp);
}

async function isAlreadyChecked(pathname) {
  const cache = caches.default;
  const key = `${CHECKED_CACHE_BASE}${pathname}`;
  const hit = await cache.match(key);
  return hit !== undefined;
}

async function isKnownMismatch(db, pathname) {
  try {
    const row = await db
      .prepare("SELECT 1 FROM shadow_mismatches WHERE path = ? LIMIT 1")
      .bind(pathname)
      .first();
    return row !== null;
  } catch {
    // If D1 is unreachable, err on the side of doing the comparison.
    return false;
  }
}

async function recordMismatch(db, pathname, endpointType, result) {
  const now = Math.floor(Date.now() / 1000);
  // INSERT OR IGNORE so concurrent requests for the same path don't error.
  await db
    .prepare(
      `INSERT OR IGNORE INTO shadow_mismatches
         (path, endpoint_type, status_new, status_old, diff_kind, first_seen)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      pathname,
      endpointType,
      result.statusNew,
      result.statusOld,
      result.diffKind,
      now
    )
    .run();
}

// Main entry. Call from within ctx.waitUntil.
//
//   newResponse: the Response we are about to return to the user. Caller MUST
//   pass a clone — we will consume the body.
//
//   request: the original Request (for method + headers).
//
//   env: the worker env, providing SHADOW_DB / SHADOW_ORIGIN / SHADOW_SAMPLE_RATE.
//
//   sentry: optional Toucan instance for error capture.
export async function shadowCompare(newResponse, request, env, sentry) {
  if (!shadowEnabled(env)) return;

  const origin = shadowOrigin(env);
  if (!origin) return;

  const rate = sampleRate(env);
  if (rate <= 0) return;
  if (Math.random() >= rate) return;

  const url = new URL(request.url);
  const pathname = decodeURI(url.pathname);
  const endpointType = classify(pathname);
  if (endpointType === "other") return;

  const db = env.SHADOW_DB;

  try {
    // Skip if we've already verified this path recently.
    if (await isAlreadyChecked(pathname)) return;
    // Skip if it's a known-bad path.
    if (await isKnownMismatch(db, pathname)) return;

    // Fetch the same path from the old origin.
    const oldUrl = `${origin}${pathname}${url.search || ""}`;
    let oldResp;
    try {
      oldResp = await fetch(oldUrl, {
        method: request.method,
        // Do not forward client headers — we want an apples-to-apples origin response.
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch {
      // Network error reaching the old origin: nothing to compare, do nothing.
      return;
    }

    const result = await compare(newResponse, oldResp, endpointType);

    if (result.skip) return;

    if (result.match) {
      await markChecked(pathname);
      return;
    }

    await recordMismatch(db, pathname, endpointType, result);
  } catch (e) {
    if (sentry) sentry.captureException(e);
  }
}
