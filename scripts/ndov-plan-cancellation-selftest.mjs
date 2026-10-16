import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyNdovCancellationsToPlan, buildNsTrainIdentities } from '../src/ndov-plan-cancellation.js';

const planCancellationSource = readFileSync(new URL('../src/ndov-plan-cancellation.js', import.meta.url), 'utf8');
assert.doesNotMatch(planCancellationSource, /idFromName\(["'](?:bison|kv78)["']\)/,
  'all NDOV plan reads must use the shared collector object, not retired per-stream objects');
assert.equal((planCancellationSource.match(/idFromName\(NDOV_SHARED_OBJECT_NAME\)/g) ?? []).length, 7,
  'snapshot, mutation, event, KV78 snapshot/exact-row/vehicle-row, and on-demand identity diagnostic reads must all use the shared collector object');
assert.match(planCancellationSource, /status\?stream=bison&identityDiagnostics=1/,
  'no-match diagnostics must include the targeted current CXX journey identities');


// NS identity lookup must not inherit the 12-record diagnostic truncation.
{
  const prefixOutcomes = Array.from({ length: 12 }, (_, index) => ({
    tripId: `bus-trip-${index}`,
    source: 'openov-route-crossmatch',
    reason: 'exact_openov_trip_id_match',
    parsedIdentity: { owner: 'CXX', journey: `U073:${7000 + index}` },
  }));
  const trainOutcome = {
    tripId: '20261016_22:44_nl-OpenOV_382969680',
    source: 'openov-route-crossmatch',
    reason: 'exact_openov_trip_id_match',
    parsedIdentity: { owner: 'IFF', journey: '6080' },
  };
  const identities = buildNsTrainIdentities([...prefixOutcomes, trainOutcome]);
  assert.deepEqual(identities, [{
    tripId: trainOutcome.tripId,
    trainNumber: '6080',
  }]);
  assert.deepEqual(
    buildNsTrainIdentities([...prefixOutcomes, {
      ...trainOutcome,
      reason: 'ambiguous_route_time_stop_match',
    }]),
    [],
    'ambiguous train identities must not enter the NS lookup index',
  );
  assert.deepEqual(
    buildNsTrainIdentities([...prefixOutcomes, trainOutcome, {
      ...trainOutcome,
      parsedIdentity: { owner: 'IFF', journey: '6081' },
    }]),
    [],
    'conflicting train numbers for one trip ID must fail closed',
  );
  console.log('PASS: exact NS identity index includes a train beyond 12 bus matches and rejects ambiguous/conflicting mappings');
}

const now = () => new Date().toISOString();
function createEnv({ latestMessageAt = now(), latestMutations = [], state = 'complete' } = {}) {
  const assets = new Map([
    ['/ndov-trip-crosswalk/manifest.json', {
      format: 1,
      generatedAt: now(),
      shards: ['382'],
    }],
    ['/ndov-trip-crosswalk/trips-382.json', {
      '382969674': 'EBS:1314:1037',
      '382969676': 'EBS:1314:1039',
    }],
    ['/ndov-openov-route-crosswalk/manifest.json', {
      schemaVersion: 1,
      generatedAt: now(),
      serviceCalendarDateCount: 0,
      routes: {
        '146888': ['route-146888.json'],
        // Deliberately missing shard: it must diagnose only this leg.
        '146889': ['route-146889-missing.json'],
      },
    }],
    ['/ndov-openov-route-crosswalk/routes/route-146888.json', [{
      routeId: '146888',
      realtimeTripId: 'IFF:1000:661',
      openovTripId: '123456789',
      stops: [
        { stopId: 'start-stop', departureTime: '11:20:00' },
        { stopId: 'mid-from', departureTime: '11:30:00' },
        { stopId: 'mid-to', arrivalTime: '11:50:00' },
        { stopId: 'end-stop', arrivalTime: '12:00:00' },
      ],
    }]],
  ]);
  return {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (!assets.has(path)) return new Response('not found', { status: 404 });
        return Response.json(assets.get(path));
      },
    },
    NDOV_FEEDS: {
      idFromName(name) { return name; },
      get() {
        return {
          async fetch(request) {
            const url = new URL(typeof request === "string" ? request : request.url);
            if (url.pathname === "/mutations") {
              const identities = new Set(url.searchParams.getAll("identity"));
              const matches = latestMutations.filter((m) => {
                const date = String(m.operationDate ?? m.OperationDate ?? "").replace(/-/g, "");
                const identity = [m.dataOwnerCode ?? m.DataOwnerCode, date,
                  m.linePlanningNumber ?? m.LinePlanningNumber,
                  m.journeyNumber ?? m.JourneyNumber,
                  m.reinforcementNumber ?? m.ReinforcementNumber ?? "0"].join("|");
                return identities.has(identity);
              });
              return Response.json({ ok: true, state, latestMessageAt, mutations: matches });
            }
            return Response.json({ state, latestMessageAt, latestMutations });
          },
        };
      },
    },
  };
}

