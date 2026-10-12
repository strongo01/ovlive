import assert from 'node:assert/strict';
import { applyNdovCancellationsToPlan } from '../src/ndov-plan-cancellation.js';

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

console.log('All NDOV plan-cancellation selftests passed.');


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
