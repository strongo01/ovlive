import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

function extractFunction(name) {
  const start = html.indexOf("function " + name + "(");
  assert.ok(start >= 0, "Required function must exist: " + name);
  const end = html.indexOf("\n}", start);
  assert.ok(end > start, "Could not isolate function: " + name);
  return html.slice(start, end + 2);
}

const normalizeLiveVehicleId = new vm.Script(
  "(" + extractFunction("normalizeLiveVehicleId") + ")"
).runInNewContext();

const normalizeLiveVehicleClock = new vm.Script(
  "(" + extractFunction("normalizeLiveVehicleClock") + ")"
).runInNewContext();

const parseLiveVehicleTripIdentity = new vm.Script(
  "(" + extractFunction("parseLiveVehicleTripIdentity") + ")"
).runInNewContext({ normalizeLiveVehicleId, normalizeLiveVehicleClock });

const rdNewToWgs84 = new vm.Script(
  "(" + extractFunction("rdNewToWgs84") + ")"
).runInNewContext();

const selectExactLiveNdovVehiclePosition = new vm.Script(
  "(" + extractFunction("selectExactLiveNdovVehiclePosition") + ")"
).runInNewContext({
  normalizeLiveVehicleId,
  rdNewToWgs84,
  LIVE_NDOV_VEHICLE_MAX_AGE_SECONDS: 30
});

const selectExactLiveVehiclePosition = new vm.Script(
  "(" + extractFunction("selectExactLiveVehiclePosition") + ")"
).runInNewContext({
  normalizeLiveVehicleId,
  normalizeLiveVehicleClock,
  parseLiveVehicleTripIdentity,
  LIVE_VEHICLE_MAX_AGE_SECONDS: 30
});

const isRailVehicleLeg = new vm.Script(
  "(" + extractFunction("isRailVehicleLeg") + ")"
).runInNewContext();

const selectExactLiveNsVehiclePosition = new vm.Script(
  "(" + extractFunction("selectExactLiveNsVehiclePosition") + ")"
).runInNewContext({ LIVE_NDOV_VEHICLE_MAX_AGE_SECONDS: 30 });

const decodeLivePolyline = new vm.Script(
  "(" + extractFunction("decodeLivePolyline") + ")"
).runInNewContext();

const expectedLeg = {
  mode: "BUS",
  tripId: "20261019_08:12:00_nl-OpenOV_390123",
  routeId: "nl-OpenOV_146872",
  scheduledStartTime: "2026-10-19T08:12:00.000Z",
  from: { scheduledDeparture: "2026-10-19T08:12:00.000Z" }
};
const nowMs = Date.parse("2026-10-19T08:14:00.000Z");
const freshPosition = {
  tripId: "nl-OpenOV_390123",
  routeId: "nl-OpenOV_146872",
  startDate: "20261019",
  startTime: "08:12:00",
  timestamp: Date.parse("2026-10-19T08:13:40.000Z") / 1000,
  latitude: 52.0907,
  longitude: 5.1214,
  vehicleId: "test-vehicle"
};

const matched = selectExactLiveVehiclePosition(expectedLeg, [freshPosition], nowMs);
assert.ok(matched, "fresh exact vehicle position should match");
assert.equal(matched.vehicleId, "test-vehicle");
assert.equal(matched.ageSeconds, 20);
assert.equal(matched.latitude, 52.0907);
console.log("PASS: exact trip, route, service date and start time match a fresh vehicle position");

assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, tripId: "nl-OpenOV_another-trip" }
], nowMs), null, "a position from a different trip must never be attached");
assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, routeId: "nl-OpenOV_other-route" }
], nowMs), null, "a position from another route must never be attached");
assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, startDate: "20261018" }
], nowMs), null, "a position from another service date must never be attached");
assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, timestamp: Date.parse("2026-10-19T08:13:20.000Z") / 1000 }
], nowMs), null, "a vehicle position older than 30 seconds must be rejected");
assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, timestamp: Date.parse("2026-10-19T08:10:00.000Z") / 1000 }
], nowMs), null, "a very old vehicle position must be rejected");
assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, latitude: 95 }
], nowMs), null, "invalid coordinates must be rejected");
assert.equal(selectExactLiveVehiclePosition(expectedLeg, [
  { ...freshPosition, startDate: "", startTime: "" }
], nowMs), null, "a position without a date or trip start time must be rejected");
console.log("PASS: wrong trips, wrong dates, wrong routes, stale points and invalid coordinates are rejected");

