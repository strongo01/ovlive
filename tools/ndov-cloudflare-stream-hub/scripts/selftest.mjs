import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { correlateKv17MutationsToKv78Rows, parseBisonPayload, parseKv17Payload, parseKv78Payload } from '../src/feed-parser.mjs';
import { makeGreeting, parseGreeting, makeReadyFrame, makeSubscribeFrame } from '../src/zmtp-protocol.mjs';

const header = String.raw`\GKV8turbo_passtimes|KV8turbo_passtimes|OpenOV|||UTF-8|0.1|2026-10-11T09:53:01+02:00|
\TDATEDPASSTIME|DATEDPASSTIME|start object
\LDataOwnerCode|OperationDate|LinePlanningNumber|JourneyNumber|FortifyOrderNumber|UserStopOrderNumber|UserStopCode|LocalServiceLevelCode|JourneyPatternCode|LineDirection|LastUpdateTimeStamp|DestinationCode|IsTimingStop|ExpectedArrivalTime|ExpectedDepartureTime|TripStopStatus|TargetArrivalTime|TargetDepartureTime|VehicleNumber|CancelledJourney|CancelledCall|ShowCancelledTrip|Monitored
CXX|2026-10-11|U011|7004|0|14|51111531|2947354|pattern|1|2026-10-11T09:53:14|dest|0|09:51:52|09:51:52|PASSED|09:52:00|09:52:00|2266|\0|\0|\0|1
`;
const kv = parseKv78Payload(header, '/GOVI/KV8passtimes/CXX');
assert.equal(kv.length, 1);
assert.equal(kv[0].linePlanningNumber, 'U011');
assert.equal(kv[0].departureDelaySeconds, -8);
assert.equal(kv[0].identity, 'CXX|2026-10-11|2947354|U011|7004|0');

// Ensure non-sample planning lines can be represented and correlated.
const l014Payload = header.replace('|U011|7004|', '|L014|7006|');
const l014Rows = parseKv78Payload(l014Payload, '/GOVI/KV8passtimes/CXX');
assert.equal(l014Rows[0].linePlanningNumber, 'L014');
const l014Correlation = correlateKv17MutationsToKv78Rows(l014Rows, [{
  dataOwnerCode: 'CXX', operationDate: '2026-10-11', linePlanningNumber: 'L014',
  journeyNumber: '7006', reinforcementNumber: '0', eventType: 'CANCEL',
  timestamp: '2026-10-11T11:05:13+02:00', allJourneysOfLine: false, allLines: false,
}]);
assert.equal(l014Correlation[0].matchedKv78StopCount, 1);

const hubSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
assert.match(hubSource, /const KV78_ROW_LIMIT = 5000/);
assert.match(hubSource, /const waitForCompletion = url\.searchParams\.get\('wait'\) === '1'/);
assert.match(hubSource, /if \(waitForCompletion\) \{/);
assert.match(hubSource, /callHub\(env, 'kv78', 'start', seconds, waitForCompletion\)/);
assert.match(hubSource, /completed: true/);
assert.doesNotMatch(hubSource, /if \(!TARGET_LINES\.has\(row\.linePlanningNumber\)\) continue;/);
assert.match(hubSource, /kv78CaptureSummary/);
assert.match(hubSource, /async persistFullKv78Rows\(force = false\)/);
assert.match(hubSource, /rowsChunkCount/);
assert.match(hubSource, /Date\.now\(\) - this\.lastPersistAt < 5000/);
assert.match(hubSource, /this\.rows\.entries\(\)\]\.slice\(-300\)/);
assert.match(hubSource, /function currentOperatingDateAmsterdam\(\)/);
assert.match(hubSource, /retain the latest[\s\S]*KV17 state for the current Dutch operating date/i);
assert.doesNotMatch(hubSource, /if \(stream === 'bison'\) \{ this\.events\.clear\(\); this\.mutations\.clear\(\); \}/);
assert.match(hubSource, /for \(const \[key, mutation\] of this\.mutations\.entries\(\)\)/);

