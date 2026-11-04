import { spawnSync } from 'node:child_process';
const [bundle, file] = process.argv.slice(2);
const run = (mb) => { const r = spawnSync('node', [`--max-old-space-size=${mb}`, '--expose-gc', 'run-restore.mjs', bundle, file], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) return null; try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
let hi = 1024, best = run(hi); let lo = 8; while (hi - lo > 4) { const mid = (lo + hi) >> 1; const r = run(mid); if (r) { hi = mid; best = r; } else lo = mid; }
console.log(JSON.stringify({ minHeapMB: hi, ...best }));
