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

const vehicleTripRows = [
  row({
    identity: 'CXX|2026-10-12|U005|1050|0',
    dataOwnerCode: 'CXX', operationDate: '2026-10-12', linePlanningNumber: 'U005',
    journeyNumber: '1050', fortifyOrderNumber: '0', vehicleNumber: '2281',
    targetDepartureTime: '09:03:00', expectedDepartureTime: '09:03:30', departureDelaySeconds: 30,
    targetArrivalTime: null, expectedArrivalTime: null, arrivalDelaySeconds: null,
    userStopOrderNumber: '1', userStopCode: 'CXX-START',
  }),
  row({
    identity: 'CXX|2026-10-12|U005|1050|0',
    dataOwnerCode: 'CXX', operationDate: '2026-10-12', linePlanningNumber: 'U005',
    journeyNumber: '1050', fortifyOrderNumber: '0', vehicleNumber: '2281',
    targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null,
    targetArrivalTime: '09:29:00', expectedArrivalTime: '09:29:38', arrivalDelaySeconds: 38,
    userStopOrderNumber: '19', userStopCode: 'CXX-DUKE',
  }),
  row({
    identity: 'CXX|2026-10-12|U073|9999|0',
    dataOwnerCode: 'CXX', operationDate: '2026-10-12', linePlanningNumber: 'U073',
    journeyNumber: '9999', fortifyOrderNumber: '0', vehicleNumber: '2281',
    targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null,
    targetArrivalTime: '09:29:00', expectedArrivalTime: '09:16:00', arrivalDelaySeconds: -780,
    userStopOrderNumber: '19', userStopCode: 'WRONG-LINE',
  }),
  row({
    identity: 'CXX|2026-10-12|U005|9998|0',
    dataOwnerCode: 'CXX', operationDate: '2026-10-12', linePlanningNumber: 'U005',
    journeyNumber: '9998', fortifyOrderNumber: '0', vehicleNumber: '9999',
    targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null,
    targetArrivalTime: '09:29:00', expectedArrivalTime: '09:44:00', arrivalDelaySeconds: 900,
    userStopOrderNumber: '19', userStopCode: 'WRONG-VEHICLE',
  }),
  row({
    identity: 'CXX|2026-10-13|U005|1051|0',
    dataOwnerCode: 'CXX', operationDate: '2026-10-13', linePlanningNumber: 'U005',
    journeyNumber: '1051', fortifyOrderNumber: '0', vehicleNumber: '2281',
    targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null,
    targetArrivalTime: '09:29:00', expectedArrivalTime: '09:20:00', arrivalDelaySeconds: -540,
    userStopOrderNumber: '19', userStopCode: 'WRONG-DATE',
  }),
  row({
    identity: 'CXX|2026-10-12|U005|1052|0',
    dataOwnerCode: 'CXX', operationDate: '2026-10-12', linePlanningNumber: 'U005',
    journeyNumber: '1052', fortifyOrderNumber: '0', vehicleNumber: '2281',
    targetDepartureTime: null, expectedDepartureTime: null, departureDelaySeconds: null,
    targetArrivalTime: '09:50:00', expectedArrivalTime: '10:05:00', arrivalDelaySeconds: 900,
    userStopOrderNumber: '20', userStopCode: 'WRONG-TIME',
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
      if (url.pathname.endsWith('/ndov-stop-crosswalk/manifest.json')) {
        return Response.json({ schemaVersion: 1, generatedAt: now, shardCount: 1 });
      }
      if (url.pathname.endsWith('/ndov-stop-crosswalk/shards/stop-assignments-0.json')) {
        return Response.json({ assignments: {} });
      }
      if (url.pathname.endsWith('/ndov-openov-stopplace-crosswalk/manifest.json')) {
        return Response.json({ schemaVersion: 1, generatedAt: now, shardCount: 1 });
      }
      if (url.pathname.endsWith('/ndov-openov-stopplace-crosswalk/shards/openov-stop-places-0.json')) {
        return Response.json({ stopPlaces: {} });
      }
      if (url.pathname.endsWith('/manifest.json')) return Response.json(manifest);
      if (/\/trips-\d+\.json$/.test(url.pathname)) {
        return Response.json(url.pathname.endsWith('/trips-382.json') ? shard : {});
      }
      return new Response('not found', { status: 404 });
    },
  },
  NDOV_FEEDS: {
    idFromName(name) { return name; },
    get(objectName) {
      assert.equal(objectName, 'ndov-shared-collector-v1', 'NDOV tests must use the shared collector object');
      return {
        async fetch(input) {
          const url = new URL(input);
          const stream = url.searchParams.get('stream');
          if (url.pathname === '/status' && stream === 'bison') return Response.json(bisonSnapshot);
          if (url.pathname === '/status' && stream === 'kv78') return Response.json(kv78Snapshot);
          if (url.pathname === '/mutations' && stream === 'bison') {
            return Response.json({ mutations: url.searchParams.getAll('identity').includes('EBS|20261012|1314|1037|0') ? [mutation] : [] });
          }
          if (url.pathname === '/events' && stream === 'bison') {
            return Response.json({ events: [] });
          }
          if (url.pathname === '/rows' && stream === 'kv78') {
            if (url.searchParams.get('identity') === 'EBS|20261012|1314|1039|0') {
              return Response.json({ rows: tripRows });
            }
            if (
              url.searchParams.get('vehicleNumber') === '2281' &&
              url.searchParams.get('owner') === 'CXX' &&
              url.searchParams.get('date') === '20261012'
            ) {
              return Response.json({ rows: vehicleTripRows });
            }
            return Response.json({ rows: [] });
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
    {
      mode: 'BUS',
      tripId: '20261012_09:03_nl-OpenOV_399999999',
      routeShortName: '5',
      from: { stopId: '3923822', departure: plannedDeparture },
      to: { stopId: '3923959', arrival: '2026-10-12T07:29:00Z' },
      openovRealtime: {
        status: 'matched',
        vehiclePosition: { vehicleId: 'CXX:2281', observedAt: now, ageSeconds: 0 },
      },
    },
  ] }],
};
await applyNdovCancellationsToPlan(plan, env);
const [cancelledLeg, delayedLeg, vehicleFallbackLeg] = plan.itineraries[0].legs;
assert.equal(cancelledLeg.ndovRealtime.status, 'cancelled');
assert.equal(cancelledLeg.cancelled, true);
assert.equal(delayedLeg.ndovRealtime.status, 'kv78_delay');
assert.equal(delayedLeg.ndovRealtime.departure.delaySeconds, 180);
assert.equal(delayedLeg.ndovRealtime.kv78.departure.delaySeconds, 180, 'KV78-haltegegevens moeten in het eigen bronobject staan');
assert.equal(delayedLeg.ndovRealtime.arrival.delaySeconds, 120);
assert.equal(plan.ndovRealtimeMeta.kv78DelayLegCount, 2);
assert.equal(plan.ndovRealtimeMeta.kv78DataLegCount, 2);
assert.equal(vehicleFallbackLeg.ndovRealtime.status, 'kv78_delay');
assert.equal(vehicleFallbackLeg.ndovRealtime.arrival.delaySeconds, 38, 'vehicle lookup must recover the source-provided delay for the target stop');
assert.equal(vehicleFallbackLeg.ndovRealtime.matchBasis, 'exact_vehicle_stop_time');
assert.equal(vehicleFallbackLeg.ndovRealtime.observedVehicleId, 'CXX:2281');
assert.ok(vehicleFallbackLeg.ndovRealtime.freshnessNote.includes('De exacte NDOV-ritidentiteit en PSA/CHB-haltebevestiging ontbreken'),
  'vehicle fallback must disclose that the exact NDOV trip ID was not crossmatched and stop assignment is unconfirmed');
assert.equal(plan.ndovRealtimeMeta.kv78VehicleFallbackLegCount, 1);
console.log('PASS: exact KV17 cancellation remains attached only to its trip');
console.log('PASS: fresh KV78 delays attach to a separate exact trip identity');
console.log('PASS: exact OpenOV vehicle + target stop/time recovers a direct KV78 stop delay without guessing an NDOV trip ID');
console.log('All KV78 delay selftests passed.');
