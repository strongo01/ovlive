import assert from "node:assert/strict";
import "../public/realtime-transfer-assistant.js";

const assistant = globalThis.OVLiveRealtimeTransferAssistant;
assert.ok(assistant, "the browser transfer assistant helper must be available to Node tests");

const nowMs = Date.parse("2026-10-21T12:30:00Z");
const walkingDurationSeconds = (distanceMeters, speedKmh = 5) =>
  Math.round(distanceMeters / (speedKmh / 3.6));
const plannedEndpointTime = (leg, kind) => kind === "departure"
  ? (leg.scheduledDeparture ?? leg.from?.scheduledDeparture ?? leg.startTime ?? null)
  : (leg.scheduledArrival ?? leg.to?.scheduledArrival ?? leg.endTime ?? null);
const baseOptions = {
  nowMs,
  walkingSpeedKmh: 5,
  walkingDurationSeconds,
  plannedEndpointTime,
  timelineRealtimePrediction: () => null
};
const rail = {
  mode: "RAIL",
  routeShortName: "IC",
  scheduledArrival: "2026-10-21T12:34:00Z",
  to: { id: "station-a", name: "Station A" }
};
const walk100m = {
  mode: "WALK",
  distance: 100,
  startTime: "2026-10-21T12:34:00Z",
  endTime: "2026-10-21T12:35:12Z"
};
const bus = {
  mode: "BUS",
  routeShortName: "28",
  scheduledDeparture: "2026-10-21T12:37:00Z",
  from: { id: "station-b", name: "Station A, perron B" }
};

const tight = assistant.analyze([rail, walk100m, bus], baseOptions)[0];
assert.equal(tight.walkingKnown, true);
assert.equal(tight.walkingSeconds, 72, "walking time must use 100 m at the selected 5 km/h");
assert.equal(tight.scheduledSlackSeconds, 108, "remaining transfer time must exclude walking time");
assert.equal(tight.status, "tight", "a connection with less than two minutes left after walking is risky");
assert.equal(tight.timeBasis, "schedule", "a schedule-only result must not be labelled realtime");

const lateRail = {
  ...rail,
  scheduledArrival: "2026-10-21T12:36:00Z"
};
const impossible = assistant.analyze([lateRail, walk100m, bus], baseOptions)[0];
assert.equal(impossible.slackSeconds, -72);
assert.equal(impossible.status, "unreachable", "a delayed arrival plus walking must mark the transfer as infeasible");

const delayedBus = {
  ...bus,
  scheduledDeparture: "2026-10-21T12:40:00Z"
};
const recovered = assistant.analyze([lateRail, walk100m, delayedBus], baseOptions)[0];
assert.equal(recovered.slackSeconds, 168);
assert.equal(recovered.status, "feasible", "a later departure can make a delayed transfer feasible");

const realtimeRecovery = assistant.analyze([lateRail, walk100m, bus], {
  ...baseOptions,
  timelineRealtimePrediction: (leg, kind) => {
    if (leg === lateRail && kind === "arrival") {
      return { time: "2026-10-21T12:35:00Z", source: "Test realtime" };
    }
    if (leg === bus && kind === "departure") {
      return { time: "2026-10-21T12:39:00Z", source: "Test realtime" };
    }
    return null;
  }
})[0];
assert.equal(realtimeRecovery.timeBasis, "realtime");
assert.equal(realtimeRecovery.slackSeconds, 168);
assert.equal(realtimeRecovery.status, "feasible",
  "fresh realtime arrival and departure predictions must drive the live result");

const samePlatform = assistant.analyze([
  {
    mode: "RAIL",
    scheduledArrival: "2026-10-21T12:34:00Z",
    to: { id: "nl-OpenOV_123", name: "Station A" }
  },
  {
    mode: "TRAM",
    scheduledDeparture: "2026-10-21T12:38:00Z",
    from: { id: "123", name: "Station A" }
  }
], baseOptions)[0];
assert.equal(samePlatform.walkingKnown, true,
  "a missing walk leg may be treated as zero only when the stop identifiers match");
assert.equal(samePlatform.walkingSeconds, 0);

const unknownWalk = assistant.analyze([
  rail,
  {
    mode: "WALK",
    startTime: "2026-10-21T12:34:00Z",
    endTime: null
  },
  bus
], baseOptions)[0];
assert.equal(unknownWalk.walkingKnown, false);
assert.equal(unknownWalk.status, "unknown",
  "the assistant must not claim a transfer is catchable when the walking time is unknown");

const cancelled = assistant.analyze([
  { ...rail, nsRealtime: { status: "cancelled" } },
  walk100m,
  bus
], baseOptions)[0];
assert.equal(cancelled.status, "cancelled",
  "an explicitly cancelled leg must take precedence over a timetable-only assessment");

assert.equal(assistant.samePlace(
  { stopId: "nl-OpenOV_3924355", name: "Station A" },
  { id: "3924355", name: "Other label" }
), true, "OpenOV prefixes must not prevent exact stop matching");
assert.equal(assistant.samePlace(
  { id: "platform-a", name: "Station A" },
  { id: "platform-b", name: "Station A" }
), false, "different explicit platform IDs must not be collapsed by matching names");

console.log("PASS: transfer analysis includes walking duration and remaining connection slack");
console.log("PASS: delayed and live predictions can change a connection from missed to feasible");
console.log("PASS: unknown walking durations and cancellations never claim a connection is safe");
console.log("PASS: exact stop identity is required when platform IDs are available");