const cancellation = {
  eventType: 'CANCEL',
  dataOwnerCode: 'EBS',
  operationDate: '2026-10-12',
  linePlanningNumber: '1314',
  journeyNumber: '1037',
  reinforcementNumber: '0',
  timestamp: now(),
  reasonContent: 'Personeel, Logistiek',
};

{
  const plan = { itineraries: [{ legs: [
    { mode: 'BUS', tripId: '20261012_08:52_nl-OpenOV_382969674' },
    { mode: 'BUS', tripId: '20261012_09:03_nl-OpenOV_382969676' },
  ] }] };
  await applyNdovCancellationsToPlan(plan, createEnv({ latestMutations: [cancellation] }));
  assert.equal(plan.itineraries[0].legs[0].cancelled, true, 'exactly mapped rit should be cancelled');
  assert.equal(plan.itineraries[0].legs[1].cancelled, undefined, 'next rit must not inherit cancellation');
  assert.equal(plan.ndovRealtimeMeta.cancelledLegCount, 1);
  console.log('PASS: KV17 cancellation attaches only to the exact Transitous trip');
}

{
  const plan = { itineraries: [{ legs: [
    { mode: 'BUS', tripId: '20261013_08:52_nl-OpenOV_382969674' },
  ] }] };
  await applyNdovCancellationsToPlan(plan, createEnv({ latestMutations: [cancellation] }));
  assert.equal(plan.itineraries[0].legs[0].cancelled, undefined, 'different operation date must not match');
  assert.equal(plan.ndovRealtimeMeta.cancelledLegCount, 0);
  console.log('PASS: operation date must match exactly');
}

{
  const plan = { itineraries: [{ legs: [
    { mode: 'BUS', tripId: '20261012_08:52_nl-OpenOV_382969674' },
  ] }] };
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await applyNdovCancellationsToPlan(plan, createEnv({ latestMessageAt: stale, latestMutations: [cancellation] }));
  assert.equal(plan.itineraries[0].legs[0].cancelled, undefined, 'stale feed must not cancel');
  assert.equal(plan.ndovRealtimeMeta.status, 'stale');
  console.log('PASS: stale BISON feed cannot modify a journey');
}

{
  const recovered = { ...cancellation, eventType: 'RECOVER', timestamp: new Date(Date.now() + 1000).toISOString() };
  const plan = { itineraries: [{ legs: [
    { mode: 'BUS', tripId: '20261012_08:52_nl-OpenOV_382969674' },
  ] }] };
  await applyNdovCancellationsToPlan(plan, createEnv({ latestMutations: [cancellation, recovered] }));
  assert.equal(plan.itineraries[0].legs[0].cancelled, undefined, 'newer recovery must supersede cancellation');
  assert.equal(plan.ndovRealtimeMeta.recoveredLegCount, 1);
  console.log('PASS: newer RECOVER supersedes older CANCEL');
}




{
  const stopSpecific = { ...cancellation, userStopCode: "ABC123", passageSequenceNumber: null, showCancelledTrip: false };
  const plan = { itineraries: [{ legs: [
    { mode: "BUS", tripId: "20261012_08:52_nl-OpenOV_382969674" },
  ] }] };
  await applyNdovCancellationsToPlan(plan, createEnv({ latestMutations: [stopSpecific] }));
  assert.equal(plan.itineraries[0].legs[0].cancelled, undefined, "stop-specific mutation must not cancel the entire trip");
  assert.equal(plan.ndovRealtimeMeta.cancelledLegCount, 0);
  console.log("PASS: stop-specific KV17 mutation is not applied as a trip-wide cancellation");
}

