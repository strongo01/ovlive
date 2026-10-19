export type ApiRateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

type ApiRateLimitEnv = {
  API_RATE_LIMITER?: ApiRateLimitBinding;
  PLAN_RATE_LIMITER?: ApiRateLimitBinding;
};

type JsonHeaders = Record<string, string>;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" ||
    host === "[::1]" || host === "::1";
}

function errorResponse(
  message: string,
  status: number,
  headers: JsonHeaders,
  retryAfterSeconds?: number
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  if (retryAfterSeconds != null) {
    responseHeaders.set("retry-after", String(retryAfterSeconds));
  }

  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: responseHeaders
  });
}

/**
 * Basic server-side protection for public API endpoints.
 * Local Wrangler requests bypass production-style client quotas.
 * The Worker Rate Limiting API is per Cloudflare location and eventually
 * consistent, so public production traffic still needs edge monitoring.
 */
export async function enforcePublicApiRateLimit(
  request: Request,
  env: ApiRateLimitEnv,
  headers: JsonHeaders
): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/api/")) return null;
  if (isLoopbackHost(url.hostname)) return null;

  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  if (!clientIp) {
    return errorResponse(
      "De clientidentiteit ontbreekt; de publieke API-aanvraag is niet verwerkt.",
      503,
      headers
    );
  }

  // Route planning is user-triggered and uses the stricter quota.
  // /api/realtime-refresh is a background poll every 10 seconds; it stays
  // protected by the common API limiter but must not consume the plan quota.
  const isJourneyPlanRequest = url.pathname === "/api/plan";

  if (!env.API_RATE_LIMITER ||
      (isJourneyPlanRequest && !env.PLAN_RATE_LIMITER)) {
    return errorResponse(
      "De API-beveiliging is niet volledig geconfigureerd.",
      503,
      headers
    );
  }

  try {
    const common = await env.API_RATE_LIMITER.limit({
      key: `client:${clientIp}`
    });
    if (!common.success) {
      return errorResponse(
        "Te veel API-aanvragen. Probeer het over een minuut opnieuw.",
        429,
        headers,
        60
      );
    }

    if (isJourneyPlanRequest) {
      const plan = await env.PLAN_RATE_LIMITER!.limit({
        key: `client:${clientIp}`
      });
      if (!plan.success) {
        return errorResponse(
          "Er zijn te veel reisplanningen aangevraagd. Probeer het over een minuut opnieuw.",
          429,
          headers,
          60
        );
      }
    }
  } catch {
    // Fail closed: upstream-aanvragen niet uitvoeren als de limiter faalt.
    return errorResponse(
      "De tijdelijke API-beveiligingscontrole is niet beschikbaar.",
      503,
      headers
    );
  }

  return null;
}
