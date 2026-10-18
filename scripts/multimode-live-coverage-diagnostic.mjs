import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("OVLIVE_BASE_URL is required.");

const railModes = [
  "RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL",
  "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"
];

const scenarios = [
  {
    name: "bus",
    label: "Bus · bestaande Utrecht/OpenOV-testcorridor",
    fromPlace: "nl-OpenOV_3924329",
    toPlace: "nl-OpenOV_3924355",
    transitModes: ["BUS", "COACH"],
    expectedCategory: "bus",
  },
  {
    name: "tram",
    label: "Tram · Amsterdam Centraal → De Pijp",
    fromPlace: "52.3780,4.9003",
    toPlace: "52.3540,4.8910",
    transitModes: ["TRAM"],
    expectedCategory: "tram",
  },
  {
    name: "metro",
    label: "Metro · Amsterdam Centraal → Amsterdam Zuid",
    fromPlace: "52.3780,4.9003",
    toPlace: "52.3382,4.8729",
    transitModes: ["METRO", "SUBWAY"],
    expectedCategory: "metro",
  },
  {
    name: "train",
    label: "Trein · Amsterdam Centraal → Utrecht Centraal",
    fromPlace: "52.3780,4.9003",
    toPlace: "52.0894,5.1102",
    transitModes: railModes,
    expectedCategory: "train",
  },
];

const normalizeId = (value) => String(value ?? "")
  .trim()
  .replace(/^nl-OpenOV_/i, "")
  .replace(/^OpenOV_/i, "");

const railSet = new Set(railModes);
function modeCategory(value) {
  const mode = String(value ?? "").trim().toUpperCase();
  if (["BUS", "COACH"].includes(mode)) return "bus";
  if (mode === "TRAM") return "tram";
  if (["METRO", "SUBWAY"].includes(mode)) return "metro";
  if (railSet.has(mode) || mode.endsWith("_RAIL")) return "train";
  if (mode === "FERRY") return "ferry";
  return mode ? "other:" + mode.toLowerCase() : "unknown";
}

function isOpenovLeg(leg) {
  const routeId = String(leg?.routeId ?? leg?.route?.id ?? "");
  const tripId = String(leg?.tripId ?? leg?.trip?.id ?? "");
  return /^nl-OpenOV_/i.test(routeId) && /nl-OpenOV_/i.test(tripId);
}

function plannedLegSummary(leg, itineraryIndex, legIndex) {
  const realtime = leg.openovRealtime ?? {};
  const ndov = leg.ndovRealtime ?? {};
  const ns = leg.nsRealtime ?? leg.nsRealtimeStatus ?? {};
  return {
    itinerary: itineraryIndex,
    leg: legIndex,
    mode: leg.mode ?? null,
    category: modeCategory(leg.mode),
    routeId: leg.routeId ?? leg.route?.id ?? null,
    route: leg.routeShortName ?? leg.route?.shortName ?? leg.routeLongName ?? leg.route?.longName ?? null,
    tripId: leg.tripId ?? leg.trip?.id ?? null,
    from: {
      name: leg.from?.name ?? null,
      stopId: leg.from?.stopId ?? leg.from?.id ?? leg.from?.stop?.id ?? null,
      departure: leg.from?.departure ?? leg.from?.scheduledDeparture ?? null,
    },
    to: {
      name: leg.to?.name ?? null,
      stopId: leg.to?.stopId ?? leg.to?.id ?? leg.to?.stop?.id ?? null,
      arrival: leg.to?.arrival ?? leg.to?.scheduledArrival ?? null,
    },
    openov: Object.keys(realtime).length ? {
      status: realtime.status ?? null,
      reason: realtime.reason ?? null,
      timestampBasis: realtime.timestampBasis ?? null,
      updateTimestamp: realtime.updateTimestamp ?? null,
      updateAgeSeconds: realtime.updateAgeSeconds ?? null,
      departureStopMatchMethod: realtime.departureStopMatchMethod ?? null,
      arrivalStopMatchMethod: realtime.arrivalStopMatchMethod ?? null,
      departure: realtime.departure ?? null,
      arrival: realtime.arrival ?? null,
    } : null,
    ndov: Object.keys(ndov).length ? {
      status: ndov.status ?? null,
      source: ndov.source ?? null,
      identity: ndov.identity ?? ndov.kv6?.identity ?? null,
      eventType: ndov.eventType ?? ndov.kv6?.eventType ?? null,
      punctualitySeconds: ndov.punctualitySeconds ?? ndov.kv6?.punctualitySeconds ?? null,
      feedAgeSeconds: ndov.feedAgeSeconds ?? ndov.kv6?.feedAgeSeconds ?? null,
      matchReason: leg.ndovRealtimeMatch?.reason ?? null,
    } : null,
    ns: Object.keys(ns).length ? {
      status: ns.status ?? null,
      delaySeconds: ns.delaySeconds ?? ns.punctualitySeconds ?? null,
      trainNumber: ns.trainNumber ?? ns.trainNo ?? null,
      source: ns.source ?? null,
      message: ns.message ?? null,
    } : null,
  };
}

