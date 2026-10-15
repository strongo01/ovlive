import assert from 'node:assert/strict';
import { applyNdovCancellationsToPlan } from '../src/ndov-plan-cancellation.js';

const now = new Date().toISOString();
const stale = new Date(Date.now() - 240_000).toISOString();
const row = (extra = {}) => ({
  receivedAt: now,
  targetDepartureTime: '09:03:00',
  expectedDepartureTime: '09:06:00',
  departureDelaySeconds: 180,
  targetArrivalTime: '09:29:00',
  expectedArrivalTime: '09:31:00',
  arrivalDelaySeconds: 120,
  userStopOrderNumber: '1',
  userStopCode: 'STOP-A',
  ...extra,
});
const plannedDeparture = '2026-10-12T07:03:00Z';
const tripRows = [
  row({ targetArrivalTime: null, expectedArrivalTime: null, arrivalDelaySeconds: null, identity: 'EBS|20261012|1314|1039|0', dataOwnerCode: 'EBS', operationDate: '2026-10-12', linePlanningNumber: '1314', journeyNumber: '1039', fortifyOrderNumber: '0', userStopOrderNumber: '1', userStopCode: 'AMSTERDAM-CENTRAAL' }),
  row({ targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null, targetArrivalTime: '09:31:00', expectedArrivalTime: '09:33:00', arrivalDelaySeconds: 120, identity: 'EBS|20261012|1314|1039|0', dataOwnerCode: 'EBS', operationDate: '2026-10-12', linePlanningNumber: '1314', journeyNumber: '1039', fortifyOrderNumber: '0', userStopOrderNumber: '19', userStopCode: 'EDAM-BUSSTATION' }),
];
const mutation = {
  source: 'BISON', protocol: 'KV17', eventType: 'CANCEL', dataOwnerCode: 'EBS', operationDate: '2026-10-12',
  linePlanningNumber: '1314', journeyNumber: '1037', reinforcementNumber: '0', timestamp: now, reasonContent: 'test cancellation',
};
const kv6Good = {
  source: 'BISON', envelope: '/CXX/KV6posinfo', eventType: 'ONROUTE',
  dataOwnerCode: 'CXX', operationDate: '2026-10-12', linePlanningNumber: 'U073', journeyNumber: '7042', reinforcementNumber: '0',
  identity: 'CXX|20261012|U073|7042|0',
  punctualitySeconds: 947, punctualityTimestamp: now, punctualityReceivedAt: now, receivedAt: now,
  vehicleNumber: '9625', blockCode: '80659', userStopCode: 'Rijpwetering', passageSequenceNumber: '14',
};
const kv6Stale = { ...kv6Good, journeyNumber: '7043', identity: 'CXX|20261012|U073|7043|0', receivedAt: stale, punctualityReceivedAt: stale, punctualitySeconds: 1200 };
const kv6Observed = {
  ...kv6Good,
  journeyNumber: '7044',
  identity: 'CXX|20261012|U073|7044|0',
  eventType: 'ONROUTE',
  timestamp: now,
  receivedAt: now,
  punctualitySeconds: null,
  punctualityTimestamp: null,
  punctualityReceivedAt: null,
  vehicleNumber: '9634',
  blockCode: '80660',
};
const bisonSnapshot = { state: 'complete', latestMessageAt: now };
const kv78Snapshot = { state: 'complete', latestMessageAt: now };
const manifest = { generatedAt: now, shards: ['382'] };
const shard = {
  '382969674': 'EBS:1314:1037',
  '382969676': 'EBS:1314:1039',
  '382969680': 'CXX:U073:7042',
  '382969682': 'CXX:U073:7043',
  '382969684': 'CXX:U073:7044',
};

const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/manifest.json')) return Response.json(manifest);
      if (url.pathname.endsWith('/trips-382.json')) return Response.json(shard);
      return new Response('not found', { status: 404 });
    },
  },
  NDOV_FEEDS: {
    idFromName(name) { return name; },
    get(stream) {
      return {
        async fetch(input) {
          const url = new URL(input);
          if (url.pathname === '/status' && stream === 'bison') return Response.json(bisonSnapshot);
          if (url.pathname === '/status' && stream === 'kv78') return Response.json(kv78Snapshot);
          if (url.pathname === '/mutations' && stream === 'bison') {
            return Response.json({ mutations: url.searchParams.getAll('identity').includes('EBS|20261012|1314|1037|0') ? [mutation] : [] });
          }
          if (url.pathname === '/events' && stream === 'bison') {
            const ids = url.searchParams.getAll('identity');
            return Response.json({ events: [kv6Good, kv6Stale, kv6Observed].filter((event) => ids.includes(event.identity)) });
          }
          if (url.pathname === '/rows' && stream === 'kv78') {
            return Response.json({ rows: url.searchParams.get('identity') === 'EBS|20261012|1314|1039|0' ? tripRows : [] });
          }
          return new Response('unexpected mock request', { status: 404 });
        },
      };
    },
  },
};

