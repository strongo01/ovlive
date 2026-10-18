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

function normalizeOpenovId(value) {
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").replace(/^OpenOV_/i, "").trim();
}

function openovTripId(value) {
  const raw = String(value ?? "");
  return raw.match(/_nl-OpenOV_(.+)$/i)?.[1] ?? normalizeOpenovId(raw);
}

function plannedEndpoint(leg, kind) {
  return kind === "departure"
    ? leg?.from?.scheduledDeparture ?? leg?.scheduledStartTime ?? leg?.startTime ?? leg?.from?.departure ?? null
    : leg?.to?.scheduledArrival ?? leg?.scheduledEndTime ?? leg?.endTime ?? leg?.to?.arrival ?? null;
}

function epochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value / 1000;
    if (value > 1e9) return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

function summarizeSourceRecord(record) {
  return {
    routeId: record?.routeId ?? null,
    tripId: record?.tripId ?? null,
    startDate: record?.startDate ?? null,
    startTime: record?.startTime ?? null,
    timestamp: record?.timestamp ?? null,
    delaySeconds: record?.delaySeconds ?? null,
    scheduleRelationship: record?.scheduleRelationship ?? null,
    stopUpdateCount: Array.isArray(record?.stopUpdates) ? record.stopUpdates.length : null,
    endpointStopUpdates: record?.endpointStopUpdates ?? null,
  };
}

