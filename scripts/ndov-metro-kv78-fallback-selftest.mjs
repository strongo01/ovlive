import assert from "node:assert/strict";
import { applyNdovCancellationsToPlan } from "../src/ndov-plan-cancellation.js";

const now = new Date().toISOString();
const tripManifest = { generatedAt: now, shards: ["382"] };
const tripShard = { "382969686": "GVB:52:88783" };
const stopManifest = { schemaVersion: 1, generatedAt: now, shardCount: 16, assignmentCount: 2, assignmentKeyCount: 2 };
const stopPlaceManifest = { schemaVersion: 1, generatedAt: now, shardCount: 64, keyCount: 1 };
const bisonSnapshot = { state: "complete", latestMessageAt: now, storedKv6TripCount: 0, latestEvents: [] };
const kv78Snapshot = {
  state: "complete",
  latestMessageAt: now,
  storedKv78RowCount: 2,
  latestRows: [],
  kv78IdentityDiagnostics: {
    currentDate: "20261012",
    storedRecordCount: 2,
    currentDateRecordCount: 2,
    matchingRowCount: 2,
    identityCount: 1,
    byOwnerLine: [{ owner: "GVB", line: "52", tripCount: 1, rowCount: 2 }],
    trips: [{ identity: "GVB|20261012|52|88733|0", rowCount: 2, uniqueStopCount: 2, sampleStopCodes: ["09575", "09585"] }],
    comparisons: [],
  },
};
const stopAssignmentRecords = {
  "GVB|09575": [{
    dataOwnerCode: "GVB", userStopCode: "09575", quayCode: "NL:Q:30009575", quayRef: "NL:CHB:Quay:30009575",
    stopPlaceCode: "NL:S:30009575", stopPlaceRef: "NL:CHB:StopPlace:30009575",
    stopSideCode: null, quayName: "Centraal Station", validFrom: "2018-04-24 09:00:00", validThru: null,
  }],
  "GVB|09585": [{
    dataOwnerCode: "GVB", userStopCode: "09585", quayCode: "NL:Q:30009585", quayRef: "NL:CHB:Quay:30009585",
    stopPlaceCode: "NL:S:30007408", stopPlaceRef: "NL:CHB:StopPlace:30007408",
    stopSideCode: null, quayName: "Station Zuid", validFrom: "2018-04-24 10:00:00", validThru: null,
  }],
};
const assignmentShardByPath = {
  "stop-assignments-4.json": { assignments: { "GVB|09575": stopAssignmentRecords["GVB|09575"] } },
  "stop-assignments-3.json": { assignments: { "GVB|09585": stopAssignmentRecords["GVB|09585"] } },
};
const metroRow = (stopCode, stopOrder, extra = {}) => ({
  source: "KV78Turbo",
  receivedAt: now,
  dataOwnerCode: "GVB",
  operationDate: "2026-10-12",
  linePlanningNumber: "52",
  journeyNumber: "88733",
  fortifyOrderNumber: "0",
  userStopOrderNumber: String(stopOrder),
  userStopCode: stopCode,
  targetDepartureTime: null,
  expectedDepartureTime: null,
  departureDelaySeconds: null,
  targetArrivalTime: null,
  expectedArrivalTime: null,
  arrivalDelaySeconds: null,
  ...extra,
});
const correctMetroRows = [
  metroRow("09575", 1, {
    targetDepartureTime: "09:03:00",
    expectedDepartureTime: "09:06:00",
    departureDelaySeconds: 180,
  }),
  metroRow("09585", 9, {
    targetArrivalTime: "09:13:00",
    expectedArrivalTime: "09:15:00",
    arrivalDelaySeconds: 120,
  }),
];
let metroRowsForLookup = correctMetroRows;
const lineLookupRequests = [];

