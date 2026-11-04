// node [--max-old-space-size=N] --expose-gc run-deploy-session.mjs <bundle> '<json params>'
// Draait kv78 en bison NA ELKAAR in dezelfde hub-instantie (zoals het gedeelde productie-DO) met bevroren klok.
const FIXED = Date.parse('2026-11-04T18:00:00Z');
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } };
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { makeCtx } from './fake-storage.mjs';
import { makeSocket, message } from './zmtp-feed.mjs';
import { rng } from './kv-synthetic.mjs';
const [bundle, paramsJson] = process.argv.slice(2);
const P = { kv78Messages: 800, kv78Rows: 150, kv78Pool: 60000, bisonMessages: 800, bisonEvents: 60, bisonPool: 60000, ...JSON.parse(paramsJson || '{}') };
const nowIso = new RealDate(FIXED).toISOString();
const COLS = ['DataOwnerCode','OperationDate','LocalServiceLevelCode','LinePlanningNumber','JourneyNumber','FortifyOrderNumber','UserStopOrderNumber','UserStopCode','TripStopStatus','VejoJourneyNumber','VehicleJourneyType','VejoTripStatusType','CancelledJourney','ShowCancelledJourney','ShowCancelledTrip','CancelledCall','Monitored','TargetArrivalTime','ExpectedArrivalTime','TargetDepartureTime','ExpectedDepartureTime','LastUpdateTimeStamp','VehicleNumber','ShowCancelledStop','MessageType','MessageContent'];
const OWN = ['ARR','RIG','GVB','CXX','EBS','QBUZZ','KEOLIS','IVU'];
function kv78(rows, seed) {
  const r = rng(seed); const t = (m) => { const mm = 19 * 60 + (m % 240); return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}:00`; };
  const lines = ['\\GKV78Turbo|KV8passtimes|' + nowIso, '\\L' + COLS.join('|')];
  for (let i = 0; i < rows; i++) { const j = Math.floor(r() * P.kv78Pool), stop = j % 40, base = (j * 7) % 200;
    lines.push([OWN[j % 8], '2026-11-04', '100' + (j % 7), 'L' + (j % 400), String(1000 + ((j / 40 | 0) % 9000)), '0', String(stop), 'NL' + String(100000 + (j % 50000)), r() < 0.5 ? 'DRIVING' : 'PLANNED', '0', 'PLANNEDJOURNEY', 'NOTMONITORED', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'TRUE', t(base + stop), t(base + stop + 1 + ((r() * 3) | 0)), t(base + stop), t(base + stop + 1 + ((r() * 3) | 0)), nowIso, 'V' + (j % 3000), 'FALSE', '\\0', '\\0'].join('|')); }
  return lines.join('\n');
}
function kv6(events, seed) {
  const r = rng(seed); let x = '<?xml version="1.0"?><VV_TM_PUSH xmlns="http://bison.connekt.nl/tmi8/kv6/msg"><KV6posinfo>';
  for (let i = 0; i < events; i++) { const j = Math.floor(r() * P.bisonPool), type = ['ONROUTE', 'ARRIVAL', 'DEPARTURE', 'ONSTOP'][(r() * 4) | 0];
    x += `<${type}><dataownercode>${OWN[j % 8]}</dataownercode><lineplanningnumber>L${j % 400}</lineplanningnumber><operatingday>2026-11-04</operatingday><journeynumber>${1000 + j % 9000}</journeynumber><reinforcementnumber>0</reinforcementnumber><userstopcode>NL${100000 + j % 50000}</userstopcode><passagesequencenumber>0</passagesequencenumber><timestamp>${nowIso}</timestamp><source>VEHICLE</source><vehiclenumber>${j % 3000}</vehiclenumber><punctuality>${((r() * 600) | 0) - 120}</punctuality><rd-x>${100000 + ((r() * 100000) | 0)}</rd-x><rd-y>${400000 + ((r() * 100000) | 0)}</rd-y></${type}>`; }
  return x + '</KV6posinfo></VV_TM_PUSH>';
}
function kv17(muts, seed) {
  const r = rng(seed); let x = '<?xml version="1.0"?><VV_TM_PUSH xmlns="http://bison.connekt.nl/tmi8/kv17/msg"><KV17cvlinfo>';
  for (let i = 0; i < muts; i++) { const j = Math.floor(r() * P.bisonPool);
    x += `<KV17MUTATEJOURNEY><dataownercode>${OWN[j % 8]}</dataownercode><lineplanningnumber>L${j % 400}</lineplanningnumber><operatingday>2026-11-04</operatingday><journeynumber>${1000 + j % 9000}</journeynumber><reinforcementnumber>0</reinforcementnumber><timestamp>${nowIso}</timestamp><CANCEL><reasontype>6</reasontype><reasoncontent>Rit vervalt wegens personeelstekort bij de vervoerder</reasoncontent><advicetype>5</advicetype><advicecontent>Neem de volgende bus of reis met een andere lijn</advicecontent></CANCEL></KV17MUTATEJOURNEY>`; }
  return x + '</KV17cvlinfo></VV_TM_PUSH>';
}
const { NdovFeedHub } = await import(pathToFileURL(bundle));
const ctx = makeCtx(); const hub = new NdovFeedHub(ctx, process.env.NDOV_COMPACT_RECORDS ? { NDOV_COMPACT_RECORDS: process.env.NDOV_COMPACT_RECORDS } : {}); await hub.ready;
const gc = () => { global.gc(); global.gc(); };
const live = () => { gc(); const m = process.memoryUsage(); return +((m.heapUsed + m.arrayBuffers) / 1048576).toFixed(1); };
const base = live();
const run = async (stream, gen) => { globalThis.__socketFactory = () => makeSocket(gen()); await hub.collect(stream, 600); };
const t0 = process.hrtime.bigint();
await run('kv78', function* () { for (let m = 0; m < P.kv78Messages; m++) yield message('/GOVI/KV8passtimes/ARR', kv78(P.kv78Rows, m + 1)); });
const afterKv78 = live();
await run('bison', function* () { for (let m = 0; m < P.bisonMessages; m++) yield message(m % 10 === 0 ? '/ARR/KV17cvlinfo' : '/ARR/KV6posinfo', m % 10 === 0 ? kv17(40, m + 1) : kv6(P.bisonEvents, m + 1)); });
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const afterBoth = live();
const digest = (map) => { const h = crypto.createHash('sha256'); for (const [k, v] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) h.update(k + '=' + JSON.stringify(v, Object.keys(v).sort()) + '\n'); return h.digest('hex').slice(0, 16); };
const k = hub.stateFor('kv78'), b = hub.stateFor('bison');
console.log(JSON.stringify({ rows: k.rows.size, events: b.events.size, mutations: b.mutations.size, digestRows: digest(k.rows), digestEvents: digest(b.events), digestMutations: digest(b.mutations),
  kv78LiveMB: +(afterKv78 - base).toFixed(1), bothLiveMB: +(afterBoth - base).toFixed(1), collectMs: Math.round(ms), kv78State: k.snapshot.state, bisonState: b.snapshot.state, kv78Err: k.snapshot.error }));