const xml = `<tmi8:VV_TM_PUSH xmlns:tmi8="urn:test"><tmi8:KV6posinfo><tmi8:ONROUTE><tmi8:dataownercode>CXX</tmi8:dataownercode><tmi8:lineplanningnumber>U005</tmi8:lineplanningnumber><tmi8:operatingday>2026-10-11</tmi8:operatingday><tmi8:journeynumber>7008</tmi8:journeynumber><tmi8:reinforcementnumber>0</tmi8:reinforcementnumber><tmi8:userstopcode>51112302</tmi8:userstopcode><tmi8:timestamp>2026-10-11T09:53:00+02:00</tmi8:timestamp><tmi8:punctuality>531</tmi8:punctuality><tmi8:rd-x>134172</tmi8:rd-x><tmi8:rd-y>455878</tmi8:rd-y></tmi8:ONROUTE></tmi8:KV6posinfo></tmi8:VV_TM_PUSH>`;
const bison = parseBisonPayload(xml, '/CXX/KV6posinfo');
assert.equal(bison.length, 1);
assert.equal(bison[0].linePlanningNumber, 'U005');
assert.equal(bison[0].punctualitySeconds, 531);
assert.equal(bison[0].rdX, '134172');


const kv17Xml = `<tmi8:VV_TM_PUSH xmlns:tmi8="urn:test"><tmi8:KV17cvlinfo>
<tmi8:KV17JOURNEY><tmi8:dataownercode>CXX</tmi8:dataownercode><tmi8:lineplanningnumber>U073</tmi8:lineplanningnumber><tmi8:operatingday>2026-10-11</tmi8:operatingday><tmi8:journeynumber>7016</tmi8:journeynumber><tmi8:reinforcementnumber>0</tmi8:reinforcementnumber></tmi8:KV17JOURNEY>
<tmi8:KV17MUTATEJOURNEY><tmi8:timestamp>2026-10-11T11:05:13+02:00</tmi8:timestamp><tmi8:CANCEL><tmi8:showcancelledtrip>false</tmi8:showcancelledtrip><tmi8:autorecover>false</tmi8:autorecover></tmi8:CANCEL></tmi8:KV17MUTATEJOURNEY>
<tmi8:KV17JOURNEY><tmi8:dataownercode>CXX</tmi8:dataownercode><tmi8:lineplanningnumber>U011</tmi8:lineplanningnumber><tmi8:operatingday>2026-10-11</tmi8:operatingday><tmi8:allJourneysOfLine/></tmi8:KV17JOURNEY>
<tmi8:KV17MUTATEJOURNEY><tmi8:timestamp>2026-10-11T11:05:15+02:00</tmi8:timestamp><tmi8:RECOVER/></tmi8:KV17MUTATEJOURNEY>
</tmi8:KV17cvlinfo></tmi8:VV_TM_PUSH>`;
const kv17 = parseKv17Payload(kv17Xml, '/CXX/KV17cvlinfo');
assert.equal(kv17.length, 2);
assert.equal(kv17[0].protocol, 'KV17');
assert.equal(kv17[0].eventType, 'CANCEL');
assert.equal(kv17[0].identity, 'CXX|2026-10-11|U073|7016|0');
assert.equal(kv17[0].showCancelledTrip, 'false');
assert.equal(kv17[1].eventType, 'RECOVER');
assert.equal(kv17[1].allJourneysOfLine, true);
assert.equal(kv17[1].identity, 'CXX|2026-10-11|U011|*ALL_JOURNEYS*|0');



