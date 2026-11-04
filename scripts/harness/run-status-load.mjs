// node [--max-old-space-size=N] run-status-load.mjs <bundle> <N concurrent> [urlSuffix]
// Vult de KV78-hub met ~30.000 rijen en vuurt N gelijktijdige /status-aanroepen af, zoals N gelijktijdige /api/plan-verzoeken.
import { pathToFileURL } from 'node:url';
import { makeCtx } from './fake-storage.mjs';
import { makeSocket, message } from './zmtp-feed.mjs';
import { kv78Message } from './kv-synthetic.mjs';
const [bundle, nStr, suffix = ''] = process.argv.slice(2); const N = Number(nStr);
const { NdovFeedHub } = await import(pathToFileURL(bundle));
const hub = new NdovFeedHub(makeCtx(), {}); await hub.ready;
const now = new Date().toISOString().replace('Z', '+00:00');
globalThis.__socketFactory = () => makeSocket((function* () { for (let m = 0; m < 400; m++) yield message('/GOVI/KV8passtimes/ARR', kv78Message(150, m + 1, 60000, now)); })());
await hub.collect('kv78', 600);
if (global.gc) { global.gc(); global.gc(); }
const t0 = process.hrtime.bigint();
const responses = await Promise.all(Array.from({ length: N }, () => hub.fetch(new Request('https://ndov-hub.local/status?stream=kv78' + suffix))));
const bodies = await Promise.all(responses.map((r) => r.text()));
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const parsed = JSON.parse(bodies[0]);
console.log(JSON.stringify({ N, rows: hub.rows.size, responseKB: Math.round(bodies[0].length / 1024), state: parsed.state, latestMessageAt: !!parsed.latestMessageAt, totalMs: Math.round(ms) }));