const env = {
  ASSETS: {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/ndov-trip-crosswalk/manifest.json")) return Response.json(tripManifest);
      if (pathname.endsWith("/ndov-trip-crosswalk/trips-382.json")) return Response.json(tripShard);

      if (pathname.endsWith("/ndov-stop-crosswalk/manifest.json")) return Response.json(stopManifest);
      const assignmentFile = pathname.match(/stop-assignments-\d+\.json$/)?.[0];
      if (assignmentFile) return Response.json(assignmentShardByPath[assignmentFile] ?? { assignments: {} });

      if (pathname.endsWith("/ndov-openov-stopplace-crosswalk/manifest.json")) return Response.json(stopPlaceManifest);
      if (pathname.endsWith("/openov-stop-places-6.json")) return Response.json({ stopPlaces: {} });
      if (pathname.endsWith("/openov-stop-places-56.json")) {
        return Response.json({
          stopPlaces: {
            "3980926": {
              stopPlaceCode: "NL:S:30007408",
              quayCode: "NL:Q:30009585",
              quayName: "Station Zuid",
              distanceMeters: 0.24,
              method: "exact_name_unique_stopplace_max_20m",
            },
          },
        });
      }
      return new Response("asset not found: " + pathname, { status: 404 });
    },
  },
  NDOV_FEEDS: {
    idFromName(name) { return name; },
    get() {
      return {
        async fetch(input) {
          const url = new URL(input);
          const stream = url.searchParams.get("stream");
          if (url.pathname === "/status" && stream === "bison" && url.searchParams.get("identityDiagnostics") === "1") {
            return Response.json({
              ...bisonSnapshot,
              bisonIdentityDiagnostics: { currentDate: "20261012", storedTripCount: 0, matchingTripCount: 0, byOwnerLine: [], trips: [] },
            });
          }
          if (url.pathname === "/status" && stream === "bison") return Response.json(bisonSnapshot);
          if (url.pathname === "/status" && stream === "kv78") return Response.json(kv78Snapshot);
          if (url.pathname === "/mutations" && stream === "bison") return Response.json({ mutations: [] });
          if (url.pathname === "/events" && stream === "bison") return Response.json({ events: [] });
          if (url.pathname === "/rows" && stream === "kv78") {
            if (url.searchParams.get("lineLookup") === "1") {
              lineLookupRequests.push(url);
              assert.equal(url.searchParams.get("owner"), "GVB");
              assert.equal(url.searchParams.get("date"), "20261012");
              assert.equal(url.searchParams.get("line"), "52");
              assert.equal(url.searchParams.getAll("scheduledTime").length, 2);
              return Response.json({ rows: metroRowsForLookup, lookup: { mode: "line_schedule_times" } });
            }
            return Response.json({ rows: [] });
          }
          return new Response("unexpected mock request: " + url.pathname, { status: 404 });
        },
      };
    },
  },
};

function metroPlan(mode = "SUBWAY") {
  return {
    itineraries: [{
      legs: [{
        mode,
        tripId: "20261012_09:03_nl-OpenOV_382969686",
        from: {
          stopId: "3979722",
          name: "Amsterdam, Centraal Station",
          departure: "2026-10-12T07:03:00Z",
        },
        to: {
          stopId: "3980926",
          name: "Amsterdam, Station Zuid",
          arrival: "2026-10-12T07:13:00Z",
        },
      }],
    }],
  };
}

const workingPlan = metroPlan();
await applyNdovCancellationsToPlan(workingPlan, env);
const workingLeg = workingPlan.itineraries[0].legs[0];
assert.equal(workingLeg.ndovRealtime?.status, "kv78_delay",
  "metro realtime should be recovered when line/date, unique scheduled endpoint time and official PSA/CHB stop identity agree");
assert.equal(workingLeg.ndovRealtime?.matchBasis, "line_stop_time_crossmatch");
assert.equal(workingLeg.ndovRealtime?.matchedKv78TripIdentity, "GVB|20261012|52|88733|0");
assert.equal(workingLeg.ndovRealtime?.departure?.delaySeconds, 180);
assert.equal(workingLeg.ndovRealtime?.arrival?.delaySeconds, 120);
assert.match(workingLeg.ndovRealtime?.freshnessNote ?? "", /De live KV78-rit GVB\|20261012\|52\|88733\|0/);
assert.equal(lineLookupRequests.length, 1);
console.log("PASS: metro line/time fallback resolves the live KV78 trip only with an official stop match");

metroRowsForLookup = [
  correctMetroRows[0],
  { ...correctMetroRows[1], journeyNumber: "88734" },
];
const mismatchedPlan = metroPlan();
await applyNdovCancellationsToPlan(mismatchedPlan, env);
const mismatchedLeg = mismatchedPlan.itineraries[0].legs[0];
assert.notEqual(mismatchedLeg.ndovRealtime?.matchBasis, "line_stop_time_crossmatch",
  "departure and arrival from different KV78 journeys must never be combined");
assert.notEqual(mismatchedLeg.ndovRealtime?.status, "kv78_delay",
  "a mixed-trip endpoint pair must not produce a metro realtime status");
console.log("PASS: metro fallback rejects departure/arrival rows from different live trips");

const callsBeforeBus = lineLookupRequests.length;
const busPlan = metroPlan("BUS");
await applyNdovCancellationsToPlan(busPlan, env);
assert.equal(lineLookupRequests.length, callsBeforeBus,
  "line/date/time identity fallback is restricted to metro/subway legs");
assert.notEqual(busPlan.itineraries[0].legs[0].ndovRealtime?.matchBasis, "line_stop_time_crossmatch");
console.log("PASS: metro line/time fallback does not affect bus legs");
console.log("All metro KV78 fallback selftests passed.");
