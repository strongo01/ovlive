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

// Stress fixture: irrelevant intermediate stops span all 16 PSA shards, but none
// fall inside the planned departure/arrival windows. They must not be fetched.
const stopAssignmentTestShard = (key) => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 16;
};
const coveredStopAssignmentShards = new Set();
const irrelevantTripRows = [];
for (let index = 0; coveredStopAssignmentShards.size < 16 && index < 10000; index += 1) {
  const stopCode = `IRRELEVANT_STOP_${String(index).padStart(5, "0")}`;
  const shard = stopAssignmentTestShard(`EBS|${stopCode}`);
  if (coveredStopAssignmentShards.has(shard)) continue;
  coveredStopAssignmentShards.add(shard);
  irrelevantTripRows.push(row({
    identity: "EBS|2026-10-12|1314|1039|0",
    dataOwnerCode: "EBS", operationDate: "2026-10-12", linePlanningNumber: "1314",
    journeyNumber: "1039", fortifyOrderNumber: "0",
    targetDepartureTime: "11:00:00", expectedDepartureTime: "11:03:00",
    departureDelaySeconds: 180, targetArrivalTime: "11:01:00",
    expectedArrivalTime: "11:03:00", arrivalDelaySeconds: 120,
    userStopOrderNumber: String(index + 2), userStopCode: stopCode,
  }));
}
assert.equal(coveredStopAssignmentShards.size, 16, "stress fixture must cover every PSA shard");
tripRows.push(...irrelevantTripRows);

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

