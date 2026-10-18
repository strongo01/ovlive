import assert from "node:assert/strict";
import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
// Stable points at the origin and destination used in the proven manual route.
// Coordinates avoid geocoder result-order changes in this regression test.
const fromPlace = process.env.OVLIVE_FROM_PLACE ?? "52.0443479,4.9503372";
const toPlace = process.env.OVLIVE_TO_PLACE ?? "52.357611,4.881619";

const railModes = new Set([
  "RAIL",
  "HIGHSPEED_RAIL",
  "HIGH_SPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "REGIONAL_FAST_RAIL",
  "REGIONAL_RAIL",
  "SUBURBAN",
  "TRAIN",
]);
const busModes = new Set(["BUS", "COACH"]);

function amsterdamParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function amsterdamLocalTimeIso(baseDateParts, daysAhead, hour, minute) {
  const targetDate = new Date(Date.UTC(
    baseDateParts.year,
    baseDateParts.month - 1,
    baseDateParts.day,
  ));
  targetDate.setUTCDate(targetDate.getUTCDate() + daysAhead);
  const target = {
    year: targetDate.getUTCFullYear(),
    month: targetDate.getUTCMonth() + 1,
    day: targetDate.getUTCDate(),
    hour,
    minute,
  };
  const targetWallMs = Date.UTC(
    target.year, target.month - 1, target.day, target.hour, target.minute,
  );
  let candidateMs = targetWallMs;
  // Convert Amsterdam wall-clock time to UTC without hardcoding the DST offset.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const displayed = amsterdamParts(new Date(candidateMs));
    const displayedWallMs = Date.UTC(
      displayed.year, displayed.month - 1, displayed.day,
      displayed.hour, displayed.minute,
    );
    candidateMs += targetWallMs - displayedWallMs;
  }
  return new Date(candidateMs).toISOString();
}

function chooseDepartureTime() {
  const localNow = amsterdamParts();
  // During normal daytime hours, test the next live departures. Outside this
  // window choose 10:00 Amsterdam time today or tomorrow, when service is likelier.
  if (localNow.hour >= 7 && localNow.hour < 17) {
    return new Date(Date.now() + 2 * 60 * 1000).toISOString();
  }
  return amsterdamLocalTimeIso(localNow, localNow.hour < 7 ? 0 : 1, 10, 0);
}

function itineraryLegs(itinerary) {
  if (Array.isArray(itinerary?.legs)) return itinerary.legs;
  if (Array.isArray(itinerary?.transitLegs)) return itinerary.transitLegs;
  return [];
}

function normalizeMode(leg) {
  const mode = String(leg?.mode ?? leg?.transitMode ?? leg?.product?.category ?? "")
    .trim()
    .toUpperCase();
  if (busModes.has(mode)) return "bus";
  if (railModes.has(mode)) return "train";
  if (mode === "TRAM") return "tram";
  return null;
}

// Keep this resolver aligned with plannedEndpointTime() in public/index.html.
// It deliberately prefers timetable fields over potentially realtime-adjusted
// startTime/endTime values when the UI does the chronology safety check.
function plannedEndpointTime(leg, kind) {
  const isDeparture = kind === "departure";
  const scheduled = isDeparture
    ? (leg?.scheduledStartTime || leg?.from?.scheduledDeparture)
    : (leg?.scheduledEndTime || leg?.to?.scheduledArrival);
  if (scheduled) return scheduled;

  const mode = String(leg?.mode ?? "").toUpperCase();
  if (mode === "WALK" || leg?.realTime === false) {
    return isDeparture
      ? (leg?.startTime || leg?.departureTime || leg?.from?.departure || null)
      : (leg?.endTime || leg?.arrivalTime || leg?.to?.arrival || null);
  }
  return null;
}

function epochMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function journeyChronologyIssue(legs, toleranceSeconds = 60) {
  let previousEndMs = null;
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    const startMs = epochMs(plannedEndpointTime(leg, "departure"));
    const endMs = epochMs(plannedEndpointTime(leg, "arrival"));
    if (
      previousEndMs !== null &&
      startMs !== null &&
      startMs < previousEndMs - toleranceSeconds * 1000
    ) {
      return {
        legIndex: index,
        previousArrival: new Date(previousEndMs).toISOString(),
        nextDeparture: new Date(startMs).toISOString(),
      };
    }
    if (endMs !== null) previousEndMs = endMs;
  }
  return null;
}