// A train leg's start time in a Transitous ID can describe this segment, not
// the original GTFS trip start. Keep an exact route/trip/date match despite that.
const QBUZZ_STYLE_LONG_TRIP_POSITION = {
  ...freshPosition,
  startTime: "07:45:00",
  vehicleId: "Qbuzz-8003"
};
const legStartingMidRoute = {
  ...expectedLeg,
  tripId: "20261019_09:20:00_nl-OpenOV_390123",
  scheduledStartTime: "2026-10-19T09:20:00.000Z",
  from: { scheduledDeparture: "2026-10-19T09:20:00.000Z" }
};
const longTripMatch = selectExactLiveVehiclePosition(
  legStartingMidRoute, [QBUZZ_STYLE_LONG_TRIP_POSITION], nowMs
);
assert.ok(longTripMatch,
  "an exact trip/route/service-date match must not be rejected only because the segment's departure differs from GTFS trip start_time");
assert.equal(longTripMatch.vehicleId, "Qbuzz-8003");
assert.equal(selectExactLiveVehiclePosition(legStartingMidRoute, [
  { ...QBUZZ_STYLE_LONG_TRIP_POSITION, startDate: "20261018" }
], nowMs), null, "the same trip from another service date must still be rejected");
console.log("PASS: trip-segment start time can differ without weakening exact route/trip/date checks");

// NS train positions come from the NS Virtual Train API, not OpenOV vehiclePositions.
assert.equal(isRailVehicleLeg({ mode: "RAIL" }), true);
assert.equal(isRailVehicleLeg({ mode: "TRAIN" }), true);
assert.equal(isRailVehicleLeg({ mode: "BUS" }), false);
const nsNow = Date.parse("2026-10-20T07:20:00.000Z");
const nsTrainLeg = { mode: "RAIL", nsRealtime: { trainNumber: "6919" } };
const nsTrainPosition = selectExactLiveNsVehiclePosition(nsTrainLeg, [{
  trainNumber: "6919",
  ritId: "6919",
  latitude: 52.0177,
  longitude: 5.1051,
  source: "NS Virtual Train API",
  sourceTimestampKnown: false,
  observedAt: "2026-10-20T07:19:56.000Z",
  fetchedAt: "2026-10-20T07:19:56.000Z"
}], nsNow);
assert.ok(nsTrainPosition, "a fresh exact NS train number and valid position should match");
assert.equal(nsTrainPosition.trainNumber, "6919");
assert.equal(nsTrainPosition.ageSeconds, 4);
assert.equal(selectExactLiveNsVehiclePosition(nsTrainLeg, [{
  trainNumber: "6920",
  latitude: 52.0177,
  longitude: 5.1051,
  observedAt: "2026-10-20T07:19:56.000Z",
  fetchedAt: "2026-10-20T07:19:56.000Z"
}], nsNow), null, "a different NS train number must not match");
assert.equal(selectExactLiveNsVehiclePosition(nsTrainLeg, [{
  trainNumber: "6919",
  latitude: 95,
  longitude: 5.1051,
  observedAt: "2026-10-20T07:19:56.000Z",
  fetchedAt: "2026-10-20T07:19:56.000Z"
}], nsNow), null, "invalid train coordinates must be rejected");
assert.equal(selectExactLiveNsVehiclePosition(nsTrainLeg, [{
  trainNumber: "6919",
  latitude: 52.0177,
  longitude: 5.1051,
  observedAt: "2026-10-20T07:19:20.000Z",
  fetchedAt: "2026-10-20T07:19:20.000Z"
}], nsNow), null, "an NS position older than 30 seconds must be rejected");
assert.ok(uiHasNsVehicleEndpointForTest(), "a dedicated NS vehicle endpoint must exist");
console.log("PASS: exact fresh NS train position matching and Qbuzz-safe segment matching");

// This simple local helper keeps the test independent of DOM globals.
function uiHasNsVehicleEndpointForTest() {
  return html.includes('/api/ns/vehicle-positions?') &&
    html.includes('sourceTimestampKnown === false');
}

