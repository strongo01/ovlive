import { connect } from 'cloudflare:sockets';
import {
  BufferedSocketReader,
  concatBytes,
  decodeUtf8,
  makeGreeting,
  makePongFrame,
  makeReadyFrame,
  makeSubscribeFrame,
  parseCommandBody,
  parseGreeting,
} from './zmtp-protocol.mjs';

const HOST = 'pubsub.besteffort.ndovloket.nl';
const OWNER_PREFIXES = [
  '/ARR/', '/RIG/', '/GVB/', '/CXX/', '/EBS/',
  '/QBUZZ/', '/KEOLIS/', '/IVU/', '/OPENOV/',
];
const FEEDS = {
  kv78: { port: 7817, label: 'KV78Turbo', prefixes: ['/GOVI/KV8passtimes/'] },
  bison: { port: 7658, label: 'BISON KV6/KV15/KV17', prefixes: OWNER_PREFIXES },
};
const textEncoder = new TextEncoder();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, label) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

function base64Snippet(bytes, max = 80) {
  const cut = bytes.subarray(0, Math.min(bytes.length, max));
  let binary = '';
  for (const b of cut) binary += String.fromCharCode(b);
  return btoa(binary) + (bytes.length > max ? '…' : '');
}

async function gunzipText(bytes, maxChars = 1800) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    try {
      while (result.length < maxChars) {
        const { value, done } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return result.slice(0, maxChars);
  } catch (error) {
    return `[gzip decode failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function combine(parts) {
  return concatBytes(...parts);
}

async function runProbe(streamName, seconds) {
  const config = FEEDS[streamName];
  const startedAt = new Date().toISOString();
  const result = {
    ok: false,
    stream: config.label,
    host: HOST,
    port: config.port,
    startedAt,
    requestedListenSeconds: seconds,
    prefixes: config.prefixes,
    stage: 'initializing',
    zmtpVersion: null,
    greeting: null,
    handshake: null,
    messageCount: 0,
    rawBytes: 0,
    envelopeCounts: {},
    samples: [],
    warnings: [],
  };

  let socket;
  let writer;
  let reader;
  try {
    result.stage = 'tcp_connect';
    socket = connect({ hostname: HOST, port: config.port });
    await withTimeout(socket.opened, 5000, 'TCP connect');
    writer = socket.writable.getWriter();
    reader = new BufferedSocketReader(socket.readable.getReader());

    result.stage = 'send_client_greeting';
    await writer.write(makeGreeting());

    result.stage = 'read_server_greeting';
    const greetingBytes = await withTimeout(reader.readExact(64), 5000, 'Server greeting');
    const greeting = parseGreeting(greetingBytes);
    result.zmtpVersion = `${greeting.major}.${greeting.negotiatedMinor}`;
    result.greeting = { mechanism: greeting.mechanism, peerActsAsServer: greeting.asServer };
    // With the NULL mechanism RFC 37 requires as-server = 0 for both peers.
    // A false value is expected; it is not evidence of a failed publisher.

    result.stage = 'send_ready';
    await writer.write(makeReadyFrame(greeting.negotiatedMinor));

    result.stage = 'read_server_ready';
    const readyFrame = await withTimeout(reader.readFrame(), 5000, 'Server READY command');
    if (!readyFrame.command) throw new Error('Expected a ZMTP command after greeting, received a data frame.');
    const ready = parseCommandBody(readyFrame.body, greeting.negotiatedMinor);
    result.handshake = { command: ready.name };
    if (ready.name !== 'READY') {
      throw new Error(`Expected READY from publisher; received ${ready.name}`);
    }

    result.stage = 'subscribe';
    const subscriptions = config.prefixes.map((prefix) => makeSubscribeFrame(prefix, greeting.negotiatedMinor));
    await writer.write(combine(subscriptions));

    const deadline = Date.now() + seconds * 1000;
    const multipart = [];
    const sampledEnvelopes = new Set();
    result.stage = 'collect_messages';

    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let frame;
      try {
        frame = await Promise.race([
          reader.readFrame(),
          delay(remaining).then(() => null),
        ]);
      } catch (error) {
        // A disconnect while testing is useful diagnostic output, not a crash.
        result.warnings.push(`Stream read stopped: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      if (!frame) break;
      if (frame.command) {
        const command = parseCommandBody(frame.body, greeting.negotiatedMinor);
        if (command.name === 'PING') {
          // ZMTP/3.1 PING begins with a 2-byte TTL; PONG carries only its context.
          const context = command.data.length > 2 ? command.data.subarray(2) : new Uint8Array(0);
          await writer.write(makePongFrame(context, greeting.negotiatedMinor));
        } else if (command.name === 'ERROR') {
          result.warnings.push(`Publisher command ERROR: ${decodeUtf8(command.data).slice(0, 300)}`);
        }
        continue;
      }
      multipart.push(frame.body);
      if (frame.more) continue;

      if (multipart.length > 0) {
        const envelope = decodeUtf8(multipart[0]).replace(/\0/g, '').trim();
        const payload = combine(multipart.slice(1));
        result.messageCount += 1;
        result.rawBytes += payload.length;
        result.envelopeCounts[envelope] = (result.envelopeCounts[envelope] || 0) + 1;
        if (result.samples.length < 12 && envelope && !sampledEnvelopes.has(envelope)) {
          const sample = {
            envelope,
            multipartParts: multipart.length,
            payloadBytes: payload.length,
            gzip: payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b,
            payloadBase64Prefix: base64Snippet(payload, 24),
          };
          const text = await gunzipText(payload);
          if (text !== null) sample.decompressedPrefix = text;
          result.samples.push(sample);
          sampledEnvelopes.add(envelope);
        }
      }
      multipart.length = 0;
    }

    result.ok = true;
    result.stage = 'complete';
    result.finishedAt = new Date().toISOString();
    result.note = result.messageCount > 0
      ? 'ZMTP-handshake geslaagd en live berichten ontvangen.'
      : 'ZMTP-handshake geslaagd, maar tijdens het venster zijn geen publicatieberichten ontvangen.';
    return result;
  } catch (error) {
    result.finishedAt = new Date().toISOString();
    result.error = error instanceof Error ? error.message : String(error);
    result.note = 'Lokale Cloudflare Workers-runtime kon de stream niet volledig testen. Controleer stage en error; er is niets gedeployed.';
    return result;
  } finally {
    if (socket) {
      try { await socket.close(); } catch {}
    }
    if (reader?.reader) {
      try { await reader.reader.cancel(); } catch {}
      try { reader.reader.releaseLock(); } catch {}
    }
    if (writer) {
      try { writer.releaseLock(); } catch {}
    }
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/' && url.pathname !== '/probe') {
      return new Response('Not found. Try /probe?stream=kv78&seconds=5', { status: 404 });
    }
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });
    if (url.pathname === '/') {
      return new Response([
        'OVLive local NDOV ZMTP probe',
        '',
        'Use /probe?stream=kv78&seconds=5 or /probe?stream=bison&seconds=5',
        'This is a local diagnostic only. Do not deploy this worker.',
      ].join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    const streamName = (url.searchParams.get('stream') || 'kv78').toLowerCase();
    if (!Object.hasOwn(FEEDS, streamName)) {
      return Response.json({ error: 'stream must be kv78 or bison', allowedStreams: Object.keys(FEEDS) }, { status: 400 });
    }
    const requested = Number(url.searchParams.get('seconds') || '5');
    const seconds = Number.isFinite(requested) ? Math.max(2, Math.min(10, Math.floor(requested))) : 5;
    const result = await runProbe(streamName, seconds);
    return Response.json(result, { status: result.ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
  },
};
