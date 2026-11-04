// node [--max-old-space-size=N] run-hub-session.mjs <hub-bundle.mjs> <kv78|bison> <json-params>
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { makeCtx } from './fake-storage.mjs';
import { makeSocket, message } from './zmtp-feed.mjs';
import { kv78Message, kv6Message, kv17Message } from './kv-synthetic.mjs';
const [bundle, stream, paramsJson] = process.argv.slice(2);
const P = { messages: 300, rowsPerMessage: 150, pool: 60000, bigMessages: 0, bigRows: 10000, kv17Every: 20, ...JSON.parse(paramsJson || '{}') };
const { NdovFeedHub } = await import(pathToFileURL(bundle));
const ctx = makeCtx();
let hub = new NdovFeedHub(ctx, {}); await hub.ready;
const now = '2026-11-03T10:15:30.123+00:00';   // vast, zodat oud/nieuw dezelfde invoer krijgen
function* messages() {
  for (let m = 0; m < P.messages; m++) {
    const big = P.bigMessages && m % Math.max(1, Math.floor(P.messages / P.bigMessages)) === 0;
    if (stream === 'kv78') yield message('/GOVI/KV8passtimes/ARR', kv78Message(big ? P.bigRows : P.rowsPerMessage, m + 1, P.pool, now));
    else if (m % P.kv17Every === 0) yield message('/ARR/KV17cvlinfo', kv17Message(40, m + 1, P.pool, now));
    else yield message('/ARR/KV6posinfo', kv6Message(big ? P.bigRows : P.rowsPerMessage, m + 1, P.pool, now));
  }
}
globalThis.__socketFactory = () => makeSocket(messages());
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };
const t0 = process.hrtime.bigint();
await hub.collect(stream, 600);
const collectMs = Number(process.hrtime.bigint() - t0) / 1e6;
const live = () => { gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
// Digest van de eindstaat (zonder receivedAt, dat door de klok verschilt)
function digest(map) { const h = crypto.createHash('sha256'); for (const [k, v] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { const c = { ...v }; delete c.receivedAt; delete c.punctualityReceivedAt; h.update(k + '=' + JSON.stringify(c, Object.keys(c).sort()) + '\n'); } return h.digest('hex').slice(0, 16); }
const out = { stream, state: hub.snapshot.state, error: hub.snapshot.error, messageCount: hub.snapshot.messageCount, rawBytes: hub.snapshot.rawBytes,
  rows: hub.rows.size, events: hub.events.size, mutations: hub.mutations.size,
  digestRows: digest(hub.rows), digestEvents: digest(hub.events), digestMutations: digest(hub.mutations) };
out.liveRetainedMB = +((live() / 1048576)).toFixed(1);   // alleen de live hub (geen herstelde kopie)
if (process.env.DUMP_STORAGE) { (await import('node:fs')).writeFileSync(process.env.DUMP_STORAGE, (await import('node:v8')).serialize(ctx.data)); }
if (process.env.SKIP_RESTORE === '1') { console.log(JSON.stringify({ ...out, restoredOK: true, restoredDigestRows: out.digestRows, restoredDigestEvents: out.digestEvents, restoredDigestMutations: out.digestMutations, restoredRetainedMB: 0, collectMs: Math.round(collectMs) })); process.exit(0); }
// Herstart-test: nieuwe instantie op dezelfde (nep-)opslag moet dezelfde staat laden
const hub2 = new NdovFeedHub(ctx, {}); await hub2.ready;
out.restoredRows = hub2.rows.size; out.restoredDigestRows = digest(hub2.rows); out.restoredEvents = hub2.events.size; out.restoredDigestEvents = digest(hub2.events); out.restoredMutations = hub2.mutations.size; out.restoredDigestMutations = digest(hub2.mutations);
out.collectMs = Math.round(collectMs);
out.storageKeys = ctx.data.size; out.storageBytes = [...ctx.data.values()].reduce((n, v) => n + (v?.length ?? JSON.stringify(v ?? '').length), 0);
hub = null; out.restoredRetainedMB = +((live() / 1048576)).toFixed(1);   // alleen de uit opslag herstelde instantie
console.log(JSON.stringify(out));
