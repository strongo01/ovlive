import assert from 'node:assert/strict';
import { matchOpenovRoutePattern, applyNdovCancellationsToPlan } from '../src/ndov-plan-cancellation.js';

const patterns = [{
  routeId: '146903', realtimeTripId: 'CXX:U073:7054', headsign: 'Maarssenbroek', directionId: '1',
  stops: [
    { stopId: '3924174', stopSequence: 1, arrivalTime: '15:21:00', departureTime: '15:21:00' },
    { stopId: '3924354', stopSequence: 21, arrivalTime: '16:01:00', departureTime: '16:01:00' },
    { stopId: '3924358', stopSequence: 22, arrivalTime: '16:02:00', departureTime: '16:02:00' },
    { stopId: '3924361', stopSequence: 23, arrivalTime: '16:05:00', departureTime: '16:05:00' },
    { stopId: '3924362', stopSequence: 24, arrivalTime: '16:06:00', departureTime: '16:06:00' },
    { stopId: '3925041', stopSequence: 36, arrivalTime: '16:21:00', departureTime: '16:21:00' },
  ],
}];
const leg = {
  mode: 'BUS', routeId: 'nl-OpenOV_146903', routeShortName: '73', directionId: '1', headsign: 'Maarssenbroek',
  tripId: '20261011_15:21_nl-OpenOV_390029611', realTime: false,
  tripFrom: { stopId: 'nl-OpenOV_3924174', scheduledDeparture: '2026-10-11T13:21:00Z' },
  tripTo: { stopId: 'nl-OpenOV_3925041', scheduledArrival: '2026-10-11T14:21:00Z' },
  from: { stopId: 'nl-OpenOV_3924354', scheduledDeparture: '2026-10-11T14:01:00Z' },
  to: { stopId: 'nl-OpenOV_3925041', scheduledArrival: '2026-10-11T14:21:00Z' },
  intermediateStops: [
    { stopId: 'nl-OpenOV_3924358', scheduledArrival: '2026-10-11T14:02:00Z' },
    { stopId: 'nl-OpenOV_3924361', scheduledArrival: '2026-10-11T14:05:00Z' },
    { stopId: 'nl-OpenOV_3924362', scheduledArrival: '2026-10-11T14:06:00Z' },
  ],
};
const matched = matchOpenovRoutePattern(leg, patterns);
assert.equal(matched.realtimeTripId, 'CXX:U073:7054');
assert.equal(matched.reason, 'exact_route_time_stop_match');

// Regression: a second candidate starting one minute earlier must be rejected.
const firstPattern = patterns[0];
const firstStop = firstPattern.stops[0];
const startTimeKey = [
  "departureTime", "departure", "arrivalTime", "arrival"
].find((key) => firstStop?.[key] != null);

assert.ok(startTimeKey, "the first pattern must expose its first scheduled time");

const rawStart = String(firstStop[startTimeKey]);
const clockMatch = rawStart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
assert.ok(clockMatch, "the scheduled start must contain a clock time");

const startSeconds =
  Number(clockMatch[1]) * 3600 +
  Number(clockMatch[2]) * 60 +
  Number(clockMatch[3] ?? 0);

let earlierSeconds = startSeconds - 60;
if (earlierSeconds < 0) earlierSeconds += 24 * 3600;

const earlierHour = Math.floor(earlierSeconds / 3600);
const earlierMinute = Math.floor((earlierSeconds % 3600) / 60);
const earlierSecond = earlierSeconds % 60;

const earlierClock =
  `${String(earlierHour).padStart(2, "0")}:` +
  `${String(earlierMinute).padStart(2, "0")}` +
  (clockMatch[3] === undefined
    ? ""
    : `:${String(earlierSecond).padStart(2, "0")}`);

const earlierStart =
  rawStart.slice(0, clockMatch.index) +
  earlierClock +
  rawStart.slice(clockMatch.index + clockMatch[0].length);

const oneMinuteEarlier = {
  ...firstPattern,
  realtimeTripId: "CXX:U073:one-minute-earlier",
  stops: firstPattern.stops.map((stop, index) =>
    index === 0 ? { ...stop, [startTimeKey]: earlierStart } : stop
  ),
};

const disambiguated = matchOpenovRoutePattern(
  leg,
  [firstPattern, oneMinuteEarlier]
);

assert.equal(
  disambiguated.realtimeTripId,
  matched.realtimeTripId,
  "the candidate starting one minute earlier must not create an ambiguous match"
);

const wrongTime = matchOpenovRoutePattern({ ...leg, tripId: '20261011_15:36_nl-OpenOV_390029617', tripFrom: { ...leg.tripFrom, scheduledDeparture: '2026-10-11T13:36:00Z' } }, patterns);
assert.equal(wrongTime.realtimeTripId, null, 'a different trip start must not cross-match');
const wrongRoute = matchOpenovRoutePattern({ ...leg, routeId: 'nl-OpenOV_999999' }, patterns);
assert.equal(wrongRoute.realtimeTripId, null, 'a different route must not cross-match');
const ambiguous = matchOpenovRoutePattern(leg, [...patterns, { ...patterns[0], realtimeTripId: 'CXX:U073:9999' }]);
assert.equal(ambiguous.realtimeTripId, null, 'multiple exact but conflicting realtime IDs must be rejected');
assert.equal(ambiguous.candidateRealtimeTripIds.length, 2, 'ambiguous candidates should remain inspectable');
assert.ok(ambiguous.candidateRealtimeTripIds.includes(matched.realtimeTripId), 'the original exact candidate is reported');
assert.ok(ambiguous.candidateRealtimeTripIds.includes('CXX:U073:9999'), 'the conflicting candidate is reported');
assert.equal(ambiguous.candidatePatternDetails.length, 2, 'ambiguous pattern summaries should be available');
assert.ok(ambiguous.candidatePatternDetails.every((item) => Number.isInteger(item.stopCount)), 'each summary reports its stop count');
assert.ok(ambiguous.candidatePatternDetails.every((item) => Array.isArray(item.segmentStops)), 'each summary reports the matched segment stops');

