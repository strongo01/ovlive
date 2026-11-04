// Bewijst dat de streaming-decoder exact dezelfde uitvoer geeft als de oorspronkelijke implementatie.
// Draaien: node scripts/gtfs-rt-stream-equivalence.mjs   (Node >= 22.18, type-stripping)
import assert from 'node:assert/strict';
import { decodeOpenovFeed } from '../src/gtfs-rt-stream.ts';
import { legacyDecodeAndNormalize } from './fixtures/legacy-gtfs-rt-normalize.mjs';
import { makeFeedBytes, makeAlertFeedBytes, makeVehicleFeedBytes, rt } from './lib/synthetic-gtfs-rt.mjs';

let checks = 0, failures = 0;
function same(label, bytes, kind) {
  let legacy, legacyErr, next, nextErr;
  try { legacy = legacyDecodeAndNormalize(bytes, kind); } catch (e) { legacyErr = e; }
  try { next = decodeOpenovFeed(bytes, kind); } catch (e) { nextErr = e; }
  try {
    if (legacyErr || nextErr) {
      assert.ok(legacyErr && nextErr, `alleen één implementatie faalde: legacy=${legacyErr?.message} nieuw=${nextErr?.message}`);
      assert.equal(nextErr.message, legacyErr.message, 'foutmelding verschilt');
    } else {
      assert.deepStrictEqual(next.entities, legacy.entities, 'genormaliseerde entities verschillen');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(next.header)), JSON.parse(JSON.stringify(legacy.header)), 'header verschilt');
      assert.equal(JSON.stringify(next.entities), JSON.stringify(legacy.entities), 'JSON-uitvoer verschilt');
    }
    checks++;
    console.log(`PASS: ${label}${legacy ? ` (${legacy.entities.length} entities)` : ' (beide gooien dezelfde fout)'}`);
  } catch (e) { failures++; console.log(`FAIL: ${label}: ${e.message}`); }
}

// 1. Realistische tripUpdates (en trainUpdates gebruikt dezelfde mapper) in meerdere groottes/seeds
for (const [trips, stops, seed] of [[1, 1, 1], [50, 5, 2], [3000, 12, 3], [8000, 18, 4]]) same(`tripUpdates ${trips}x~${stops} seed ${seed}`, makeFeedBytes(trips, stops, seed), 'tripUpdates');
same('trainUpdates 500x30', makeFeedBytes(500, 30, 9), 'trainUpdates');
// 2. Andere feedsoorten
same('alerts 2000', makeAlertFeedBytes(2000), 'alerts');
same('vehiclePositions 20000', makeVehicleFeedBytes(20000), 'vehiclePositions');
// 3. Entities zonder het verwachte onderdeel (alerts in tripUpdates-feed e.d.)
same('tripUpdates-feed met alert-entities', makeAlertFeedBytes(100), 'tripUpdates');
same('alerts-feed met tripUpdate-entities', makeFeedBytes(100, 4, 7), 'alerts');
// 4. Header-only, leeg, header ná entities, onbekende velden, groep, afgekapt
const header = rt.FeedHeader.create({ gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: 1793700000 });
same('alleen header', rt.FeedMessage.encode(rt.FeedMessage.create({ header })).finish(), 'tripUpdates');
same('lege invoer', new Uint8Array(0), 'tripUpdates');
const full = makeFeedBytes(40, 6, 11);
same('afgekapte feed', full.slice(0, full.length - 7), 'tripUpdates');
same('afgekapt midden in length-prefix', full.slice(0, 5), 'tripUpdates');
const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
same('onbekend varint-veld (nr 15) + fixed32 (nr 14) toegevoegd', cat(full, Uint8Array.of((15 << 3) | 0, 0x2a), Uint8Array.of((14 << 3) | 5, 1, 2, 3, 4)), 'tripUpdates');
same('onbekend length-delimited veld (nr 9)', cat(Uint8Array.of((9 << 3) | 2, 3, 65, 66, 67), full), 'tripUpdates');
same('onbekend fixed64-veld (nr 12)', cat(Uint8Array.of((12 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8), full), 'tripUpdates');
same('groep (wire type 3/4) → terugval op oorspronkelijke decoder', cat(Uint8Array.of((13 << 3) | 3, (13 << 3) | 4), full), 'tripUpdates');
// header ná de entities: oorspronkelijke decoder staat dit toe
{
  const msg = rt.FeedMessage.decode(full); const ents = msg.entity.map((e) => rt.FeedEntity.encode(e).finish());
  const parts = []; for (const e of ents) parts.push(Uint8Array.of((2 << 3) | 2, ...varint(e.length)), e);
  parts.push(Uint8Array.of((1 << 3) | 2, ...varint(rt.FeedHeader.encode(header).finish().length)), rt.FeedHeader.encode(header).finish());
  same('header na de entities', cat(...parts), 'tripUpdates');
}
function varint(n) { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; }

console.log(failures ? `\n${failures} van ${checks + failures} controles MISLUKT` : `\nAlle ${checks} equivalentiecontroles geslaagd: streaming-uitvoer == oorspronkelijke uitvoer.`);
process.exit(failures ? 1 : 0);
