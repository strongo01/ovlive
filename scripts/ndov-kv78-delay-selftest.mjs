import assert from 'node:assert/strict';
import { applyNdovCancellationsToPlan, matchKv78RowByScheduleTime } from '../src/ndov-plan-cancellation.js';

const now = new Date().toISOString();
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

const plannedDeparture = '2026-10-12T07:03:00Z'; // 09:03 Europe/Amsterdam
{
  const match = matchKv78RowByScheduleTime([row()], plannedDeparture, 'targetDepartureTime');
  assert.equal(match?.row.userStopCode, 'STOP-A');
  console.log('PASS: schedule-time matching uses Europe/Amsterdam clock and a fresh row');
}
{
  const match = matchKv78RowByScheduleTime([
    row({ userStopCode: 'A', targetDepartureTime: '09:03:00' }),
    row({ userStopCode: 'B', targetDepartureTime: '09:03:10' }),
  ], plannedDeparture, 'targetDepartureTime');
  assert.equal(match, null, 'near-tied row matches are conservatively rejected');
  console.log('PASS: ambiguous stop-time matches stay unknown');
}
{
  const match = matchKv78RowByScheduleTime([
    row({ receivedAt: new Date(Date.now() - 240_000).toISOString() }),
  ], plannedDeparture, 'targetDepartureTime');
  assert.equal(match, null, 'stale rows must not be used');
  console.log('PASS: stale KV78 rows are rejected');
}

const tripRows = [
  row({
    identity: 'EBS|2026-10-12|1314|1039|0',
    dataOwnerCode: 'EBS', operationDate: '2026-10-12', linePlanningNumber: '1314',
    journeyNumber: '1039', fortifyOrderNumber: '0',
    targetArrivalTime: null, expectedArrivalTime: null, arrivalDelaySeconds: null,
    userStopOrderNumber: '1', userStopCode: 'AMSTERDAM-CENTRAAL',
  }),
  row({
    targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null,
    targetArrivalTime: '09:31:00', expectedArrivalTime: '09:33:00', arrivalDelaySeconds: 120,
    identity: 'EBS|2026-10-12|1314|1039|0',
    dataOwnerCode: 'EBS', operationDate: '2026-10-12', linePlanningNumber: '1314',
    journeyNumber: '1039', fortifyOrderNumber: '0',
    userStopOrderNumber: '19', userStopCode: 'EDAM-BUSSTATION',
  }),
];
const mutation = {
  source: 'BISON', protocol: 'KV17', eventType: 'CANCEL',
  dataOwnerCode: 'EBS', operationDate: '2026-10-12',
  linePlanningNumber: '1314', journeyNumber: '1037', reinforcementNumber: '0',
  timestamp: now, reasonContent: 'test cancellation',
};
const bisonSnapshot = { state: 'complete', latestMessageAt: now };
const kv78Snapshot = { state: 'complete', latestMessageAt: now };
const manifest = { generatedAt: now, shards: ['382'] };
const shard = {
  '382969674': 'EBS:1314:1037',
  '382969676': 'EBS:1314:1039',
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
    {
      mode: 'BUS', tripId: '20261012_08:52_nl-OpenOV_382969674',
      from: { departure: '2026-10-12T06:52:00Z' },
      to: { arrival: '2026-10-12T07:18:00Z' },
    },
    {
      mode: 'BUS', tripId: '20261012_09:03_nl-OpenOV_382969676',
      from: { departure: plannedDeparture },
      to: { arrival: '2026-10-12T07:29:00Z' },
    },
  ] }],
};
await applyNdovCancellationsToPlan(plan, env);
const [cancelledLeg, delayedLeg] = plan.itineraries[0].legs;
assert.equal(cancelledLeg.ndovRealtime.status, 'cancelled');
assert.equal(cancelledLeg.cancelled, true);
assert.equal(delayedLeg.ndovRealtime.status, 'kv78_delay');
assert.equal(delayedLeg.ndovRealtime.departure.delaySeconds, 180);
assert.equal(delayedLeg.ndovRealtime.kv78.departure.delaySeconds, 180, 'KV78-haltegegevens moeten in het eigen bronobject staan');
assert.equal(delayedLeg.ndovRealtime.arrival.delaySeconds, 120);
assert.equal(plan.ndovRealtimeMeta.kv78DelayLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.kv78DataLegCount, 1);
console.log('PASS: exact KV17 cancellation remains attached only to its trip');
console.log('PASS: fresh KV78 delays attach to a separate exact trip identity');
console.log('All KV78 delay selftests passed.');
