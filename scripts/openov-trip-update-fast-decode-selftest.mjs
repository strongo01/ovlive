import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const source = await readFile(
  new URL("../src/openov-trip-update-fast-decode.ts", import.meta.url),
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
const { decodeOpenovTripUpdates } = await import(moduleUrl);
const rt = GtfsRealtimeBindings.transit_realtime;

function numeric(value) {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function enumName(enumObject, value) {
  if (value == null) return undefined;
  return typeof value === "string" ? value : enumObject?.[value];
}

function normalizeGeneratedFeed(feed) {
  const rows = [];
  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const trip = tu.trip ?? {};
    const rawStopUpdates = (tu.stopTimeUpdate ?? []).map((s) => ({
      stopId: s.stopId,
      stopSequence: s.stopSequence,
      arrivalTime: numeric(s.arrival?.time),
      arrivalDelaySeconds: s.arrival?.delay,
      departureTime: numeric(s.departure?.time),
      departureDelaySeconds: s.departure?.delay,
      scheduleRelationship: enumName(rt.TripUpdate?.StopTimeUpdate?.ScheduleRelationship, s.scheduleRelationship)
    }));
    let propagatedDelaySeconds =
      typeof tu.delay === "number" && Number.isFinite(tu.delay)
        ? tu.delay
        : undefined;
    const stopUpdates = rawStopUpdates.map((stop) => {
      const ownArrivalDelay =
        typeof stop.arrivalDelaySeconds === "number" && Number.isFinite(stop.arrivalDelaySeconds)
          ? stop.arrivalDelaySeconds
          : undefined;
      const ownDepartureDelay =
        typeof stop.departureDelaySeconds === "number" && Number.isFinite(stop.departureDelaySeconds)
          ? stop.departureDelaySeconds
          : undefined;
      const explicitDelay = ownDepartureDelay ?? ownArrivalDelay;
      if (explicitDelay !== undefined) propagatedDelaySeconds = explicitDelay;
      const noData = String(stop.scheduleRelationship ?? "").toUpperCase() === "NO_DATA";
      const inheritedDelay = noData ? undefined : propagatedDelaySeconds;
      return {
        ...stop,
        effectiveArrivalDelaySeconds: ownArrivalDelay ?? inheritedDelay,
        effectiveDepartureDelaySeconds: ownDepartureDelay ?? inheritedDelay
      };
    });
    rows.push({
      entityId: entity.id,
      tripId: trip.tripId,
      routeId: trip.routeId,
      startDate: trip.startDate,
      startTime: trip.startTime,
      directionId: trip.directionId,
      scheduleRelationship: enumName(rt.TripDescriptor?.ScheduleRelationship, trip.scheduleRelationship),
      delaySeconds: tu.delay,
      vehicleId: tu.vehicle?.id,
      timestamp: (() => {
        const value = numeric(tu.timestamp);
        return value != null && value > 0 ? value : undefined;
      })(),
      stopUpdates
    });
  }
  return rows;
}

const feedTimestamp = 1_792_450_000;
const updateTimestamp = feedTimestamp - 4;
const feedObject = {
  header: { gtfsRealtimeVersion: "2.0", timestamp: feedTimestamp },
  entity: [
    {
      id: "target-trip",
      tripUpdate: {
        trip: {
          tripId: "391215411",
          routeId: "159450",
          startDate: "20261019",
          startTime: "19:03:00",
          directionId: 1,
          scheduleRelationship: "SCHEDULED"
        },
        vehicle: { id: "UOV-2801", label: "Bus 28" },
        timestamp: updateTimestamp,
        delay: 38,
        stopTimeUpdate: [
          {
            stopSequence: 1,
            stopId: "3923827",
            arrival: { time: feedTimestamp + 60, delay: -45 },
            departure: { time: feedTimestamp + 90, delay: -30 }
          },
          {
            stopSequence: 2,
            stopId: "3923899",
            scheduleRelationship: 2
          },
          {
            stopSequence: 3,
            stopId: "3923922",
            arrival: { time: feedTimestamp + 420, delay: 55 }
          }
        ]
      }
    },
    {
      id: "route-date-fallback",
      tripUpdate: {
        trip: {
          tripId: "another-trip-same-route-date",
          routeId: "159450",
          startDate: "20261019",
          startTime: "19:18:00",
          directionId: 1
        },
        timestamp: updateTimestamp - 1,
        delay: -12,
        stopTimeUpdate: [{
          stopSequence: 1,
          stopId: "3923827",
          departure: { time: feedTimestamp + 900, delay: -12 }
        }]
      }
    },
    {
      id: "unrelated-trip",
      tripUpdate: {
        trip: {
          tripId: "unrelated",
          routeId: "999999",
          startDate: "20261020",
          startTime: "19:03:00",
          directionId: 0
        },
        timestamp: updateTimestamp,
        delay: 0,
        stopTimeUpdate: [{
          stopSequence: 1,
          stopId: "elsewhere",
          departure: { time: feedTimestamp + 60, delay: 0 }
        }]
      }
    },
    {
      id: "non-trip-update",
      alert: { headerText: { translation: [{ text: "Testmelding", language: "nl" }] } }
    }
  ]
};

const bytes = rt.FeedMessage.encode(feedObject).finish();
const generated = rt.FeedMessage.decode(bytes);
const expected = normalizeGeneratedFeed(generated);
const full = decodeOpenovTripUpdates(new Uint8Array(bytes));
assert.equal(full.feedTimestamp, feedTimestamp);
assert.equal(full.sourceEntityCount, 3);
assert.deepEqual(full.entities, expected);
console.log("PASS: selective trip-update decoder matches GTFS-Realtime decoder for full-feed fields");
console.log("PASS: signed early/late delays and NO_DATA inheritance retain their exact meaning");

const filtered = decodeOpenovTripUpdates(new Uint8Array(bytes), {
  tripIds: new Set(["391215411"]),
  routeDateKeys: new Set(["159450|20261019"])
});
assert.equal(filtered.feedTimestamp, feedTimestamp);
assert.equal(filtered.sourceEntityCount, 3);
assert.deepEqual(
  filtered.entities,
  expected.filter((row) =>
    row.tripId === "391215411" ||
    (row.routeId === "159450" && row.startDate === "20261019")
  )
);
assert.equal(filtered.entities.length, 2);
assert.ok(filtered.entities.every((row) => row.routeId === "159450"));
// Keep this log output stable so CI confirms the selective decoder path.
console.log("PASS: targeted decoding keeps exact trips and same-route/service-date fallback candidates");
console.log("PASS: unrelated route/date updates do not allocate normalized stop-update arrays");
console.log("All OpenOV trip-update fast-decode selftests passed.");
