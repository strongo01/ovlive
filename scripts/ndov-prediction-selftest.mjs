import assert from "node:assert/strict";
import {
  buildUnifiedRealtimePrediction,
  deriveNdovKv6Prediction,
  getNdovPredictionStopIds,
} from "../src/ndov-prediction.js";

const nowMs = Date.parse("2026-10-12T09:30:20.000Z");
const leg = {
  from: { stopId: "nl-OpenOV_3924354", scheduledDeparture: "2026-10-12T09:30:00.000Z", departure: "2026-10-12T09:30:00.000Z" },
  to: { stopId: "nl-OpenOV_3924355", scheduledArrival: "2026-10-12T09:50:00.000Z", arrival: "2026-10-12T09:50:00.000Z" },
};
const pattern = {
  realtimeTripId: "CXX:U073:89",
  stops: [
    { stopId: "3924353", stopSequence: 1, arrivalTime: "11:20:00", departureTime: "11:20:00" },
    { stopId: "3924354", stopSequence: 2, arrivalTime: "11:30:00", departureTime: "11:30:00" },
    { stopId: "3924355", stopSequence: 3, arrivalTime: "11:50:00", departureTime: "11:50:00" },
    { stopId: "3924356", stopSequence: 4, arrivalTime: "12:00:00", departureTime: "12:00:00" },
  ],
};
const event = {
  dataOwnerCode: "CXX", operationDate: "2026-10-12", linePlanningNumber: "U073", journeyNumber: "89",
  eventType: "ONSTOP", userStopCode: "59250254", punctualitySeconds: 20,
  timestamp: "2026-10-12T11:30:20+02:00", punctualityTimestamp: "2026-10-12T11:30:20+02:00",
  receivedAt: "2026-10-12T09:30:20.000Z", punctualityReceivedAt: "2026-10-12T09:30:20.000Z",
};
const assignmentIndex = { assignments: { "CXX|59250254": [{
  dataOwnerCode: "CXX", userStopCode: "59250254", stopPlaceCode: "NL:S:123",
  stopPlaceRef: "NL:CHB:StopPlace:123", quayCode: "NL:Q:ABC", quayRef: "NL:CHB:Quay:ABC",
  validFrom: "2025-12-14 00:00:00", validThru: null,
}] } };
const stopPlaceIndex = { stopPlaces: {
  "3924353": { stopPlaceCode: "NL:S:122", quayCode: "NL:Q:OLD" },
  "3924354": { stopPlaceCode: "NL:S:123", quayCode: "NL:Q:ABC" },
  "3924355": { stopPlaceCode: "NL:S:124", quayCode: "NL:Q:DEF" },
  "3924356": { stopPlaceCode: "NL:S:125", quayCode: "NL:Q:GHI" },
} };

{
  const ids = getNdovPredictionStopIds(leg, pattern, event, 20);
  assert.ok(ids.includes("3924354"));
  assert.ok(ids.includes("3924355"));
  assert.ok(!ids.includes("3924353"), "a stop 10 minutes away from the measured timestamp must not expand the lookup window");
  assert.ok(!ids.includes("3924356"), "a stop 10 minutes away from the measured timestamp must not expand the lookup window");
  assert.ok(ids.length < pattern.stops.length, "crosswalk reads must be bounded to target and nearby timetable stops");
  const prediction = deriveNdovKv6Prediction({
    leg, pattern, event, assignmentIndex, stopPlaceIndex, operationDate: "20261012", nowMs,
  });
  assert.ok(prediction, "fresh exact trip + official quay + unique route position should produce a projection");
  assert.equal(prediction.confidence, "high");
  assert.equal(prediction.measuredDelaySeconds, 20);
  assert.equal(prediction.currentStop.stopId, "3924354");
  assert.equal(prediction.departure.delaySeconds, 20);
  assert.equal(prediction.arrival.delaySeconds, 20);
  assert.equal(prediction.departure.time, "2026-10-12T09:30:20.000Z");
  assert.equal(prediction.arrival.time, "2026-10-12T09:50:20.000Z");
  console.log("PASS: fresh KV6 delay projects only after an official PSA/CHB quay match");
}

