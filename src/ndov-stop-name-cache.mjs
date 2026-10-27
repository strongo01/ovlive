const ENTRY_PREFIX = "kv78:stop-name-cache:entry:";
const INDEX_PREFIX = "kv78:stop-name-cache:index:";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_KEYS_PER_REQUEST = 100;
const MAX_PRUNE_ENTRIES = 1000;
let lastPruneAtMs = 0;

function normalizeCacheKey(value) {
  const match = String(value ?? "").trim().match(
    /^([A-Za-z0-9_-]{1,16})\|([A-Za-z0-9_-]{1,64})\|(\d{4})-?(\d{2})-?(\d{2})$/
  );
  if (!match) return null;
  const [, rawOwner, stopCode, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) return null;
  return rawOwner.toUpperCase() + "|" + stopCode + "|" + year + month + day;
}

function sanitizeNameValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedStatuses = new Set([
    "official_psa_chb_unique",
    "ambiguous_or_unavailable",
    "unmapped",
  ]);
  const status = String(value.stopNameMatchStatus ?? "");
  if (!allowedStatuses.has(status)) return null;
  const textField = (input) => {
    if (input === null || input === undefined || String(input).trim() === "") return null;
    const text = String(input).trim();
    return text.length <= 256 ? text : null;
  };
  const result = {
    resolvedStopName: textField(value.resolvedStopName),
    stopPlaceCode: textField(value.stopPlaceCode),
    stopPlaceRef: textField(value.stopPlaceRef),
    quayCode: textField(value.quayCode),
    quayRef: textField(value.quayRef),
    stopNameMatchStatus: status,
  };
  if (status === "official_psa_chb_unique" && !result.resolvedStopName) return null;
  return result;
}

function indexKey(cacheKey) {
  return INDEX_PREFIX + encodeURIComponent(cacheKey);
}

function entryKey(expiresAtMs, cacheKey) {
  return ENTRY_PREFIX + String(expiresAtMs).padStart(13, "0") + ":" + encodeURIComponent(cacheKey);
}

async function pruneExpiredEntries(storage, now) {
  if (now - lastPruneAtMs < 60_000) return;
  lastPruneAtMs = now;
  const expiredEntries = await storage.list({ prefix: ENTRY_PREFIX, limit: MAX_PRUNE_ENTRIES });
  const deleteKeys = [];
  for (const [storageKey, value] of expiredEntries) {
    const expirationText = String(storageKey).slice(ENTRY_PREFIX.length, ENTRY_PREFIX.length + 13);
    const expiresAtMs = Number(expirationText);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > now) break;
    const cacheKey = normalizeCacheKey(value?.cacheKey);
    if (cacheKey) {
      const lookupKey = indexKey(cacheKey);
      if (await storage.get(lookupKey) === storageKey) deleteKeys.push(lookupKey);
    }
    deleteKeys.push(storageKey);
  }
  if (deleteKeys.length) await storage.delete([...new Set(deleteKeys)]);
}

/**
 * Durable, bounded-TTL cache for resolved PSA/CHB stop names.
 * Entry keys are sorted by expiry so a small sweep removes the oldest values first.
 */
export async function handleNdovStopNameCacheRequest(storage, request, now = Date.now()) {
  const url = new URL(request.url);
  if (url.pathname !== "/stop-name-cache") {
    return Response.json({ ok: false, error: "unknown endpoint" }, { status: 404 });
  }
  if (url.searchParams.get("stream") !== "kv78") {
    return Response.json({ ok: false, error: "stop-name cache is only available for KV78" }, { status: 400 });
  }

  await pruneExpiredEntries(storage, now);

  if (request.method === "GET") {
    const rawKeys = url.searchParams.getAll("key");
    if (rawKeys.length < 1 || rawKeys.length > MAX_KEYS_PER_REQUEST) {
      return Response.json({ ok: false, error: "request 1–100 stop-name keys" }, { status: 400 });
    }
    const keys = [...new Set(rawKeys.map(normalizeCacheKey))];
    if (keys.some((key) => !key)) {
      return Response.json({ ok: false, error: "invalid stop-name cache key" }, { status: 400 });
    }
    const entries = [];
    for (const key of keys) {
      const storedEntryKey = await storage.get(indexKey(key));
      if (typeof storedEntryKey !== "string" || !storedEntryKey.startsWith(ENTRY_PREFIX)) continue;
      const stored = await storage.get(storedEntryKey);
      if (!stored || !Number.isFinite(Number(stored.expiresAtMs)) || Number(stored.expiresAtMs) <= now) {
        await storage.delete(indexKey(key));
        if (storedEntryKey) await storage.delete(storedEntryKey);
        continue;
      }
      const value = sanitizeNameValue(stored.value);
      if (value) entries.push({ key, value, expiresAtMs: Number(stored.expiresAtMs) });
    }
    return Response.json({ ok: true, entries }, { headers: { "cache-control": "no-store" } });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!Array.isArray(body?.entries) || body.entries.length < 1 || body.entries.length > MAX_KEYS_PER_REQUEST) {
      return Response.json({ ok: false, error: "POST requires 1–100 stop-name entries" }, { status: 400 });
    }

    const validEntries = [];
    for (const item of body.entries) {
      const key = normalizeCacheKey(item?.key);
      const value = sanitizeNameValue(item?.value);
      if (!key || !value) {
        return Response.json({ ok: false, error: "invalid stop-name cache entry" }, { status: 400 });
      }
      validEntries.push({ key, value });
    }

    const nowEntries = new Map();
    const expiry = now + CACHE_TTL_MS;
    const deleteKeys = [];
    const storedEntries = [];
    for (const { key, value } of validEntries) {
      const oldEntryKey = await storage.get(indexKey(key));
      if (typeof oldEntryKey === "string" && oldEntryKey.startsWith(ENTRY_PREFIX)) deleteKeys.push(oldEntryKey);
      const nextEntryKey = entryKey(expiry, key);
      nowEntries.set(nextEntryKey, { cacheKey: key, value, expiresAtMs: expiry });
      nowEntries.set(indexKey(key), nextEntryKey);
      storedEntries.push({ key, value, expiresAtMs: expiry });
    }
    if (deleteKeys.length) await storage.delete([...new Set(deleteKeys)]);
    await storage.put(Object.fromEntries(nowEntries));
    return Response.json({ ok: true, storedCount: storedEntries.length, entries: storedEntries }, {
      headers: { "cache-control": "no-store" },
    });
  }

  return Response.json({ ok: false, error: "GET or POST required" }, { status: 405 });
}
