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
const CONTINUOUS_FULL_CHECKPOINT_MS = 10 * 60 * 1000;
const AUTO_DATA_IDLE_RECONNECT_MS = 120 * 1000;
const AUTO_RETRY_BASE_MS = 30 * 1000;
const AUTO_RETRY_MAX_MS = 5 * 60 * 1000;
const CONTINUOUS_PERSIST_INTERVAL_MS = 60 * 1000;
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
    // Eén fysieke DO-instantie beheert beide feeds; de streamtoestand blijft gescheiden.
    this.streamStates = new Map(Object.keys(CONFIG).map((stream) => [stream, {
      snapshot: initialSnapshot(stream), rows: new Map(), events: new Map(), mutations: new Map(),
      running: false, continuousMode: false, continuousEnabled: false, stopRequested: false,
      socket: null, lastPersistAt: 0, lastFullPersistAt: Date.now(), lastEventPruneAt: 0,
    }]));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      for (const stream of Object.keys(CONFIG)) {
        const state = this.stateFor(stream);
        const key = (suffix) => stream + ':' + suffix;
        const saved = await ctx.storage.get(key('snapshot'));
        if (saved) state.snapshot = saved;
        state.continuousEnabled = (await ctx.storage.get(key('continuousEnabled'))) === true;
        const savedRows = await ctx.storage.get(key('rows'));
        const compressedRowCount = Number(await ctx.storage.get(key('rowsGzipChunkCount'))) || 0;
        const savedRowChunkCount = Number(await ctx.storage.get(key('rowsChunkCount'))) || 0;
        const savedEvents = await ctx.storage.get(key('events'));
        const compressedEventCount = Number(await ctx.storage.get(key('eventsGzipChunkCount'))) || 0;
        const savedMutations = await ctx.storage.get(key('mutations'));

        if (compressedRowCount > 0) {
          const chunks = await Promise.all(Array.from({ length: compressedRowCount }, (_, i) => ctx.storage.get(key('rows:gzip:' + i))));
          const entries = [];
          for (const chunk of chunks) if (chunk) entries.push(...await gunzipJson(chunk));
          state.rows = new Map(entries);
        } else if (savedRowChunkCount > 0) {
          const chunks = await Promise.all(Array.from({ length: savedRowChunkCount }, (_, i) => ctx.storage.get(key('rows:' + i))));
          state.rows = new Map(chunks.flatMap((chunk) => Array.isArray(chunk) ? chunk : []));
        } else state.rows = new Map(savedRows ?? []);

        state.events = new Map();
        if (compressedEventCount > 0) {
          const chunks = await Promise.all(Array.from({ length: compressedEventCount }, (_, i) => ctx.storage.get(key('events:gzip:' + i))));
          for (const chunk of chunks) if (chunk) {
            for (const [savedKey, event] of await gunzipJson(chunk)) {
              const identity = canonicalBisonTripIdentity(event) ?? savedKey;
              state.events.set(identity, { ...event, identity });
            }
          }
        } else {
          for (const [savedKey, event] of (savedEvents ?? [])) {
            const identity = canonicalBisonTripIdentity(event) ?? savedKey;
            state.events.set(identity, { ...event, identity });
          }
        }

        const compressedMutationCount = Number(await ctx.storage.get(key('mutationsGzipChunkCount'))) || 0;
        const legacyMutationChunkCount = Number(await ctx.storage.get(key('mutationsChunkCount'))) || 0;
        if (compressedMutationCount > 0) {
          const chunks = await Promise.all(Array.from({ length: compressedMutationCount }, (_, i) => ctx.storage.get(key('mutations:gzip:' + i))));
          for (const chunk of chunks) if (chunk) {
            for (const [identity, mutationState] of await gunzipJson(chunk)) state.mutations.set(identity, mutationState);
          }
        } else if (legacyMutationChunkCount > 0) {
          const chunks = await Promise.all(Array.from({ length: legacyMutationChunkCount }, (_, i) => ctx.storage.get(key('mutations:' + i))));
          for (const chunk of chunks) for (const [identity, mutation] of (Array.isArray(chunk) ? chunk : [])) {
            if (mutation?.events && mutation?.identity) state.mutations.set(identity, mutation);
            else upsertCurrentMutationState(state.mutations, mutation, KV17_STATE_LIMIT);
          }
        } else {
          for (const item of new Map(savedMutations ?? []).values()) {
            if (item?.events && item?.identity) state.mutations.set(item.identity, item);
            else upsertCurrentMutationState(state.mutations, item, KV17_STATE_LIMIT);
          }
        }

        // KV17-mutaties worden ook per exacte identiteit opgeslagen; checkpoints zijn minder frequent.
        if (stream === 'bison') {
          const prefix = key('mutation:');
          let startAfter;
          while (true) {
            const options = { prefix, limit: 1000 };
            if (startAfter) options.startAfter = startAfter;
            const entries = await ctx.storage.list(options);
            if (entries.size === 0) break;
            for (const [storageKey, mutationState] of entries) {
              const identity = storageKey.slice(prefix.length);
              const current = state.mutations.get(identity);
              if (mutationState?.identity && (!current || Number(mutationState.timestampMs) >= Number(current.timestampMs))) state.mutations.set(identity, mutationState);
            }
            const lastKey = [...entries.keys()].at(-1);
            if (entries.size < 1000 || !lastKey) break;
            startAfter = lastKey;
          }
          while (state.mutations.size > KV17_STATE_LIMIT) state.mutations.delete(state.mutations.keys().next().value);
        }

        this.pruneRows(stream);
        this.pruneEvents(stream);
        await this.pruneMutationDates(stream);
        state.lastFullPersistAt = Date.now();
      }
    });
  }

  stateFor(stream) {
    const state = this.streamStates.get(stream);
    if (!state) throw new Error('Unknown NDOV stream: ' + stream);
    return state;
  }

  async pruneMutationDates(stream) {
    if (stream !== 'bison') return;
    const state = this.stateFor(stream);
    const cutoffDate = operatingDateRetentionCutoff(normalizeOperatingDate(currentOperatingDateAmsterdam()), 2);
    if (!cutoffDate) return;
    const expired = [];
    for (const [identity] of state.mutations.entries()) {
      const identityDate = normalizeOperatingDate(identity.split('|')[1]);
      if (/^\d{8}$/.test(identityDate) && identityDate < cutoffDate) {
        state.mutations.delete(identity);
        expired.push('bison:mutation:' + identity);
      }
    }
    for (let i = 0; i < expired.length; i += 500) await this.ctx.storage.delete(expired.slice(i, i + 500));
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const stream = url.searchParams.get('stream') || 'kv78';
    if (!CONFIG[stream]) return Response.json({ ok: false, error: 'unknown stream' }, { status: 400 });
    const state = this.stateFor(stream);
    if (url.pathname === '/status') {
      if (stream === 'bison') this.pruneEvents(stream);
      const base = state.snapshot.state === 'idle' ? initialSnapshot(stream) : state.snapshot;
      const kv78IdentityDiagnostics =
        stream === "kv78" && url.searchParams.get("identityDiagnostics") === "1"
          ? (() => {
              const currentDate = normalizeOperatingDate(currentOperatingDateAmsterdam());
              const groups = new Map();
              let matchingRowCount = 0;

              for (const row of state.rows.values()) {
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
                cacheSize: state.rows.size,
                cacheLimit: KV78_ROW_LIMIT,
                matchingRowCount,
                identityCount: trips.length,
                trips: trips.slice(0, 80),
              };
            })()
          : null;
      const currentMutations = flattenCurrentMutations(state.mutations, 300);
      return Response.json({
        ...base,
        latestRows: url.searchParams.get('includeAllRows') === '1'
          ? [...state.rows.values()]
          : [...state.rows.values()].slice(-KV78_STATUS_SAMPLE_LIMIT),
        latestEvents: [...state.events.values()].slice(-100),
        storedKv6TripCount: state.events.size,
        latestMutations: currentMutations,
        storedKv78RowCount: state.rows.size,
        kv78IdentityDiagnostics,
        storedMutationIdentityCount: state.mutations.size,
        continuousEnabled: state.continuousEnabled,
        nextAlarmAt: await this.ctx.storage.getAlarm(),
        autoCollector: { enabled: state.continuousEnabled, sessionSeconds: AUTO_SESSION_SECONDS, restSeconds: AUTO_REST_MS / 1000, rowRetentionSeconds: ROW_RETENTION_MS / 1000, freshnessSeconds: FRESH_ROW_MS / 1000 },
      }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/continuous/enable') {
      state.continuousEnabled = true;
      state.stopRequested = false;
      if (state.snapshot.stream !== stream) state.snapshot = initialSnapshot(stream);
      await this.ctx.storage.put({ [stream + ':continuousEnabled']: true, [stream + ':snapshot']: state.snapshot });
      const alarmAt = await this.ctx.storage.getAlarm();
      if (alarmAt === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return Response.json({ ok: true, enabled: true, stream, nextAlarmAt: await this.ctx.storage.getAlarm(), note: 'Duurzame alarmgestuurde collector ingeschakeld; huidige verzameling start via alarm.' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/continuous/disable') {
      const persistedEnabled = (await this.ctx.storage.get(stream + ':continuousEnabled')) === true;
      const existingAlarm = await this.ctx.storage.getAlarm();
      const alreadyDisabled = !persistedEnabled &&
        existingAlarm === null &&
        !state.running &&
        !state.socket;

      state.continuousEnabled = false;
      state.stopRequested = true;

      // Idempotent: als de collector al uit staat, voorkom onnodige writes.
      if (alreadyDisabled) {
        const anotherCollectorEnabled = [...this.streamStates.entries()].some(([otherStream, otherState]) => otherStream !== stream && otherState.continuousEnabled);
        if (anotherCollectorEnabled && existingAlarm === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
        return Response.json({ ok: true, enabled: false, stream, anotherCollectorEnabled, alreadyDisabled: true, note: 'Collector stond al uit; er is geen opslag gewijzigd.' }, { headers: { 'cache-control': 'no-store' } });
      }

      await this.ctx.storage.put(stream + ':continuousEnabled', false);
      if (state.socket) { try { await state.socket.close(); } catch {} }
      const anotherCollectorEnabled = [...this.streamStates.entries()].some(([otherStream, otherState]) => otherStream !== stream && otherState.continuousEnabled);
      if (!anotherCollectorEnabled) await this.ctx.storage.deleteAlarm();
      else if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return Response.json({ ok: true, enabled: false, stream, anotherCollectorEnabled, note: 'Deze automatische collector is uitgeschakeld.' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/events') {
      if (stream !== 'bison') return Response.json({ ok: false, error: 'KV6-events zijn alleen beschikbaar op de BISON-stream.' }, { status: 400 });
      const identities = [...new Set(url.searchParams.getAll('identity').map((value) => {
        const lookup = normalizeTripLookupIdentity(value);
        return lookup ? [lookup.owner, lookup.date, lookup.line, lookup.journey, lookup.reinforcement].join('|') : null;
      }).filter(Boolean))].slice(0, 20);
      this.pruneEvents(stream);
      const events = identities.map((identity) => state.events.get(identity)).filter((event) => {
        if (!event) return false;
        const receivedMs = Date.parse(event.punctualityReceivedAt ?? '');
        return Number.isFinite(receivedMs) && receivedMs <= Date.now() + 30000 && Date.now() - receivedMs <= KV6_EVENT_STATUS_FRESH_MS && event.punctualitySeconds !== null && event.punctualitySeconds !== undefined;
      });
      return Response.json({ ok: true, state: state.snapshot.state, latestMessageAt: state.snapshot.latestMessageAt, returnedCount: events.length, events }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/mutations') {
      if (stream !== 'bison') return Response.json({ ok: false, error: 'KV17-mutaties zijn alleen beschikbaar op de BISON-stream.' }, { status: 400 });
      const identities = url.searchParams.getAll('identity').filter(Boolean).slice(0, 20);
      const mutations = eventsForIdentities(state.mutations, identities);
      return Response.json({ ok: true, state: state.snapshot.state, latestMessageAt: state.snapshot.latestMessageAt, mutations }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/rows') {
      if (stream !== 'kv78') return Response.json({ ok: false, error: 'KV78-halterijen zijn alleen beschikbaar op de KV78-stream.' }, { status: 400 });
      const identity = normalizeTripLookupIdentity(url.searchParams.get('identity'));
      if (!identity) return Response.json({ ok: false, error: 'Geef identity=owner|YYYY-MM-DD|line|journey|reinforcement op.' }, { status: 400 });
      const now = Date.now();
      const rows = [...state.rows.values()].filter((row) => rowMatchesIdentity(row, identity));
      const fresh = rows.filter((row) => { const at = Date.parse(row.receivedAt ?? ''); return Number.isFinite(at) && at <= now + 30000 && now - at <= FRESH_ROW_MS; });
      return Response.json({ ok: true, identity: [identity.owner, identity.date, identity.line, identity.journey, identity.reinforcement].join('|'), returnedCount: Math.min(fresh.length, 200), staleCount: rows.length - fresh.length, rows: fresh.slice(0, 200) }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname !== '/start') return new Response('not found', { status: 404 });
    const rawSeconds = Number(url.searchParams.get('seconds') || '45');
    const seconds = Number.isFinite(rawSeconds) ? Math.max(10, Math.min(120, Math.floor(rawSeconds))) : 45;
    if (state.running) {
      return Response.json({ ok: true, alreadyRunning: true, stream, snapshot: state.snapshot });
    }
    // Each short session starts with fresh KV78/KV6 samples, but retain the latest
    // KV17 state for the current Dutch operating date. KV17 is event-driven: a
    // CANCEL remains the latest known state until a newer RECOVER/change arrives.
    // Old operating dates are discarded so yesterday's mutations cannot fill the cache.
    if (stream === 'kv78' && !state.continuousEnabled) state.rows.clear();
    if (stream === 'bison') {
      state.events.clear();
      await this.pruneMutationDates(stream);
    }
    state.snapshot = { ...initialSnapshot(stream), state: 'connecting', startedAt: new Date().toISOString(), sessionSeconds: seconds };
    const waitForCompletion = url.searchParams.get('wait') === '1';
    state.running = true;
    const startTask = () => {
      const task = this.collect(stream, seconds).catch(async (error) => {
        state.snapshot = { ...state.snapshot, state: 'error', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
        await this.persist(stream, true, false);
      }).finally(() => { state.running = false; state.socket = null; });
      this.ctx.waitUntil(task);
      return task;
    };

    if (waitForCompletion) {
      // Local diagnostic mode: keep the HTTP request attached until the bounded
      // collector is finished. This distinguishes a feed/read issue from a local
      // dev-runtime/background-task lifecycle issue.
      await this.persist(stream, true, false);
      await startTask();
      return Response.json({
        ok: state.snapshot.state === 'complete', started: true, completed: true,
        stream, seconds,
        snapshot: {
          stream: state.snapshot.stream, state: state.snapshot.state,
          messageCount: state.snapshot.messageCount, rawBytes: state.snapshot.rawBytes,
          envelopeCounts: state.snapshot.envelopeCounts,
          latestMessageAt: state.snapshot.latestMessageAt,
          startedAt: state.snapshot.startedAt, finishedAt: state.snapshot.finishedAt,
          error: state.snapshot.error, warnings: state.snapshot.warnings,
        },
      }, { headers: { 'cache-control': 'no-store' } });
    }

    const task = startTask();
    // Default mode returns immediately and records the task in waitUntil.
    await this.persist(stream, true, false);
    return Response.json({ ok: true, started: true, stream, seconds, note: 'Eén collector gestart voor dit stream-type; raadpleeg /status voor de gedeelde momentopname.' });
  }

  async persistFullKv78Rows(stream, force = false) {
    const state = this.stateFor(stream);
    if (!force || state.snapshot.stream !== 'kv78') return;
    this.pruneRows(stream);
    const entries = [...state.rows.entries()];
    const chunkCount = Math.ceil(entries.length / ROW_CHUNK_SIZE);
    const previousCount = Number(await this.ctx.storage.get(stream + ':rowsGzipChunkCount')) || 0;
    const legacyCount = Number(await this.ctx.storage.get(stream + ':rowsChunkCount')) || 0;

    // Compress independently-sized chunks. This keeps each SQLite-backed DO
    // value comfortably below Cloudflare's 2 MB per-value limit while using far
    // fewer storage writes than one write per stop row.
    for (let i = 0; i < chunkCount; i += 1) {
      const bytes = await gzipJson(entries.slice(i * ROW_CHUNK_SIZE, (i + 1) * ROW_CHUNK_SIZE));
      if (bytes.length > 1_500_000) throw new Error(`Compressed KV78 chunk ${i} exceeds safe storage value size`);
      await this.ctx.storage.put(stream + ':rows:gzip:' + i, bytes);
    }
    await this.ctx.storage.put(stream + ':rowsGzipChunkCount', chunkCount);
    const obsolete = [];
    for (let i = chunkCount; i < previousCount; i += 1) obsolete.push(stream + ':rows:gzip:' + i);
    for (let i = 0; i < legacyCount; i += 1) obsolete.push(stream + ':rows:' + i);
    if (obsolete.length) await this.ctx.storage.delete(obsolete);
    if (legacyCount) await this.ctx.storage.delete(stream + ':rowsChunkCount');
  }

  async persistFullBisonEvents(stream, force = false) {
    const state = this.stateFor(stream);
    if (!force || state.snapshot.stream !== 'bison') return;
    this.pruneEvents(stream);
    const entries = [...state.events.entries()];
    const chunkCount = Math.ceil(entries.length / MUTATION_CHUNK_SIZE);
    const previousCount = Number(await this.ctx.storage.get(stream + ':eventsGzipChunkCount')) || 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const bytes = await gzipJson(entries.slice(i * MUTATION_CHUNK_SIZE, (i + 1) * MUTATION_CHUNK_SIZE));
      if (bytes.length > 1_500_000) throw new Error(`Compressed KV6 event chunk ${i} exceeds safe storage value size`);
      await this.ctx.storage.put(stream + ':events:gzip:' + i, bytes);
    }
    await this.ctx.storage.put(stream + ':eventsGzipChunkCount', chunkCount);
    const obsolete = [];
    for (let i = chunkCount; i < previousCount; i += 1) obsolete.push(stream + ':events:gzip:' + i);
    if (obsolete.length) await this.ctx.storage.delete(obsolete);
  }

  async persistFullMutations(stream, force = false) {
    const state = this.stateFor(stream);
    if (!force || state.snapshot.stream !== 'bison') return;
    const entries = [...state.mutations.entries()];
    const chunkCount = Math.ceil(entries.length / MUTATION_CHUNK_SIZE);
    const previousCount = Number(await this.ctx.storage.get(stream + ':mutationsGzipChunkCount')) || 0;
    const legacyCount = Number(await this.ctx.storage.get(stream + ':mutationsChunkCount')) || 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const bytes = await gzipJson(entries.slice(i * MUTATION_CHUNK_SIZE, (i + 1) * MUTATION_CHUNK_SIZE));
      if (bytes.length > 1_500_000) throw new Error(`Compressed KV17 chunk ${i} exceeds safe storage value size`);
      await this.ctx.storage.put(stream + ':mutations:gzip:' + i, bytes);
    }
    await this.ctx.storage.put(stream + ':mutationsGzipChunkCount', chunkCount);
    const obsolete = [];
    for (let i = chunkCount; i < previousCount; i += 1) obsolete.push(stream + ':mutations:gzip:' + i);
    for (let i = 0; i < legacyCount; i += 1) obsolete.push(stream + ':mutations:' + i);
    if (obsolete.length) await this.ctx.storage.delete(obsolete);
    if (legacyCount) await this.ctx.storage.delete(stream + ':mutationsChunkCount');
  }

  pruneEvents(stream) {
    const state = this.stateFor(stream);
    const now = Date.now(), cutoff = now - KV6_EVENT_RETENTION_MS;
    for (const [key, event] of state.events.entries()) {
      const received = Date.parse(event?.receivedAt ?? '');
      const punctualityReceived = Date.parse(event?.punctualityReceivedAt ?? '');
      if (!Number.isFinite(received) || received < cutoff || (Number.isFinite(punctualityReceived) && punctualityReceived < now - KV6_EVENT_STATUS_FRESH_MS)) state.events.delete(key);
    }
    while (state.events.size > KV6_EVENT_LIMIT) state.events.delete(state.events.keys().next().value);
  }

  pruneRows(stream) {
    const state = this.stateFor(stream);
    const cutoff = Date.now() - ROW_RETENTION_MS;
    for (const [key, row] of state.rows.entries()) {
      const captured = Date.parse(row?.receivedAt ?? '');
      if (!Number.isFinite(captured) || captured < cutoff) state.rows.delete(key);
    }
    while (state.rows.size > KV78_ROW_LIMIT) state.rows.delete(state.rows.keys().next().value);
  }

  async persist(stream, force = false, bulk = false) {
    const state = this.stateFor(stream);
    const minInterval = state.continuousMode ? CONTINUOUS_PERSIST_INTERVAL_MS : 5000;
    if (!force && Date.now() - state.lastPersistAt < minInterval) return;
    const persistStartedAt = Date.now(), persistDiagnostic = state.continuousMode;
    if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_START]", JSON.stringify({
      stream: state.snapshot.stream, force, bulk, rows: state.rows.size,
      events: state.events.size, mutations: state.mutations.size, messageCount: state.snapshot.messageCount,
    }));
    state.lastPersistAt = Date.now();
    state.snapshot.latestRows = [...state.rows.values()].slice(-30);
    state.snapshot.latestEvents = [...state.events.values()].slice(-20);
    state.snapshot.latestMutations = flattenCurrentMutations(state.mutations, 30);
    state.snapshot.storedKv78RowCount = state.rows.size;
    state.snapshot.storedMutationIdentityCount = state.mutations.size;
    state.snapshot.continuousEnabled = state.continuousEnabled;
    const now = Date.now();
    const hasCollectedData = stream === 'kv78' ? state.rows.size > 0 : state.events.size > 0 || state.mutations.size > 0;
    const checkpointDue = state.continuousMode && hasCollectedData && now - state.lastFullPersistAt >= CONTINUOUS_FULL_CHECKPOINT_MS;
    const finalCheckpointDue = bulk && hasCollectedData && (!state.continuousMode || now - state.lastFullPersistAt >= 5000);
    if (checkpointDue || finalCheckpointDue) {
      await this.persistFullKv78Rows(stream, true);
      await this.persistFullBisonEvents(stream, true);
      await this.persistFullMutations(stream, true);
      state.lastFullPersistAt = Date.now();
    }
    await this.ctx.storage.put({
      [stream + ':snapshot']: state.snapshot,
      [stream + ':rows']: [...state.rows.entries()].slice(-100),
      [stream + ':events']: [...state.events.entries()].slice(-100),
      [stream + ':mutations']: [...state.mutations.entries()].slice(-50),
    });
    if (persistDiagnostic) console.log("[OVLIVE_NDOV_PERSIST_DONE]", JSON.stringify({
      stream: state.snapshot.stream, elapsedMs: Date.now() - persistStartedAt, messageCount: state.snapshot.messageCount,
    }));
  }

  async alarm() {
    await this.ready;
    const streams = [];
    for (const stream of Object.keys(CONFIG)) {
      const state = this.stateFor(stream);
      state.continuousEnabled = (await this.ctx.storage.get(stream + ':continuousEnabled')) === true;
      if (state.continuousEnabled) streams.push(stream);
    }
    if (streams.length === 0) return;
    await this.ctx.storage.setAlarm(Date.now() + AUTO_CYCLE_MS);
    const nextDelays = await Promise.all(streams.map(async (stream) => {
      const state = this.stateFor(stream);
      if (state.running) return AUTO_REST_MS;
      state.running = true;
      state.continuousMode = true;
      state.stopRequested = false;
      try {
        await this.collect(stream, AUTO_SESSION_SECONDS);
      } catch (error) {
        state.snapshot = { ...state.snapshot, state: 'error', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
        await this.persist(stream, true, true);
      } finally {
        state.continuousMode = false;
        state.running = false;
        state.socket = null;
      }
      const stillEnabled = (await this.ctx.storage.get(stream + ':continuousEnabled')) === true;
      state.continuousEnabled = stillEnabled;
      if (!stillEnabled) return null;
      if (state.snapshot.state === 'complete' || state.snapshot.state === 'stopped') {
        await this.ctx.storage.put(stream + ':continuousFailures', 0);
        return AUTO_REST_MS;
      }
      const failureKey = stream + ':continuousFailures';
      const failures = Math.min(10, (Number(await this.ctx.storage.get(failureKey)) || 0) + 1);
      await this.ctx.storage.put(failureKey, failures);
      return Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * (2 ** Math.min(failures - 1, 4)));
    }));
    const delays = nextDelays.filter((value) => value !== null);
    if (delays.length > 0) await this.ctx.storage.setAlarm(Date.now() + Math.min(...delays));
    else await this.ctx.storage.deleteAlarm();
  }

  async collect(stream, seconds) {
    const config = CONFIG[stream];
    const state = this.stateFor(stream);
    const deadline = Date.now() + seconds * 1000;
    let socket, writer, buffered, reader;
    let multipart = [];
    // Always bind the snapshot to this named stream. A freshly-created BISON
    // object otherwise inherits the constructor's KV78 placeholder and would
    // skip durable mutation persistence at the end of its first session.
    if (stream === 'bison') await this.pruneMutationDates(stream);
    state.snapshot = {
      ...initialSnapshot(stream),
      state: 'connecting',
      startedAt: new Date().toISOString(),
      sessionSeconds: seconds,
      continuousEnabled: state.continuousEnabled,
    };
    try {
      socket = connect({ hostname: HOST, port: config.port });
      state.socket = socket;
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
      state.snapshot = { ...state.snapshot, state: 'listening', zmtpVersion: `${greeting.major}.${greeting.negotiatedMinor}`, handshake: ready.name, prefixes: config.prefixes };
      await this.persist(stream, true, false);

      while (Date.now() < deadline && !state.stopRequested) {
        const lastMessageTimeMs = Date.parse(
          state.snapshot.latestMessageAt ?? state.snapshot.startedAt ?? ""
        );
        const lastPayloadMs = Number.isFinite(lastMessageTimeMs)
          ? lastMessageTimeMs
          : Date.now();
        const idleAgeMs = Math.max(0, Date.now() - lastPayloadMs);

        if (idleAgeMs >= AUTO_DATA_IDLE_RECONNECT_MS) {
          console.log("[OVLIVE_NDOV_IDLE_TIMEOUT]", JSON.stringify({
            stream, stage: "loop-top",
            idleAgeSeconds: Math.floor(idleAgeMs / 1000),
            messageCount: state.snapshot.messageCount,
            latestMessageAt: state.snapshot.latestMessageAt,
          }));
          state.snapshot.warnings.push(
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
            state.snapshot.latestMessageAt ?? state.snapshot.startedAt ?? ""
          );
          const timeoutBaseMs = Number.isFinite(timeoutMessageTimeMs)
            ? timeoutMessageTimeMs
            : Date.now();
          const timeoutIdleMs = Math.max(0, Date.now() - timeoutBaseMs);

          console.log("[OVLIVE_NDOV_READ_TIMEOUT]", JSON.stringify({
            stream,
            idleAgeSeconds: Math.floor(timeoutIdleMs / 1000),
            sessionElapsedSeconds: Math.floor((Date.now() - Date.parse(state.snapshot.startedAt)) / 1000),
            messageCount: state.snapshot.messageCount,
            latestMessageAt: state.snapshot.latestMessageAt,
          }));

          if (timeoutIdleMs >= AUTO_DATA_IDLE_RECONNECT_MS) {
            state.snapshot.warnings.push(
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
            state.snapshot.warnings.push(`Publisher ERROR: ${decodeUtf8(command.data).slice(0, 200)}`);
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
          state.snapshot.messageCount += 1;
          state.snapshot.rawBytes += payload.length;
          state.snapshot.latestMessageAt = new Date().toISOString();
          state.snapshot.envelopeCounts[envelope] = (state.snapshot.envelopeCounts[envelope] || 0) + 1;
          if (stream === 'kv78' && /\/KV8passtimes\//.test(envelope)) {
            for (const row of parseKv78Payload(text, envelope)) {
              // Keep every line during this bounded diagnostic run. Filtering to
              // U005/U011/U073/24 hid mutations such as CXX L014 and ARR 26010.
              row.receivedAt = new Date().toISOString();
              const key = `${row.identity}|${row.userStopOrderNumber}|${row.userStopCode}`;
              state.rows.delete(key);
              state.rows.set(key, row);
              if (state.rows.size > KV78_ROW_LIMIT) state.rows.delete(state.rows.keys().next().value);
            }
          } else if (stream === 'bison' && /KV6posinfo/.test(envelope)) {
            const receivedAt = new Date().toISOString();
            for (const ev of parseBisonPayload(text, envelope)) {
              const key = canonicalBisonTripIdentity(ev);
              if (!key) continue;
              const previous = state.events.get(key) ?? {};
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
              state.events.delete(key);
              state.events.set(key, next);
            }
            if (Date.now() - (state.lastEventPruneAt ?? 0) > 10000) {
              this.pruneEvents(stream);
              state.lastEventPruneAt = Date.now();
            }
          } else if (stream === 'bison' && /KV17cvlinfo/i.test(envelope)) {
            const changedMutationIdentities = new Set();
            const oldestMutationIdentity = state.mutations.keys().next().value;
            for (const mutation of parseKv17Payload(text, envelope)) {
              if (upsertCurrentMutationState(state.mutations, mutation, KV17_STATE_LIMIT)) {
                const identity = canonicalBisonTripIdentity(mutation);
                if (identity) changedMutationIdentities.add(identity);
              }
            }
            if (oldestMutationIdentity && !state.mutations.has(oldestMutationIdentity)) await this.ctx.storage.delete('bison:mutation:' + oldestMutationIdentity);
            if (changedMutationIdentities.size > 0) {
              const durableChanges = {};
              for (const identity of changedMutationIdentities) {
                const current = state.mutations.get(identity);
                if (current) durableChanges['bison:mutation:' + identity] = current;
              }
              if (Object.keys(durableChanges).length > 0) await this.ctx.storage.put(durableChanges);
          }
          await this.persist(stream, false, false);
        }
        multipart = [];
      }
      if (stream === 'kv78') this.pruneRows(stream);
      console.log("[OVLIVE_NDOV_COLLECT_LOOP_EXIT]", JSON.stringify({
        stream,
        stopRequested: state.stopRequested,
        deadlineReached: Date.now() >= deadline,
        latestMessageAt: state.snapshot.latestMessageAt,
        messageCount: state.snapshot.messageCount,
      }));
      state.snapshot = { ...state.snapshot, state: state.stopRequested ? 'stopped' : 'complete', finishedAt: new Date().toISOString(), ok: true, error: null };
      await this.persist(stream, true, true);
    } catch (error) {
      const expectedEnd = Date.now() >= deadline;
      const wasStopped = state.stopRequested;
      if (stream === 'kv78') this.pruneRows(stream);
      state.snapshot = {
        ...state.snapshot,
        state: wasStopped ? 'stopped' : expectedEnd ? 'complete' : 'error',
        ok: expectedEnd || wasStopped,
        finishedAt: new Date().toISOString(),
        error: expectedEnd || wasStopped ? null : (error instanceof Error ? error.message : String(error)),
      };
      await this.persist(stream, true, true);
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
  const id = env.NDOV_FEEDS.idFromName("ndov-shared-collector-v1");
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
