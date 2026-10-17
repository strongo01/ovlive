import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { correlateKv17MutationsToKv78Rows, parseBisonPayload, parseKv17Payload, parseKv78Payload } from '../src/ndov-feed-parser.mjs';
import { makeGreeting, parseGreeting, makeReadyFrame, makeSubscribeFrame } from '../src/ndov-zmtp-protocol.mjs';
import { isKv78RowScheduleRelevant, kv78RowCacheKey } from '../src/ndov-live-state.mjs';

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

// Canonical cache keys must collapse LocalServiceLevelCode-only duplicates.
const sameStopOtherServiceLevel = { ...kv[0], localServiceLevelCode: 'another-service-level' };
assert.equal(kv78RowCacheKey(kv[0]), kv78RowCacheKey(sameStopOtherServiceLevel));
assert.notEqual(
  kv78RowCacheKey(kv[0]),
  kv78RowCacheKey({ ...kv[0], userStopCode: 'DIFFERENT_STOP' }),
);

// Current time 14:00 Amsterdam on the fixed test date.
const cacheNow = Date.parse('2026-10-17T12:00:00.000Z');
assert.equal(isKv78RowScheduleRelevant({ targetDepartureTime: '13:59:00' }, cacheNow), true);
assert.equal(isKv78RowScheduleRelevant({ targetArrivalTime: '13:56:59' }, cacheNow), false);
assert.equal(isKv78RowScheduleRelevant({ targetDepartureTime: '14:05:00' }, cacheNow), true);
assert.equal(isKv78RowScheduleRelevant({ targetDepartureTime: null, targetArrivalTime: null }, cacheNow), true);

// Midnight must be interpreted conservatively as wall-clock schedule time.
const midnightNow = Date.parse('2026-10-17T21:55:00.000Z'); // 23:55 Amsterdam
assert.equal(isKv78RowScheduleRelevant({ targetDepartureTime: '00:05:00' }, midnightNow), true);
assert.equal(isKv78RowScheduleRelevant({ targetDepartureTime: '23:51:00' }, midnightNow), false);

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

// A GVB tram uses the exact same neutral KV78 parser and exact trip-cancellation path.
const gvbTramPayload = header.replace(
  "CXX|2026-10-11|U011|7004|0|14|51111531|2947354|",
  "GVB|2026-10-11|24|56057|0|14|08001|3107751|"
);
const gvbTramRows = parseKv78Payload(gvbTramPayload, "/GOVI/KV8passtimes/GVB");
assert.equal(gvbTramRows.length, 1);
assert.equal(gvbTramRows[0].dataOwnerCode, "GVB");
assert.equal(gvbTramRows[0].linePlanningNumber, "24");
assert.equal(gvbTramRows[0].journeyNumber, "56057");
assert.equal(gvbTramRows[0].identity, "GVB|2026-10-11|3107751|24|56057|0");
const gvbTramCorrelation = correlateKv17MutationsToKv78Rows(gvbTramRows, [{
  dataOwnerCode: "GVB", operationDate: "2026-10-11", linePlanningNumber: "24",
  journeyNumber: "56057", reinforcementNumber: "0", eventType: "CANCEL",
  timestamp: "2026-10-11T11:05:13+02:00", allJourneysOfLine: false, allLines: false,
}]);
assert.equal(gvbTramCorrelation.length, 1);
assert.equal(gvbTramCorrelation[0].matchedKv78StopCount, 1);