function describeItinerary(itinerary) {
  return itineraryLegs(itinerary).map((leg) => ({
    mode: String(leg?.mode ?? leg?.transitMode ?? "UNKNOWN").toUpperCase(),
    route: leg?.routeShortName ?? leg?.route?.shortName ?? leg?.route?.name
      ?? leg?.displayName ?? leg?.headsign ?? null,
    from: leg?.from?.name ?? leg?.origin?.name ?? null,
    departure: plannedEndpointTime(leg, "departure"),
    to: leg?.to?.name ?? leg?.destination?.name ?? null,
    arrival: plannedEndpointTime(leg, "arrival"),
  }));
}

async function main() {
  const departureTime = chooseDepartureTime();
  const url = new URL("/api/plan", baseUrl);
  const params = {
    fromPlace,
    toPlace,
    time: departureTime,
    // Match the UI choices for bus, train and tram; intentionally exclude metro.
    transitModes: [
      "BUS", "COACH", "RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE",
      "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN", "TRAM",
    ].join(","),
    maxTransfers: "2",
    maxPreTransitTime: "900",
    maxPostTransitTime: "900",
    pedestrianSpeed: "1.5",
    numItineraries: "5",
    maxItineraries: "5",
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(65000),
  });
  const body = await response.text();
  let plan;
  try {
    plan = JSON.parse(body);
  } catch {
    throw new Error("/api/plan returned invalid JSON (HTTP " + response.status + ").");
  }
  if (!response.ok) {
    throw new Error("/api/plan returned HTTP " + response.status + ": "
      + String(plan?.error ?? body).slice(0, 600));
  }

  const itineraries = Array.isArray(plan?.itineraries)
    ? plan.itineraries
    : Array.isArray(plan?.journeys) ? plan.journeys : [];
  const candidateSummary = itineraries.map((itinerary, index) => {
    const legs = itineraryLegs(itinerary);
    const modeSequence = legs.map(normalizeMode).filter(Boolean);
    return {
      itinerary: index + 1,
      modes: modeSequence,
      chronologyIssue: journeyChronologyIssue(legs),
      legs: describeItinerary(itinerary),
    };
  });

  const matches = itineraries.map((itinerary, index) => {
    const legs = itineraryLegs(itinerary);
    const entries = legs.map((leg, legIndex) => ({
      leg,
      legIndex,
      mode: normalizeMode(leg),
      departureMs: epochMs(plannedEndpointTime(leg, "departure")),
      arrivalMs: epochMs(plannedEndpointTime(leg, "arrival")),
    }));
    const bus = entries.find((entry) => entry.mode === "bus");
    const train = entries.find((entry) => entry.mode === "train");
    const tram = entries.find((entry) => entry.mode === "tram");
    if (!bus || !train || !tram) return null;
    if (!(bus.legIndex < train.legIndex && train.legIndex < tram.legIndex)) return null;
    // Require real scheduled endpoints for each of the three modes.
    if ([bus, train, tram].some((entry) =>
      entry.departureMs === null || entry.arrivalMs === null
    )) return null;
    const chronologyIssue = journeyChronologyIssue(legs);
    if (chronologyIssue) return null;
    if (bus.arrivalMs > train.departureMs + 60_000) return null;
    if (train.arrivalMs > tram.departureMs + 60_000) return null;
    return {
      itineraryNumber: index + 1,
      modes: ["bus", "train", "tram"],
      chronologyIssue: null,
      legs: describeItinerary(itinerary),
    };
  }).filter(Boolean);

  console.log(JSON.stringify({
    check: "bus-train-tram-route-regression",
    baseUrl,
    fromPlace,
    toPlace,
    departureTime,
    httpStatus: response.status,
    itineraryCount: itineraries.length,
    qualifyingItineraries: matches,
    candidateSummary,
  }, null, 2));

  assert.ok(
    matches.length > 0,
    "No single chronological itinerary contained bus -> train -> tram from Montfoort Kasteelplein to Amsterdam Museumplein.",
  );
  console.log("PASS: one visible, chronologically valid bus -> train -> tram itinerary was found.");
}

await main();
