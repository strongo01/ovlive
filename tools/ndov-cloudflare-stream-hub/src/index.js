import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
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
import { correlateKv17MutationsToKv78Rows, parseBisonPayload, parseKv17Payload, parseKv78Payload } from './feed-parser.mjs';

const HOST = 'pubsub.besteffort.ndovloket.nl';
const OWNER_PREFIXES = ['/ARR/', '/RIG/', '/GVB/', '/CXX/', '/EBS/', '/QBUZZ/', '/KEOLIS/', '/IVU/', '/OPENOV/'];
const CONFIG = {
  kv78: { port: 7817, name: 'KV78Turbo', prefixes: ['/GOVI/KV8passtimes/'] },
  bison: { port: 7658, name: 'BISON KV6/KV15/KV17', prefixes: OWNER_PREFIXES },
};
const TARGET_LINES = new Set(['U005', 'U011', 'U073', '24']); // BISON KV6 sample only; KV78 must capture all planning lines for KV17 correlation
const KV78_ROW_LIMIT = 5000; // bounded local diagnostic cache; not a production data store

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function currentOperatingDateAmsterdam() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function b64(bytes) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}
async function gunzip(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > 5_000_000) throw new Error('NDOV payload exceeds 5 MB safety limit');
    }
  } finally { try { await reader.cancel(); } catch {} }
  return concatBytes(...chunks);
}

function initialSnapshot(stream) {
  const c = CONFIG[stream];
  return {
    stream, label: c.name, host: HOST, port: c.port, state: 'idle',
    startedAt: null, finishedAt: null, sessionSeconds: null, messageCount: 0, rawBytes: 0,
    envelopeCounts: {}, latestMessageAt: null, latestRows: [], latestEvents: [], latestMutations: [],
    error: null, warnings: [],
  };
}

