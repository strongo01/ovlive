import assert from "node:assert/strict";
import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("OVLIVE_BASE_URL is required.");

// This matches the Utrecht Centraal -> Jazzsingel test route that exposed
// NS realtime disappearing when buses are enabled in the planner.
const fromPlace = process.env.OVLIVE_FROM_PLACE ?? "52.0888900756836,5.11027765274048";
const toPlace = process.env.OVLIVE_TO_PLACE ?? "52.102126,5.048507";
const transitModes = process.env.OVLIVE_TRANSIT_MODES ??
  "RAIL,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_FAST_RAIL,REGIONAL_RAIL,SUBURBAN,BUS,COACH,METRO,SUBWAY,TRAM,FERRY";

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

const planUrl = new URL("/api/plan", baseUrl);
planUrl.searchParams.set("fromPlace", fromPlace);
planUrl.searchParams.set("toPlace", toPlace);
planUrl.searchParams.set("time", new Date(Date.now() + 120_000).toISOString());
planUrl.searchParams.set("numItineraries", "3");
planUrl.searchParams.set("maxItineraries", "3");
planUrl.searchParams.set("maxPreTransitTime", "900");
planUrl.searchParams.set("maxPostTransitTime", "900");
planUrl.searchParams.set("pedestrianSpeed", "1.5");
planUrl.searchParams.set("transitModes", transitModes);

const requestStartedAt = Date.now();
let response;
try {
  response = await fetch(planUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(70_000)
  });
} catch (error) {
  console.log(JSON.stringify({
    check: "production-mixed-mode-ns-realtime",
    baseUrl,
    fromPlace,
    toPlace,
    transitModes,
    requestDurationMs: Date.now() - requestStartedAt,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  throw new Error("Mixed-mode /api/plan did not return a response within the validation window.");
}
const body = await response.text();
let plan;
try {
  plan = JSON.parse(body);
} catch {
  throw new Error(`Mixed-mode /api/plan returned non-JSON (HTTP ${response.status}): ${body.slice(0, 250)}`);
}
if (!response.ok) {
  throw new Error(`Mixed-mode /api/plan returned HTTP ${response.status}: ${String(plan?.error ?? body).slice(0, 500)}`);
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
  check: "production-mixed-mode-ns-realtime",
  baseUrl,
  fromPlace,
  toPlace,
  transitModes,
  httpStatus: response.status,
  itineraryCount: Array.isArray(plan?.itineraries) ? plan.itineraries.length : null,
  totalLegCount: legs.length,
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
    mode: leg.mode ?? null,
    routeId: leg.routeId ?? leg.route?.id ?? null,
    tripId: leg.tripId ?? leg.trip?.id ?? null,
    trainNumber: leg.nsRealtime?.trainNumber ?? null,
    nsStatus: leg.nsRealtime?.status ?? null,
    boardError: leg.nsRealtime?.boardError ?? null,
    stationLookupSource: leg.nsRealtime?.stationLookupSource ?? null,
    stationListError: leg.nsRealtime?.stationListError ?? null,
    message: leg.nsRealtime?.message ?? null,
    departureDelaySeconds: leg.nsRealtime?.departure?.delaySeconds ?? null,
    arrivalDelaySeconds: leg.nsRealtime?.arrival?.delaySeconds ?? null
  }))
};
console.log(JSON.stringify(summary, null, 2));

assert.ok(legs.length > 0, "Transitous must return at least one leg.");
assert.ok(busLegs.length > 0, "The test must contain a bus leg; otherwise it is not a mixed-mode regression.");
assert.ok(railLegs.length > 0, "The test must contain a train leg.");
assert.ok(Number(nsMeta.candidateLegCount) > 0,
  "No exact NS train identity was matched; the mixed-mode NS path was not successfully exercised.");
assert.ok(Number(nsMeta.matchedLegCount) > 0,
  "NS found no matching departure/arrival for any train in the mixed-mode plan.");
console.log("PASS: the production mixed-mode plan retained an NS realtime match with buses enabled.");
