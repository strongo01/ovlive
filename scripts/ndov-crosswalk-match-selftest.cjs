#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
if (!fs.existsSync(tsc)) {
  console.error('FOUT: TypeScript-compiler ontbreekt. Voer npm install uit in de projectmap.');
  process.exit(2);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovlive-ndov-crosswalk-'));
try {
  const compiled = spawnSync(tsc, [
    path.join(root, 'src', 'ndov-realtime-adapter.ts'),
    path.join(root, 'src', 'ndov-transitous-crosswalk-matcher.ts'),
    '--target', 'ES2022', '--module', 'commonjs', '--lib', 'ES2022,DOM',
    '--strict', '--skipLibCheck', '--outDir', temp,
  ], { encoding: 'utf8' });
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout || '');
    process.stderr.write(compiled.stderr || '');
    process.exit(compiled.status || 1);
  }

  const adapter = require(path.join(temp, 'ndov-realtime-adapter.js'));
  const matcher = require(path.join(temp, 'ndov-transitous-crosswalk-matcher.js'));
  const projectCrosswalkPath = path.join(root, 'src', 'data', 'ndov-gtfs-crosswalk.json');
  const crosswalk = fs.existsSync(projectCrosswalkPath)
    ? JSON.parse(fs.readFileSync(projectCrosswalkPath, 'utf8'))
    : {
        schemaVersion: 1,
        stopCodes: [['3924352', '51112302'], ['3924329', '51111531']],
        routeRows: [['146872', 'UOV', '5', 'Maarssen - Utrecht CS - Voordorp']],
        agencies: { UOV: 'U-OV' },
      };

  const payload = [
    '\\GKV8turbo_passtimes|KV8turbo_passtimes|OpenOV|||UTF-8|0.1|2026-10-11T09:53:15+02:00|',
    '\\TDATEDPASSTIME|DATEDPASSTIME|start object',
    '\\LDataOwnerCode|OperationDate|LinePlanningNumber|JourneyNumber|FortifyOrderNumber|UserStopOrderNumber|UserStopCode|LocalServiceLevelCode|TargetArrivalTime|TargetDepartureTime|ExpectedArrivalTime|ExpectedDepartureTime|LastUpdateTimeStamp|TripStopStatus|CancelledJourney|ShowCancelledTrip|CancelledCall|ShowCancelledStop|VehicleNumber|DestinationCode',
    'CXX|2026-10-11|U005|7008|0|22|51112302|3148595||2026-10-11T09:48:00+02:00||2026-10-11T09:56:51+02:00|2026-10-11T09:53:03+02:00|DRIVING|false|false|false|false|2277|U005000604',
    'CXX|2026-10-11|U005|7008|0|25|51111531|3148595|2026-10-11T09:53:00+02:00|2026-10-11T09:53:00+02:00|2026-10-11T10:01:21+02:00|2026-10-11T10:01:21+02:00|2026-10-11T09:53:03+02:00|PASSED|false|false|false|false|2277|U005000604',
  ].join('\n');
  const rows = adapter.parseKv78Payload(payload);
  assert.equal(rows.length, 2);
  console.log('PASS: testdata uit echte KV78-rapportage parseert');

  const result = matcher.matchTransitousLegWithKv78(rows, crosswalk, {
    routeId: 'nl-OpenOV_146872',
    operationDate: '2026-10-11',
    fromStopId: '3924352',
    toStopId: '3924329',
    plannedDeparture: '2026-10-11T07:48:00Z',
    plannedArrival: '2026-10-11T07:53:00Z',
    allowedDataOwnerCodes: ['CXX'],
    allowedLinePlanningNumbers: ['U005'],
    nowMs: Date.parse('2026-10-11T09:53:15+02:00'),
  });
  assert.equal(result.mappingStatus, 'resolved');
  assert.equal(result.route.routeId, '146872');
  assert.equal(result.route.agencyId, 'UOV');
  assert.equal(result.fromStopCode, '51112302');
  assert.equal(result.toStopCode, '51111531');
  assert.equal(result.realtimeMatch.matchStatus, 'matched');
  assert.equal(result.realtimeMatch.tripIdentity, 'CXX|2026-10-11|3148595|U005|7008|0');
  assert.equal(result.realtimeMatch.fromDelaySeconds, 531);
  assert.equal(result.realtimeMatch.toDelaySeconds, 501);
  assert.equal(result.realtimeMatch.realtimeUsable, true);
  console.log('PASS: Transitous route 146872 + twee stopcodes koppelen uniek aan KV78-rit U005/7008');
  console.log('PASS: gemeten voorspelling is +531 sec vertrek en +501 sec aankomst');

  const stale = matcher.matchTransitousLegWithKv78(rows, crosswalk, {
    routeId: 'nl-OpenOV_146872', operationDate: '2026-10-11',
    fromStopId: '3924352', toStopId: '3924329',
    plannedDeparture: '2026-10-11T07:48:00Z', plannedArrival: '2026-10-11T07:53:00Z',
    allowedDataOwnerCodes: ['CXX'], allowedLinePlanningNumbers: ['U005'],
    nowMs: Date.parse('2026-10-11T10:00:00+02:00'),
  });
  assert.equal(stale.realtimeMatch.matchStatus, 'matched');
  assert.equal(stale.realtimeMatch.realtimeUsable, false);
  assert.equal(stale.realtimeMatch.freshness, 'stale');
  console.log('PASS: oudere updates worden niet als bruikbare realtime-data gepresenteerd');

  const incomplete = matcher.matchTransitousLegWithKv78(rows, {
    ...crosswalk,
    stopCodes: crosswalk.stopCodes.filter(pair => pair[0] !== '3924329'),
  }, {
    routeId: 'nl-OpenOV_146872', operationDate: '2026-10-11',
    fromStopId: '3924352', toStopId: '3924329',
    plannedDeparture: '2026-10-11T07:48:00Z', plannedArrival: '2026-10-11T07:53:00Z',
    nowMs: Date.parse('2026-10-11T09:53:15+02:00'),
  });
  assert.equal(incomplete.mappingStatus, 'not_found');
  assert.match(incomplete.reason, /stop_code_missing/);
  console.log('PASS: ontbrekende stop_code blijft onbekend; geen gok op basis van halte-naam');

  const ambiguous = matcher.matchTransitousLegWithKv78(rows, {
    ...crosswalk,
    stopCodes: [...crosswalk.stopCodes, ['3924329', 'OTHER_CODE']],
  }, {
    routeId: 'nl-OpenOV_146872', operationDate: '2026-10-11',
    fromStopId: '3924352', toStopId: '3924329',
    plannedDeparture: '2026-10-11T07:48:00Z', plannedArrival: '2026-10-11T07:53:00Z',
    nowMs: Date.parse('2026-10-11T09:53:15+02:00'),
  });
  assert.equal(ambiguous.mappingStatus, 'ambiguous');
  console.log('PASS: dubbele stopcode-mapping wordt geweigerd als ambigu');
  console.log('\nAlle 5 crosswalk-matchertests geslaagd.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
