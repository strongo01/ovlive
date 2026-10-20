export interface NsLiveVehiclePosition {
  trainNumber: string;
  ritId: string | null;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDeg: number | null;
  trainType: string | null;
  source: "NS Virtual Train API";
  observedAt: string;
  fetchedAt: string;
  sourceTimestampKnown: boolean;
  horizontalAccuracyMeters: number | null;
}

export interface NsLiveVehiclePositionEnv {
  NS_API_SUBSCRIPTION_KEY?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  APP_CONTACT?: string;
}

export interface NsLiveVehicleFeed {
  fetchedAt: string;
  positions: NsLiveVehiclePosition[];
}

const NS_VIRTUAL_TRAIN_API = "https://gateway.apiportal.ns.nl/virtual-train-api/vehicle";
const CACHE_TTL_MS = 5_000;
const MAX_RESPONSE_BYTES = 2_000_000;

let localCache: { expiresAtMs: number; feed: NsLiveVehicleFeed } | null = null;
let inflight: Promise<NsLiveVehicleFeed> | null = null;

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  const text = asText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function rawVehicleList(input: any): any[] | null {
  const payload = input?.payload ?? input;
  if (Array.isArray(payload?.treinen)) return payload.treinen;
  if (Array.isArray(payload?.vehicles)) return payload.vehicles;
  if (Array.isArray(payload?.vehicle)) return payload.vehicle;
  if (Array.isArray(payload)) return payload;
  return null;
}

