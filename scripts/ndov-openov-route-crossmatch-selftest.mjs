import assert from 'node:assert/strict';
import { matchOpenovRoutePattern, applyNdovCancellationsToPlan, openovTripStartBucket, getLruCacheValue, setBoundedLruCacheValue } from '../src/ndov-plan-cancellation.js';

assert.equal(openovTripStartBucket('20261011_11:59_nl-OpenOV_390000001'), '00');
assert.equal(openovTripStartBucket('20261011_12:00_nl-OpenOV_390000001'), '12');
assert.equal(openovTripStartBucket('20261011_24:02_nl-OpenOV_390000001'), '24');
assert.equal(openovTripStartBucket('invalid-trip-id'), null);
console.log('PASS: service-day trip start selects the correct 00/12/24 route bucket');

// Memory-safety regression: parsed crosswalk shards must not accumulate
// unboundedly across many different routes in a long-lived Worker isolate.
{
  const cache = new Map([["route-a", 1], ["route-b", 2]]);
  assert.equal(getLruCacheValue(cache, "route-a"), 1);
  assert.deepEqual([...cache.keys()], ["route-b", "route-a"]);
  setBoundedLruCacheValue(cache, "route-c", 3, 2);
  assert.deepEqual([...cache.keys()], ["route-a", "route-c"]);
  setBoundedLruCacheValue(cache, "route-d", 4, 2);
  assert.deepEqual([...cache.keys()], ["route-c", "route-d"]);
  assert.equal(cache.size, 2);
  console.log("PASS: parsed crosswalk cache uses bounded least-recently-used eviction");
}

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