const hubSource = readFileSync(new URL('../src/ndov-stream-hub.js', import.meta.url), 'utf8');
assert.ok(
  hubSource.includes('!/^\\d{8}$/.test(date)'),
  'targeted realtime identity diagnostics must normalize YYYYMMDD dates correctly',
);
assert.match(hubSource, /function ndovCollectionWindow/);
assert.match(hubSource, /AUTO_ACTIVE_START_UTC_HOUR = 4/);
assert.match(hubSource, /setAlarm\(window\.nextAlarmAt\)/);
assert.match(hubSource, /CONTINUOUS_FULL_CHECKPOINT_MS = 5 \* 60 \* 1000/);
assert.doesNotMatch(hubSource, /storage\.put\(durableChanges\)/);
console.log('PASS: dagelijkse UTC-planning en gebundelde opslagwrites');
assert.match(hubSource, /const KV78_ROW_LIMIT = 30000/);
assert.match(hubSource, /const FRESH_ROW_MS = 180 \* 1000/);
assert.match(hubSource, /const ROW_RETENTION_MS = FRESH_ROW_MS/);
assert.match(hubSource, /const KV78_ROW_PRUNE_INTERVAL_MS = 30 \* 1000/);
assert.match(hubSource, /const KV78_STOP_TIME_PAST_RETENTION_SECONDS = 180/);
assert.match(hubSource, /isKv78RowScheduleRelevant\(row, now, KV78_STOP_TIME_PAST_RETENTION_SECONDS, nowSeconds\)/);
assert.match(hubSource, /kv78RowCacheKey\(row\)/);
assert.match(hubSource, /rowCacheStats: \{ stalePrunedRows: 0, schedulePrunedRows: 0, limitEvictedRows: 0, duplicateRowsCollapsed: 0 \}/);
assert.match(hubSource, /lastRowPruneAt: 0/);
assert.match(hubSource, /Date\.now\(\) - state\.lastRowPruneAt >= KV78_ROW_PRUNE_INTERVAL_MS/);
assert.match(hubSource, /const AUTO_SESSION_SECONDS = 600/);
assert.match(hubSource, /const AUTO_REST_MS = 5 \* 1000/);
assert.match(hubSource, /async alarm\(\)/);
assert.match(hubSource, /return AUTO_REST_MS/);
assert.match(hubSource, /async persistFullKv78Rows\(stream, force = false\)/);
assert.match(hubSource, /async persistFullMutations\(stream, force = false\)/);
assert.match(hubSource, /new CompressionStream\('gzip'\)/);
assert.match(hubSource, /new DecompressionStream\('gzip'\)/);
assert.match(hubSource, /state\.rows\.size > KV78_ROW_LIMIT/);
assert.match(hubSource, /ROW_RETENTION_MS/);
assert.match(hubSource, /row\.receivedAt = new Date\(\)\.toISOString\(\)/);
assert.match(hubSource, /async pruneMutationDates\(stream\)/);
assert.match(hubSource, /continuousEnabled: state\.continuousEnabled/);
assert.match(hubSource, /url\.pathname === '\/continuous\/enable'/);
assert.match(hubSource, /url\.pathname === '\/continuous\/disable'/);
assert.match(hubSource, /url\.pathname === '\/mutations'/);
assert.match(hubSource, /url\.pathname === '\/rows'/);
assert.match(hubSource, /const rawIdentities = url\.searchParams\.getAll\('identity'\)/,
  'KV78 row reads must support batching exact trip identities into one Durable Object call');
assert.match(hubSource, /url\.pathname === '\/events'/);
assert.match(hubSource, /bisonIdentityDiagnostics/);
assert.match(hubSource, /identityDiagnostics.*=== "1"/);
assert.match(hubSource, /matchingTripCount: trips\.length/);
assert.match(hubSource, /byOwnerLine/);
assert.doesNotMatch(hubSource, /owner !== "CXX"/);
assert.doesNotMatch(hubSource, /"U005", "U011", "U073"/);
assert.match(hubSource, /const OWNER_PREFIXES = \[[\s\S]*?'\/RIG\/'[\s\S]*?'\/GVB\/'[\s\S]*?\];/);
assert.match(hubSource, /kv78: \{ port: 7817, name: 'KV78Turbo', prefixes: \['\/GOVI\/KV8passtimes\/'\] \}/);
assert.match(hubSource, /KV6_EVENT_LIMIT = 30000/);
assert.match(hubSource, /persistFullBisonEvents/);
assert.doesNotMatch(hubSource, /TARGET_LINES/);
assert.match(hubSource, /eventsForIdentities\(state\.mutations, identities\)/);
assert.match(hubSource, /rowMatchesIdentity\(row, identity\)/);
assert.match(hubSource, /Date\.now\(\) - state\.lastPersistAt < minInterval/);
assert.match(hubSource, /if \(stream === 'kv78' && !state\.continuousEnabled\) state\.rows\.clear\(\)/);
assert.doesNotMatch(hubSource, /if \(!TARGET_LINES\.has\(row\.linePlanningNumber\)\) continue;/);