const rdOrigin = rdNewToWgs84(155000, 463000);
assert.ok(rdOrigin);
assert.ok(Math.abs(rdOrigin.latitude - 52.1551744) < 1e-7);
assert.ok(Math.abs(rdOrigin.longitude - 5.38720621) < 1e-7);
const utrechtRd = rdNewToWgs84(136000, 455000);
assert.ok(utrechtRd && utrechtRd.latitude > 52.0 && utrechtRd.latitude < 52.2);
assert.ok(utrechtRd.longitude > 5.0 && utrechtRd.longitude < 5.3);
assert.equal(rdNewToWgs84(0, 0), null);

const ndovLeg = {
  mode: "BUS",
  routeId: "nl-OpenOV_146872",
  ndovRealtime: {
    kv6: {
      identity: "CXX|20261019|U073|89|0",
      source: "NDOV BISON KV6",
      eventType: "ONROUTE",
      rdX: "136000",
      rdY: "455000",
      positionTimestamp: "2026-10-19T08:13:50.000Z",
      positionReceivedAt: "2026-10-19T08:13:51.000Z",
      vehicleNumber: "2281",
    }
  }
};
const ndovNow = Date.parse("2026-10-19T08:14:00.000Z");
const ndovPosition = selectExactLiveNdovVehiclePosition(ndovLeg, ndovNow);
assert.ok(ndovPosition, "fresh exact NDOV coordinate observations should match without relying on an OpenOV trip ID");
assert.equal(ndovPosition.source, "NDOV BISON KV6");
assert.equal(ndovPosition.ageSeconds, 10);
assert.equal(ndovPosition.vehicleId, "2281");

assert.equal(selectExactLiveNdovVehiclePosition({
  ...ndovLeg,
  ndovRealtime: { kv6: { ...ndovLeg.ndovRealtime.kv6,
    positionTimestamp: "2026-10-19T08:12:00.000Z" } }
}, ndovNow), null, "an old source coordinate timestamp must be rejected even if the record was received recently");
assert.equal(selectExactLiveNdovVehiclePosition({
  ...ndovLeg,
  ndovRealtime: { kv6: { ...ndovLeg.ndovRealtime.kv6,
    positionReceivedAt: "2026-10-19T08:13:00.000Z" } }
}, ndovNow), null, "an old received coordinate pair must be rejected");
assert.equal(selectExactLiveNdovVehiclePosition({
  ...ndovLeg,
  ndovRealtime: { kv6: { ...ndovLeg.ndovRealtime.kv6,
    rdX: null, rdY: null } }
}, ndovNow), null, "a KV6 activity event without coordinates must not fabricate a position");
console.log("PASS: fresh NDOV KV6 RD coordinates produce a direct vehicle position; stale coordinates are rejected");

const polyline = decodeLivePolyline(
  "_p~iF~ps|U_ulLnnqC_mqNvxq" + String.fromCharCode(96) + "@",
  5
);
assert.equal(polyline.length, 3);
assert.deepEqual(Array.from(polyline, point => Array.from(point)), [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453]
]);
console.log("PASS: encoded Transitous route geometry decodes to map coordinates");

const dollar = String.fromCharCode(36);
assert.ok(html.includes('data-tracking-index="' + dollar + '{index}"'),
  "each expandable journey card must be wired to its tracking state");
assert.ok(html.includes('kind: "vehiclePositions"'),
  "the live map must keep OpenOV vehicle positions as a fallback");
assert.ok(html.includes('/api/ns/vehicle-positions?') &&
  html.includes('features=trein') === false,
  "the live map must call a separate backend endpoint for NS train positions");
assert.ok(html.includes('selectExactLiveNdovVehiclePosition(leg, now)'),
  "the live map must first use fresh exact-matched NDOV KV6 positions");
assert.ok(html.includes("LIVE_VEHICLE_MAX_AGE_SECONDS = 30"),
  "OpenOV fallback vehicle positions must be younger than 30 seconds");
assert.ok(html.includes("positionTimestamp") && html.includes("positionReceivedAt"),
  "NDOV coordinates must carry their own source/receive timestamps");
assert.ok(html.includes("LIVE_VEHICLE_POLL_MS = 10000"),
  "vehicle locations should refresh every 10 seconds while details are open");
assert.ok(html.includes("map.remove()"),
  "live maps must be disposed when a new plan replaces results");
assert.ok(html.includes('L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png"'),
  "map tiles must be served with an OpenStreetMap layer");
assert.ok(html.includes("renderLiveJourneyStopTimeline(legs)"),
  "each journey must include a per-stop time line");
console.log("PASS: live map markup, 10-second polling, route timeline and lifecycle are wired");
console.log("All live vehicle map selftests passed.");
