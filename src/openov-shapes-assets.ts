interface Env {
  ASSETS: Fetcher;
}

/**
 * Static origin for the daily OpenOV GTFS trip geometries.
 * This Worker deliberately has no storage binding, database or paid R2 dependency.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    if (pathname !== "/manifest.json" &&
        !/^\/route-\d+-\d+\.json$/.test(pathname)) {
      return new Response("Not found", { status: 404 });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (!assetResponse.ok) return assetResponse;

    const headers = new Headers(assetResponse.headers);
    headers.set("Cache-Control", pathname === "/manifest.json"
      ? "public, max-age=30, s-maxage=30"
      : "public, max-age=86400, s-maxage=86400");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(request.method === "HEAD" ? null : assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
};
