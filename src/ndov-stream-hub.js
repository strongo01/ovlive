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
} from './ndov-zmtp-protocol.mjs';
import { correlateKv17MutationsToKv78Rows, parseBisonPayload, parseKv17Payload, parseKv78Payload } from './ndov-feed-parser.mjs';
import { eventsForIdentities, flattenCurrentMutations, normalizeOperatingDate, normalizeTripLookupIdentity, operatingDateRetentionCutoff, rowMatchesIdentity, upsertCurrentMutationState } from './ndov-live-state.mjs';

const HOST = 'pubsub.besteffort.ndovloket.nl';
const OWNER_PREFIXES = ['/ARR/', '/RIG/', '/GVB/', '/CXX/', '/EBS/', '/QBUZZ/', '/KEOLIS/', '/IVU/', '/OPENOV/'];
const CONFIG = {
  kv78: { port: 7817, name: 'KV78Turbo', prefixes: ['/GOVI/KV8passtimes/'] },
  bison: { port: 7658, name: 'BISON KV6/KV15/KV17', prefixes: OWNER_PREFIXES },
};
const KV6_EVENT_LIMIT = 30000;
const KV6_EVENT_RETENTION_MS = 10 * 60 * 1000;
const KV6_EVENT_STATUS_FRESH_MS = 180 * 1000;
const KV78_ROW_LIMIT = 30000; // rolling, durable row cache; still bounded by design
const KV78_STATUS_SAMPLE_LIMIT = 5000;
const KV17_STATE_LIMIT = 5000;
const ROW_RETENTION_MS = 10 * 60 * 1000;
const FRESH_ROW_MS = 180 * 1000;
// Near-continuous streaming; reconnect before the long-lived TCP/request ceiling.
const AUTO_SESSION_SECONDS = 600;
const AUTO_REST_MS = 5 * 1000;
const AUTO_CYCLE_MS = AUTO_SESSION_SECONDS * 1000 + AUTO_REST_MS;
const CONTINUOUS_FULL_CHECKPOINT_MS = 60 * 1000;
const AUTO_DATA_IDLE_RECONNECT_MS = 120 * 1000;
const AUTO_RETRY_BASE_MS = 30 * 1000;
const AUTO_RETRY_MAX_MS = 5 * 60 * 1000;
const CONTINUOUS_PERSIST_INTERVAL_MS = 30 * 1000;
const ROW_CHUNK_SIZE = 1000;
const MUTATION_CHUNK_SIZE = 1000;

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
async function gunzip(bytes, maxExpandedBytes = 5_000_000) {
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
      if (total > maxExpandedBytes) throw new Error(`Expanded NDOV data exceeds ${maxExpandedBytes} byte safety limit`);
    }
  } finally { try { await reader.cancel(); } catch {} }
  return concatBytes(...chunks);
}

async function gzip(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')).getReader();
  const chunks = [];
  try { while (true) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); } }
  finally { try { await reader.cancel(); } catch {} }
  return concatBytes(...chunks);
}