function positionSourceTimestamp(raw: any): number | null {
  for (const value of [
    raw?.positionTimestamp,
    raw?.gpsTimestamp,
    raw?.timestampGps,
    raw?.lastUpdateTimeStamp,
    raw?.lastUpdateTime,
    raw?.lastUpdated,
    raw?.updatedAt,
    raw?.updateTime,
    raw?.tijdstip,
    raw?.timestamp
  ]) {
    const parsed = timestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function normalizeNsLiveVehiclePositions(
  input: unknown,
  fetchedAtMs = Date.now()
): NsLiveVehiclePosition[] {
  const rows = rawVehicleList(input);
  if (!rows) return [];
  const fetchedAt = new Date(fetchedAtMs).toISOString();
  const deduped = new Map<string, NsLiveVehiclePosition>();

  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const trainNumberValue = asText(
      raw.treinNummer ?? raw.trainNumber ?? raw.trainNo ?? raw.ritnummer
    );
    if (!/^\d{1,6}$/.test(trainNumberValue)) continue;

    const latitude = finiteNumber(raw.lat, raw.latitude);
    const longitude = finiteNumber(raw.lng, raw.lon, raw.longitude);
    // NS's vehicle API can include trains outside the Netherlands, but the live
    // tracking view is for Dutch itineraries. These bounds still include the
    // nearby Belgian and German border sections.
    if (
      latitude === null || longitude === null ||
      latitude < 49 || latitude > 56 ||
      longitude < 2 || longitude > 9.5
    ) continue;

    const sourceTimestamp = positionSourceTimestamp(raw);
    const observedAt = new Date(sourceTimestamp ?? fetchedAtMs).toISOString();
    const normalized: NsLiveVehiclePosition = {
      trainNumber: trainNumberValue,
      ritId: asText(raw.ritId ?? raw.ritnummerId ?? raw.journeyId) || null,
      latitude,
      longitude,
      speedKmh: finiteNumber(raw.snelheid, raw.speedKmh, raw.speed),
      headingDeg: finiteNumber(raw.richting, raw.headingDeg, raw.heading),
      trainType: asText(raw.type ?? raw.trainType) || null,
      source: "NS Virtual Train API",
      observedAt,
      fetchedAt,
      sourceTimestampKnown: sourceTimestamp !== null,
      horizontalAccuracyMeters: finiteNumber(
        raw.horizontaleNauwkeurigheid,
        raw.horizontalAccuracy,
        raw.accuracy
      )
    };

    const previous = deduped.get(trainNumberValue);
    if (!previous) {
      deduped.set(trainNumberValue, normalized);
      continue;
    }

    // Prefer an explicitly timestamped position over a fetched-time fallback;
    // otherwise the endpoint cannot reliably distinguish duplicate train IDs.
    if (
      normalized.sourceTimestampKnown &&
      (!previous.sourceTimestampKnown ||
        Date.parse(normalized.observedAt) > Date.parse(previous.observedAt))
    ) {
      deduped.set(trainNumberValue, normalized);
    }
  }

  return [...deduped.values()];
}

async function readEdgeCache(cacheKey: Request): Promise<NsLiveVehicleFeed | null> {
  if (typeof caches === "undefined" || !caches.default) return null;
  try {
    const response = await caches.default.match(cacheKey);
    if (!response) return null;
    const value = await response.json() as NsLiveVehicleFeed;
    if (!value || !Array.isArray(value.positions) || typeof value.fetchedAt !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

async function writeEdgeCache(cacheKey: Request, feed: NsLiveVehicleFeed): Promise<void> {
  if (typeof caches === "undefined" || !caches.default) return;
  try {
    await caches.default.put(cacheKey, new Response(JSON.stringify(feed), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=5"
      }
    }));
  } catch {
    // The isolate cache below remains a safe fallback if edge caching is unavailable.
  }
}

export async function fetchNsLiveVehiclePositions(
  env: NsLiveVehiclePositionEnv,
  cacheOrigin: string
): Promise<NsLiveVehicleFeed> {
  const subscriptionKey = asText(env.NS_API_SUBSCRIPTION_KEY);
  if (!subscriptionKey) throw new Error("NS_VIRTUAL_TRAIN_KEY_MISSING");

  const cacheKey = new Request(new URL(
    "/__ovlive-internal/ns-live-vehicle-positions-v1",
    cacheOrigin
  ).toString());

  const edgeCached = await readEdgeCache(cacheKey);
  if (edgeCached) {
    localCache = { expiresAtMs: Date.now() + CACHE_TTL_MS, feed: edgeCached };
    return edgeCached;
  }

  const now = Date.now();
  if (localCache && localCache.expiresAtMs > now) return localCache.feed;
  if (inflight) return inflight;

  const task = (async (): Promise<NsLiveVehicleFeed> => {
    const upstream = new URL(NS_VIRTUAL_TRAIN_API);
    upstream.searchParams.set("features", "trein");
    const response = await fetch(upstream, {
      method: "GET",
      headers: {
        accept: "application/json",
        "Ocp-Apim-Subscription-Key": subscriptionKey,
        "user-agent": `${env.APP_NAME || "OVLive"}/${env.APP_VERSION || "0.1.0"}` +
          (env.APP_CONTACT ? ` (${env.APP_CONTACT})` : "")
      },
      signal: AbortSignal.timeout(8_000)
    });

    if (!response.ok) {
      throw new Error("NS_VIRTUAL_TRAIN_HTTP_" + response.status);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("NS_VIRTUAL_TRAIN_RESPONSE_TOO_LARGE");
    }

    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("NS_VIRTUAL_TRAIN_RESPONSE_TOO_LARGE");
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error("NS_VIRTUAL_TRAIN_INVALID_JSON");
    }

    if (!rawVehicleList(json)) throw new Error("NS_VIRTUAL_TRAIN_RESPONSE_FORMAT");

    const fetchedAt = new Date().toISOString();
    const feed: NsLiveVehicleFeed = {
      fetchedAt,
      positions: normalizeNsLiveVehiclePositions(json, Date.parse(fetchedAt))
    };
    localCache = { expiresAtMs: Date.now() + CACHE_TTL_MS, feed };
    await writeEdgeCache(cacheKey, feed);
    return feed;
  })();

  inflight = task;
  try {
    return await task;
  } finally {
    if (inflight === task) inflight = null;
  }
}
