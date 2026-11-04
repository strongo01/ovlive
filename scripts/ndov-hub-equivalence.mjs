// Vergelijkt de NdovFeedHub van de basiscommit met de huidige werkkopie op identieke synthetische invoer:
// eindstaat (aantallen + digest van rijen/events/mutaties) én herstel uit opslag moeten gelijk zijn.
// Draaien: node scripts/ndov-hub-equivalence.mjs [basiscommit]   (standaard: 3517fb0cce6b38d2c5247bbf0238d6887289c9b9)
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const base = process.argv[2] ?? '3517fb0cce6b38d2c5247bbf0238d6887289c9b9';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-eq-'));
execSync(`git -C ${root} archive ${base} src | tar -x -C ${tmp}`);
const build = (entry, out) => execSync(`node ${root}/scripts/harness/build-hub.mjs ${entry} ${out}`);
build(path.join(tmp, 'src/ndov-stream-hub.js'), path.join(tmp, 'old.mjs')); build(path.join(root, 'src/ndov-stream-hub.js'), path.join(tmp, 'new.mjs'));
const run = (bundle, stream, params) => JSON.parse(spawnSync('node', ['--expose-gc', 'run-hub-session.mjs', bundle, stream, JSON.stringify(params)], { cwd: path.join(root, 'scripts/harness'), encoding: 'utf8', maxBuffer: 1 << 26 }).stdout.trim().split('\n').pop());
let bad = 0;
for (const [name, stream, params] of [
  ['KV78 steady', 'kv78', { messages: 300, rowsPerMessage: 150, pool: 60000 }],
  ['KV78 grote batches', 'kv78', { messages: 30, rowsPerMessage: 150, pool: 60000, bigMessages: 6, bigRows: 8000 }],
  ['KV78 weinig sleutels (veel overschrijven)', 'kv78', { messages: 300, rowsPerMessage: 150, pool: 3000 }],
  ['BISON KV6+KV17', 'bison', { messages: 300, rowsPerMessage: 60, pool: 60000, kv17Every: 10 }],
]) {
  const a = run(path.join(tmp, 'old.mjs'), stream, params), b = run(path.join(tmp, 'new.mjs'), stream, params);
  const keys = ['messageCount', 'rawBytes', 'rows', 'events', 'mutations', 'digestRows', 'digestEvents', 'digestMutations', 'restoredRows', 'restoredEvents', 'restoredMutations', 'restoredDigestRows', 'restoredDigestEvents', 'restoredDigestMutations'];
  const diff = keys.filter((k) => a[k] !== b[k]);
  console.log(`${diff.length ? 'FAIL' : 'PASS'}: ${name}: ${b.messageCount} berichten, rijen=${b.rows} events=${b.events} mutaties=${b.mutations}, herstel identiek${diff.length ? ' — verschil in ' + diff.join(',') : ''}`);
  bad += diff.length ? 1 : 0;
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