const exactSourceTripId = "391225406";
const exactSourceTripLeg = {
  ...leg,
  tripId: String(leg.tripId).replace(
    /nl-OpenOV_\d+$/i,
    `nl-OpenOV_${exactSourceTripId}`
  ),
};
const exactSourceTripCandidates = [
  { ...matched.pattern, realtimeTripId: "CXX:U073:44", openovTripId: exactSourceTripId },
  { ...matched.pattern, realtimeTripId: "CXX:U073:6024", openovTripId: "999999999" },
];
const exactSourceTripMatch = matchOpenovRoutePattern(
  exactSourceTripLeg,
  exactSourceTripCandidates
);
assert.equal(exactSourceTripMatch.realtimeTripId, "CXX:U073:44");
assert.equal(exactSourceTripMatch.reason, "exact_openov_trip_id_match");
console.log("PASS: oorspronkelijke GTFS-rit-ID onderscheidt dubbele routepatronen");

console.log('PASS: exact route + full-trip start/end + segment stop sequence resolves CXX:U073:7054');
console.log('PASS: wrong start time is rejected');
console.log('PASS: wrong route is rejected');
console.log('PASS: ambiguous realtimeTripIds are rejected');
console.log('PASS: ambiguous candidate realtimeTripIds are exposed for safe diagnostics');
console.log('PASS: ambiguous candidate patterns expose route, trip endpoints and segment-stop details');
console.log('All OpenOV route crossmatch selftests passed.');


// Full plan-enrichment test: route/time/stop fallback must flow through to the fresh exact KV6 event.
const now = new Date().toISOString();
const identity = 'CXX|20261011|U073|7054|0';
const event = {
  source: 'BISON', envelope: '/CXX/KV6posinfo', eventType: 'ONROUTE',
  dataOwnerCode: 'CXX', operationDate: '2026-10-11', linePlanningNumber: 'U073', journeyNumber: '7054', reinforcementNumber: '0',
  identity, punctualitySeconds: 102, punctualityTimestamp: now, punctualityReceivedAt: now, receivedAt: now,
  vehicleNumber: '9633', blockCode: null, userStopCode: '50003360', passageSequenceNumber: '0',
};
const planEnv = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/ndov-trip-crosswalk/manifest.json') return Response.json({ generatedAt: now, shards: [] });
      if (url.pathname === '/ndov-openov-route-crosswalk/manifest.json') return Response.json({ generatedAt: now, routes: { '146903': ['route-146903-0.json'] } });
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-146903-0.json') return Response.json(patterns);
      return new Response('not found', { status: 404 });
    },
  },
  NDOV_FEEDS: {
    idFromName(name) { return name; },
    get(objectName) {
      assert.equal(objectName, 'ndov-shared-collector-v1', 'NDOV tests must use the shared collector object');
      return { async fetch(input) {
        const url = new URL(input);
          const stream = url.searchParams.get('stream');
        if (url.pathname === '/status' && stream === 'bison') return Response.json({ state: 'listening', latestMessageAt: now });
        if (url.pathname === '/status' && stream === 'kv78') return Response.json({ state: 'listening', latestMessageAt: now });
        if (url.pathname === '/mutations' && stream === 'bison') return Response.json({ mutations: [] });
        if (url.pathname === '/events' && stream === 'bison') return Response.json({ events: url.searchParams.getAll('identity').includes(identity) ? [event] : [] });
        if (url.pathname === '/rows' && stream === 'kv78') return Response.json({ rows: [] });
        return new Response('unexpected mock request', { status: 404 });
      } };
    },
  },
};
const endToEndPlan = { itineraries: [{ legs: [{ ...leg }] }] };
await applyNdovCancellationsToPlan(endToEndPlan, planEnv);
const enrichedLeg = endToEndPlan.itineraries[0].legs[0];
assert.equal(enrichedLeg.ndovRealtime?.status, 'kv6_live');
assert.equal(enrichedLeg.ndovRealtime?.identity, identity);
assert.equal(enrichedLeg.ndovRealtime?.punctualitySeconds, 102);
assert.equal(enrichedLeg.ndovRealtime?.vehicleNumber, '9633');
assert.equal(endToEndPlan.ndovRealtimeMeta.routeCrosswalkMatchedLegCount, 1);
assert.equal(endToEndPlan.ndovRealtimeMeta.kv6MatchedLegCount, 1);
console.log('PASS: route crossmatch flows into the plan as fresh exact KV6 delay (102 seconds, vehicle 9633)');