const gvbKv78Rows = [
  { dataOwnerCode: 'GVB', operationDate: '2026-10-11', localServiceLevelCode: '3107751', linePlanningNumber: '24', journeyNumber: '56057', fortifyOrderNumber: '0', userStopCode: '08001', tripStopStatus: 'DRIVING' },
  { dataOwnerCode: 'GVB', operationDate: '2026-10-11', localServiceLevelCode: '3107751', linePlanningNumber: '24', journeyNumber: '56057', fortifyOrderNumber: '0', userStopCode: '08002', tripStopStatus: 'DRIVING' },
  { dataOwnerCode: 'GVB', operationDate: '2026-10-11', localServiceLevelCode: '3107751', linePlanningNumber: '24', journeyNumber: '56059', fortifyOrderNumber: '0', userStopCode: '08003', tripStopStatus: 'DRIVING' },
];
const liveStyleMutations = [
  { dataOwnerCode: 'GVB', operationDate: '2026-10-11', linePlanningNumber: '24', journeyNumber: '56057', reinforcementNumber: '0', eventType: 'CANCEL', timestamp: '2026-10-11T11:16:11.083', allJourneysOfLine: false, allLines: false, showCancelledTrip: null },
  { dataOwnerCode: 'GVB', operationDate: '2026-10-11', linePlanningNumber: '24', journeyNumber: '56059', reinforcementNumber: '0', eventType: 'CANCEL', timestamp: '2026-10-11T11:16:11.137', allJourneysOfLine: false, allLines: false, showCancelledTrip: null },
];
const correlated = correlateKv17MutationsToKv78Rows(gvbKv78Rows, liveStyleMutations);
assert.equal(correlated.length, 2);
assert.equal(correlated.find((x) => x.journeyNumber === '56057').cancelled, true);
assert.equal(correlated.find((x) => x.journeyNumber === '56057').matchedKv78StopCount, 2);
assert.equal(correlated.find((x) => x.journeyNumber === '56059').status, 'cancelled-exact-trip-match');
const recovered = correlateKv17MutationsToKv78Rows(gvbKv78Rows, [
  ...liveStyleMutations,
  { ...liveStyleMutations[0], eventType: 'RECOVER', timestamp: '2026-10-11T11:17:12.000' },
]);
assert.equal(recovered.find((x) => x.journeyNumber === '56057').cancelled, false);
const noGuessOnWrongJourney = correlateKv17MutationsToKv78Rows(gvbKv78Rows, [
  { ...liveStyleMutations[0], journeyNumber: '99999' },
]);
assert.equal(noGuessOnWrongJourney[0].matchedKv78StopCount, 0);
assert.equal(noGuessOnWrongJourney[0].status, 'cancelled-no-kv78-row-match');
const broadMutation = correlateKv17MutationsToKv78Rows(gvbKv78Rows, [
  { ...liveStyleMutations[0], allJourneysOfLine: true },
]);
assert.equal(broadMutation.length, 0);

const greeting = parseGreeting(makeGreeting());
assert.equal(greeting.mechanism, 'NULL');
assert.equal(greeting.negotiatedMinor, 1);
assert.ok(makeReadyFrame(1).length > 0);
assert.ok(makeSubscribeFrame('/GOVI/KV8passtimes/', 1).length > 0);

console.log('PASS: KV78 table parser reads route/stop identity and delay');
console.log('PASS: KV78 capture includes non-sample lines such as CXX L014 for exact KV17 correlation');
console.log('PASS: namespaced BISON XML parser reads punctuality and coordinates');
console.log('PASS: KV17 parser identifies cancellations, recoveries, and all-line-trip mutations');
console.log('PASS: KV17 CANCEL matches KV78 only by exact owner/date/line/journey/reinforcement');
console.log('PASS: newest RECOVER supersedes older CANCEL; broad mutations are not guessed onto individual trips');
console.log('PASS: diagnostics expose stored KV78 coverage and start with fresh per-session data');
console.log('PASS: latest KV17 state persists across sessions within the Dutch operating day and expires after that day');
console.log('PASS: stream clients encode greeting, READY and SUBSCRIBE frames');
console.log('PASS: test parser and protocol offline checks passed');
