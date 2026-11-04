// Bouwt een ZMTP 3.1 bytestroom (greeting, READY, multipart berichten) en levert die als TCP-achtige chunks.
import { gzipSync } from 'node:zlib';
const enc = new TextEncoder();
export function frame(flags, body) {
  if (body.length < 256) { const o = new Uint8Array(2 + body.length); o[0] = flags; o[1] = body.length; o.set(body, 2); return o; }
  const o = new Uint8Array(9 + body.length); o[0] = flags | 0x02; new DataView(o.buffer).setBigUint64(1, BigInt(body.length)); o.set(body, 9); return o;
}
export function serverGreeting() { const g = new Uint8Array(64); g[0] = 0xff; g[9] = 0x7f; g[10] = 3; g[11] = 1; g.set(enc.encode('NULL'), 12); g[32] = 1; return g; }
export function readyFrame() {
  const name = enc.encode('Socket-Type'), val = enc.encode('PUB'); const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, val.length);
  const prop = Uint8Array.of(name.length, ...name, ...len, ...val); const cmd = enc.encode('READY');
  return frame(0x04, Uint8Array.of(cmd.length, ...cmd, ...prop));
}
export function message(envelope, text) {
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  const a = frame(0x01, enc.encode(envelope + '\0')), b = frame(0x00, new Uint8Array(gz));
  const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o;
}
/** generator -> ReadableStream van chunks (default 32 KiB, zoals een TCP-lezer) */
export function makeSocket(messageIterator, chunk = 32768) {
  async function* chunks() {
    yield serverGreeting(); yield readyFrame();
    let carry = new Uint8Array(0);
    for (const m of messageIterator) {
      const all = new Uint8Array(carry.length + m.length); all.set(carry); all.set(m, carry.length);
      let off = 0; while (all.length - off >= chunk) { yield all.slice(off, off + chunk); off += chunk; } carry = all.slice(off);
    }
    if (carry.length) yield carry;
  }
  const it = chunks();
  const readable = new ReadableStream({ async pull(c) { const { value, done } = await it.next(); if (done) c.close(); else c.enqueue(value); } });
  const writable = new WritableStream({ write() {} });
  return { opened: Promise.resolve(), readable, writable, close: async () => {} };
}