const xml = `<tmi8:VV_TM_PUSH xmlns:tmi8="urn:test"><tmi8:KV6posinfo><tmi8:ONROUTE><tmi8:dataownercode>CXX</tmi8:dataownercode><tmi8:lineplanningnumber>U005</tmi8:lineplanningnumber><tmi8:operatingday>2026-10-11</tmi8:operatingday><tmi8:journeynumber>7008</tmi8:journeynumber><tmi8:reinforcementnumber>0</tmi8:reinforcementnumber><tmi8:userstopcode>51112302</tmi8:userstopcode><tmi8:timestamp>2026-10-11T09:53:00+02:00</tmi8:timestamp><tmi8:punctuality>531</tmi8:punctuality><tmi8:rd-x>134172</tmi8:rd-x><tmi8:rd-y>455878</tmi8:rd-y></tmi8:ONROUTE></tmi8:KV6posinfo></tmi8:VV_TM_PUSH>`;
const bison = parseBisonPayload(xml, '/CXX/KV6posinfo');
assert.equal(bison.length, 1);
assert.equal(bison[0].linePlanningNumber, 'U005');
assert.equal(bison[0].punctualitySeconds, 531);
assert.equal(bison[0].rdX, '134172');
const initXml = `<tmi8:VV_TM_PUSH xmlns:tmi8="urn:test"><tmi8:KV6posinfo><tmi8:INIT><tmi8:dataownercode>CXX</tmi8:dataownercode><tmi8:lineplanningnumber>U073</tmi8:lineplanningnumber><tmi8:operatingday>2026-10-11</tmi8:operatingday><tmi8:journeynumber>7042</tmi8:journeynumber><tmi8:reinforcementnumber>0</tmi8:reinforcementnumber><tmi8:vehiclenumber>9625</tmi8:vehiclenumber><tmi8:blockcode>80659</tmi8:blockcode></tmi8:INIT></tmi8:KV6posinfo></tmi8:VV_TM_PUSH>`;
const initEvent = parseBisonPayload(initXml, '/CXX/KV6posinfo');
assert.equal(initEvent.length, 1);
assert.equal(initEvent[0].vehicleNumber, '9625');
assert.equal(initEvent[0].blockCode, '80659');


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
console.log('PASS: KV78 capture includes non-sample bus lines for exact KV17 correlation');
console.log('PASS: GVB tram KV78 parsing and exact cancellation correlation');
console.log('PASS: namespaced BISON XML parser reads punctuality and coordinates');
console.log('PASS: KV17 parser identifies cancellations, recoveries, and all-line-trip mutations');
console.log('PASS: KV17 CANCEL matches KV78 only by exact owner/date/line/journey/reinforcement');
console.log('PASS: newest RECOVER supersedes older CANCEL; broad mutations are not guessed onto individual trips');
console.log('PASS: rolling KV78 cache prunes beyond the prediction freshness window before cap pressure');
console.log('PASS: rolling KV78 cache is bounded, timestamped, and kept fresh');
console.log('PASS: current KV17 state persists across sessions and older operating days are pruned');
console.log('PASS: alarm-driven collection, compressed durable state, and exact read endpoints are configured');
console.log('PASS: stream clients encode greeting, READY and SUBSCRIBE frames');
console.log('PASS: test parser and protocol offline checks passed');
