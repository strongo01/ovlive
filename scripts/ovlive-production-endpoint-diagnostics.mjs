import assert from "node:assert/strict";
import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("OVLIVE_BASE_URL is required.");

async function get(path, timeoutMs = 30000) {
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.byteLength(text),
      json,
      textStart: text.slice(0, 160),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectLegs(plan) {
  const itineraries = Array.isArray(plan?.itineraries) ? plan.itineraries
    : Array.isArray(plan?.journeys) ? plan.journeys : [];
  return itineraries.flatMap((itinerary) =>
    (Array.isArray(itinerary?.legs) ? itinerary.legs : []).map((leg, index) => ({
      ...leg,
      _diagnosticItineraryIndex: itineraries.indexOf(itinerary) + 1,
      _diagnosticLegIndex: index + 1,
    }))
  );
}

function routeId(leg) {
  const raw = String(leg?.routeId ?? leg?.route?.id ?? "");
  return raw.match(/(\d+)$/)?.[1] ?? null;
}

async function main() {
  const planUrl = new URL("/api/plan", baseUrl);
  planUrl.searchParams.set("fromPlace", process.env.OVLIVE_FROM_PLACE ?? "nl-OpenOV_3924329");
  planUrl.searchParams.set("toPlace", process.env.OVLIVE_TO_PLACE ?? "nl-OpenOV_3924355");
  planUrl.searchParams.set("time", new Date(Date.now() + 120_000).toISOString());
  planUrl.searchParams.set("numItineraries", "5");
  planUrl.searchParams.set("maxItineraries", "5");

  const planResult = await get(planUrl.pathname + planUrl.search, 65000);
  if (!planResult.ok || !planResult.json) {
    console.log(JSON.stringify({ check: "production-plan", ...planResult }, null, 2));
    throw new Error("Production /api/plan could not be queried.");
  }

  const legs = collectLegs(planResult.json);
  const openovLegs = legs.filter((leg) => /^nl-OpenOV_/i.test(String(leg.routeId ?? leg.route?.id ?? "")));
  const ndovStatusCounts = {};
  for (const leg of legs) {
    const status = String(leg.ndovRealtime?.status ?? "no_ndov_match");
    ndovStatusCounts[status] = (ndovStatusCounts[status] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    check: "production-plan",
    baseUrl,
    httpStatus: planResult.status,
    itineraries: Array.isArray(planResult.json.itineraries) ? planResult.json.itineraries.length : null,
    totalLegs: legs.length,
    openovLegs: openovLegs.length,
    ndovStatusCounts,
    ndovRealtimeMeta: planResult.json.ndovRealtimeMeta ?? null,
    legs: legs.map((leg) => ({
      routeId: leg.routeId ?? leg.route?.id ?? null,
      tripId: leg.tripId ?? leg.trip?.id ?? null,
      mode: leg.mode ?? null,
      openovStatus: leg.openovRealtime?.status ?? null,
      openovReason: leg.openovRealtime?.reason ?? null,
      departure: leg.openovRealtime?.departure ?? null,
      arrival: leg.openovRealtime?.arrival ?? null,
      ndovStatus: leg.ndovRealtime?.status ?? null,
      ndovSource: leg.ndovRealtime?.source ?? null,
      ndovIdentity: leg.ndovRealtime?.identity ?? null,
      ndovEventType: leg.ndovRealtime?.eventType ?? leg.ndovRealtime?.kv6?.eventType ?? null,
      ndovPunctualitySeconds: leg.ndovRealtime?.punctualitySeconds ?? leg.ndovRealtime?.kv6?.punctualitySeconds ?? null,
      ndovMatchReason: leg.ndovRealtimeMatch?.reason ?? null,
    })),
  }, null, 2));

  const manifests = [
    "/ndov-openov-route-crosswalk/manifest.json",
    "/ndov-trip-crosswalk/manifest.json",
    "/ndov-stop-crosswalk/manifest.json",
  ];
  const results = [];
  let routeManifest = null;
  for (const path of manifests) {
    const result = await get(path);
    const data = result.json;
    const summary = {
      path,
      status: result.status,
      contentType: result.contentType ?? null,
      bytes: result.bytes ?? null,
      validJson: Boolean(data && typeof data === "object" && !Array.isArray(data)),
      generatedAt: data?.generatedAt ?? null,
      source: data?.source ?? null,
      routeCount: data?.routeCount ?? (data?.routes ? Object.keys(data.routes).length : null),
      serviceCalendarDateCount: data?.serviceCalendarDateCount ?? null,
      shardCount: data?.shardCount ?? (Array.isArray(data?.shards) ? data.shards.length : null),
      error: result.error ?? null,
    };
    results.push(summary);
    if (path === "/ndov-openov-route-crosswalk/manifest.json" && result.ok && data?.routes) {
      routeManifest = data;
    }
  }

  const shardChecks = [];
  const routeIds = [...new Set(openovLegs.map(routeId).filter(Boolean))].slice(0, 8);
  for (const id of routeIds) {
    const files = routeManifest?.routes?.[id];
    if (!Array.isArray(files) || !files.length) {
      shardChecks.push({ routeId: id, manifestHasRoute: false });
      continue;
    }
    const file = String(files[0]);
    const shardPath = "/ndov-openov-route-crosswalk/routes/" + file;
    const shard = await get(shardPath);
    shardChecks.push({
      routeId: id,
      manifestHasRoute: true,
      filename: file,
      status: shard.status,
      contentType: shard.contentType ?? null,
      bytes: shard.bytes ?? null,
      validJsonArray: Array.isArray(shard.json),
      patternCount: Array.isArray(shard.json) ? shard.json.length : null,
      error: shard.error ?? null,
    });
  }
  console.log(JSON.stringify({
    check: "production-static-crosswalk-assets",
    assets: results,
    routeShardChecks: shardChecks,
  }, null, 2));

  assert.ok(legs.length > 0, "Production /api/plan must return at least one leg.");
  console.log("PASS: production endpoint diagnostics finished; no data was changed.");
}

await main();
