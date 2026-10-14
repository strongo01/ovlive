import assert from 'node:assert/strict';
import {
  BufferedSocketReader,
  concatBytes,
  decodeUtf8,
  makeGreeting,
  makeReadyFrame,
  makeSubscribeFrame,
  parseCommandBody,
  parseGreeting,
} from '../src/zmtp-protocol.mjs';

const greeting = makeGreeting();
assert.equal(greeting.length, 64);
assert.equal(greeting[0], 0xff);
assert.equal(greeting[9], 0x7f);
assert.equal(greeting[10], 3);
assert.equal(greeting[11], 1);
assert.equal(decodeUtf8(greeting.subarray(12, 16)), 'NULL');
const peer = greeting.slice();
peer[32] = 0; // NULL mechanism: as-server MUST be zero for both peers (RFC 37).
assert.deepEqual(parseGreeting(peer), { major: 3, minor: 1, negotiatedMinor: 1, mechanism: 'NULL', asServer: false });

const ready = makeReadyFrame(1);
assert.equal(ready[0], 0x04);
const readyBody = ready.subarray(2);
const parsedReady = parseCommandBody(readyBody, 1);
assert.equal(parsedReady.name, 'READY');
assert.equal(parsedReady.data[0], 11); // Socket-Type metadata property name length

// Parse the exact peer payload reported by the live test: 05 READY 0b Socket-Type...
const serverReadyBody = concatBytes(
  Uint8Array.of(5), new TextEncoder().encode('READY'),
  Uint8Array.of(11), new TextEncoder().encode('Socket-Type'),
  Uint8Array.of(0, 0, 0, 3), new TextEncoder().encode('PUB'),
);
const parsedServerReady = parseCommandBody(serverReadyBody, 1);
assert.equal(parsedServerReady.name, 'READY');
assert.equal(decodeUtf8(parsedServerReady.data.subarray(1, 12)), 'Socket-Type');
assert.equal(decodeUtf8(parsedServerReady.data.subarray(16)), 'PUB');

const sub = makeSubscribeFrame('/GOVI/KV8passtimes/', 1);
assert.equal(sub[0], 0x04);
assert.equal(parseCommandBody(sub.subarray(2), 1).name, 'SUBSCRIBE');
const oldSub = makeSubscribeFrame('/GOVI/KV8passtimes/', 0);
assert.equal(oldSub[0], 0x00);
assert.equal(oldSub[2], 0x01); // ZMTP/3.0 subscription message payload

// Prove the frame reader handles arbitrary TCP chunk boundaries and multipart frames.
const input = concatBytes(
  Uint8Array.of(0x01, 0x03, 0x61, 0x62, 0x63),
  Uint8Array.of(0x00, 0x02, 0x64, 0x65),
);
let offset = 0;
const source = new ReadableStream({
  pull(controller) {
    if (offset >= input.length) { controller.close(); return; }
    const end = Math.min(offset + 2, input.length);
    controller.enqueue(input.slice(offset, end));
    offset = end;
  },
});
const buffered = new BufferedSocketReader(source.getReader());
const first = await buffered.readFrame();
assert.equal(first.more, true);
assert.equal(decodeUtf8(first.body), 'abc');
const second = await buffered.readFrame();
assert.equal(second.more, false);
assert.equal(decodeUtf8(second.body), 'de');

console.log('PASS: ZMTP 3.1 greeting encoding/decoding; NULL role bit handled correctly');
console.log('PASS: length-prefixed ZMTP 3.1 READY/SUBSCRIBE command encoding');
console.log('PASS: decodes real READY + Socket-Type=PUB structure from probe error');
console.log('PASS: ZMTP 3.0 subscription fallback framing');
console.log('PASS: frame reader handles fragmented TCP chunks and multipart messages');
console.log('All ZMTP protocol self-tests passed.');
