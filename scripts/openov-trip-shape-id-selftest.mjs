import assert from "node:assert/strict";
import { openovTripShapeIdCandidates } from "../src/openov-trip-shape-id.js";

const zeroSeconds = openovTripShapeIdCandidates(
  "20261024_10:30:00_nl-OpenOV_380014114"
);
assert.deepEqual(zeroSeconds, [
  "20261024_10:30:00_nl-OpenOV_380014114",
  "20261024_10:30_nl-OpenOV_380014114"
], "only canonical, date-wrapped Transitous trip IDs should be tried");

const minuteOnly = openovTripShapeIdCandidates(
  "20261024_10:30_nl-OpenOV_380014114"
);
assert.deepEqual(minuteOnly, [
  "20261024_10:30_nl-OpenOV_380014114",
  "20261024_10:30:00_nl-OpenOV_380014114"
], "a minute-only trip ID may try the equivalent zero-seconds spelling");

const withoutInnerNamespace = openovTripShapeIdCandidates(
  "20261024_10:30_380014114"
);
assert.deepEqual(withoutInnerNamespace, [
  "20261024_10:30_nl-OpenOV_380014114",
  "20261024_10:30:00_nl-OpenOV_380014114"
], "an untagged trip ID must be canonicalized before being sent to Transitous");

const outerNamespace = openovTripShapeIdCandidates(
  "nl-OpenOV_20261024_25:15:00_380014114"
);
assert.deepEqual(outerNamespace, [
  "20261024_25:15:00_nl-OpenOV_380014114",
  "20261024_25:15_nl-OpenOV_380014114"
], "outer feed namespace and overnight times must be converted to the canonical Transitous ID");

assert.deepEqual(
  openovTripShapeIdCandidates("nl-OpenOV_380014114"),
  [],
  "a bare namespaced trip ID is incomplete and must not be sent to /trip"
);
assert.deepEqual(openovTripShapeIdCandidates("380014114"), [],
  "a bare numeric trip ID must never be used as a /trip identifier");
assert.deepEqual(openovTripShapeIdCandidates(""), []);
assert.deepEqual(openovTripShapeIdCandidates("x".repeat(257)), []);
console.log("PASS: only canonical date-wrapped Transitous trip IDs and zero-seconds aliases are generated");
