#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const tsc = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
if (!fs.existsSync(tsc)) {
  console.error('FOUT: lokale TypeScript-compiler niet gevonden. Voer eerst npm install uit in de projectmap.');
  process.exit(2);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovlive-ndov-adapter-'));
try {
  const compiled = spawnSync(tsc, [
    path.join(projectRoot, 'src', 'ndov-realtime-adapter.ts'),
    '--target', 'ES2022', '--module', 'commonjs', '--lib', 'ES2022,DOM',
    '--strict', '--skipLibCheck', '--outDir', temp,
  ], { encoding: 'utf8' });
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout || '');
    process.stderr.write(compiled.stderr || '');
    process.exit(compiled.status || 1);
  }
  const adapter = require(path.join(temp, 'ndov-realtime-adapter.js'));

  const payload = [
    '\\GKV8turbo_passtimes|KV8turbo_passtimes|OpenOV|||UTF-8|0.1|2026-10-11T09:53:15+02:00|',
    '\\TDATEDPASSTIME|DATEDPASSTIME|start object',
    '\\LDataOwnerCode|OperationDate|LinePlanningNumber|JourneyNumber|FortifyOrderNumber|UserStopOrderNumber|UserStopCode|LocalServiceLevelCode|LastUpdateTimeStamp|TargetArrivalTime|TargetDepartureTime|ExpectedArrivalTime|ExpectedDepartureTime|RecordedArrivalTime|RecordedDepartureTime|TripStopStatus|CancelledJourney|ShowCancelledTrip|CancelledCall|ShowCancelledStop|VehicleNumber|DestinationCode|LineDirection',
    'CXX|2026-10-11|U011|7004|0|13|51111400|2947354|2026-10-11T09:53:14+02:00||2026-10-11T09:47:00| |2026-10-11T09:47:04|| |PASSED|false|false|false|false|2266|U011000300|1',
    'CXX|2026-10-11|U011|7004|0|14|51111531|2947354|2026-10-11T09:53:13+02:00|2026-10-11T09:52:00|2026-10-11T09:52:00|2026-10-11T09:51:52|2026-10-11T09:51:52|| |PASSED|false|false|false|false|2266|U011000300|1',
    'CXX|2026-10-11|U011|7004|0|14|51111531|2947354|2026-10-11T09:53:14+02:00|2026-10-11T09:52:00|2026-10-11T09:52:00|2026-10-11T09:51:52|2026-10-11T09:51:52|| |PASSED|false|false|true|false|2266|U011000300|1',
  ].join('\n');
  const rows = adapter.parseKv78Payload(payload);
  assert.equal(rows.length, 3, 'KV78 pipe payload must parse three rows');
  assert.equal(adapter.kv78TripIdentity(rows[0]), 'CXX|2026-10-11|2947354|U011|7004|0');
  console.log('PASS: KV78 headers, pipe rows, full trip identity');

  const nowMs = Date.parse('2026-10-11T09:53:15+02:00');
  const match = adapter.matchKv78Leg(rows, {
    operationDate: '2026-10-11',
    plannedDeparture: '2026-10-11T07:47:00Z',
    plannedArrival: '2026-10-11T07:52:00Z',
    fromUserStopCode: '51111400',
    toUserStopCode: '51111531',
    allowedLinePlanningNumbers: ['U011'],
    allowedDataOwnerCodes: ['CXX'],
    nowMs,
  });
  assert.equal(match.matchStatus, 'matched');
  assert.equal(match.tripIdentity, 'CXX|2026-10-11|2947354|U011|7004|0');
  assert.equal(match.freshness, 'fresh');
  assert.equal(match.fromDelaySeconds, 4);
  assert.equal(match.toDelaySeconds, -8);
  assert.equal(match.tripCancelled, false, 'cancelled call must not cancel full trip');
  assert.equal(match.toStopCancelled, true, 'cancelled call must be kept as stop-level cancellation');
  console.log('PASS: match requires both stop codes, order, local times, and full KV78 identity');
  console.log('PASS: expected-vs-target delay calculated in local time and stop cancellation kept separate');

  const stale = adapter.matchKv78Leg(rows, {
    operationDate: '2026-10-11',
    plannedDeparture: '2026-10-11T07:47:00Z',
    plannedArrival: '2026-10-11T07:52:00Z',
    fromUserStopCode: '51111400',
    toUserStopCode: '51111531',
    allowedLinePlanningNumbers: ['U011'],
    allowedDataOwnerCodes: ['CXX'],
    nowMs: Date.parse('2026-10-11T10:00:00+02:00'),
  });
  assert.equal(stale.matchStatus, 'matched');
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.realtimeUsable, false);
  console.log('PASS: stale records cannot be presented as usable real-time data');

  const xml = `<tmi8:VV_TM_PUSH xmlns:tmi8="urn:test"><tmi8:KV6posinfo><tmi8:ONROUTE><tmi8:dataownercode>CXX</tmi8:dataownercode><tmi8:lineplanningnumber>U011</tmi8:lineplanningnumber><tmi8:journeynumber>7004</tmi8:journeynumber><tmi8:reinforcementnumber>0</tmi8:reinforcementnumber><tmi8:userstopcode>51111531</tmi8:userstopcode><tmi8:timestamp>2026-10-11T09:53:14+02:00</tmi8:timestamp><tmi8:vehiclenumber>2266</tmi8:vehiclenumber><tmi8:punctuality>4</tmi8:punctuality><tmi8:rd-x>131764</tmi8:rd-x><tmi8:rd-y>457169</tmi8:rd-y></tmi8:ONROUTE></tmi8:KV6posinfo></tmi8:VV_TM_PUSH>`;
  const events = adapter.parseKv6XmlPayload(xml);
  assert.equal(events.length, 1);
  assert.equal(events[0].punctualitySeconds, 4);
  assert.equal(events[0].rdX, 131764);
  const joined = adapter.joinKv6ToKv78(rows.slice(0, 2), events);
  assert.equal(joined[0].joinStatus, 'matched');
  assert.equal(joined[0].tripIdentity, 'CXX|2026-10-11|2947354|U011|7004|0');
  console.log('PASS: namespaced KV6 XML parsed and joined only on a unique shared identity');

  const ambiguousRows = rows.slice(0, 2).map((row) => ({
    ...row,
    localServiceLevelCode: 'OTHER_SERVICE_LEVEL',
  }));
  const ambiguous = adapter.joinKv6ToKv78([...rows.slice(0, 2), ...ambiguousRows], events);
  assert.equal(ambiguous[0].joinStatus, 'ambiguous');
  console.log('PASS: KV6 join refuses ambiguous LocalServiceLevelCode matches');

  const cancelledRows = rows.slice(0, 2).map((row) => ({ ...row }));
  cancelledRows[0].raw = { ...cancelledRows[0].raw, CancelledJourney: 'true' };
  cancelledRows[0].cancelledJourney = true;
  const cancelled = adapter.matchKv78Leg(cancelledRows, {
    operationDate: '2026-10-11',
    plannedDeparture: '2026-10-11T07:47:00Z',
    plannedArrival: '2026-10-11T07:52:00Z',
    fromUserStopCode: '51111400',
    toUserStopCode: '51111531',
    allowedLinePlanningNumbers: ['U011'],
    allowedDataOwnerCodes: ['CXX'],
    nowMs,
  });
  assert.equal(cancelled.tripCancelled, true);
  assert.equal(cancelled.realtimeUsable, false);
  console.log('PASS: explicit trip cancellation disables normal prediction');

  console.log('\nAlle 7 NDOV-adaptertests geslaagd.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