{
  const { "3924354": omittedMapping, ...withoutCurrentStopMapping } = stopPlaceIndex.stopPlaces;
  const fallbackEvent = { ...event, eventType: "DEPARTURE" };
  const prediction = deriveNdovKv6Prediction({
    leg,
    pattern,
    event: fallbackEvent,
    assignmentIndex,
    stopPlaceIndex: { stopPlaces: withoutCurrentStopMapping },
    operationDate: "20261012",
    nowMs,
  });
  assert.ok(prediction, "unique near-exact stop time plus active official PSA/CHB quay should resolve a missing static OpenOV mapping");
  assert.equal(prediction.confidence, "medium");
  assert.match(prediction.method, /scheduled stop time.*PSA\/CHB quay.*mapping missing/i);
  assert.equal(prediction.currentStop.stopId, "3924354");
  assert.equal(prediction.currentStop.stopPlaceCode, "NL:S:123");
  assert.equal(prediction.currentStop.quayCode, "ABC");
  assert.equal(prediction.arrival.delaySeconds, 20);
  console.log("PASS: unique stop-time fallback handles missing OpenOV mapping with medium confidence");

  const nonStopEvent = { ...fallbackEvent, eventType: "ONSTOP" };
  let nonStopFailureReason = null;
  assert.equal(deriveNdovKv6Prediction({
    leg,
    pattern,
    event: nonStopEvent,
    assignmentIndex,
    stopPlaceIndex: { stopPlaces: withoutCurrentStopMapping },
    operationDate: "20261012",
    nowMs,
    onFailure: (reason) => { nonStopFailureReason = reason; },
  }), null, "schedule-time fallback must not be used for ONSTOP events without a static mapping");
  assert.equal(
    nonStopFailureReason,
    "missing_static_stop_mapping_for_non_stop_event",
    "a missing projection must expose why the safe stop-time fallback was rejected",
  );

  const conflictingStopPlaces = {
    ...stopPlaceIndex.stopPlaces,
    "3924354": { stopPlaceCode: "NL:S:123", quayCode: "NL:Q:OTHER" },
  };
  const conflictPrediction = deriveNdovKv6Prediction({
    leg,
    pattern,
    event: fallbackEvent,
    assignmentIndex,
    stopPlaceIndex: { stopPlaces: conflictingStopPlaces },
    operationDate: "20261012",
    nowMs,
  });
  assert.equal(conflictPrediction, null, "a present but conflicting static stop mapping must never be bypassed");
  console.log("PASS: fallback rejects ONSTOP-only evidence and conflicting static quay mappings");
}

{
  const atDestination = {
    ...event, userStopCode: "59250255",
    timestamp: "2026-10-12T11:50:20+02:00", punctualityTimestamp: "2026-10-12T11:50:20+02:00",
    receivedAt: "2026-10-12T09:50:20.000Z", punctualityReceivedAt: "2026-10-12T09:50:20.000Z",
  };
  const targetAssignments = { assignments: { "CXX|59250255": [{
    dataOwnerCode: "CXX", userStopCode: "59250255", stopPlaceCode: "NL:S:124",
    quayCode: "NL:Q:DEF", validFrom: "2025-12-14 00:00:00", validThru: null,
  }] } };
  const prediction = deriveNdovKv6Prediction({
    leg, pattern, event: atDestination, assignmentIndex: targetAssignments, stopPlaceIndex,
    operationDate: "20261012", nowMs: Date.parse("2026-10-12T09:50:20.000Z"),
  });
  assert.ok(prediction);
  assert.equal(prediction.departure, null, "a passed boarding stop must not get a new forecast");
  assert.equal(prediction.arrival.delaySeconds, 20);
  console.log("PASS: a passed boarding stop is not forecast as still ahead");
}

{
  const wrongQuay = { assignments: { "CXX|59250254": [{
    dataOwnerCode: "CXX", userStopCode: "59250254", stopPlaceCode: "NL:S:123",
    quayCode: "NL:Q:WRONG", validFrom: "2025-12-14 00:00:00", validThru: null,
  }] } };
  assert.equal(deriveNdovKv6Prediction({
    leg, pattern, event, assignmentIndex: wrongQuay, stopPlaceIndex, operationDate: "20261012", nowMs,
  }), null, "a conflicting official quay must fail closed");
  const staleEvent = {
    ...event, receivedAt: "2026-10-12T09:26:00.000Z", punctualityReceivedAt: "2026-10-12T09:26:00.000Z",
  };
  assert.equal(deriveNdovKv6Prediction({
    leg, pattern, event: staleEvent, assignmentIndex, stopPlaceIndex, operationDate: "20261012", nowMs,
  }), null, "stale punctuality must not be projected");
  console.log("PASS: wrong quay and stale KV6 events never produce a prediction");
}

{
  const ambiguousPattern = { ...pattern, stops: [
    pattern.stops[0], pattern.stops[1],
    { stopId: "3924357", stopSequence: 3, arrivalTime: "11:33:00", departureTime: "11:33:00" },
    pattern.stops[2], pattern.stops[3],
  ] };
  const ambiguousStopPlaces = { stopPlaces: {
    ...stopPlaceIndex.stopPlaces, "3924357": { stopPlaceCode: "NL:S:123" },
  } };
  const noQuayAssignments = { assignments: { "CXX|59250254": [{
    dataOwnerCode: "CXX", userStopCode: "59250254", stopPlaceCode: "NL:S:123",
    validFrom: "2025-12-14 00:00:00", validThru: null,
  }] } };
  assert.equal(deriveNdovKv6Prediction({
    leg, pattern: ambiguousPattern, event, assignmentIndex: noQuayAssignments,
    stopPlaceIndex: ambiguousStopPlaces, operationDate: "20261012", nowMs,
  }), null, "repeated place-only stops must remain ambiguous");
  console.log("PASS: ambiguous StopPlace-only route matches remain unknown");
}