// De statische treinritkoppeling moet beschikbaar blijven als BISON stale is.
{
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const plan = { itineraries: [{ legs: [{
    mode: 'RAIL',
    routeId: 'nl-OpenOV_146888',
    tripId: '20261014_11:20_nl-OpenOV_123456789',
    tripFrom: {
      stopId: 'start-stop',
      scheduledDeparture: '11:20:00',
    },
    tripTo: {
      stopId: 'end-stop',
      scheduledArrival: '12:00:00',
    },
    from: {
      stopId: 'mid-from',
      scheduledDeparture: '11:30:00',
    },
    to: {
      stopId: 'mid-to',
      scheduledArrival: '11:50:00',
    },
  }] }] };

  await applyNdovCancellationsToPlan(
    plan,
    createEnv({ latestMessageAt: stale })
  );

  assert.equal(plan.ndovRealtimeMeta.status, 'stale');
  assert.equal(plan.itineraries[0].legs[0].cancelled, undefined);

  const outcome = plan.ndovRealtimeMeta.routeCrosswalkOutcomes
    ?.find((item) => item.tripId === plan.itineraries[0].legs[0].tripId);

  assert.ok(outcome, 'crosswalk-uitkomst moet behouden blijven bij stale BISON');
  assert.equal(outcome.reason, 'exact_openov_trip_id_match');
  assert.deepEqual(outcome.parsedIdentity, {
    owner: 'IFF',
    line: '1000',
    journey: '661',
  });
  assert.equal(plan.ndovRealtimeMeta.routeCrosswalkMatchedLegCount, 1);
  console.log('PASS: NS-ritidentiteit blijft beschikbaar bij verouderde BISON-feed');
}

// A missing route shard must be shown on that leg, not erase other successful matches.
{
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const plan = { itineraries: [{ legs: [
    {
      mode: 'BUS',
      routeId: 'nl-OpenOV_146888',
      tripId: '20261014_11:20_nl-OpenOV_123456789',
      tripFrom: { stopId: 'start-stop', scheduledDeparture: '11:20:00' },
      tripTo: { stopId: 'end-stop', scheduledArrival: '12:00:00' },
      from: { stopId: 'mid-from', scheduledDeparture: '11:30:00' },
      to: { stopId: 'mid-to', scheduledArrival: '11:50:00' },
    },
    {
      mode: 'BUS',
      routeId: 'nl-OpenOV_146889',
      tripId: '20261014_12:20_nl-OpenOV_123456790',
      tripFrom: { stopId: 'start-stop', scheduledDeparture: '12:20:00' },
      tripTo: { stopId: 'end-stop', scheduledArrival: '13:00:00' },
      from: { stopId: 'mid-from', scheduledDeparture: '12:30:00' },
      to: { stopId: 'mid-to', scheduledArrival: '12:50:00' },
    },
  ] }] };

  await applyNdovCancellationsToPlan(plan, createEnv({ latestMessageAt: stale }));
  const [mappedLeg, missingShardLeg] = plan.itineraries[0].legs;

  assert.equal(mappedLeg.ndovRealtimeMatch, undefined,
    'a healthy route crosswalk must remain resolved when another shard is missing');
  assert.equal(missingShardLeg.ndovRealtimeMatch?.status, 'unavailable');
  assert.equal(missingShardLeg.ndovRealtimeMatch?.reason, 'crosswalk_asset_unavailable');
  assert.match(missingShardLeg.ndovRealtimeMatch?.error ?? '', /HTTP 404/);
  assert.equal(plan.ndovRealtimeMeta.routeCrosswalkMatchedLegCount, 1);
  console.log('PASS: a missing NDOV route shard is diagnosed on one leg without erasing another leg match');
}

console.log('All NDOV plan-cancellation selftests passed.');
