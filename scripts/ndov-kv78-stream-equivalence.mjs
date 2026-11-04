// Bewijst: nieuwe KV78-parser (tekst én chunk-gebaseerd) == oorspronkelijke parser, ook voor afwijkende invoer.
import assert from 'node:assert/strict';
import { parseKv78Payload as legacy } from './fixtures/legacy-ndov-feed-parser.mjs';
import { parseKv78Payload, parseKv78Chunks } from '../src/ndov-feed-parser.mjs';
import { kv78Message, rng } from './harness/kv-synthetic.mjs';
const enc = new TextEncoder(); const dec = new TextDecoder();
let n = 0;
async function check(label, text, chunkSizes = [1, 7, 64, 1000, 1 << 20]) {
  const expected = legacy(text, 'ENV');
  assert.deepStrictEqual(parseKv78Payload(text, 'ENV'), expected, label + ': tekst-API');
  const bytes = typeof text === 'string' ? enc.encode(text) : text;
  const expectedBytes = legacy(dec.decode(bytes), 'ENV');
  for (const size of chunkSizes) {
    const chunks = []; for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    assert.deepStrictEqual(await parseKv78Chunks(chunks, 'ENV'), expectedBytes, `${label}: chunks van ${size} bytes`);
  }
  n++; console.log(`PASS: ${label} (${expected.length} rijen)`);
}
const now = '2026-11-03T10:15:30+01:00';
await check('realistisch bericht 800 rijen', kv78Message(800, 1, 5000, now));
await check('realistisch bericht 3000 rijen, 1 MB-chunks', kv78Message(3000, 2, 9000, now), [4096, 1 << 20]);
const base = kv78Message(30, 3, 100, now).split('\n');
await check('CRLF-regeleinden', base.join('\r\n'));
await check('eindigt zonder newline', base.join('\n'));
await check('eindigt met lege regels', base.join('\n') + '\n\n\n');
await check('BOM aan het begin', '\uFEFF' + base.join('\n'));
await check('twee BOMs aan het begin', '\uFEFF\uFEFF' + base.join('\n'));
await check('BOM op eigen eerste regel', '\uFEFF\n' + base.join('\n'));
await check('geen kopregel', base.filter((l) => !l.startsWith('\\L')).join('\n'));
await check('kopregel NA gegevensregels', [...base.slice(0, 1), ...base.slice(2, 10), base[1], ...base.slice(10)].join('\n'));
await check('tweede \\L-regel wordt genegeerd', [...base.slice(0, 5), '\\LDataOwnerCode|Foo', ...base.slice(5)].join('\n'));
await check('alternatieve kopvorm \\L|DataOwnerCode|', base.map((l) => l.startsWith('\\LDataOwnerCode') ? l.replace('\\LDataOwnerCode', '\\L|DataOwnerCode') : l).join('\n'));
await check('te korte regels worden overgeslagen', [...base.slice(0, 6), 'ARR|x|y', ...base.slice(6)].join('\n'));
await check('lege tekst', '');
await check('Unicode in MessageContent', base.join('\n').replace(/\\0$/m, 'Omleiding – café ñ 日本語 😀'));
// ongeldige UTF-8 en multibyte over chunkgrenzen
{ const b = enc.encode(base.join('\n').replace(/\\0$/m, 'Ünïcödé 日本語 😀')); const bad = new Uint8Array(b.length + 3); bad.set(b); bad.set([0xff, 0xc3, 0x0a], b.length); await check('ongeldige UTF-8-bytes', bad); }
// fuzz: willekeurige regelcorruptie
const r = rng(42);
for (let i = 0; i < 40; i++) {
  const lines = kv78Message(60, 100 + i, 500, now).split('\n').map((l) => (r() < 0.15 ? l.slice(0, Math.floor(r() * l.length)) : r() < 0.05 ? '\\' + l : r() < 0.05 ? '' : l));
  await check(`fuzz ${i}`, lines.join(r() < 0.5 ? '\n' : '\r\n'), [13, 997]);
}
console.log(`\nAlle ${n} KV78-equivalentiecontroles geslaagd.`);
