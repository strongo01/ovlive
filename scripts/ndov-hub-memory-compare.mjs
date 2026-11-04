// Vergelijkt de NdovFeedHub van de basiscommit met de werkkopie op identieke synthetische invoer, met beide
// streams (kv78 + bison) in ÉÉN hub-instantie zoals in het gedeelde productie-DO, en een bevroren klok.
// Controle 1: eindstaat (aantallen + digest van rijen/events/mutaties) moet gelijk zijn.
// Controle 2: toont het blijvende (live) geheugen van die staat voor oud en nieuw.
// Draaien: node scripts/ndov-hub-memory-compare.mjs [basiscommit]   (standaard: 78df20f90c6514249fcf5254f2a2acce5bbe81d7)
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const base = process.argv[2] ?? '78df20f90c6514249fcf5254f2a2acce5bbe81d7';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mem-'));
execSync(`git -C ${root} archive ${base} src | tar -x -C ${tmp}`);
const build = (entry, out) => execSync(`node ${root}/scripts/harness/build-hub.mjs ${entry} ${out}`);
build(path.join(tmp, 'src/ndov-stream-hub.js'), path.join(tmp, 'old.mjs')); build(path.join(root, 'src/ndov-stream-hub.js'), path.join(tmp, 'new.mjs'));
const run = (bundle, params) => JSON.parse(spawnSync('node', ['--expose-gc', 'scripts/harness/run-deploy-session.mjs', bundle, JSON.stringify(params)], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).stdout.trim().split('\n').pop());
let bad = 0;
for (const [name, params] of [
  ['volledig volume (30k rijen, 16k events)', {}],
  ['veel overschrijvingen (kleine sleutelpool)', { kv78Pool: 4000, bisonPool: 4000 }],
  ['kleine sessie', { kv78Messages: 60, bisonMessages: 60 }],
]) {
  const a = run(path.join(tmp, 'old.mjs'), params), b = run(path.join(tmp, 'new.mjs'), params);
  const keys = ['rows', 'events', 'mutations', 'digestRows', 'digestEvents', 'digestMutations'];
  const diff = keys.filter((k) => a[k] !== b[k]);
  console.log(`${diff.length ? 'FAIL' : 'PASS'}: ${name}: rijen=${b.rows} events=${b.events} mutaties=${b.mutations} | live geheugen kv78 ${a.kv78LiveMB}→${b.kv78LiveMB} MB, beide streams ${a.bothLiveMB}→${b.bothLiveMB} MB | verwerkingstijd ${a.collectMs}→${b.collectMs} ms${diff.length ? ' — verschil in ' + diff.join(',') : ''}`);
  bad += diff.length ? 1 : 0;
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