{
  const combinedLeg = {
    ...leg,
    openovRealtime: {
      status: "matched", timestampBasis: "trip_update", updateAgeSeconds: 5,
      departure: { time: "2026-10-12T09:31:00.000Z", delaySeconds: 60, delayBasis: "absolute_prediction_minus_scheduled_time" },
      arrival: { time: "2026-10-12T09:51:00.000Z", delaySeconds: 60, delayBasis: "gtfsrt_propagated_from_prior_stop_update" },
    },
    ndovRealtime: {
      status: "kv6_live",
      prediction: {
        departure: { time: "2026-10-12T09:32:00.000Z", delaySeconds: 120, source: "NDOV BISON KV6" },
        arrival: { time: "2026-10-12T09:52:00.000Z", delaySeconds: 120, source: "NDOV BISON KV6" },
      },
      kv78: {
        departure: { delaySeconds: 180, receivedAt: new Date().toISOString(), stopAssignmentStatus: "confirmed_quay_platform" },
      },
    },
  };
  const unified = buildUnifiedRealtimePrediction(combinedLeg, "2026-10-12T09:30:20.000Z");
  assert.equal(unified.departure.source, "OpenOV GTFS-Realtime", "direct target-stop predictions should outrank a projected delay");
  assert.equal(unified.departure.time, "2026-10-12T09:31:00.000Z");
  assert.equal(unified.arrival.source, "NDOV BISON KV6", "fresh measured punctuality should outrank OpenOV propagation from an earlier stop");
  assert.equal(unified.arrival.time, "2026-10-12T09:52:00.000Z");
  console.log("PASS: unified predictions prefer direct stop predictions over weaker propagation");
}

{
  const feedHeaderOnlyLeg = {
    ...leg,
    openovRealtime: {
      status: "matched",
      timestampBasis: "feed_header",
      updateAgeSeconds: 5,
      freshnessNote: "De timestamp per rit ontbreekt; de versheid is afgeleid van de feed-header.",
      departure: {
        time: "2026-10-12T09:31:00.000Z",
        delaySeconds: 60,
        delayBasis: "absolute_prediction_minus_scheduled_time",
      },
      arrival: {
        time: "2026-10-12T09:51:00.000Z",
        delaySeconds: 60,
        delayBasis: "absolute_prediction_minus_scheduled_time",
      },
    },
  };
  const unconfirmedOnly = buildUnifiedRealtimePrediction(feedHeaderOnlyLeg, "2026-10-12T09:30:20.000Z");
  assert.equal(
    unconfirmedOnly.departure.source,
    "OpenOV GTFS-Realtime (rit-timestamp ontbreekt)",
    "feed-header-only predictions must be visibly marked unconfirmed",
  );
  assert.equal(unconfirmedOnly.departure.confidence, "low");
  assert.equal(unconfirmedOnly.departure.hasPerTripTimestamp, false);

  const independentlyConfirmedLeg = {
    ...feedHeaderOnlyLeg,
    ndovRealtime: {
      status: "kv6_live",
      prediction: {
        departure: { time: "2026-10-12T09:32:00.000Z", delaySeconds: 120, source: "NDOV BISON KV6" },
      },
    },
  };
  const independentlyConfirmed = buildUnifiedRealtimePrediction(
    independentlyConfirmedLeg,
    "2026-10-12T09:30:20.000Z",
  );
  assert.equal(
    independentlyConfirmed.departure.source,
    "NDOV BISON KV6",
    "a fresh independent NDOV projection must outrank OpenOV data without a per-trip timestamp",
  );
  console.log("PASS: feed-header-only OpenOV predictions are downgraded and clearly labelled");
}


{
  const now = Date.now();
  const staleOpenov = {
    status: "matched",
    timestampBasis: "trip_update",
    updateAgeSeconds: 95,
    departure: {
      time: new Date(now + 60_000).toISOString(),
      delaySeconds: 60,
      delayBasis: "absolute_prediction_minus_scheduled_time",
    },
  };
  const freshNdov = {
    status: "kv6_live",
    prediction: {
      departure: {
        time: new Date(now + 120_000).toISOString(),
        delaySeconds: 120,
        source: "NDOV BISON KV6",
      },
    },
  };
  const selected = buildUnifiedRealtimePrediction({
    ...leg, openovRealtime: staleOpenov, ndovRealtime: freshNdov,
  });
  assert.equal(selected.departure.source, "NDOV BISON KV6",
    "a 95-second-old OpenOV prediction must not outrank a fresh exact NDOV projection");
  console.log("PASS: stale OpenOV predictions are ignored in favor of fresh exact NDOV data");
}

console.log("All NDOV prediction regression tests passed.");
