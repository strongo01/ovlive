export type ApiRateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

type ApiRateLimitEnv = {
  API_RATE_LIMITER?: ApiRateLimitBinding;
  PLAN_RATE_LIMITER?: ApiRateLimitBinding;
  DEVICE_API_RATE_LIMITER?: ApiRateLimitBinding;
  DEVICE_PLAN_RATE_LIMITER?: ApiRateLimitBinding;
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
    console.warn("[OVLIVE_API_RATE_LIMIT]", JSON.stringify({
      path: url.pathname,
      outcome: "missing_client_ip"
    }));
    return errorResponse(
      "De clientidentiteit ontbreekt; de publieke API-aanvraag is niet verwerkt.",
      503,
      headers
    );
  }

  // Browser IDs improve fairness for people sharing one public IP address.
  // They are pseudonymous client identifiers, not authentication credentials.
  const rawDeviceId = request.headers.get("x-ovlive-device-id")?.trim() ?? "";
  const deviceId = /^[A-Za-z0-9_-]{16,128}$/.test(rawDeviceId)
    ? rawDeviceId
    : null;

  // Route planning consumes both the common API quota and the separate plan quota.
  // The 10-second realtime poll is protected by common quotas only.
  const isJourneyPlanRequest = url.pathname === "/api/plan";

  if (!env.API_RATE_LIMITER ||
      (isJourneyPlanRequest && !env.PLAN_RATE_LIMITER) ||
      (deviceId !== null && !env.DEVICE_API_RATE_LIMITER) ||
      (isJourneyPlanRequest && deviceId !== null && !env.DEVICE_PLAN_RATE_LIMITER)) {
    console.error("[OVLIVE_API_RATE_LIMIT]", JSON.stringify({
      path: url.pathname,
      outcome: "missing_binding",
      apiLimiterConfigured: Boolean(env.API_RATE_LIMITER),
      planLimiterRequired: isJourneyPlanRequest,
      planLimiterConfigured: Boolean(env.PLAN_RATE_LIMITER),
      deviceIdPresent: deviceId !== null,
      deviceApiLimiterConfigured: Boolean(env.DEVICE_API_RATE_LIMITER),
      devicePlanLimiterRequired: isJourneyPlanRequest && deviceId !== null,
      devicePlanLimiterConfigured: Boolean(env.DEVICE_PLAN_RATE_LIMITER)
    }));
    return errorResponse(
      "De API-beveiliging is niet volledig geconfigureerd.",
      503,
      headers
    );
  }

  try {
    // Wider IP-based ceiling prevents a shared network from being blocked by
    // normal household/school use. A tighter browser-ID quota improves fairness.
    const commonIp = await env.API_RATE_LIMITER.limit({
      key: "client:" + clientIp
    });
    if (!commonIp.success) {
      return errorResponse(
        "Te veel API-aanvragen vanaf dit netwerk. Probeer het over een minuut opnieuw.",
        429,
        headers,
        60
      );
    }

    if (deviceId !== null) {
      const commonDevice = await env.DEVICE_API_RATE_LIMITER!.limit({
        key: "device:" + deviceId
      });
      if (!commonDevice.success) {
        return errorResponse(
          "Dit browserprofiel heeft te veel API-aanvragen gedaan. Probeer het over een minuut opnieuw.",
          429,
          headers,
          60
        );
      }
    }

    if (isJourneyPlanRequest) {
      const planIp = await env.PLAN_RATE_LIMITER!.limit({
        key: "client:" + clientIp
      });
      if (!planIp.success) {
        return errorResponse(
          "Er zijn te veel reisplanningen vanaf dit netwerk aangevraagd. Probeer het over een minuut opnieuw.",
          429,
          headers,
          60
        );
      }

      if (deviceId !== null) {
        const planDevice = await env.DEVICE_PLAN_RATE_LIMITER!.limit({
          key: "device:" + deviceId
        });
        if (!planDevice.success) {
          return errorResponse(
            "Dit browserprofiel heeft te veel reisplanningen aangevraagd. Probeer het over een minuut opnieuw.",
            429,
            headers,
            60
          );
        }
      }
    }
  } catch (error) {
    // Fail closed: do not call upstream APIs if a configured limiter fails.
    console.error("[OVLIVE_API_RATE_LIMIT]", JSON.stringify({
      path: url.pathname,
      outcome: "limiter_exception",
      message: error instanceof Error ? error.message.slice(0, 180) : "onbekende fout"
    }));
    return errorResponse(
      "De tijdelijke API-beveiligingscontrole is niet beschikbaar.",
      503,
      headers
    );
  }
  return null;
}