async function main() {
  const auditStartedMs = Date.now();
  const requestedPlanTime = new Date(auditStartedMs + 120_000).toISOString();
  const planUrl = new URL("/api/plan", baseUrl);
  planUrl.searchParams.set("fromPlace", process.env.OVLIVE_FROM_PLACE ?? "nl-OpenOV_3924329");
  planUrl.searchParams.set("toPlace", process.env.OVLIVE_TO_PLACE ?? "nl-OpenOV_3924355");
  planUrl.searchParams.set("time", requestedPlanTime);
  const parsedItineraryCount = Number.parseInt(process.env.OVLIVE_NUM_ITINERARIES ?? "3", 10);
  const itineraryCount = Number.isFinite(parsedItineraryCount)
    ? Math.min(5, Math.max(1, parsedItineraryCount))
    : 3;
  planUrl.searchParams.set("numItineraries", String(itineraryCount));
  planUrl.searchParams.set("maxItineraries", String(itineraryCount));
  planUrl.searchParams.set("ndovIdentityDiagnostics", "1");

  const planResult = await get(planUrl.pathname + planUrl.search, 65000);
  if (!planResult.ok || !planResult.json) {
    console.log(JSON.stringify({ check: "production-plan", ...planResult }, null, 2));
    throw new Error("Production /api/plan could not be queried.");
  }

  const legs = collectLegs(planResult.json);
  const openovLegs = legs.filter((leg) => /^nl-OpenOV_/i.test(String(leg.routeId ?? leg.route?.id ?? "")));

  // Inspect raw OpenOV feed records for the exact trips selected by production
  // /api/plan. This separates a missing source record from a failure to enrich
  // a record that actually exists. Only two bounded, read-only API requests.
  const openovTripIds = [...new Set(openovLegs
    .map((leg) => openovTripId(leg.tripId ?? leg.trip?.id))
    .filter(Boolean))];
  const sourceFeedResults = await Promise.all(["tripUpdates", "vehiclePositions"].map(async (kind) => {
    if (!openovTripIds.length) return { kind, result: null };
    const query = new URLSearchParams({
      kind,
      tripId: openovTripIds.join(","),
      limit: "2000",
    });
    const result = await get("/api/realtime?" + query.toString(), 45000);
    return { kind, result };
  }));
  const sourceFeeds = Object.fromEntries(sourceFeedResults.map(({ kind, result }) => {
    const data = result?.json;
    return [kind, {
      httpStatus: result?.status ?? null,
      ok: data?.ok === true,
      freshness: data?.freshness ?? null,
      ageSeconds: data?.ageSeconds ?? null,
      feedTimestamp: data?.feedTimestamp ?? null,
      matchingCount: data?.matchingCount ?? null,
      returnedCount: data?.returnedCount ?? null,
      error: data?.error ?? result?.error ?? null,
    }];
  }));
  const exactOpenovSourceEvidence = {
    requestedPlanTime,
    auditStartedAt: new Date(auditStartedMs).toISOString(),
    feedChecks: sourceFeeds,
    trips: openovLegs.map((leg) => {
      const expectedRouteId = normalizeOpenovId(leg.routeId ?? leg.route?.id);
      const expectedTripId = openovTripId(leg.tripId ?? leg.trip?.id);
      const departure = plannedEndpoint(leg, "departure");
      const arrival = plannedEndpoint(leg, "arrival");
      const departureSeconds = epochSeconds(departure);
      const tripEvidence = Object.fromEntries(sourceFeedResults.map(({ kind, result }) => {
        const records = Array.isArray(result?.json?.entities) ? result.json.entities : [];
        const sameTrip = records.filter((record) =>
          normalizeOpenovId(record?.tripId) === expectedTripId
        );
        const exactRouteAndTrip = sameTrip.filter((record) =>
          normalizeOpenovId(record?.routeId) === expectedRouteId
        );
        return [kind, {
          sameTripIdCount: sameTrip.length,
          exactRouteAndTripCount: exactRouteAndTrip.length,
          sameTripIdRecords: sameTrip.slice(0, 3).map(summarizeSourceRecord),
          exactRecords: exactRouteAndTrip.slice(0, 3).map(summarizeSourceRecord),
        }];
      }));
      const hasExactSourceRecord = Object.values(tripEvidence)
        .some((evidence) => evidence.exactRouteAndTripCount > 0);
      const secondsUntilDeparture = departureSeconds == null
        ? null
        : Math.round(departureSeconds - auditStartedMs / 1000);
      const sourceStatus = hasExactSourceRecord
        ? "exact_openov_source_record_found"
        : secondsUntilDeparture != null && secondsUntilDeparture > 300
          ? "trip_may_not_be_published_to_realtime_yet"
          : "no_exact_openov_source_record_for_near_departure";
      return {
        mode: leg.mode ?? leg.transitMode ?? null,
        routeId: leg.routeId ?? leg.route?.id ?? null,
        openovRouteId: expectedRouteId || null,
        transitousTripId: leg.tripId ?? leg.trip?.id ?? null,
        openovFeedTripId: expectedTripId || null,
        scheduledDeparture: departure,
        scheduledArrival: arrival,
        secondsUntilDeparture,
        openovStatusFromPlan: leg.openovRealtime?.status ?? null,
        openovReasonFromPlan: leg.openovRealtime?.reason ?? null,
        sourceStatus,
        feeds: tripEvidence,
      };
    }),
  };

  const transitLegs = legs.filter((leg) => {
    const mode = String(leg?.mode ?? leg?.transitMode ?? "").trim().toUpperCase();
    const tripId = String(leg?.tripId ?? leg?.trip?.id ?? "").trim();
    const route = String(leg?.routeId ?? leg?.route?.id ?? "").trim();
    return mode !== "WALK" && mode !== "TRANSFER" && Boolean(tripId || route);
  });
  const ndovStatusCounts = {};
  for (const leg of transitLegs) {
    const status = String(leg.ndovRealtime?.status ?? "no_ndov_match");
    ndovStatusCounts[status] = (ndovStatusCounts[status] ?? 0) + 1;
  }
  const openovStatusCounts = {};
  const openovReasonCounts = {};
  for (const leg of openovLegs) {
    const status = String(leg.openovRealtime?.status ?? "no_openov_match");
    openovStatusCounts[status] = (openovStatusCounts[status] ?? 0) + 1;
    if (leg.openovRealtime?.reason) {
      const reason = String(leg.openovRealtime.reason);
      openovReasonCounts[reason] = (openovReasonCounts[reason] ?? 0) + 1;
    }
  }

  console.log(JSON.stringify({
    check: "production-plan",
    baseUrl,
    requestedItineraries: itineraryCount,
    httpStatus: planResult.status,
    itineraries: Array.isArray(planResult.json.itineraries) ? planResult.json.itineraries.length : null,
    totalLegs: legs.length,
    transitLegs: transitLegs.length,
    openovLegs: openovLegs.length,
    ndovStatusScope: "transit legs only; walking and transfer legs are excluded",
    ndovStatusCounts,
    openovStatusCounts,
    openovReasonCounts,
    ndovRealtimeMeta: planResult.json.ndovRealtimeMeta ?? null,
    exactOpenovSourceEvidence,
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
      ndovPrediction: leg.ndovRealtime?.prediction ?? null,
      realtimePrediction: leg.realtimePrediction ?? null,
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