async function gzipJson(value) { return gzip(new TextEncoder().encode(JSON.stringify(value))); }
async function gunzipJson(value, limit = 8_000_000) {
  if (!(value instanceof Uint8Array)) value = new Uint8Array(value);
  return JSON.parse(decodeUtf8(await gunzip(value, limit)));
}
function parseTimestamp(value) {
  if (!value) return null;
  let text = String(value).trim().replace(/\.(\d{3})\d+(?=([+-]\d{2}:?\d{2}|Z)$)/, '.$1');
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function canonicalBisonTripIdentity(item) {
  if (!item) return null;
  const owner = String(item.dataOwnerCode ?? item.DataOwnerCode ?? '').trim();
  const date = normalizeOperatingDate(item.operationDate ?? item.operatingDay ?? item.OperatingDay);
  const line = String(item.linePlanningNumber ?? item.LinePlanningNumber ?? '').trim();
  const journey = String(item.journeyNumber ?? item.JourneyNumber ?? '').trim();
  const reinforcement = String(item.reinforcementNumber ?? item.ReinforcementNumber ?? '0').trim() || '0';
  if (!owner || !/^\d{8}$/.test(date) || !line || !journey) return null;
  return [owner, date, line, journey, reinforcement].join('|');
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
    this.ctx = ctx;
    this.snapshot = initialSnapshot('kv78');
    this.rows = new Map();
    this.events = new Map();
    // Map identity -> the most recent timestamp and its same-timestamp KV17 actions.
    this.mutations = new Map();
    this.running = false;
    this.continuousMode = false;
    this.continuousEnabled = false;
    this.stopRequested = false;
    this.socket = null;
    this.lastPersistAt = 0;
    this.lastFullPersistAt = 0;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('snapshot');
      if (saved) this.snapshot = saved;
      this.continuousEnabled = (await ctx.storage.get('continuousEnabled')) === true;
      const savedRows = await ctx.storage.get('rows');
      const compressedRowCount = Number(await ctx.storage.get('rowsGzipChunkCount')) || 0;
      const savedRowChunkCount = Number(await ctx.storage.get('rowsChunkCount')) || 0;
      const savedEvents = await ctx.storage.get('events');
      const compressedEventCount = Number(await ctx.storage.get('eventsGzipChunkCount')) || 0;
      const savedMutations = await ctx.storage.get('mutations');
      if (compressedRowCount > 0) {
        const rowChunks = await Promise.all(Array.from({ length: compressedRowCount }, (_, i) => ctx.storage.get(`rows:gzip:${i}`)));
        const entries = [];
        for (const chunk of rowChunks) if (chunk) entries.push(...await gunzipJson(chunk));
        this.rows = new Map(entries);
      } else if (savedRowChunkCount > 0) {
        const rowChunks = await Promise.all(Array.from({ length: savedRowChunkCount }, (_, i) => ctx.storage.get(`rows:${i}`)));
        this.rows = new Map(rowChunks.flatMap((chunk) => Array.isArray(chunk) ? chunk : []));
      } else {
        this.rows = new Map(savedRows ?? []);
      }
      this.events = new Map();
      if (compressedEventCount > 0) {
        const eventChunks = await Promise.all(Array.from({ length: compressedEventCount }, (_, i) => ctx.storage.get(`events:gzip:${i}`)));
        for (const chunk of eventChunks) if (chunk) {
          for (const [savedKey, event] of await gunzipJson(chunk)) {
            const key = canonicalBisonTripIdentity(event) ?? savedKey;
            this.events.set(key, { ...event, identity: key });
          }
        }
      } else {
        for (const [savedKey, event] of (savedEvents ?? [])) {
          const key = canonicalBisonTripIdentity(event) ?? savedKey;
          this.events.set(key, { ...event, identity: key });
        }
      }
      const compressedMutationCount = Number(await ctx.storage.get('mutationsGzipChunkCount')) || 0;
      const legacyMutationChunkCount = Number(await ctx.storage.get('mutationsChunkCount')) || 0;
      if (compressedMutationCount > 0) {
        const mutationChunks = await Promise.all(Array.from({ length: compressedMutationCount }, (_, i) => ctx.storage.get(`mutations:gzip:${i}`)));
        for (const chunk of mutationChunks) if (chunk) {
          for (const [identity, state] of await gunzipJson(chunk)) this.mutations.set(identity, state);
        }
      } else if (legacyMutationChunkCount > 0) {
        const mutationChunks = await Promise.all(Array.from({ length: legacyMutationChunkCount }, (_, i) => ctx.storage.get(`mutations:${i}`)));
        for (const chunk of mutationChunks) for (const [key, mutation] of (Array.isArray(chunk) ? chunk : [])) upsertCurrentMutationState(this.mutations, mutation, KV17_STATE_LIMIT);
      } else {
        // Migrate the bounded event map saved by older bridge versions.
        for (const item of new Map(savedMutations ?? []).values()) {
          if (item?.events && item?.identity) this.mutations.set(item.identity, item);
          else upsertCurrentMutationState(this.mutations, item, KV17_STATE_LIMIT);
        }
      }
      this.pruneRows();
      this.pruneEvents();
      this.pruneMutationDates();
    });
  }

  pruneMutationDates() {
    // Keep the current and previous two operating dates. Some GTFS service
    // trips cross midnight; pruning at midnight would drop still-relevant KV17.
    const currentDate = normalizeOperatingDate(currentOperatingDateAmsterdam());
    const cutoffDate = operatingDateRetentionCutoff(currentDate, 2);
    if (!cutoffDate) return;
    for (const [identity] of this.mutations.entries()) {
      const identityDate = normalizeOperatingDate(identity.split('|')[1]);
      if (/^\d{8}$/.test(identityDate) && identityDate < cutoffDate) this.mutations.delete(identity);
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const stream = url.searchParams.get('stream') || this.snapshot.stream || 'kv78';
    if (!CONFIG[stream]) return Response.json({ ok: false, error: 'unknown stream' }, { status: 400 });
    if (url.pathname === '/status') {
      if (stream === 'bison') this.pruneEvents();
      const base = this.snapshot.state === 'idle' ? initialSnapshot(stream) : this.snapshot;
      const kv78IdentityDiagnostics =
        stream === "kv78" && url.searchParams.get("identityDiagnostics") === "1"
          ? (() => {
              const currentDate = normalizeOperatingDate(currentOperatingDateAmsterdam());
              const groups = new Map();
              let matchingRowCount = 0;

              for (const row of this.rows.values()) {
                const owner = String(row?.dataOwnerCode ?? "").trim().toUpperCase();
                const date = normalizeOperatingDate(row?.operationDate);
                const line = String(row?.linePlanningNumber ?? "").trim().toUpperCase();

                if (
                  owner !== "CXX" ||
                  date !== currentDate ||
                  !["U005", "U011", "U073"].includes(line)
                ) continue;

                const journey = String(row?.journeyNumber ?? "").trim();
                const reinforcement = String(row?.fortifyOrderNumber ?? "0").trim() || "0";
                if (!journey) continue;

                matchingRowCount += 1;
                const identity = [owner, date, line, journey, reinforcement].join("|");

                if (!groups.has(identity)) {
                  groups.set(identity, {
                    identity,
                    rowCount: 0,
                    stopCodes: new Set(),
                    latestReceivedAt: null,
                    latestSourceUpdatedAt: null,
                  });
                }

                const group = groups.get(identity);
                group.rowCount += 1;

                if (row?.userStopCode != null) {
                  group.stopCodes.add(String(row.userStopCode));
                }

                const receivedAt = String(row?.receivedAt ?? "");
                if (receivedAt && (
                  !group.latestReceivedAt || receivedAt > group.latestReceivedAt
                )) group.latestReceivedAt = receivedAt;

                const sourceUpdatedAt = String(row?.lastUpdateTimeStamp ?? "");
                if (sourceUpdatedAt && (
                  !group.latestSourceUpdatedAt ||
                  sourceUpdatedAt > group.latestSourceUpdatedAt
                )) group.latestSourceUpdatedAt = sourceUpdatedAt;
              }

              const trips = [...groups.values()]
                .map(({ stopCodes, ...group }) => ({
                  ...group,
                  uniqueStopCount: stopCodes.size,
                  sampleStopCodes: [...stopCodes].slice(0, 10),
                }))
                .sort((a, b) =>
                  String(b.latestReceivedAt ?? "").localeCompare(
                    String(a.latestReceivedAt ?? "")
                  )
                );

              return {
                currentDate,
                cacheSize: this.rows.size,
                cacheLimit: KV78_ROW_LIMIT,
                matchingRowCount,
                identityCount: trips.length,
                trips: trips.slice(0, 80),
              };
            })()
          : null;
      const currentMutations = flattenCurrentMutations(this.mutations, 300);
      return Response.json({
        ...base,
        latestRows: url.searchParams.get('includeAllRows') === '1'
          ? [...this.rows.values()]
          : [...this.rows.values()].slice(-KV78_STATUS_SAMPLE_LIMIT),
        latestEvents: [...this.events.values()].slice(-100),
        storedKv6TripCount: this.events.size,
        latestMutations: currentMutations,
        storedKv78RowCount: this.rows.size,
        kv78IdentityDiagnostics,
        storedMutationIdentityCount: this.mutations.size,
        continuousEnabled: this.continuousEnabled,
        nextAlarmAt: await this.ctx.storage.getAlarm(),
        autoCollector: { enabled: this.continuousEnabled, sessionSeconds: AUTO_SESSION_SECONDS, restSeconds: AUTO_REST_MS / 1000, rowRetentionSeconds: ROW_RETENTION_MS / 1000, freshnessSeconds: FRESH_ROW_MS / 1000 },
      }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/continuous/enable') {
      this.continuousEnabled = true;
      this.stopRequested = false;
      if (this.snapshot.stream !== stream) this.snapshot = initialSnapshot(stream);
      await this.ctx.storage.put({ continuousEnabled: true, collectorStream: stream, snapshot: this.snapshot });
      const alarmAt = await this.ctx.storage.getAlarm();
      if (alarmAt === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return Response.json({ ok: true, enabled: true, stream, nextAlarmAt: await this.ctx.storage.getAlarm(), note: 'Duurzame alarmgestuurde collector ingeschakeld; huidige verzameling start via alarm.' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/continuous/disable') {
      const persistedEnabled = (await this.ctx.storage.get('continuousEnabled')) === true;
      const existingAlarm = await this.ctx.storage.getAlarm();
      const alreadyDisabled = !persistedEnabled &&
        existingAlarm === null &&
        !this.running &&
        !this.socket;

      this.continuousEnabled = false;
      this.stopRequested = true;

      // Idempotent: als de collector al uit staat, voorkom onnodige writes.
      if (alreadyDisabled) {
        return Response.json({
          ok: true,
          enabled: false,
          stream,
          alreadyDisabled: true,
          note: 'Collector stond al uit; er is geen opslag gewijzigd.'
        }, { headers: { 'cache-control': 'no-store' } });
      }

      await this.ctx.storage.put('continuousEnabled', false);
      await this.ctx.storage.deleteAlarm();
      if (this.socket) { try { await this.socket.close(); } catch {} }
      return Response.json({ ok: true, enabled: false, stream, note: 'Automatische collector uitgeschakeld; geen nieuwe alarmen worden gepland.' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/events') {
      if (stream !== 'bison') return Response.json({ ok: false, error: 'KV6-events zijn alleen beschikbaar op de BISON-stream.' }, { status: 400 });
      const identities = [...new Set(url.searchParams.getAll('identity').map((value) => {
        const lookup = normalizeTripLookupIdentity(value);
        return lookup ? [lookup.owner, lookup.date, lookup.line, lookup.journey, lookup.reinforcement].join('|') : null;
      }).filter(Boolean))].slice(0, 20);
      this.pruneEvents();
      const events = identities.map((identity) => this.events.get(identity)).filter((event) => {
        if (!event) return false;
        const receivedMs = Date.parse(event.punctualityReceivedAt ?? '');
        return Number.isFinite(receivedMs) && receivedMs <= Date.now() + 30000 && Date.now() - receivedMs <= KV6_EVENT_STATUS_FRESH_MS && event.punctualitySeconds !== null && event.punctualitySeconds !== undefined;
      });
      return Response.json({ ok: true, state: this.snapshot.state, latestMessageAt: this.snapshot.latestMessageAt, returnedCount: events.length, events }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/mutations') {
      if (stream !== 'bison') return Response.json({ ok: false, error: 'KV17-mutaties zijn alleen beschikbaar op de BISON-stream.' }, { status: 400 });
      const identities = url.searchParams.getAll('identity').filter(Boolean).slice(0, 20);
      const mutations = eventsForIdentities(this.mutations, identities);
      return Response.json({ ok: true, state: this.snapshot.state, latestMessageAt: this.snapshot.latestMessageAt, mutations }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/rows') {
      if (stream !== 'kv78') return Response.json({ ok: false, error: 'KV78-halterijen zijn alleen beschikbaar op de KV78-stream.' }, { status: 400 });
      const identity = normalizeTripLookupIdentity(url.searchParams.get('identity'));
      if (!identity) return Response.json({ ok: false, error: 'Geef identity=owner|YYYY-MM-DD|line|journey|reinforcement op.' }, { status: 400 });
      const now = Date.now();
      const rows = [...this.rows.values()].filter((row) => rowMatchesIdentity(row, identity));
      const fresh = rows.filter((row) => { const at = Date.parse(row.receivedAt ?? ''); return Number.isFinite(at) && at <= now + 30000 && now - at <= FRESH_ROW_MS; });
      return Response.json({ ok: true, identity: [identity.owner, identity.date, identity.line, identity.journey, identity.reinforcement].join('|'), returnedCount: Math.min(fresh.length, 200), staleCount: rows.length - fresh.length, rows: fresh.slice(0, 200) }, { headers: { 'cache-control': 'no-store' } });
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
    if (stream === 'kv78' && !this.continuousEnabled) this.rows.clear();
    if (stream === 'bison') {
      this.events.clear();
      this.pruneMutationDates();
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
      await this.persist(true, false);
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
    await this.persist(true, false);
    return Response.json({ ok: true, started: true, stream, seconds, note: 'Eén collector gestart voor dit stream-type; raadpleeg /status voor de gedeelde momentopname.' });
  }

  async persistFullKv78Rows(force = false) {
    if (!force || this.snapshot.stream !== 'kv78') return;
    this.pruneRows();
    const entries = [...this.rows.entries()];
    const chunkCount = Math.ceil(entries.length / ROW_CHUNK_SIZE);
    const previousCount = Number(await this.ctx.storage.get('rowsGzipChunkCount')) || 0;
    const legacyCount = Number(await this.ctx.storage.get('rowsChunkCount')) || 0;

    // Compress independently-sized chunks. This keeps each SQLite-backed DO
    // value comfortably below Cloudflare's 2 MB per-value limit while using far
    // fewer storage writes than one write per stop row.
    for (let i = 0; i < chunkCount; i += 1) {
      const bytes = await gzipJson(entries.slice(i * ROW_CHUNK_SIZE, (i + 1) * ROW_CHUNK_SIZE));
      if (bytes.length > 1_500_000) throw new Error(`Compressed KV78 chunk ${i} exceeds safe storage value size`);
      await this.ctx.storage.put(`rows:gzip:${i}`, bytes);
    }
    await this.ctx.storage.put('rowsGzipChunkCount', chunkCount);
    const obsolete = [];
    for (let i = chunkCount; i < previousCount; i += 1) obsolete.push(`rows:gzip:${i}`);
    for (let i = 0; i < legacyCount; i += 1) obsolete.push(`rows:${i}`);
    if (obsolete.length) await this.ctx.storage.delete(obsolete);
    if (legacyCount) await this.ctx.storage.delete('rowsChunkCount');
  }

  async persistFullBisonEvents(force = false) {
    if (!force || this.snapshot.stream !== 'bison') return;
    this.pruneEvents();
    const entries = [...this.events.entries()];
    const chunkCount = Math.ceil(entries.length / MUTATION_CHUNK_SIZE);
    const previousCount = Number(await this.ctx.storage.get('eventsGzipChunkCount')) || 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const bytes = await gzipJson(entries.slice(i * MUTATION_CHUNK_SIZE, (i + 1) * MUTATION_CHUNK_SIZE));
      if (bytes.length > 1_500_000) throw new Error(`Compressed KV6 event chunk ${i} exceeds safe storage value size`);
      await this.ctx.storage.put(`events:gzip:${i}`, bytes);
    }
    await this.ctx.storage.put('eventsGzipChunkCount', chunkCount);
    const obsolete = [];
    for (let i = chunkCount; i < previousCount; i += 1) obsolete.push(`events:gzip:${i}`);
    if (obsolete.length) await this.ctx.storage.delete(obsolete);
  }

  async persistFullMutations(force = false) {
    if (!force || this.snapshot.stream !== 'bison') return;
    const entries = [...this.mutations.entries()];
    const chunkCount = Math.ceil(entries.length / MUTATION_CHUNK_SIZE);
    const previousCount = Number(await this.ctx.storage.get('mutationsGzipChunkCount')) || 0;
    const legacyCount = Number(await this.ctx.storage.get('mutationsChunkCount')) || 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const bytes = await gzipJson(entries.slice(i * MUTATION_CHUNK_SIZE, (i + 1) * MUTATION_CHUNK_SIZE));
      if (bytes.length > 1_500_000) throw new Error(`Compressed KV17 chunk ${i} exceeds safe storage value size`);
      await this.ctx.storage.put(`mutations:gzip:${i}`, bytes);
    }
    await this.ctx.storage.put('mutationsGzipChunkCount', chunkCount);
    const obsolete = [];
    for (let i = chunkCount; i < previousCount; i += 1) obsolete.push(`mutations:gzip:${i}`);
    for (let i = 0; i < legacyCount; i += 1) obsolete.push(`mutations:${i}`);
    if (obsolete.length) await this.ctx.storage.delete(obsolete);
    if (legacyCount) await this.ctx.storage.delete('mutationsChunkCount');
  }

  pruneEvents() {
    const now = Date.now();
    const cutoff = now - KV6_EVENT_RETENTION_MS;
    for (const [key, event] of this.events.entries()) {
      const received = Date.parse(event?.receivedAt ?? '');
      const punctualityReceived = Date.parse(event?.punctualityReceivedAt ?? '');
      if (!Number.isFinite(received) || received < cutoff || (Number.isFinite(punctualityReceived) && punctualityReceived < now - KV6_EVENT_STATUS_FRESH_MS)) this.events.delete(key);
    }
    while (this.events.size > KV6_EVENT_LIMIT) this.events.delete(this.events.keys().next().value);
  }

  pruneRows() {
    const cutoff = Date.now() - ROW_RETENTION_MS;
    for (const [key, row] of this.rows.entries()) {
      const captured = Date.parse(row?.receivedAt ?? '');
      if (!Number.isFinite(captured) || captured < cutoff) this.rows.delete(key);
    }
    while (this.rows.size > KV78_ROW_LIMIT) this.rows.delete(this.rows.keys().next().value);
  }

  async persist(force = false, bulk = false) {
    const minInterval = this.continuousMode ? CONTINUOUS_PERSIST_INTERVAL_MS : 5000;
    if (!force && Date.now() - this.lastPersistAt < minInterval) return;

    const persistStartedAt = Date.now();
    const persistDiagnostic = this.continuousMode;
    if (persistDiagnostic) {
      console.log("[OVLIVE_NDOV_PERSIST_START]", JSON.stringify({
        stream: this.snapshot.stream,
        force, bulk,
        rows: this.rows.size,
        events: this.events.size,
        mutations: this.mutations.size,
        messageCount: this.snapshot.messageCount,
      }));
    }
    this.lastPersistAt = Date.now();
    this.snapshot.latestRows = [...this.rows.values()].slice(-30);
    this.snapshot.latestEvents = [...this.events.values()].slice(-20);
    this.snapshot.latestMutations = flattenCurrentMutations(this.mutations, 30);
    this.snapshot.storedKv78RowCount = this.rows.size;
    this.snapshot.storedMutationIdentityCount = this.mutations.size;
    this.snapshot.continuousEnabled = this.continuousEnabled;

    const now = Date.now();
    const hasCollectedData = this.snapshot.stream === 'kv78'
      ? this.rows.size > 0
      : this.events.size > 0 || this.mutations.size > 0;
    const checkpointDue = this.continuousMode
      && hasCollectedData
      && now - this.lastFullPersistAt >= CONTINUOUS_FULL_CHECKPOINT_MS;
    if (bulk || checkpointDue) {
      if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_PHASE]", JSON.stringify({stream: this.snapshot.stream, phase: "kv78-start"}));
      await this.persistFullKv78Rows(true);
      if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_PHASE]", JSON.stringify({stream: this.snapshot.stream, phase: "kv78-done"}));

      if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_PHASE]", JSON.stringify({stream: this.snapshot.stream, phase: "bison-events-start"}));
      await this.persistFullBisonEvents(true);
      if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_PHASE]", JSON.stringify({stream: this.snapshot.stream, phase: "bison-events-done"}));

      if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_PHASE]", JSON.stringify({stream: this.snapshot.stream, phase: "mutations-start"}));
      await this.persistFullMutations(true);
      if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_PHASE]", JSON.stringify({stream: this.snapshot.stream, phase: "mutations-done"}));

      this.lastFullPersistAt = Date.now();
    }
    // Small legacy-compatible sample for quick cold-start diagnostics; full
    // rows/mutation state are stored in compressed chunks only at session end.
    await this.ctx.storage.put({ snapshot: this.snapshot, rows: [...this.rows.entries()].slice(-100), events: [...this.events.entries()].slice(-100), mutations: [...this.mutations.entries()].slice(-50) });

    if (persistDiagnostic) {
      console.log("[OVLIVE_NDOV_PERSIST_DONE]", JSON.stringify({
        stream: this.snapshot.stream,
        elapsedMs: Date.now() - persistStartedAt,
        messageCount: this.snapshot.messageCount,
      }));
    }
  }

  async alarm() {
    await this.ready;
    if ((await this.ctx.storage.get('continuousEnabled')) !== true) return;
    const stream = await this.ctx.storage.get('collectorStream') || this.snapshot.stream;
    if (!CONFIG[stream]) return;

    // Watchdog alarm is committed first. If the current invocation is cut short,
    // another attempt still wakes the object. A successful cycle moves it to a
    // 2-minute rest; a failed cycle uses bounded exponential backoff.
    await this.ctx.storage.setAlarm(Date.now() + AUTO_CYCLE_MS);
    if (this.running) return;
    this.running = true;
    this.continuousMode = true;
    this.stopRequested = false;
    try {
      await this.collect(stream, AUTO_SESSION_SECONDS);
    } catch (error) {
      this.snapshot = { ...this.snapshot, state: 'error', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
      await this.persist(true, true);
    } finally {
      this.continuousMode = false;
      this.running = false;
      this.socket = null;
    }

    if ((await this.ctx.storage.get('continuousEnabled')) !== true) return;
    if (this.snapshot.state === 'complete') {
      await this.ctx.storage.put('continuousFailures', 0);
      await this.ctx.storage.setAlarm(Date.now() + AUTO_REST_MS);
    } else {
      const failures = Math.min(10, (Number(await this.ctx.storage.get('continuousFailures')) || 0) + 1);
      await this.ctx.storage.put('continuousFailures', failures);
      const delay = Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * (2 ** Math.min(failures - 1, 4)));
      await this.ctx.storage.setAlarm(Date.now() + delay);
    }
  }

  async collect(stream, seconds) {
    const config = CONFIG[stream];
    const deadline = Date.now() + seconds * 1000;
    let socket, writer, buffered, reader;
    let multipart = [];
    // Always bind the snapshot to this named stream. A freshly-created BISON
    // object otherwise inherits the constructor's KV78 placeholder and would
    // skip durable mutation persistence at the end of its first session.
    if (stream === 'bison') this.pruneMutationDates();
    this.snapshot = {
      ...initialSnapshot(stream),
      state: 'connecting',
      startedAt: new Date().toISOString(),
      sessionSeconds: seconds,
      continuousEnabled: this.continuousEnabled,
    };
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

      while (Date.now() < deadline && !this.stopRequested) {
        const lastMessageTimeMs = Date.parse(
          this.snapshot.latestMessageAt ?? this.snapshot.startedAt ?? ""
        );
        const lastPayloadMs = Number.isFinite(lastMessageTimeMs)
          ? lastMessageTimeMs
          : Date.now();
        const idleAgeMs = Math.max(0, Date.now() - lastPayloadMs);

        if (idleAgeMs >= AUTO_DATA_IDLE_RECONNECT_MS) {
          console.log("[OVLIVE_NDOV_IDLE_TIMEOUT]", JSON.stringify({
            stream, stage: "loop-top",
            idleAgeSeconds: Math.floor(idleAgeMs / 1000),
            messageCount: this.snapshot.messageCount,
            latestMessageAt: this.snapshot.latestMessageAt,
          }));
          this.snapshot.warnings.push(
            `Geen NDOV-data ontvangen gedurende ${Math.floor(idleAgeMs / 1000)} seconden; verbinding wordt vernieuwd.`
          );
          break;
        }

        const sessionRemainingMs = Math.max(1, deadline - Date.now());
        const idleRemainingMs = Math.max(1, AUTO_DATA_IDLE_RECONNECT_MS - idleAgeMs);
        const frame = await this.withReadTimeout(
          buffered.readFrame(),
          Math.min(sessionRemainingMs, idleRemainingMs),
          'stream frame',
          true,
          () => {
            // Promise.race annuleert de onderliggende socketlezing niet.
            // Stop daarom de reader en socket direct bij een lees-time-out.
            try {
              if (reader) {
                void reader.cancel('NDOV stream read timeout').catch(() => {});
              }
            } catch {}
            try {
              if (socket) void socket.close().catch(() => {});
            } catch {}
          }
        );

        if (!frame) {
          const timeoutMessageTimeMs = Date.parse(
            this.snapshot.latestMessageAt ?? this.snapshot.startedAt ?? ""
          );
          const timeoutBaseMs = Number.isFinite(timeoutMessageTimeMs)
            ? timeoutMessageTimeMs
            : Date.now();
          const timeoutIdleMs = Math.max(0, Date.now() - timeoutBaseMs);

          console.log("[OVLIVE_NDOV_READ_TIMEOUT]", JSON.stringify({
            stream,
            idleAgeSeconds: Math.floor(timeoutIdleMs / 1000),
            sessionElapsedSeconds: Math.floor((Date.now() - Date.parse(this.snapshot.startedAt)) / 1000),
            messageCount: this.snapshot.messageCount,
            latestMessageAt: this.snapshot.latestMessageAt,
          }));

          if (timeoutIdleMs >= AUTO_DATA_IDLE_RECONNECT_MS) {
            this.snapshot.warnings.push(
              `Geen NDOV-data ontvangen gedurende ${Math.floor(timeoutIdleMs / 1000)} seconden; verbinding wordt vernieuwd.`
            );
          }
          break;
        }
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
              row.receivedAt = new Date().toISOString();
              const key = `${row.identity}|${row.userStopOrderNumber}|${row.userStopCode}`;
              this.rows.delete(key);
              this.rows.set(key, row);
              if (this.rows.size > KV78_ROW_LIMIT) this.rows.delete(this.rows.keys().next().value);
            }
          } else if (stream === 'bison' && /KV6posinfo/.test(envelope)) {
            const receivedAt = new Date().toISOString();
            for (const ev of parseBisonPayload(text, envelope)) {
              const key = canonicalBisonTripIdentity(ev);
              if (!key) continue;
              const previous = this.events.get(key) ?? {};
              const hasPunctuality = ev.punctualitySeconds !== null && ev.punctualitySeconds !== undefined;
              const terminalEvent = ['END', 'CANCEL'].includes(String(ev.eventType ?? '').toUpperCase());
              const next = {
                ...previous, ...ev, identity: key, receivedAt,
                userStopCode: ev.userStopCode ?? previous.userStopCode ?? null,
                passageSequenceNumber: ev.passageSequenceNumber ?? previous.passageSequenceNumber ?? null,
                vehicleNumber: ev.vehicleNumber ?? previous.vehicleNumber ?? null,
                blockCode: ev.blockCode ?? previous.blockCode ?? null,
                rdX: ev.rdX ?? previous.rdX ?? null,
                rdY: ev.rdY ?? previous.rdY ?? null,
                distanceSinceLastStop: ev.distanceSinceLastStop ?? previous.distanceSinceLastStop ?? null,
                punctualitySeconds: terminalEvent ? null : hasPunctuality ? ev.punctualitySeconds : (previous.punctualitySeconds ?? null),
                punctualityTimestamp: terminalEvent ? null : hasPunctuality ? (ev.timestamp ?? receivedAt) : (previous.punctualityTimestamp ?? null),
                punctualityReceivedAt: terminalEvent ? null : hasPunctuality ? receivedAt : (previous.punctualityReceivedAt ?? null),
              };
              this.events.delete(key);
              this.events.set(key, next);
            }
            if (Date.now() - (this.lastEventPruneAt ?? 0) > 10000) {
              this.pruneEvents();
              this.lastEventPruneAt = Date.now();
            }
          } else if (stream === 'bison' && /KV17cvlinfo/i.test(envelope)) {
            for (const mutation of parseKv17Payload(text, envelope)) {
              // Persist only the newest state per exact identity. Actions with the
              // same event timestamp are kept together so conflicting CANCEL and
              // RECOVER records are not resolved by arbitrary ordering.
              upsertCurrentMutationState(this.mutations, mutation, KV17_STATE_LIMIT);
            }
          }
          await this.persist(false, false);
        }
        multipart = [];
      }
      if (stream === 'kv78') this.pruneRows();
      console.log("[OVLIVE_NDOV_COLLECT_LOOP_EXIT]", JSON.stringify({
        stream,
        stopRequested: this.stopRequested,
        deadlineReached: Date.now() >= deadline,
        latestMessageAt: this.snapshot.latestMessageAt,
        messageCount: this.snapshot.messageCount,
      }));
      this.snapshot = { ...this.snapshot, state: this.stopRequested ? 'stopped' : 'complete', finishedAt: new Date().toISOString(), ok: true, error: null };
      await this.persist(true, true);
    } catch (error) {
      const expectedEnd = Date.now() >= deadline;
      const wasStopped = this.stopRequested;
      if (stream === 'kv78') this.pruneRows();
      this.snapshot = {
        ...this.snapshot,
        state: wasStopped ? 'stopped' : expectedEnd ? 'complete' : 'error',
        ok: expectedEnd || wasStopped,
        finishedAt: new Date().toISOString(),
        error: expectedEnd || wasStopped ? null : (error instanceof Error ? error.message : String(error)),
      };
      await this.persist(true, true);
    } finally {
      // Start beide opruimacties voordat we op een van beide wachten.
      const cleanup = [];
      try {
        if (reader) {
          cleanup.push(Promise.resolve(reader.cancel()).catch(() => {}));
        }
      } catch {}
      try {
        if (socket) {
          cleanup.push(Promise.resolve(socket.close()).catch(() => {}));
        }
      } catch {}

      // Laat een geblokkeerde opruimactie de collector niet onbeperkt vasthouden.
      let cleanupTimer;
      await Promise.race([
        Promise.all(cleanup),
        new Promise((resolve) => {
          cleanupTimer = setTimeout(resolve, 2000);
        }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);

      if (writer) { try { writer.releaseLock(); } catch {} }
    }
  }

  async withReadTimeout(promise, ms, label, returnNull = false, onTimeout = null) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (returnNull) {
              try {
                if (typeof onTimeout === 'function') onTimeout();
              } catch {}
              resolve(null);
              return;
            }
            reject(new Error(`${label} timed out after ${ms} ms`));
          }, ms);
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