const plan = {
  itineraries: [{ legs: [
    { mode: 'BUS', tripId: '20261012_08:52_nl-OpenOV_382969674', from: { departure: '2026-10-12T06:52:00Z' }, to: { arrival: '2026-10-12T07:18:00Z' } },
    { mode: 'BUS', tripId: '20261012_09:03_nl-OpenOV_382969676', from: { departure: plannedDeparture }, to: { arrival: '2026-10-12T07:29:00Z' } },
    { mode: 'BUS', tripId: '20261012_09:40_nl-OpenOV_382969680', from: { departure: '2026-10-12T07:40:00Z' }, to: { arrival: '2026-10-12T08:10:00Z' } },
    { mode: 'BUS', tripId: '20261012_10:00_nl-OpenOV_382969682', from: { departure: '2026-10-12T08:00:00Z' }, to: { arrival: '2026-10-12T08:30:00Z' } },
    { mode: 'BUS', tripId: '20261012_10:30_nl-OpenOV_382969684', from: { departure: '2026-10-12T08:30:00Z' }, to: { arrival: '2026-10-12T09:00:00Z' } },
  ] }],
};
await applyNdovCancellationsToPlan(plan, env);
const [cancelledLeg, kv78Leg, kv6Leg, staleLeg, observedLeg] = plan.itineraries[0].legs;
assert.equal(plan.ndovRealtimeMeta.kv17MatchedLegCount, plan.ndovRealtimeMeta.matchedLegCount, 'KV17-teller moet expliciet beschikbaar zijn');
assert.equal(plan.ndovRealtimeMeta.kv78DataLegCount, 1);
assert.equal(cancelledLeg.ndovRealtime.status, 'cancelled');
assert.equal(cancelledLeg.cancelled, true);
assert.equal(kv78Leg.ndovRealtime.status, 'kv78_delay');
assert.equal(kv78Leg.ndovRealtime.departure.delaySeconds, 180);
assert.equal(kv78Leg.ndovRealtime.kv78.departure.delaySeconds, 180, 'KV78 moet ook in het eigen bronobject staan');
assert.equal(kv78Leg.ndovRealtime.punctualitySeconds, undefined, 'an EBS KV78 trip should not inherit another operator\'s KV6 event');
assert.equal(kv6Leg.ndovRealtime.status, 'kv6_live');
assert.equal(kv6Leg.ndovRealtime.punctualitySeconds, 947);
assert.equal(kv6Leg.ndovRealtime.kv6.punctualitySeconds, 947, 'KV6 moet ook in het eigen bronobject staan');
assert.equal(kv6Leg.ndovRealtime.vehicleNumber, '9625');
assert.equal(kv6Leg.ndovRealtime.blockCode, '80659');
assert.equal(staleLeg.ndovRealtime, undefined, 'stale KV6 observations must not be shown as current');
assert.equal(observedLeg.ndovRealtime.status, 'kv6_observed', 'a fresh ONROUTE event must be displayed even without punctuality');
assert.equal(observedLeg.ndovRealtime.punctualitySeconds, null, 'missing punctuality must stay unknown rather than become zero');
assert.equal(observedLeg.ndovRealtime.eventType, 'ONROUTE');
assert.equal(observedLeg.ndovRealtime.vehicleNumber, '9634');
assert.equal(plan.ndovRealtimeMeta.kv6ObservedLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.kv6MatchedLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.kv6DelayLegCount, 1);
console.log('PASS: exact KV17 cancellation remains attached only to its trip');
console.log('PASS: KV78 stop-specific delays remain separate from KV6 trip punctuality');
console.log('PASS: fresh exact KV6 punctuality displays delay in seconds with vehicle/block data');
console.log('PASS: stale KV6 observations are rejected');
console.log('PASS: fresh exact ONROUTE activity is shown even when punctuality is absent, without implying on-time running');
console.log('All OVLive KV6 live selftests passed.');
