import assert from "node:assert/strict";
import { matchKv78RowByScheduleTime } from "../src/ndov-plan-cancellation.js";

const now = new Date().toISOString();
const index = {
  generatedAt: "2026-10-11T01:31:00Z",
  assignments: {
    "CXX|51112304": [{
      dataOwnerCode: "CXX",
      userStopCode: "51112304",
      quayCode: "NL:Q:51112304",
      quayRef: "NL:CHB:Quay:51112304",
      stopPlaceCode: "NL:S:51112302",
      stopPlaceRef: "NL:CHB:StopPlace:51112302",
      stopSideCode: "E",
      quayName: "Station Leidsche Rijn",
      validFrom: "2025-12-14 00:00:00",
      validThru: null,
    }],
  },
};
const row = {
  dataOwnerCode: "CXX",
  userStopCode: "51112304",
  targetDepartureTime: "17:01:00",
  expectedDepartureTime: "17:02:27",
  departureDelaySeconds: 87,
  receivedAt: now,
};
const context = {
  assignmentIndex: index,
  operationDate: "20261011",
  expectedStop: {
    parentId: "nl-OpenOV_NL:S:51112302",
    stopId: "nl-OpenOV_3924354",
    scheduledTrack: "E",
    track: "E",
  },
};

const matched = matchKv78RowByScheduleTime(
  [row], "2026-10-11T15:01:00Z", "targetDepartureTime", 180, context,
);
assert.ok(matched, "matching PSA/CHB quay on the correct stop must be accepted");
assert.equal(matched.stopAssignmentStatus, "confirmed_quay_platform");
assert.equal(matched.stopAssignment?.stopSideCode, "E");
assert.equal(matched.matchMethod, "PSA/CHB StopPlace + Quay/haltezijde + dienstregelingstijd");
console.log("PASS: CXX 51112304 resolves to Station Leidsche Rijn, side E via official PSA/CHB data");

const wrongSide = matchKv78RowByScheduleTime(
  [row], "2026-10-11T15:01:00Z", "targetDepartureTime", 180,
  { ...context, expectedStop: { ...context.expectedStop, scheduledTrack: "D", track: "D" } },
);
assert.equal(wrongSide, null, "wrong side of the same station must be rejected");
console.log("PASS: a different platform/side is rejected even when the timetable time matches");

const wrongStation = matchKv78RowByScheduleTime(
  [row], "2026-10-11T15:01:00Z", "targetDepartureTime", 180,
  { ...context, expectedStop: { ...context.expectedStop, parentId: "nl-OpenOV_NL:S:99999999" } },
);
assert.equal(wrongStation, null, "a different station must be rejected");
console.log("PASS: a different station is rejected even when the timetable time matches");

const timeOnly = matchKv78RowByScheduleTime(
  [row], "2026-10-11T15:01:00Z", "targetDepartureTime", 180,
);
assert.ok(timeOnly, "legacy callers without a PSA map keep backward-compatible time-only matching");
assert.equal(timeOnly.stopAssignmentStatus, "time_only_unverified");
console.log("PASS: legacy time-only callers remain compatible and are marked unverified");