const plusClockSeconds = (clock, seconds) => {
  const parts = clock.split(":").map(Number);
  const total = parts[0] * 3600 + parts[1] * 60 + parts[2] + seconds;
  return [Math.floor(total / 3600) % 24, Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");
};
const makeModeRows = (owner, line, journey, departureDelaySeconds, arrivalDelaySeconds) => [
  row({
    dataOwnerCode: owner, operationDate: "2026-10-12", linePlanningNumber: line,
    journeyNumber: journey, fortifyOrderNumber: "0",
    targetDepartureTime: "09:03:00",
    expectedDepartureTime: plusClockSeconds("09:03:00", departureDelaySeconds),
    departureDelaySeconds, targetArrivalTime: null, expectedArrivalTime: null,
    arrivalDelaySeconds: null, userStopOrderNumber: "1",
    userStopCode: owner + "-" + line + "-START", vehicleNumber: null,
  }),
  row({
    dataOwnerCode: owner, operationDate: "2026-10-12", linePlanningNumber: line,
    journeyNumber: journey, fortifyOrderNumber: "0",
    targetDepartureTime: null, expectedDepartureTime: null,
    departureDelaySeconds: null, targetArrivalTime: "09:29:00",
    expectedArrivalTime: plusClockSeconds("09:29:00", arrivalDelaySeconds),
    arrivalDelaySeconds, userStopOrderNumber: "19",
    userStopCode: owner + "-" + line + "-END", vehicleNumber: null,
  }),
];
const alternateModeRows = {
  "RIG|20261012|3|56057|0": makeModeRows("RIG", "3", "56057", 120, 180),
  "GVB|20261012|52|66051|0": makeModeRows("GVB", "52", "66051", 60, 60),
  "GVB|20261012|50|56059|0": makeModeRows("GVB", "50", "56059", 240, 300),
};
const mutation = {
  source: 'BISON', protocol: 'KV17', eventType: 'CANCEL',
  dataOwnerCode: 'EBS', operationDate: '2026-10-12',
  linePlanningNumber: '1314', journeyNumber: '1037', reinforcementNumber: '0',
  timestamp: now, reasonContent: 'test cancellation',
};
const tramMutation = {
  source: "BISON", protocol: "KV17", eventType: "CANCEL",
  dataOwnerCode: "RIG", operationDate: "2026-10-12",
  linePlanningNumber: "3", journeyNumber: "56058", reinforcementNumber: "0",
  timestamp: now, reasonContent: "test tram cancellation",
};
const metroMutation = {
  source: "BISON", protocol: "KV17", eventType: "CANCEL",
  dataOwnerCode: "GVB", operationDate: "2026-10-12",
  linePlanningNumber: "50", journeyNumber: "56060", reinforcementNumber: "0",
  timestamp: now, reasonContent: "test metro cancellation",
};
const mutations = [mutation, tramMutation, metroMutation];
const bisonSnapshot = { state: 'complete', latestMessageAt: now };
const kv78Snapshot = { state: 'complete', latestMessageAt: now };
const manifest = { generatedAt: now, shards: ['382'] };
const shard = {
  '382969674': 'EBS:1314:1037',
  '382969676': 'EBS:1314:1039',
  '382969677': 'RIG:3:56057',
  '382969678': 'RIG:3:56058',
  '382969679': 'GVB:52:66051',
  '382969680': 'GVB:50:56059',
  '382969681': 'GVB:50:56060',
};

const assetFetchPaths = [];
let kv78ExactBatchRequestCount = 0;
const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      assetFetchPaths.push(url.pathname);
      if (url.pathname.endsWith('/ndov-stop-crosswalk/manifest.json')) {
        return Response.json({ schemaVersion: 1, generatedAt: now, shardCount: 16 });
      }
      if (/\/ndov-stop-crosswalk\/shards\/stop-assignments-\d+\.json$/.test(url.pathname)) {
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
            const identities = new Set(url.searchParams.getAll("identity"));
            const matching = mutations.filter((entry) => identities.has([
              entry.dataOwnerCode, entry.operationDate.replace(/-/g, ""),
              entry.linePlanningNumber, entry.journeyNumber, entry.reinforcementNumber,
            ].join("|")));
            return Response.json({ mutations: matching });
          }
          if (url.pathname === '/events' && stream === 'bison') {
            return Response.json({ events: [] });
          }
          if (url.pathname === '/rows' && stream === 'kv78') {
            const identities = url.searchParams.getAll("identity");
            if (identities.length) {
              kv78ExactBatchRequestCount += 1;
              const rows = [];
              if (identities.includes("EBS|20261012|1314|1039|0")) rows.push(...tripRows);
              for (const [identity, matchedRows] of Object.entries(alternateModeRows)) {
                if (identities.includes(identity)) rows.push(...matchedRows);
              }
              return Response.json({ rows });
            }
            if (
              url.searchParams.get('vehicleNumber') === '2281' &&
              url.searchParams.get('owner') === 'CXX' &&
              url.searchParams.get('date') === '20261012'
            ) return Response.json({ rows: vehicleTripRows });
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
    { mode: "TRAM", tripId: "20261012_09:03_nl-OpenOV_382969677", from: { departure: plannedDeparture }, to: { arrival: "2026-10-12T07:29:00Z" } },
    { mode: "TRAM", tripId: "20261012_09:03_nl-OpenOV_382969678", from: { departure: plannedDeparture }, to: { arrival: "2026-10-12T07:29:00Z" } },
    { mode: "SUBWAY", tripId: "20261012_09:03_nl-OpenOV_382969679", from: { departure: plannedDeparture }, to: { arrival: "2026-10-12T07:29:00Z" } },
    { mode: "METRO", tripId: "20261012_09:03_nl-OpenOV_382969680", from: { departure: plannedDeparture }, to: { arrival: "2026-10-12T07:29:00Z" } },
    { mode: "METRO", tripId: "20261012_09:03_nl-OpenOV_382969681", from: { departure: plannedDeparture }, to: { arrival: "2026-10-12T07:29:00Z" } },
  ] }],
};
await applyNdovCancellationsToPlan(plan, env);
const [
  cancelledLeg, delayedLeg, vehicleFallbackLeg,
  tramDelayedLeg, tramCancelledLeg, subwayDelayedLeg, metroDelayedLeg, metroCancelledLeg,
] = plan.itineraries[0].legs;
assert.equal(cancelledLeg.ndovRealtime.status, 'cancelled');
assert.equal(cancelledLeg.cancelled, true);
assert.equal(delayedLeg.ndovRealtime.status, 'kv78_delay');
assert.equal(delayedLeg.ndovRealtime.departure.delaySeconds, 180);
assert.equal(delayedLeg.ndovRealtime.kv78.departure.delaySeconds, 180, 'KV78-haltegegevens moeten in het eigen bronobject staan');
assert.equal(delayedLeg.ndovRealtime.arrival.delaySeconds, 120);
assert.equal(plan.ndovRealtimeMeta.kv78DelayLegCount, 5, "two bus matches plus tram, subway and metro delays");
assert.equal(plan.ndovRealtimeMeta.kv78DataLegCount, 5, "KV78 delay data is counted across bus, tram, subway and metro");
assert.equal(vehicleFallbackLeg.ndovRealtime.status, 'kv78_delay');
assert.equal(vehicleFallbackLeg.ndovRealtime.arrival.delaySeconds, 38, 'vehicle lookup must recover the source-provided delay for the target stop');
assert.equal(vehicleFallbackLeg.ndovRealtime.matchBasis, 'exact_vehicle_stop_time');
assert.equal(vehicleFallbackLeg.ndovRealtime.observedVehicleId, 'CXX:2281');
assert.ok(vehicleFallbackLeg.ndovRealtime.freshnessNote.includes('De exacte NDOV-ritidentiteit en PSA/CHB-haltebevestiging ontbreken'),
  'vehicle fallback must disclose that the exact NDOV trip ID was not crossmatched and stop assignment is unconfirmed');
