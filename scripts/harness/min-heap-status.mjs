import { spawnSync } from 'node:child_process';
const [bundle, n, suffix = ''] = process.argv.slice(2);
const run = (mb) => { const r = spawnSync('node', [`--max-old-space-size=${mb}`, '--expose-gc', 'run-status-load.mjs', bundle, n, suffix], { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26 }); if (r.status !== 0) return null; try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
let hi = 2048, best = run(hi); if (!best) { console.log('mislukt bij 2048'); process.exit(0); }
let lo = 24; while (hi - lo > 8) { const mid = (lo + hi) >> 1; const r = run(mid); if (r) { hi = mid; best = r; } else lo = mid; }
console.log(JSON.stringify({ concurrentStatusCalls: Number(n), minHeapMB: hi, responseKB: best.responseKB, totalMs: best.totalMs }));