async function getJson(url, timeoutMs = 65000) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (!response.ok || !json || typeof json !== "object") {
    throw new Error(url.pathname + " HTTP " + response.status + ": " + body.slice(0, 250));
  }
  return json;
}

function tripUpdateSummary(entity, targetLeg) {
  const endpointIds = new Set([
    normalizeId(targetLeg?.from?.stopId ?? targetLeg?.from?.id),
    normalizeId(targetLeg?.to?.stopId ?? targetLeg?.to?.id),
  ].filter(Boolean));
  return {
    tripId: entity.tripId ?? null,
    routeId: entity.routeId ?? null,
    startDate: entity.startDate ?? null,
    startTime: entity.startTime ?? null,
    timestamp: entity.timestamp ?? null,
    delaySeconds: entity.delaySeconds ?? entity.delay ?? null,
    scheduleRelationship: entity.scheduleRelationship ?? null,
    stopUpdateCount: Array.isArray(entity.stopUpdates) ? entity.stopUpdates.length : 0,
    endpointStopUpdates: (entity.stopUpdates ?? [])
      .filter(stop => endpointIds.has(normalizeId(stop.stopId)))
      .map(stop => ({
        stopId: normalizeId(stop.stopId),
        arrivalTime: stop.arrivalTime ?? null,
        arrivalDelaySeconds: stop.arrivalDelaySeconds ?? null,
        departureTime: stop.departureTime ?? null,
        departureDelaySeconds: stop.departureDelaySeconds ?? null,
        scheduleRelationship: stop.scheduleRelationship ?? null,
      })),
  };
}

