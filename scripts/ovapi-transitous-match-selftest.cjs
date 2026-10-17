#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  assert.ok(fs.existsSync(tsc), 'TypeScript compiler must be installed before running this selftest');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovlive-ovapi-mode-test-'));
  const originalFetch = global.fetch;
  try {
    const compiled = spawnSync(tsc, [
      path.join(root, 'src', 'ovapi-transitous-match.ts'),
      '--target', 'ES2022', '--module', 'commonjs', '--lib', 'ES2022,DOM',
      '--strict', '--skipLibCheck', '--outDir', temp,
    ], { encoding: 'utf8' });
    if (compiled.status !== 0) {
      process.stderr.write(compiled.stdout || '');
      process.stderr.write(compiled.stderr || '');
      throw new Error('Could not compile OVAPI comparison handler for isolated tests');
    }
    const { handleTransitousOvapiMatch } = require(path.join(temp, 'ovapi-transitous-match.js'));
    const date = '2026-10-17';
    const lastUpdate = new Date().toISOString();
    function makePass(owner, line, journey, clockTime, expectedTime, endpoint) {
      const departure = endpoint === 'from';
      const row = {
        DataOwnerCode: owner, LinePublicNumber: line, LinePlanningNumber: line,
        OperationDate: date, JourneyNumber: journey,
        DestinationName50: 'Testbestemming',
        UserStopCode: owner + '-' + line + '-' + (departure ? 'FROM' : 'TO'),
        LastUpdateTimeStamp: lastUpdate, TripStopStatus: 'PASSED',
      };
      row.TargetDepartureTime = departure ? date + 'T' + clockTime : null;
      row.ExpectedDepartureTime = departure ? date + 'T' + expectedTime : null;
      row.TargetArrivalTime = departure ? null : date + 'T' + clockTime;
      row.ExpectedArrivalTime = departure ? null : date + 'T' + expectedTime;
      return row;
    }
    const originRows = [
      makePass('RIG', '3', '3001', '10:00:00', '10:02:00', 'from'),
      makePass('GVB', '50', '5001', '10:05:00', '10:06:00', 'from'),
      makePass('GVB', '52', '5201', '10:10:00', '10:09:30', 'from'),
      makePass('GVB', '52', '5202', '10:10:00', '10:09:00', 'from'),
    ];
    const destinationRows = [
      makePass('RIG', '3', '3001', '10:20:00', '10:22:00', 'to'),
      makePass('GVB', '50', '5001', '10:25:00', '10:26:00', 'to'),
      makePass('GVB', '52', '5201', '10:30:00', '10:29:30', 'to'),
      makePass('GVB', '52', '5202', '10:30:00', '10:29:00', 'to'),
    ];
    global.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const match = url.pathname.match(/\/stopareacode\/([^/]+)\/departures$/);
      if (!match) return new Response('not found', { status: 404 });
      const area = decodeURIComponent(match[1]);
      const rows = area === 'area-from' ? originRows : area === 'area-to' ? destinationRows : null;
      if (!rows) return new Response('unknown mock area', { status: 404 });
      return new Response(JSON.stringify(Object.fromEntries(rows.map((row, index) => ['pass' + index, row]))), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const body = {
      fromArea: 'area-from', toArea: 'area-to',
      legs: [
        { itinerary: 1, mode: 'TRAM', line: 'T3', departure: date + 'T10:00:00+02:00', arrival: date + 'T10:20:00+02:00' },
        { itinerary: 2, mode: 'METRO', line: 'M50', departure: date + 'T10:05:00+02:00', arrival: date + 'T10:25:00+02:00' },
        { itinerary: 3, mode: 'SUBWAY', line: '52', departure: date + 'T10:10:00+02:00', arrival: date + 'T10:30:00+02:00' },
      ],
    };
    const req = new Request('https://ovlive.test/api/ovapi-test/match-plan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = await handleTransitousOvapiMatch(req);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.matchCount, 2, 'one tram and one metro should get unique matches');
    assert.equal(result.ambiguousCount, 1, 'duplicate same-time subway journeys must stay ambiguous');
    assert.equal(result.noCandidateCount, 0);
    const [tram, metro, subway] = result.comparisons;
    assert.equal(tram.status, 'unique_schedule_candidate');
    assert.equal(tram.line, '3');
    assert.equal(tram.mode, 'TRAM');
    assert.equal(tram.match.dataOwner, 'RIG');
    assert.equal(tram.match.from.differenceSeconds, 120);
    assert.equal(tram.match.to.differenceSeconds, 120);
    assert.equal(tram.match.reliableDelayAtBothStops, true);
    assert.equal(metro.status, 'unique_schedule_candidate');
    assert.equal(metro.line, '50');
    assert.equal(metro.match.dataOwner, 'GVB');
    assert.equal(metro.match.from.differenceSeconds, 60);
    assert.equal(metro.match.to.differenceSeconds, 60);
    assert.equal(metro.match.reliableDelayAtBothStops, true);
    assert.equal(subway.status, 'ambiguous');
    assert.equal(subway.candidates.length, 2, 'do not guess between multiple possible subway trips');
    console.log('PASS: T/M-prefixed labels normalize to numeric OVAPI lines');
    console.log('PASS: reliable delay requires fresh updates at both stops');
    console.log('PASS: ambiguous subway candidate stays unselected');
    console.log('All OVAPI bus/tram/metro comparison selftests passed.');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
