import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const source = await readFile(
  new URL("../src/openov-vehicle-position-fast-decode.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = "data:text/javascript;base64," +
  Buffer.from(compiled).toString("base64");
const { decodeOpenovVehiclePositions } = await import(moduleUrl);
const rt = GtfsRealtimeBindings.transit_realtime;

function numeric(value) {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function normalizeWithGeneratedDecoder(bytes) {
  const feed = rt.FeedMessage.decode(bytes);
  const feedTimestamp = numeric(feed.header?.timestamp);
  const entities = (feed.entity ?? []).map((entity) => ({
    entityId: entity.id,
    vehicleId: entity.vehicle?.vehicle?.id,
    tripId: entity.vehicle?.trip?.tripId,
    routeId: entity.vehicle?.trip?.routeId,
    startDate: entity.vehicle?.trip?.startDate,
    startTime: entity.vehicle?.trip?.startTime,
    directionId: entity.vehicle?.trip?.directionId,
    stopId: entity.vehicle?.stopId,
    latitude: entity.vehicle?.position?.latitude,
    longitude: entity.vehicle?.position?.longitude,
    timestamp: numeric(entity.vehicle?.timestamp)
  })).filter((entity) => entity.vehicleId || entity.tripId || entity.latitude != null);

  return { feedTimestamp, entities };
}

const feedTimestamp = 1_792_450_000;
const positionTimestamp = feedTimestamp - 7;
const feedObject = {
  header: { gtfsRealtimeVersion: "2.0", timestamp: feedTimestamp },
  entity: [
    {
      id: "vehicle-28-a",
      vehicle: {
        trip: {
          tripId: "391215411",
          routeId: "159450",
          startDate: "20261019",
          startTime: "19:03:00",
          directionId: 1
        },
        vehicle: { id: "UOV-2801", label: "Bus 28" },
        position: { latitude: 52.09303283691406, longitude: 5.100654602050781, bearing: 180 },
        timestamp: positionTimestamp,
        stopId: "3923827",
        currentStatus: 2,
        occupancyStatus: 1
      }
    },
    {
      id: "vehicle-without-trip-but-coordinate",
      vehicle: {
        position: { latitude: 52.1, longitude: 5.1 },
        timestamp: positionTimestamp - 1,
        stopId: "3920000"
      }
    },
    {
      id: "entity-with-trip-only",
      vehicle: { trip: { tripId: "trip-only" } }
    },
    {
      id: "empty-vehicle-position",
      vehicle: { timestamp: positionTimestamp }
    },
    {
      id: "not-a-vehicle-position",
      tripUpdate: {
        trip: { tripId: "391215411", routeId: "159450" },
        stopTimeUpdate: [{ stopId: "3923827", departure: { time: positionTimestamp } }]
      }
    },
    { id: "deleted-entity", isDeleted: true }
  ]
};
const bytes = rt.FeedMessage.encode(feedObject).finish();
const fast = decodeOpenovVehiclePositions(new Uint8Array(bytes));
const generated = normalizeWithGeneratedDecoder(bytes);

// Exact parity against the generated GTFS-Realtime decoder: same header
// timestamp, same retained entities, and same identity / coordinate fields.
assert.deepEqual(fast, generated);
assert.equal(fast.feedTimestamp, feedTimestamp);
assert.equal(fast.entities.length, 3);
assert.deepEqual(fast.entities[0], {
  entityId: "vehicle-28-a",
  vehicleId: "UOV-2801",
  tripId: "391215411",
  routeId: "159450",
  startDate: "20261019",
  startTime: "19:03:00",
  directionId: 1,
  stopId: "3923827",
  latitude: 52.09303283691406,
  longitude: 5.100654602050781,
  timestamp: positionTimestamp
});
console.log("PASS: selective decoder matches GTFS-Realtime decoder for exact vehicle identity and coordinates");
console.log("PASS: non-vehicle entities and empty VehiclePosition messages are skipped");
console.log("PASS: feed timestamp and per-vehicle timestamp are preserved independently");

// Malformed/truncated protobuf input must fail explicitly; the Worker can then
// invoke its logged compatibility fallback rather than silently returning bad data.
assert.throws(
  () => decodeOpenovVehiclePositions(Uint8Array.from([0x12, 0xff])),
  /GTFS-Realtime protobuf/
);
console.log("PASS: truncated protobuf input is rejected for the logged fallback path");
console.log("All OpenOV vehicle-position fast-decode selftests passed.");