// End-to-end enrichment tests for exact BUS, TRAM, SUBWAY and METRO identities.
const now = new Date().toISOString();
const identity = 'CXX|20261011|U073|7054|0';
const event = {
  source: 'BISON', envelope: '/CXX/KV6posinfo', eventType: 'ONROUTE',
  dataOwnerCode: 'CXX', operationDate: '2026-10-11', linePlanningNumber: 'U073', journeyNumber: '7054', reinforcementNumber: '0',
  identity, punctualitySeconds: 102, punctualityTimestamp: now, punctualityReceivedAt: now, receivedAt: now,
  vehicleNumber: '9633', blockCode: null, userStopCode: '50003360', passageSequenceNumber: '0',
};
const makeModeEvent = (owner, line, journey, punctualitySeconds, vehicleNumber) => ({
  source: "BISON", envelope: "/" + owner + "/KV6posinfo", eventType: "ONROUTE",
  dataOwnerCode: owner, operationDate: "2026-10-11", linePlanningNumber: line,
  journeyNumber: journey, reinforcementNumber: "0",
  identity: owner + "|20261011|" + line + "|" + journey + "|0",
  punctualitySeconds, punctualityTimestamp: now, punctualityReceivedAt: now, receivedAt: now,
  vehicleNumber, blockCode: null, userStopCode: owner + "-STOP", passageSequenceNumber: "1",
});
const tramIdentity = "RIG|20261011|3|56057|0";
const subwayIdentity = "GVB|20261011|52|66051|0";
const metroIdentity = "GVB|20261011|50|56059|0";
const modeEvents = [
  event,
  makeModeEvent("RIG", "3", "56057", 180, "2201"),
  makeModeEvent("GVB", "52", "66051", -15, "3001"),
  makeModeEvent("GVB", "50", "56059", 45, "3002"),
];
const tramPattern = { ...patterns[0], routeId: "120024", realtimeTripId: "RIG:3:56057" };
const subwayPattern = { ...patterns[0], routeId: "120052", realtimeTripId: "GVB:52:66051" };
const metroPattern = { ...patterns[0], routeId: "120050", realtimeTripId: "GVB:50:56059" };
const makeModeLeg = (mode, routeId, sourceTripId) => ({
  ...leg, mode, routeId: "nl-OpenOV_" + routeId,
  tripId: "20261011_15:21_nl-OpenOV_" + sourceTripId,
});
const assetFetchPaths = [];
const planEnv = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      assetFetchPaths.push(url.pathname);
      if (url.pathname === '/ndov-trip-crosswalk/manifest.json') return Response.json({ generatedAt: now, shards: [] });
      if (url.pathname === '/ndov-openov-route-crosswalk/manifest.json') return Response.json({
        generatedAt: now, serviceCalendarDateCount: 1, serviceIdsEmbedded: false,
        routes: {
          '146903': ['route-146903-t00-0.json', 'route-146903-t12-0.json', 'route-146903-t12-1.json'],
          '120024': ['route-120024-t12-0.json'],
          '120052': ['route-120052-t12-0.json'],
          '120050': ['route-120050-t12-0.json'],
        },
        routesByStartBucket: {
          '146903': { '00': ['route-146903-t00-0.json'], '12': ['route-146903-t12-0.json', 'route-146903-t12-1.json'] },
          '120024': { '12': ['route-120024-t12-0.json'] },
          '120052': { '12': ['route-120052-t12-0.json'] },
          '120050': { '12': ['route-120050-t12-0.json'] },
        },
      });
      if (url.pathname === '/ndov-openov-route-crosswalk/service-calendar.json') {
        return Response.json({ '20261011': ['TEST-SERVICE'] });
      }
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-146903-t00-0.json') {
        return new Response('A different start-time bucket must not be loaded.', { status: 500 });
      }
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-146903-t12-0.json') return Response.json(patterns);
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-146903-t12-1.json') {
        return Response.json([{ ...patterns[0], headsign: 'This shard must not match', realtimeTripId: 'CXX:U073:unmatched' }]);
      }
      if (url.pathname.endsWith('-services.json')) {
        const routeShard = url.pathname.split('/').pop().replace(/-services\.json$/i, '.json');
        if (routeShard === 'route-146903-t12-0.json') return Response.json([['TEST-SERVICE']]);
        if (routeShard === 'route-146903-t12-1.json') return Response.json([['INACTIVE-SERVICE']]);
        if (routeShard === 'route-120024-t12-0.json') return Response.json([['TEST-SERVICE']]);
        if (routeShard === 'route-120052-t12-0.json') return Response.json([['TEST-SERVICE']]);
        if (routeShard === 'route-120050-t12-0.json') return Response.json([['TEST-SERVICE']]);
      }
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-120024-t12-0.json') return Response.json([tramPattern]);
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-120052-t12-0.json') return Response.json([subwayPattern]);
      if (url.pathname === '/ndov-openov-route-crosswalk/routes/route-120050-t12-0.json') return Response.json([metroPattern]);
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
        if (url.pathname === '/events' && stream === 'bison') {
          const requested = new Set(url.searchParams.getAll("identity"));
          return Response.json({ events: modeEvents.filter((item) => requested.has(item.identity)) });
        }
        if (url.pathname === '/rows' && stream === 'kv78') return Response.json({ rows: [] });
        return new Response('unexpected mock request', { status: 404 });
      } };
    },
  },
};
const endToEndPlan = { itineraries: [{ legs: [
  { ...leg },
  makeModeLeg("TRAM", "120024", "391225407"),
  makeModeLeg("SUBWAY", "120052", "391225408"),
  makeModeLeg("METRO", "120050", "391225409"),
] }] };
await applyNdovCancellationsToPlan(endToEndPlan, planEnv);
const [enrichedLeg, enrichedTramLeg, enrichedSubwayLeg, enrichedMetroLeg] = endToEndPlan.itineraries[0].legs;
for (const [modeName, actualLeg, expectedIdentity, expectedDelay, expectedVehicle] of [
  ["BUS", enrichedLeg, identity, 102, "9633"],
  ["TRAM", enrichedTramLeg, tramIdentity, 180, "2201"],
  ["SUBWAY", enrichedSubwayLeg, subwayIdentity, -15, "3001"],
  ["METRO", enrichedMetroLeg, metroIdentity, 45, "3002"],
]) {
  assert.equal(actualLeg.ndovRealtime?.status, "kv6_live", modeName + " should receive a fresh exact KV6 match");
  assert.equal(actualLeg.ndovRealtime?.identity, expectedIdentity);
  assert.equal(actualLeg.ndovRealtime?.punctualitySeconds, expectedDelay);
  assert.equal(actualLeg.ndovRealtime?.vehicleNumber, expectedVehicle);
}
assert.equal(endToEndPlan.ndovRealtimeMeta.routeCrosswalkMatchedLegCount, 4);
assert.equal(endToEndPlan.ndovRealtimeMeta.kv6MatchedLegCount, 4);
assert.equal(endToEndPlan.ndovRealtimeMeta.coverageByMode.BUS.kv6MatchedLegCount, 1);
assert.equal(endToEndPlan.ndovRealtimeMeta.coverageByMode.TRAM.kv6MatchedLegCount, 1);
assert.equal(endToEndPlan.ndovRealtimeMeta.coverageByMode.SUBWAY.kv6MatchedLegCount, 1);
assert.equal(endToEndPlan.ndovRealtimeMeta.coverageByMode.METRO.kv6MatchedLegCount, 1);
assert.ok(assetFetchPaths.includes('/ndov-openov-route-crosswalk/routes/route-146903-t12-0-services.json'),
  'the exact matching route shard must have its service IDs checked');
assert.ok(!assetFetchPaths.includes('/ndov-openov-route-crosswalk/routes/route-146903-t12-1-services.json'),
  'a route shard with no exact route/time/stop candidate must not fetch its sidecar');
assert.ok(!assetFetchPaths.includes('/ndov-openov-route-crosswalk/routes/route-146903-t00-0-services.json'),
  'a different start-time bucket must not fetch its sidecar');
console.log("PASS: route/time/stop matching fetches service sidecars only for exact candidate shards");
console.log("PASS: exact route/time/stop crossmatch attaches fresh KV6 to BUS/TRAM/SUBWAY/METRO");
console.log("PASS: per-mode coverage counters preserve each operator and exact trip identity");
