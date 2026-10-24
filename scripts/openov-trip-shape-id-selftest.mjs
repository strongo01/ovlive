import assert from "node:assert/strict";
import { openovTripShapeIdCandidates } from "../src/openov-trip-shape-id.js";

const zeroSeconds = openovTripShapeIdCandidates(
  "20261024_10:30:00_nl-OpenOV_380014114"
);
assert.deepEqual(zeroSeconds, [
  "20261024_10:30:00_nl-OpenOV_380014114",
  "20261024_10:30:00_380014114",
  "20261024_10:30_nl-OpenOV_380014114",
  "20261024_10:30_380014114"
], "only the same trip and service date may be tried without zero seconds");

const outerNamespace = openovTripShapeIdCandidates(
  "nl-OpenOV_20261024_25:15:00_380014114"
);
assert.ok(outerNamespace.includes("20261024_25:15:00_nl-OpenOV_380014114"),
  "a leading feed namespace must be translated to the Transitous trip-ID spelling");
assert.ok(outerNamespace.includes("20261024_25:15_380014114"),
  "overnight GTFS service times must retain their service date when seconds are omitted");

const differentTrip = openovTripShapeIdCandidates(
  "20261024_10:30:00_nl-OpenOV_380014114"
);
assert.ok(!differentTrip.some(candidate => candidate.includes("380014115")),
  "trip lookup aliases must never change the underlying trip ID");
assert.ok(!differentTrip.some(candidate => candidate.startsWith("20261025_")),
  "trip lookup aliases must never change the service date");

assert.deepEqual(openovTripShapeIdCandidates(""), []);
assert.deepEqual(openovTripShapeIdCandidates("x".repeat(257)), []);
console.log("PASS: exact OpenOV trip-ID aliases handle zero seconds and overnight GTFS times");