export class NdovFeedHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.snapshot = initialSnapshot('kv78');
    this.rows = new Map();
    this.events = new Map();
    this.mutations = new Map();
    this.running = false;
    this.socket = null;
    this.lastPersistAt = 0;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('snapshot');
      if (saved) this.snapshot = saved;
      const savedRows = await ctx.storage.get('rows');
      const savedRowChunkCount = await ctx.storage.get('rowsChunkCount');
      const savedEvents = await ctx.storage.get('events');
      const savedMutations = await ctx.storage.get('mutations');
      if (Number.isInteger(savedRowChunkCount) && savedRowChunkCount > 0) {
        const rowChunks = await Promise.all(Array.from(
          { length: savedRowChunkCount }, (_, i) => ctx.storage.get(`rows:${i}`),
        ));
        this.rows = new Map(rowChunks.flatMap((chunk) => Array.isArray(chunk) ? chunk : []));
      } else {
        this.rows = new Map(savedRows ?? []);
      }
      this.events = new Map(savedEvents ?? []);
      this.mutations = new Map(savedMutations ?? []);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const stream = url.searchParams.get('stream') || this.snapshot.stream || 'kv78';
    if (!CONFIG[stream]) return Response.json({ ok: false, error: 'unknown stream' }, { status: 400 });
    if (url.pathname === '/status') {
      const base = this.snapshot.state === 'idle' ? initialSnapshot(stream) : this.snapshot;
      return Response.json({ ...base, latestRows: [...this.rows.values()].slice(-KV78_ROW_LIMIT), latestEvents: [...this.events.values()].slice(-100), latestMutations: [...this.mutations.values()].slice(-300) }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname !== '/start') return new Response('not found', { status: 404 });
    const rawSeconds = Number(url.searchParams.get('seconds') || '45');
    const seconds = Number.isFinite(rawSeconds) ? Math.max(10, Math.min(120, Math.floor(rawSeconds))) : 45;
    if (this.running) {
      return Response.json({ ok: true, alreadyRunning: true, stream, snapshot: this.snapshot });
    }
    // Each short session starts with fresh KV78/KV6 samples, but retain the latest
    // KV17 state for the current Dutch operating date. KV17 is event-driven: a
    // CANCEL remains the latest known state until a newer RECOVER/change arrives.
    // Old operating dates are discarded so yesterday's mutations cannot fill the cache.
    if (stream === 'kv78') this.rows.clear();
    if (stream === 'bison') {
      this.events.clear();
      const operatingDate = currentOperatingDateAmsterdam();
      for (const [key, mutation] of this.mutations.entries()) {
        if (mutation.operationDate && mutation.operationDate < operatingDate) this.mutations.delete(key);
      }
    }
    this.snapshot = { ...initialSnapshot(stream), state: 'connecting', startedAt: new Date().toISOString(), sessionSeconds: seconds };
    const waitForCompletion = url.searchParams.get('wait') === '1';
    this.running = true;
    const startTask = () => {
      const task = this.collect(stream, seconds).catch(async (error) => {
        this.snapshot = { ...this.snapshot, state: 'error', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
        await this.persist(true);
      }).finally(() => { this.running = false; this.socket = null; });
      this.ctx.waitUntil(task);
      return task;
    };

    if (waitForCompletion) {
      // Local diagnostic mode: keep the HTTP request attached until the bounded
      // collector is finished. This distinguishes a feed/read issue from a local
      // dev-runtime/background-task lifecycle issue.
      await this.persist(true);
      await startTask();
      return Response.json({
        ok: this.snapshot.state === 'complete', started: true, completed: true,
        stream, seconds,
        snapshot: {
          stream: this.snapshot.stream, state: this.snapshot.state,
          messageCount: this.snapshot.messageCount, rawBytes: this.snapshot.rawBytes,
          envelopeCounts: this.snapshot.envelopeCounts,
          latestMessageAt: this.snapshot.latestMessageAt,
          startedAt: this.snapshot.startedAt, finishedAt: this.snapshot.finishedAt,
          error: this.snapshot.error, warnings: this.snapshot.warnings,
        },
      }, { headers: { 'cache-control': 'no-store' } });
    }

    const task = startTask();
    // Default mode returns immediately and records the task in waitUntil.
    await this.persist(true);
    return Response.json({ ok: true, started: true, stream, seconds, note: 'Eén collector gestart voor dit stream-type; raadpleeg /status voor de gedeelde momentopname.' });
  }

  async persistFullKv78Rows(force = false) {
    // Full diagnostic rows are held in memory during collection. Durable Object
    // storage values have size limits, so checkpoint KV78 rows in small chunks
    // only at forced checkpoints (start/handshake/end), not on every message.
    if (!force || this.snapshot.stream !== 'kv78') return;
    const entries = [...this.rows.entries()];
    const chunkSize = 100;
    const chunkCount = Math.ceil(entries.length / chunkSize);
    const previousCount = Number(await this.ctx.storage.get('rowsChunkCount')) || 0;

    for (let i = 0; i < chunkCount; i += 1) {
      await this.ctx.storage.put(`rows:${i}`, entries.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    if (previousCount > chunkCount) {
      const obsoleteKeys = Array.from({ length: previousCount - chunkCount }, (_, i) => `rows:${chunkCount + i}`);
      if (obsoleteKeys.length) await this.ctx.storage.delete(obsoleteKeys);
    }
    await this.ctx.storage.put('rowsChunkCount', chunkCount);
  }

  async persist(force = false) {
    // Avoid repeated heavy storage writes while high-volume KV78 batches arrive.
    if (!force && Date.now() - this.lastPersistAt < 5000) return;
    this.lastPersistAt = Date.now();
    this.snapshot.latestRows = [...this.rows.values()].slice(-30);
    this.snapshot.latestEvents = [...this.events.values()].slice(-20);
    this.snapshot.latestMutations = [...this.mutations.values()].slice(-30);
    await this.persistFullKv78Rows(force);
    // 'rows' remains a small recovery sample; the full bounded set is chunked above.
    await this.ctx.storage.put({ snapshot: this.snapshot, rows: [...this.rows.entries()].slice(-300), events: [...this.events.entries()].slice(-100), mutations: [...this.mutations.entries()].slice(-300) });
  }

  async collect(stream, seconds) {
    const config = CONFIG[stream];
    const deadline = Date.now() + seconds * 1000;
    let socket, writer, buffered, reader;
    let multipart = [];
    this.snapshot = { ...this.snapshot, state: 'connecting' };
    try {
      socket = connect({ hostname: HOST, port: config.port });
      this.socket = socket;
      await Promise.race([socket.opened, wait(5000).then(() => { throw new Error('TCP connect timed out'); })]);
      writer = socket.writable.getWriter();
      buffered = new BufferedSocketReader(socket.readable.getReader());
      reader = buffered.reader;
      await writer.write(makeGreeting());
      const greet = await this.withReadTimeout(buffered.readExact(64), 5000, 'server greeting');
      const greeting = parseGreeting(greet);
      await writer.write(makeReadyFrame(greeting.negotiatedMinor));
      const readyFrame = await this.withReadTimeout(buffered.readFrame(), 5000, 'server READY');
      if (!readyFrame.command) throw new Error('Expected ZMTP READY command frame');
      const ready = parseCommandBody(readyFrame.body, greeting.negotiatedMinor);
      if (ready.name !== 'READY') throw new Error(`Expected READY, received ${ready.name}`);
      await writer.write(concatBytes(...config.prefixes.map((p) => makeSubscribeFrame(p, greeting.negotiatedMinor))));
      this.snapshot = { ...this.snapshot, state: 'listening', zmtpVersion: `${greeting.major}.${greeting.negotiatedMinor}`, handshake: ready.name, prefixes: config.prefixes };
      await this.persist(true);

      while (Date.now() < deadline) {
        const frame = await this.withReadTimeout(buffered.readFrame(), Math.max(1, deadline - Date.now()), 'stream frame', true);
        if (!frame) break;
        if (frame.command) {
          const command = parseCommandBody(frame.body, greeting.negotiatedMinor);
          if (command.name === 'PING') {
            const context = command.data.length > 2 ? command.data.subarray(2) : new Uint8Array(0);
            await writer.write(makePongFrame(context, greeting.negotiatedMinor));
          } else if (command.name === 'ERROR') {
            this.snapshot.warnings.push(`Publisher ERROR: ${decodeUtf8(command.data).slice(0, 200)}`);
          }
          continue;
        }
        multipart.push(frame.body);
        if (frame.more) continue;
        if (multipart.length >= 2) {
          const envelope = decodeUtf8(multipart[0]).replace(/\0/g, '').trim();
          const payload = concatBytes(...multipart.slice(1));
          const expanded = await gunzip(payload);
          const text = decodeUtf8(expanded);
          this.snapshot.messageCount += 1;
          this.snapshot.rawBytes += payload.length;
          this.snapshot.latestMessageAt = new Date().toISOString();
          this.snapshot.envelopeCounts[envelope] = (this.snapshot.envelopeCounts[envelope] || 0) + 1;
          if (stream === 'kv78' && /\/KV8passtimes\//.test(envelope)) {
            for (const row of parseKv78Payload(text, envelope)) {
              // Keep every line during this bounded diagnostic run. Filtering to
              // U005/U011/U073/24 hid mutations such as CXX L014 and ARR 26010.
              const key = `${row.identity}|${row.userStopOrderNumber}|${row.userStopCode}`;
              this.rows.delete(key);
              this.rows.set(key, row);
              if (this.rows.size > KV78_ROW_LIMIT) this.rows.delete(this.rows.keys().next().value);
            }
          } else if (stream === 'bison' && /KV6posinfo/.test(envelope)) {
            for (const ev of parseBisonPayload(text, envelope)) {
              if (!TARGET_LINES.has(ev.linePlanningNumber)) continue;
              const key = `${ev.identity}|${ev.eventType}|${ev.userStopCode}`;
              this.events.delete(key);
              this.events.set(key, ev);
              if (this.events.size > 300) this.events.delete(this.events.keys().next().value);
            }
          } else if (stream === 'bison' && /KV17cvlinfo/i.test(envelope)) {
            for (const mutation of parseKv17Payload(text, envelope)) {
              // KV17 messages are relatively sparse; keep a bounded sample across
              // subscribed operators so diagnostics still see mutations for lines
              // outside the KV78/KV6 sample set.
              const key = `${mutation.identity}|${mutation.eventType}|${mutation.userStopCode ?? ''}|${mutation.passageSequenceNumber ?? ''}|${mutation.timestamp ?? ''}`;
              this.mutations.delete(key);
              this.mutations.set(key, mutation);
              if (this.mutations.size > 300) this.mutations.delete(this.mutations.keys().next().value);
            }
          }
          await this.persist(false);
        }
        multipart = [];
      }
      this.snapshot = { ...this.snapshot, state: 'complete', finishedAt: new Date().toISOString(), ok: true };
      await this.persist(true);
    } catch (error) {
      const expectedEnd = Date.now() >= deadline;
      this.snapshot = {
        ...this.snapshot,
        state: expectedEnd ? 'complete' : 'error',
        ok: expectedEnd,
        finishedAt: new Date().toISOString(),
        error: expectedEnd ? null : (error instanceof Error ? error.message : String(error)),
      };
      await this.persist(true);
    } finally {
      if (socket) { try { await socket.close(); } catch {} }
      if (reader) { try { await reader.cancel(); } catch {} }
      if (writer) { try { writer.releaseLock(); } catch {} }
    }
  }

  async withReadTimeout(promise, ms, label, returnNull = false) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => returnNull ? resolve(null) : reject(new Error(`${label} timed out after ${ms} ms`)), ms);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

async function callHub(env, stream, action, seconds, waitForCompletion = false) {
  const id = env.NDOV_FEEDS.idFromName(stream);
  const stub = env.NDOV_FEEDS.get(id);
  const url = new URL(`https://ndov-hub.local/${action}`);
  url.searchParams.set('stream', stream);
  if (seconds != null) url.searchParams.set('seconds', String(seconds));
  if (waitForCompletion) url.searchParams.set('wait', '1');
  const response = await stub.fetch(url.toString());
  return response.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });
    if (url.pathname === '/' || url.pathname === '/help') {
      return new Response([
        'OVLive NDOV Durable Object stream-hub probe (local only)',
        '',
        '1) GET /start?seconds=45 starts exactly one collector instance per feed.',
        '2) GET /status returns the shared snapshots and selected-line events.',
        '3) Do not deploy this probe. It is a local architecture test.',
      ].join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname === '/start') {
      const n = Number(url.searchParams.get('seconds') || 45);
      const seconds = Number.isFinite(n) ? Math.max(10, Math.min(120, Math.floor(n))) : 45;
      const waitForCompletion = url.searchParams.get('wait') === '1';
      const results = await Promise.all([
        callHub(env, 'kv78', 'start', seconds, waitForCompletion),
        callHub(env, 'bison', 'start', seconds, waitForCompletion),
      ]);
      return Response.json({ ok: results.every((r) => r.ok), seconds, feeds: results }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/status') {
      const results = await Promise.all([
        callHub(env, 'kv78', 'status'),
        callHub(env, 'bison', 'status'),
      ]);
      const kv78Rows = results[0]?.latestRows ?? [];
      const kv78TripKey = (r) => [r.dataOwnerCode, r.operationDate, r.linePlanningNumber, r.journeyNumber, r.fortifyOrderNumber ?? '0'].join('|');
      const kv78OwnerLineCounts = {};
      for (const row of kv78Rows) {
        const key = `${row.dataOwnerCode ?? '?'}|${row.linePlanningNumber ?? '?'}`;
        kv78OwnerLineCounts[key] = (kv78OwnerLineCounts[key] ?? 0) + 1;
      }
      const tripStatuses = correlateKv17MutationsToKv78Rows(
        kv78Rows,
        results[1]?.latestMutations ?? [],
      );
      return Response.json({
        ok: results.every((r) => r.state !== 'error'),
        checkedAt: new Date().toISOString(),
        feeds: results,
        kv78CaptureSummary: {
          storedStopRows: kv78Rows.length,
          distinctTrips: new Set(kv78Rows.map(kv78TripKey)).size,
          rowLimit: KV78_ROW_LIMIT,
          ownerLineRowCounts: Object.entries(kv78OwnerLineCounts).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([ownerLine, stopRows]) => ({ ownerLine, stopRows })),
        },
        tripStatuses,
        tripStatusSummary: {
          mutationTrips: tripStatuses.length,
          exactKv78Matches: tripStatuses.filter((t) => t.matchedKv78StopCount > 0).length,
          cancelledTrips: tripStatuses.filter((t) => t.cancelled === true).length,
          recoveredTrips: tripStatuses.filter((t) => t.cancelled === false).length,
          unmatchedMutationTrips: tripStatuses.filter((t) => t.matchedKv78StopCount === 0).length,
        },
      }, { headers: { 'cache-control': 'no-store' } });
    }
    return new Response('Not found. Use /start?seconds=45 or /status.', { status: 404 });
  },
};