async function inspectExactOpenovSource(leg) {
  if (!isOpenovLeg(leg)) return null;
  const routeId = normalizeId(leg.routeId ?? leg.route?.id);
  const tripId = String(leg.tripId ?? leg.trip?.id ?? "");
  const kinds = ["tripUpdates", "trainUpdates", "vehiclePositions"];
  const result = {};
  for (const kind of kinds) {
    const url = new URL("/api/realtime", baseUrl);
    url.searchParams.set("kind", kind);
    url.searchParams.set("routeId", routeId);
    url.searchParams.set("tripId", tripId);
    url.searchParams.set("limit", "20");
    try {
      const data = await getJson(url, 45000);
      result[kind] = {
        ok: data.ok ?? null,
        httpStatus: data.httpStatus ?? data.status ?? null,
        freshness: data.freshness ?? null,
        feedAgeSeconds: data.ageSeconds ?? null,
        timestamp: data.feedTimestamp ?? null,
        matchingCount: data.matchingCount ?? data.entityCount ?? null,
        returnedCount: data.returnedCount ?? (data.entities ?? []).length,
        entities: (data.entities ?? []).slice(0, 3).map(entity =>
          kind !== "vehiclePositions"
            ? tripUpdateSummary(entity, leg)
            : {
                tripId: entity.tripId ?? null,
                routeId: entity.routeId ?? null,
                startDate: entity.startDate ?? null,
                startTime: entity.startTime ?? null,
                timestamp: entity.timestamp ?? null,
                vehicleId: entity.vehicleId ?? null,
                stopId: entity.stopId ?? null,
                hasPosition: Number.isFinite(Number(entity.latitude)) &&
                  Number.isFinite(Number(entity.longitude)),
                latitude: Number.isFinite(Number(entity.latitude)) ? entity.latitude : null,
                longitude: Number.isFinite(Number(entity.longitude)) ? entity.longitude : null,
              })
      };
    } catch (error) {
      result[kind] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return result;
}

async function runScenario(scenario) {
  const url = new URL("/api/plan", baseUrl);
  url.searchParams.set("fromPlace", scenario.fromPlace);
  url.searchParams.set("toPlace", scenario.toPlace);
  url.searchParams.set("time", new Date(Date.now() + 180_000).toISOString());
  url.searchParams.set("transitModes", scenario.transitModes.join(","));
  url.searchParams.set("maxPreTransitTime", "900");
  url.searchParams.set("maxPostTransitTime", "900");
  url.searchParams.set("pedestrianSpeed", "1.5");
  url.searchParams.set("numItineraries", "5");
  url.searchParams.set("maxItineraries", "5");
  url.searchParams.set("ndovIdentityDiagnostics", "1");

  try {
    const plan = await getJson(url);
    const itineraries = Array.isArray(plan.itineraries) ? plan.itineraries
      : Array.isArray(plan.journeys) ? plan.journeys : [];
    const legs = itineraries.flatMap((itinerary, itineraryIndex) =>
      (Array.isArray(itinerary?.legs) ? itinerary.legs : [])
        .filter(leg => !["WALK", "TRANSFER"].includes(String(leg?.mode ?? "").toUpperCase()))
        .map((leg, legIndex) => plannedLegSummary(leg, itineraryIndex + 1, legIndex + 1))
    );
    const matchingModeLegs = legs.filter(leg => leg.category === scenario.expectedCategory);
    const sourceLeg = matchingModeLegs.find(leg =>
      /^nl-OpenOV_/i.test(String(leg.routeId ?? "")) &&
      /nl-OpenOV_/i.test(String(leg.tripId ?? ""))
    );
    let sourceEvidence = null;
    if (sourceLeg) {
      const original = itineraries
        .flatMap(itinerary => Array.isArray(itinerary?.legs) ? itinerary.legs : [])
        .find(leg => String(leg.tripId ?? leg.trip?.id ?? "") === String(sourceLeg.tripId ?? "") &&
          String(leg.routeId ?? leg.route?.id ?? "") === String(sourceLeg.routeId ?? ""));
      sourceEvidence = original ? await inspectExactOpenovSource(original) : null;
    }

    return {
      scenario: scenario.name,
      label: scenario.label,
      parameters: {
        fromPlace: scenario.fromPlace,
        toPlace: scenario.toPlace,
        transitModes: scenario.transitModes,
      },
      httpOk: true,
      itineraryCount: itineraries.length,
      transitLegCount: legs.length,
      expectedModeLegCount: matchingModeLegs.length,
      modeCoverage: matchingModeLegs.length ? "route_found" : "no_matching_mode_leg",
      openovRealtimeMeta: plan.openovRealtimeMeta ?? null,
      nsRealtimeMeta: plan.nsRealtimeMeta ? {
        status: plan.nsRealtimeMeta.status ?? null,
        candidateLegCount: plan.nsRealtimeMeta.candidateLegCount ?? null,
        matchedLegCount: plan.nsRealtimeMeta.matchedLegCount ?? null,
        departureDeviationKnownLegCount: plan.nsRealtimeMeta.departureDeviationKnownLegCount ?? null,
        arrivalDeviationKnownLegCount: plan.nsRealtimeMeta.arrivalDeviationKnownLegCount ?? null,
        unknownLegCount: plan.nsRealtimeMeta.unknownLegCount ?? null,
        stationLookupSource: plan.nsRealtimeMeta.stationLookupSource ?? null,
        stationListError: plan.nsRealtimeMeta.stationListError ?? null,
        message: plan.nsRealtimeMeta.message ?? null,
      } : null,
      ndovRealtimeMeta: plan.ndovRealtimeMeta ? {
        kv6MatchedLegCount: plan.ndovRealtimeMeta.kv6MatchedLegCount ?? null,
        kv6DelayLegCount: plan.ndovRealtimeMeta.kv6DelayLegCount ?? null,
        kv78DataLegCount: plan.ndovRealtimeMeta.kv78DataLegCount ?? null,
        kv78ConfirmedStopLegCount: plan.ndovRealtimeMeta.kv78ConfirmedStopLegCount ?? null,
        kv17CancelledLegCount: plan.ndovRealtimeMeta.kv17CancelledLegCount ?? null,
        coverageByMode: plan.ndovRealtimeMeta.coverageByMode ?? null,
        kv6LookupDiagnostics: plan.ndovRealtimeMeta.kv6LookupDiagnostics ?? null,
      } : null,
      legs,
      exactOpenovSourceEvidence: sourceEvidence,
    };
  } catch (error) {
    return {
      scenario: scenario.name,
      label: scenario.label,
      parameters: {
        fromPlace: scenario.fromPlace,
        toPlace: scenario.toPlace,
        transitModes: scenario.transitModes,
      },
      httpOk: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

console.log(JSON.stringify({
  check: "ovlive-production-multimode-realtime-coverage",
  baseUrl,
  generatedAt: new Date().toISOString(),
  readOnly: true,
  note: "Live production API checks only. No matching mode/identity is reported as a coverage gap; missing data is never inferred to mean on-time.",
  summary: results.map(result => ({
    scenario: result.scenario,
    httpOk: result.httpOk,
    itineraryCount: result.itineraryCount ?? null,
    expectedModeLegCount: result.expectedModeLegCount ?? null,
    modeCoverage: result.modeCoverage ?? "request_failed",
    openovExactSourceRecords: result.exactOpenovSourceEvidence
      ? {
          tripUpdates: result.exactOpenovSourceEvidence.tripUpdates?.matchingCount ?? null,
          trainUpdates: result.exactOpenovSourceEvidence.trainUpdates?.matchingCount ?? null,
          vehiclePositions: result.exactOpenovSourceEvidence.vehiclePositions?.matchingCount ?? null,
        }
      : null,
    kv6Matches: result.ndovRealtimeMeta?.kv6MatchedLegCount ?? null,
    kv78DataLegs: result.ndovRealtimeMeta?.kv78DataLegCount ?? null,
    error: result.error ?? null,
  })),
  scenarios: results,
}, null, 2));

if (results.every(result => result.httpOk === false)) {
  throw new Error("All production mode checks failed at the API layer.");
}
