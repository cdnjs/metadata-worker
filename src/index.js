import { ALLOWED_EXTENSIONS } from "./constants.js";
import { shadowCompare } from "./shadow.js";
import { Toucan } from "toucan-js";

export default {
  async fetch(request, env, ctx) {
    const sentry = new Toucan({
      dsn: env.SENTRY_DSN,
      request,
      context: ctx,
      environment: env.ENV,
      // sentry10.cfdata.org is behind Cloudflare Access. Authenticate the
      // worker→Sentry POST with a service token, the same pattern used by
      // worker-files. Both values come from `wrangler secret put`.
      transportOptions: {
        headers: {
          "CF-Access-Client-ID": env.SENTRY_CLIENT_ID,
          "CF-Access-Client-Secret": env.SENTRY_CLIENT_SECRET,
        },
      },
    });
    return handleRequest(request, env, ctx, sentry);
  },
};

async function handleRequest(request, env, ctx, sentry) {
  function respond(msg, status) {
    return new Response(msg, { status });
  }

  function ok(msg) {
    return respond(msg, 200);
  }

  function forbid(msg = "invalid request") {
    return respond(msg, 403);
  }

  function not_found(msg = "metadata not found") {
    return respond(msg, 404);
  }

  function err(msg = "something went wrong") {
    return respond(msg, 500);
  }

  // `manual`: `resp` has encodeBody "manual", so its body is already encoded.
  function cache_resp(resp, cache, cache_key, max_age, manual = false) {
    resp.headers.append("Cache-Control", `max-age=${max_age}`);
    // clone() drops encodeBody "manual", and cache.put would then encode the
    // body a second time, so cache hits sent two gzip layers.
    const copy = resp.clone();
    ctx.waitUntil(
      cache.put(
        cache_key,
        manual
          ? new Response(copy.body, {
              status: copy.status,
              headers: copy.headers,
              encodeBody: "manual",
            })
          : copy
      )
    );
    // Shadow-compare in background. Runs on cache misses only (this function
    // is only reached when cache.match() returned undefined upstream).
    ctx.waitUntil(shadowCompare(resp.clone(), request, env, sentry));
    return resp;
  }

  // Responds with a KV value read as an ArrayBuffer. A gzipped value is sent
  // as it is with Content-Encoding: gzip and encodeBody "manual", so HTTP
  // clients inflate it once. Without "manual" the runtime gzips it again.
  // Pass `gzipped` on to cache_resp.
  function kv_bytes_resp(value) {
    const bytes = new Uint8Array(value);
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const resp = gzipped
      ? new Response(value, {
          status: 200,
          headers: { "Content-Encoding": "gzip" },
          encodeBody: "manual",
        })
      : ok(new TextDecoder().decode(bytes));
    return { resp, gzipped };
  }

  // Gets all keys in a KV namespace.
  async function* get_all_keys(namespace, options) {
    let cursor;
    let list_complete;
    do {
      const result = await namespace.list({ ...options, cursor });
      ({ list_complete, cursor } = result);
      for (const key of result.keys) yield key;
    } while (list_complete === false);
  }

  try {
    const url = new URL(request.url);
    // Keep pathname URL-encoded for routing; decode each captured segment
    // individually below before using it as a KV key. `decodeURI` does NOT
    // decode reserved chars like `@` (`%40`), which broke version lookups
    // for names such as `scatterjs-core@2.7.18`.
    const pathname = url.pathname;

    if (pathname === "/favicon.ico") {
      return not_found("not found");
    }

    if (pathname === "/extensions") {
      return ok(JSON.stringify(ALLOWED_EXTENSIONS));
    }

    const cache = caches.default;
    const cache_key = new Request(url.toString(), request);

    // Check cache for request.
    let response = await cache.match(cache_key);
    if (response !== undefined) {
      return response;
    }

    if (pathname === "/packages") {
      // Endpoint: `/packages`.
      // Return list of package names.
      let package_names = [];
      for await (const { name } of get_all_keys(env.CDNJS_PACKAGES)) {
        package_names.push(name);
      }

      // Cache response for an hour.
      // New packages are not added often.
      return cache_resp(
        ok(JSON.stringify(package_names)),
        cache,
        cache_key,
        "3600"
      );
    }

    const packages_endpoint = new RegExp(
      "^/packages/(?<package_name>[^/]+)$"
    ).exec(pathname);

    if (packages_endpoint !== null) {
      // Endpoint: `/packages/<package name>`.
      // Fetch package metadata from KV.
      const package_name = decodeURIComponent(packages_endpoint.groups.package_name);
      const package_json = await env.CDNJS_PACKAGES.get(package_name);
      if (package_json === null) {
        // Cache 404 package for an hour.
        // New packages are not added often.
        return cache_resp(not_found(), cache, cache_key, "3600");
      }

      // Cache package metadata for an hour since the
      // autoupdater runs about once per hour.
      return cache_resp(ok(package_json), cache, cache_key, "3600");
    }

    const pkg_sris_endpoint = new RegExp(
      "^/packages/(?<package_name>[^/]+)/sris(/(?<version_name>[^/]+))?$"
    ).exec(pathname);

    if (pkg_sris_endpoint !== null) {
      // Endpoints: `/packages/<package name>/sris`, `/packages/<package name>/sris/<version name>`
      // Fetch SRIs for a package.
      const package_name = decodeURIComponent(pkg_sris_endpoint.groups.package_name);
      const version_name =
        pkg_sris_endpoint.groups.version_name === undefined
          ? undefined
          : decodeURIComponent(pkg_sris_endpoint.groups.version_name);
      let sris = {};
      for await (const { name, metadata } of get_all_keys(env.CDNJS_SRIS, {
        prefix: `${package_name}/${
          version_name === undefined ? "" : version_name
        }`,
      })) {
        sris[name] = metadata.sri;
      }

      // Cache SRIs for an hour since the
      // autoupdater runs about once per hour.
      return cache_resp(ok(JSON.stringify(sris)), cache, cache_key, "3600");
    }

    const aggregated_metadata_endpoint = new RegExp(
      "^/packages/(?<package_name>[^/]+)/all$"
    ).exec(pathname);

    if (aggregated_metadata_endpoint !== null) {
      // Endpoint: `/packages/<package name>/all`.
      // Fetch aggregated metadata for a package.
      const package_name = decodeURIComponent(
        aggregated_metadata_endpoint.groups.package_name
      );
      const aggregated_value = await env.CDNJS_AGGREGATED_METADATA.get(
        package_name,
        "arrayBuffer"
      );
      if (aggregated_value === null) {
        // Cache 404 package for an hour.
        // New packages are not added often.
        return cache_resp(not_found(), cache, cache_key, "3600");
      }

      // The bot stores aggregated metadata gzipped.
      const { resp, gzipped } = kv_bytes_resp(aggregated_value);

      // Cache package metadata for a couple minutes.
      // The API will use this metadata to update itself often.
      return cache_resp(resp, cache, cache_key, "300", gzipped);
    }

    const versions_endpoint = new RegExp(
      "^/packages/(?<package_name>[^/]+)/versions$"
    ).exec(pathname);

    if (versions_endpoint !== null) {
      // Endpoint: `/packages/<package name>/versions`.
      // Fetch all versions for a package.
      const package_name = decodeURIComponent(versions_endpoint.groups.package_name);
      const version_prefix = `${package_name}/`;

      let version_names = [];
      for await (const { name } of get_all_keys(env.CDNJS_VERSIONS, {
        prefix: version_prefix,
      })) {
        version_names.push(name.substring(version_prefix.length));
      }

      // Cache versions for an hour since the
      // autoupdater runs about once per hour.
      return cache_resp(
        ok(JSON.stringify(version_names)),
        cache,
        cache_key,
        "3600"
      );
    }

    const version_endpoint = new RegExp(
      "^/packages/(?<package_name>[^/]+)/versions/(?<version_name>[^/]+)$"
    ).exec(pathname);

    if (version_endpoint !== null) {
      // Endpoint: `/packages/<package name>/versions/<version name>`.
      const package_name = decodeURIComponent(version_endpoint.groups.package_name);
      const version_name = decodeURIComponent(version_endpoint.groups.version_name);
      const version_key = `${package_name}/${version_name}`;
      const version_value = await env.CDNJS_VERSIONS.get(
        version_key,
        "arrayBuffer"
      );
      if (version_value === null) {
        // Cache 404 version for an hour since the
        // autoupdater runs about once per hour.
        return cache_resp(
          not_found(`version not found: ${version_key}`),
          cache,
          cache_key,
          "3600"
        );
      }

      // The bot stores a file list over 20 MiB of JSON gzipped, because a KV
      // value holds at most 25 MiB. Reading the value as text would corrupt it.
      const { resp, gzipped } = kv_bytes_resp(version_value);

      // Each version is immutable once in KV
      // so cache it for a year.
      return cache_resp(resp, cache, cache_key, "31536000", gzipped);
    }

    // Unknown request.
    return forbid();
  } catch (e) {
    sentry.captureException(e);
    return env.ENV === "production" ? err() : err(e.stack);
  }
}