assert.equal(plan.ndovRealtimeMeta.kv78VehicleFallbackLegCount, 1);
assert.equal(tramDelayedLeg.ndovRealtime.status, "kv78_delay");
assert.equal(tramDelayedLeg.ndovRealtime.departure.delaySeconds, 120);
assert.equal(tramDelayedLeg.ndovRealtime.arrival.delaySeconds, 180);
assert.equal(tramCancelledLeg.ndovRealtime.status, "cancelled");
assert.equal(tramCancelledLeg.cancelled, true);
assert.equal(subwayDelayedLeg.ndovRealtime.status, "kv78_delay");
assert.equal(subwayDelayedLeg.ndovRealtime.departure.delaySeconds, 60);
assert.equal(subwayDelayedLeg.ndovRealtime.arrival.delaySeconds, 60);
assert.equal(metroDelayedLeg.ndovRealtime.status, "kv78_delay");
assert.equal(metroDelayedLeg.ndovRealtime.departure.delaySeconds, 240);
assert.equal(metroDelayedLeg.ndovRealtime.arrival.delaySeconds, 300);
assert.equal(metroCancelledLeg.ndovRealtime.status, "cancelled");
assert.equal(metroCancelledLeg.cancelled, true);
assert.equal(plan.ndovRealtimeMeta.kv78DataLegCount, 5);
assert.equal(plan.ndovRealtimeMeta.kv78DelayLegCount, 5);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.BUS.candidateLegCount, 3);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.TRAM.candidateLegCount, 2);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.TRAM.kv78DataLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.TRAM.cancelledLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.SUBWAY.kv78DataLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.METRO.kv78DataLegCount, 1);
assert.equal(plan.ndovRealtimeMeta.coverageByMode.METRO.cancelledLegCount, 1);
assert.equal(kv78ExactBatchRequestCount, 1, "all exact trip identities should be fetched in one KV78 Durable Object call");
const assignmentShardReads = assetFetchPaths.filter((path) =>
  /\/ndov-stop-crosswalk\/shards\/stop-assignments-\d+\.json$/.test(path)
);
assert.ok(assignmentShardReads.length > 0, "PSA candidate stop shards should be checked");
assert.ok(
  assignmentShardReads.length < 16,
  `irrelevant mid-trip stop rows must not fetch all 16 PSA shards; fetched ${assignmentShardReads.length}`
);
console.log("PASS: PSA/CHB lookup only reads shards for time-relevant target haltes");
console.log("PASS: exact KV17 cancellations attach only to their own bus/tram/metro trip");
console.log("PASS: KV78 departure/arrival delays are tested for BUS/TRAM/SUBWAY/METRO");
console.log("PASS: same planned time cannot cause another operator/trip's delay to be copied");
console.log("PASS: per-mode realtime coverage counters report data separately");
console.log("All bus/tram/metro KV78 integration selftests passed.");
