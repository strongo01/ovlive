import assert from "node:assert/strict";
import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("OVLIVE_BASE_URL is required.");

// Utrecht Centraal -> Maarssen is a current-time rail trip. Bus remains an
// allowed Transitous mode; this probe checks NS against near-term live boards
// instead of asking the NS board API to match a train several days in advance.
const fromPlace = process.env.OVLIVE_LIVE_FROM_PLACE ?? "nl-OpenOV_2993993";
const toPlace = process.env.OVLIVE_LIVE_TO_PLACE ?? "nl-OpenOV_2993430";
const transitModes = process.env.OVLIVE_TRANSIT_MODES ??
  "RAIL,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_FAST_RAIL,REGIONAL_RAIL,SUBURBAN,BUS,COACH";

function collectLegs(plan) {
  const containers = [
    ...(Array.isArray(plan?.itineraries) ? plan.itineraries : []),
    ...(Array.isArray(plan?.connections) ? plan.connections : []),
    ...(Array.isArray(plan?.journeys) ? plan.journeys : [])
  ];
  const legs = [];
  const seen = new Set();
  for (const container of containers) {
    if (!Array.isArray(container?.legs)) continue;
    for (const leg of container.legs) {
      if (leg && typeof leg === "object" && !seen.has(leg)) {
        seen.add(leg);
        legs.push(leg);
      }
    }
  }
  return legs;
}

const requestTime = new Date(Date.now() + 120_000).toISOString();
const planUrl = new URL("/api/plan", baseUrl);
planUrl.searchParams.set("fromPlace", fromPlace);
planUrl.searchParams.set("toPlace", toPlace);
planUrl.searchParams.set("time", requestTime);
planUrl.searchParams.set("numItineraries", "5");
planUrl.searchParams.set("maxItineraries", "5");
planUrl.searchParams.set("maxPreTransitTime", "900");
planUrl.searchParams.set("maxPostTransitTime", "900");
planUrl.searchParams.set("pedestrianSpeed", "1.5");
planUrl.searchParams.set("transitModes", transitModes);

const startedAt = Date.now();
let response;
try {
  response = await fetch(planUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(70_000)
  });
} catch (error) {
  console.log(JSON.stringify({
    check: "production-current-ns-with-bus-filter",
    baseUrl, fromPlace, toPlace, requestTime, transitModes,
    requestDurationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  throw new Error("Current-time NS validation did not receive a plan response.");
}
const body = await response.text();
let plan;
try {
  plan = JSON.parse(body);
} catch {
  throw new Error(`Current-time /api/plan returned non-JSON (HTTP ${response.status}): ${body.slice(0, 250)}`);
}
if (!response.ok) {
  throw new Error(`Current-time /api/plan returned HTTP ${response.status}: ${String(plan?.error ?? body).slice(0, 500)}`);
}

const legs = collectLegs(plan);
const railModes = new Set([
  "RAIL", "REGIONAL_RAIL", "LONG_DISTANCE", "HIGH_SPEED_RAIL",
  "HIGHSPEED_RAIL", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "SUBURBAN", "TRAIN"
]);
const railLegs = legs.filter(leg => railModes.has(String(leg?.mode ?? "").toUpperCase()));
const busLegs = legs.filter(leg => ["BUS", "COACH"].includes(String(leg?.mode ?? "").toUpperCase()));
const nsMeta = plan?.nsRealtimeMeta ?? {};

const summary = {
  check: "production-current-ns-with-bus-filter",
  baseUrl, fromPlace, toPlace, requestTime, transitModes,
  httpStatus: response.status,
  itineraryCount: Array.isArray(plan?.itineraries) ? plan.itineraries.length : null,
  busLegCount: busLegs.length,
  railLegCount: railLegs.length,
  nsMeta: {
    status: nsMeta.status ?? null,
    candidateLegCount: nsMeta.candidateLegCount ?? null,
    matchedLegCount: nsMeta.matchedLegCount ?? null,
    departureMatchedLegCount: nsMeta.departureMatchedLegCount ?? null,
    arrivalMatchedLegCount: nsMeta.arrivalMatchedLegCount ?? null,
    stationLookupSource: nsMeta.stationLookupSource ?? null,
    stationListError: nsMeta.stationListError ?? null,
    message: nsMeta.message ?? null
  },
  railResults: railLegs.map(leg => ({
    routeShortName: leg.routeShortName ?? leg.route?.shortName ?? null,
    routeLongName: leg.routeLongName ?? leg.route?.longName ?? null,
    tripShortName: leg.tripShortName ?? null,
    headsign: leg.headsign ?? leg.direction ?? null,
    tripId: leg.tripId ?? leg.trip?.id ?? null,
    from: leg.from?.name ?? leg.from?.stationName ?? null,
    to: leg.to?.name ?? leg.to?.stationName ?? null,
    scheduledDeparture: leg.from?.scheduledDeparture ?? leg.scheduledStartTime ?? leg.startTime ?? null,
    scheduledArrival: leg.to?.scheduledArrival ?? leg.scheduledEndTime ?? leg.endTime ?? null,
    trainNumber: leg.nsRealtime?.trainNumber ?? null,
    nsStatus: leg.nsRealtime?.status ?? null,
    matchMethod: leg.nsRealtime?.matchMethod ?? null,
    boardError: leg.nsRealtime?.boardError ?? null,
    stationLookupSource: leg.nsRealtime?.stationLookupSource ?? null,
    stationListError: leg.nsRealtime?.stationListError ?? null,
    message: leg.nsRealtime?.message ?? null,
    departureDelaySeconds: leg.nsRealtime?.departure?.delaySeconds ?? null,
    arrivalDelaySeconds: leg.nsRealtime?.arrival?.delaySeconds ?? null
  }))
};
console.log(JSON.stringify(summary, null, 2));

assert.ok(transitModes.split(",").map(value => value.trim().toUpperCase()).includes("BUS"),
  "The live plan request must explicitly allow BUS.");
assert.ok(legs.length > 0, "Transitous must return at least one leg.");
assert.ok(railLegs.length > 0, "The current-time route must contain a train.");
assert.ok(Number(nsMeta.candidateLegCount) > 0,
  "No exact NS train identity was found in the current-time route.");
assert.ok(Number(nsMeta.matchedLegCount) > 0,
  "NS returned no unique departure/arrival match for any current-time train while BUS was allowed.");
console.log("PASS: current-time NS departure/arrival data matched while BUS was allowed in Transitous.");
