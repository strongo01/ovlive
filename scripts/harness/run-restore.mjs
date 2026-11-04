// node [--max-old-space-size=N] run-restore.mjs <bundle> <storage.bin> : alleen de DO-herstart (constructor-restore) uit opgeslagen staat
import fs from 'node:fs'; import v8 from 'node:v8'; import { pathToFileURL } from 'node:url'; import crypto from 'node:crypto';
import { makeCtx } from './fake-storage.mjs';
const [bundle, file] = process.argv.slice(2);
const { NdovFeedHub } = await import(pathToFileURL(bundle));
const ctx = makeCtx(); for (const [k, v] of v8.deserialize(fs.readFileSync(file))) ctx.data.set(k, v);
const t0 = process.hrtime.bigint();
const hub = new NdovFeedHub(ctx, {}); await hub.ready;
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const h = crypto.createHash('sha256'); for (const m of [hub.rows, hub.events, hub.mutations]) for (const [k, v] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { const c = { ...v }; delete c.receivedAt; delete c.punctualityReceivedAt; h.update(k + JSON.stringify(c, Object.keys(c).sort())); }
global.gc?.(); global.gc?.();
console.log(JSON.stringify({ rows: hub.rows.size, events: hub.events.size, mutations: hub.mutations.size, digest: h.digest('hex').slice(0, 16), restoreMs: Math.round(ms), retainedMB: +(((process.memoryUsage().heapUsed) / 1048576)).toFixed(1) }));
