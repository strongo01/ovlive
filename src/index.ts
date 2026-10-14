import { summarizeRealtimeEvent } from "./openov-realtime-prediction.js";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { handleOvapiTestApi } from "./ovapi-test";
import { NdovFeedHub } from "./ndov-stream-hub.js";
import { handleTransitousOvapiMatch } from "./ovapi-transitous-match";

import { applyNdovCancellationsToPlan } from "./ndov-plan-cancellation.js";
import { enrichNsTrainPlan } from "./ns-train-realtime";
import { enforcePublicApiRateLimit, type ApiRateLimitBinding } from "./api-rate-limit";

interface Env {
  ASSETS: Fetcher;
  NDOV_FEEDS: DurableObjectNamespace;
  NDOV_AUTOCOLLECT?: string;
  APP_NAME: string;
  APP_VERSION: string;
  APP_CONTACT: string;
  NS_API_SUBSCRIPTION_KEY?: string;
  GEOAPIFY_API_KEY?: string;
  API_RATE_LIMITER?: ApiRateLimitBinding;
  PLAN_RATE_LIMITER?: ApiRateLimitBinding;
}

const OPENOV = {
  tripUpdates: "https://gtfs.openov.nl/gtfs-rt/tripUpdates.pb",
  alerts: "https://gtfs.openov.nl/gtfs-rt/alerts.pb",
  trainUpdates: "https://gtfs.openov.nl/gtfs-rt/trainUpdates.pb",
  vehiclePositions: "https://gtfs.openov.nl/gtfs-rt/vehiclePositions.pb"
};

const TRANSITOUS = "https://api.transitous.org/api/v6";

// NOMINATIM_LOCAL_GEOCODER_V1
// Cache en wachtrij voor lokale tests. De wachtrij geldt per Worker-isolate.
const NOMINATIM_CACHE_TTL_MS = 10 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const NOMINATIM_MAX_CACHE_ENTRIES = 200;

const nominatimGeocodeCache = new Map<
  string,
  { expiresAtMs: number; data: any }
>();
const nominatimGeocodeInflight = new Map<string, Promise<any>>();

let nominatimRequestQueue: Promise<void> = Promise.resolve();
let nominatimLastRequestAtMs = 0;

async function fetchNominatimSerialized(
  url: URL,
  env: Env
): Promise<Response> {
  const request = nominatimRequestQueue.then(async () => {
    const waitMs = Math.max(
      0,
      NOMINATIM_MIN_INTERVAL_MS -
        (Date.now() - nominatimLastRequestAtMs)
    );

    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    nominatimLastRequestAtMs = Date.now();

    return fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent":
          `${env.APP_NAME}/${env.APP_VERSION} (contact: ${env.APP_CONTACT})`
      },
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 600, cacheEverything: true }
    });
  });

  nominatimRequestQueue = request.then(
    () => undefined,
    () => undefined
  );

  return request;
}

async function getNominatimFeatures(
  query: string,
  env: Env
): Promise<any> {
  const cacheKey = query.trim().toLocaleLowerCase("nl-NL");
  const now = Date.now();
  const cached = nominatimGeocodeCache.get(cacheKey);

  if (cached && cached.expiresAtMs > now) {
    return cached.data;
  }

  if (cached) nominatimGeocodeCache.delete(cacheKey);

  const inFlight = nominatimGeocodeInflight.get(cacheKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    const upstream = new URL(
      "https://nominatim.openstreetmap.org/search"
    );
    upstream.searchParams.set("q", query);
    upstream.searchParams.set("format", "jsonv2");
    upstream.searchParams.set("addressdetails", "1");
    upstream.searchParams.set("limit", "6");
    upstream.searchParams.set("accept-language", "nl");

    const response = await fetchNominatimSerialized(upstream, env);

    if (!response.ok) {
      throw new Error(`Nominatim gaf HTTP ${response.status}.`);
    }

    const items = await response.json();

    if (!Array.isArray(items)) {
      throw new Error("Nominatim gaf geen geldige lijst met zoekresultaten.");
    }

    const features = items.map((item: any) => {
      const address = item?.address ?? {};
      const lon = Number(item?.lon);
      const lat = Number(item?.lat);

      return {
        type: "Feature",
        properties: {
          osm_type: item?.osm_type ?? null,
          osm_id: item?.osm_id ?? null,
          osm_key: item?.class ?? null,
          osm_value: item?.type ?? item?.class ?? "place",
          type: item?.type ?? item?.class ?? "place",
          name: item?.name ?? null,
          street:
            address.road ??
            address.pedestrian ??
            address.residential ??
            address.footway ??
            address.path ??
            null,
          housenumber: address.house_number ?? null,
          postcode: address.postcode ?? null,
          city:
            address.city ??
            address.town ??
            address.village ??
            address.municipality ??
            address.hamlet ??
            null,
          locality:
            address.suburb ??
            address.neighbourhood ??
            address.quarter ??
            null,
          district:
            address.city_district ??
            address.borough ??
            null,
          state: address.state ?? null,
          country: address.country ?? null,
          countrycode: address.country_code
            ? String(address.country_code).toUpperCase()
            : null,
          display_name: item?.display_name ?? null
        },
        geometry: {
          type: "Point",
          coordinates: [lon, lat]
        }
      };
    }).filter((feature: any) =>
      feature.geometry.coordinates.every(
        (coordinate: number) => Number.isFinite(coordinate)
      )
    );

    const data = {
      type: "FeatureCollection",
      features
    };

    if (nominatimGeocodeCache.size >= NOMINATIM_MAX_CACHE_ENTRIES) {
      const oldestKey = nominatimGeocodeCache.keys().next().value;
      if (oldestKey) nominatimGeocodeCache.delete(oldestKey);
    }

    nominatimGeocodeCache.set(cacheKey, {
      expiresAtMs: Date.now() + NOMINATIM_CACHE_TTL_MS,
      data
    });

    return data;
  })();

  nominatimGeocodeInflight.set(cacheKey, task);

  try {
    return await task;
  } finally {
    if (nominatimGeocodeInflight.get(cacheKey) === task) {
      nominatimGeocodeInflight.delete(cacheKey);
    }
  }
}


// GEOAPIFY FALLBACK: alleen aangeroepen als Nominatim een technische fout geeft.
const GEOAPIFY_CACHE_TTL_MS = 10 * 60 * 1000;
const GEOAPIFY_MAX_CACHE_ENTRIES = 200;

const geoapifyGeocodeCache = new Map<
  string,
  { expiresAtMs: number; data: any }
>();
const geoapifyGeocodeInflight = new Map<string, Promise<any>>();

async function getGeoapifyFeatures(
  query: string,
  env: Env
): Promise<any> {
  const apiKey = env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Geoapify API-sleutel ontbreekt.");
  }

  const cacheKey = query.trim().toLocaleLowerCase("nl-NL");
  const now = Date.now();
  const cached = geoapifyGeocodeCache.get(cacheKey);

  if (cached && cached.expiresAtMs > now) {
    return cached.data;
  }
  if (cached) geoapifyGeocodeCache.delete(cacheKey);

  const inFlight = geoapifyGeocodeInflight.get(cacheKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    const upstream = new URL(
      "https://api.geoapify.com/v1/geocode/search"
    );
    upstream.searchParams.set("text", query);
    upstream.searchParams.set("format", "json");
    upstream.searchParams.set("limit", "6");
    upstream.searchParams.set("lang", "nl");
    upstream.searchParams.set("apiKey", apiKey);

    const response = await fetch(upstream, {
      headers: { "accept": "application/json" },
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 600, cacheEverything: true }
    });

    if (!response.ok) {
      throw new Error(`Geoapify gaf HTTP ${response.status}.`);
    }

    const body: any = await response.json();
    if (!Array.isArray(body?.results)) {
      throw new Error("Geoapify gaf geen geldige zoekresultaten.");
    }

    // Normaliseer naar hetzelfde FeatureCollection-formaat als Nominatim.
    const features = body.results.map((item: any) => {
      const lon = Number(item?.lon);
      const lat = Number(item?.lat);
      const address = item ?? {};

      return {
        type: "Feature",
        properties: {
          osm_type: item?.datasource?.raw?.osm_type ?? null,
          osm_id: item?.datasource?.raw?.osm_id ?? null,
          osm_key: item?.category ?? item?.datasource?.sourcename ?? null,
          osm_value: item?.result_type ?? item?.type ?? "place",
          type: item?.result_type ?? item?.type ?? "place",
          name: item?.name ?? item?.address_line1 ?? null,
          street: address.street ?? null,
          housenumber: address.housenumber ?? null,
          postcode: address.postcode ?? null,
          city:
            address.city ??
            address.town ??
            address.village ??
            address.municipality ??
            null,
          locality: address.suburb ?? address.district ?? null,
          district: address.county ?? null,
          state: address.state ?? null,
          country: address.country ?? null,
          countrycode: address.country_code
            ? String(address.country_code).toUpperCase()
            : null,
          display_name: address.formatted ?? null
        },
        geometry: {
          type: "Point",
          coordinates: [lon, lat]
        }
      };
    }).filter((feature: any) =>
      feature.geometry.coordinates.every(
        (coordinate: number) => Number.isFinite(coordinate)
      )
    );

    const data = {
      type: "FeatureCollection",
      features
    };

    if (geoapifyGeocodeCache.size >= GEOAPIFY_MAX_CACHE_ENTRIES) {
      const oldestKey = geoapifyGeocodeCache.keys().next().value;
      if (oldestKey) geoapifyGeocodeCache.delete(oldestKey);
    }

    geoapifyGeocodeCache.set(cacheKey, {
      expiresAtMs: Date.now() + GEOAPIFY_CACHE_TTL_MS,
      data
    });

    return data;
  })();

  geoapifyGeocodeInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (geoapifyGeocodeInflight.get(cacheKey) === task) {
      geoapifyGeocodeInflight.delete(cacheKey);
    }
  }
}

async function getGeocodeFeatures(
  query: string,
  env: Env
): Promise<any> {
  try {
    // Nominatim blijft altijd de primaire bron.
    return await getNominatimFeatures(query, env);
  } catch (primaryError) {
    console.warn(
      "[OVLIVE_GEOCODE] Nominatim mislukt; Geoapify-fallback wordt geprobeerd.",
      primaryError instanceof Error ? primaryError.message : "Onbekende fout"
    );

    if (!env.GEOAPIFY_API_KEY?.trim()) {
      throw primaryError;
    }

    try {
      return await getGeoapifyFeatures(query, env);
    } catch (fallbackError) {
      console.warn(
        "[OVLIVE_GEOCODE] Ook Geoapify is niet beschikbaar.",
        fallbackError instanceof Error ? fallbackError.message : "Onbekende fout"
      );
      throw new Error("Nominatim en Geoapify zijn tijdelijk niet beschikbaar.");
    }
  }
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_ROUTE_PARAMS = new Set([
  "fromPlace", "toPlace", "time", "arriveBy", "realtimeMode", "transitModes",
  "maxTransfers", "maxTravelTime", "timetableView", "numItineraries",
  "maxItineraries", "searchWindow", "preTransitModes", "postTransitModes",
  "maxPreTransitTime", "maxPostTransitTime", "pedestrianSpeed",
  "language", "wheelchair"
]);

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function corsHeaders(origin: string | null) {
  // Same-origin frontend is the intended production deployment. CORS is deliberately
  // not wildcard-enabled to avoid turning this Worker into a public open proxy.
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin"
  };
  if (origin && (origin === "https://ovlive.pages.dev" || origin.startsWith("http://localhost:"))) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

function toNumber(value: any): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function translatedText(value: any): string | undefined {
  const translations = value?.translation;
  if (!Array.isArray(translations) || translations.length === 0) return undefined;
  const dutch = translations.find((t: any) => t.language === "nl");
  return (dutch ?? translations[0])?.text;
}

function enumName(enumObject: any, value: any): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : enumObject?.[value];
}

function normalizeTripUpdates(feed: any) {
  const rt = (GtfsRealtimeBindings as any).transit_realtime;
  const rows: any[] = [];
  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const trip = tu.trip ?? {};
    const rawStopUpdates = (tu.stopTimeUpdate ?? []).map((s: any) => ({
    stopId: s.stopId,
    stopSequence: s.stopSequence,
    arrivalTime: toNumber(s.arrival?.time),
    arrivalDelaySeconds: s.arrival?.delay,
    departureTime: toNumber(s.departure?.time),
    departureDelaySeconds: s.departure?.delay,
    scheduleRelationship: enumName(rt.StopTimeUpdate?.ScheduleRelationship, s.scheduleRelationship)
  }));

  // GTFS-RT: een trip-level delay geldt ook voor volgende stops,
  // totdat een stop-update een eigen vertraging opgeeft.
  let propagatedDelaySeconds =
    typeof tu.delay === "number" && Number.isFinite(tu.delay)
      ? tu.delay
      : undefined;

  const stopUpdates = rawStopUpdates.map((stop: any) => {
    const ownArrivalDelay =
      typeof stop.arrivalDelaySeconds === "number" && Number.isFinite(stop.arrivalDelaySeconds)
        ? stop.arrivalDelaySeconds
        : undefined;
    const ownDepartureDelay =
      typeof stop.departureDelaySeconds === "number" && Number.isFinite(stop.departureDelaySeconds)
        ? stop.departureDelaySeconds
        : undefined;

    // Als één event op deze halte een expliciete delay heeft, wordt die
    // de geërfde delay voor volgende halte-updates.
    const explicitDelay = ownDepartureDelay ?? ownArrivalDelay;
    if (explicitDelay !== undefined) propagatedDelaySeconds = explicitDelay;

    const noData = String(stop.scheduleRelationship ?? "").toUpperCase() === "NO_DATA";
    const inheritedDelay = noData ? undefined : propagatedDelaySeconds;

    return {
      ...stop,
      effectiveArrivalDelaySeconds: ownArrivalDelay ?? inheritedDelay,
      effectiveDepartureDelaySeconds: ownDepartureDelay ?? inheritedDelay
    };
  });
    rows.push({
      entityId: entity.id,
      tripId: trip.tripId,
      routeId: trip.routeId,
      startDate: trip.startDate,
      startTime: trip.startTime,
      directionId: trip.directionId,
      scheduleRelationship: enumName(rt.TripDescriptor?.ScheduleRelationship, trip.scheduleRelationship),
      delaySeconds: tu.delay,
      vehicleId: tu.vehicle?.id,
      // Een ontbrekende protobuf-timestamp mag niet als tijdstip 0 gelden.
      timestamp: (() => {
        const value = toNumber(tu.timestamp);
        return value != null && value > 0 ? value : undefined;
      })(),
      stopUpdates
    });
  }
  return rows;
}

function normalizeAlerts(feed: any) {
  const rt = (GtfsRealtimeBindings as any).transit_realtime;
  const rows: any[] = [];
  for (const entity of feed.entity ?? []) {
    const alert = entity.alert;
    if (!alert) continue;
    rows.push({
      entityId: entity.id,
      header: translatedText(alert.headerText),
      description: translatedText(alert.descriptionText),
      url: translatedText(alert.url),
      cause: enumName(rt.Alert?.Cause, alert.cause),
      effect: enumName(rt.Alert?.Effect, alert.effect),
      activePeriods: (alert.activePeriod ?? []).map((p: any) => ({
        start: toNumber(p.start),
        end: toNumber(p.end)
      })),
      communicationPeriods: (alert.communicationPeriod ?? []).map((p: any) => ({
        start: toNumber(p.start),
        end: toNumber(p.end)
      })),
      impactPeriods: (alert.impactPeriod ?? []).map((p: any) => ({
        start: toNumber(p.start),
        end: toNumber(p.end)
      })),
      informedEntities: (alert.informedEntity ?? []).map((e: any) => ({
        agencyId: e.agencyId,
        routeId: e.routeId,
        stopId: e.stopId,
        tripId: e.trip?.tripId
      }))
    });
  }
  return rows;
}


type OpenovFeedKind =
  | "tripUpdates"
  | "alerts"
  | "trainUpdates"
  | "vehiclePositions";

type OpenovFeedCacheEntry = {
  result: any;
  fetchedAtMs: number;
};

// Een korte cache voorkomt dat iedere klik de upstream opnieuw belast.
const OPENOV_FEED_CACHE_TTL_MS = 20_000;
const OPENOV_RATE_LIMIT_COOLDOWN_MS = 30_000;

const openovFeedCache = new Map<string, OpenovFeedCacheEntry>();
const openovFeedInflight = new Map<string, Promise<any>>();
const openovRateLimitedUntil = new Map<string, number>();

function cachedOpenovFeedView(
  entry: OpenovFeedCacheEntry,
  servedFromCache: boolean,
  refreshWarning?: string
): any {
  const nowMs = Date.now();
  const feedTimestampMs = typeof entry.result.feedTimestamp === "string"
    ? Date.parse(entry.result.feedTimestamp)
    : Number.NaN;

  const rawAgeSeconds = Number.isFinite(feedTimestampMs)
    ? nowMs / 1000 - feedTimestampMs / 1000
    : null;

  const ageSeconds = rawAgeSeconds == null
    ? null
    : Math.max(0, Math.round(rawAgeSeconds));

  const freshness =
    rawAgeSeconds != null &&
    rawAgeSeconds >= -60 &&
    rawAgeSeconds <= 180
      ? "fresh"
      : "stale_or_unknown";

  return {
    ...entry.result,
    ageSeconds,
    freshness,
    servedFromCache,
    cacheAgeSeconds: Math.max(
      0,
      Math.round((nowMs - entry.fetchedAtMs) / 1000)
    ),
    ...(refreshWarning ? { refreshWarning } : {})
  };
}

async function getOpenovFeed(
  url: string,
  kind: OpenovFeedKind
): Promise<any> {
  const now = Date.now();
  const cached = openovFeedCache.get(url);

  // 1. Hergebruik een recent resultaat.
  if (cached && now - cached.fetchedAtMs < OPENOV_FEED_CACHE_TTL_MS) {
    console.log("[OVLIVE_FEED_CACHE]", JSON.stringify({
      kind,
      mode: "memory_hit",
      cacheAgeSeconds: Math.round((now - cached.fetchedAtMs) / 1000)
    }));

    const rateUntil = openovRateLimitedUntil.get(url) ?? 0;
    return cachedOpenovFeedView(
      cached,
      true,
      rateUntil > now
        ? "De bron heeft een rate limit opgelegd; de laatst opgehaalde feed wordt hergebruikt."
        : undefined
    );
  }

  // 2. Deel een download als meerdere aanvragen tegelijk dezelfde feed nodig hebben.
  const inflight = openovFeedInflight.get(url);
  if (inflight) {
    console.log("[OVLIVE_FEED_CACHE]", JSON.stringify({
      kind,
      mode: "single_flight_join"
    }));
    return inflight;
  }

  // 3. Probeer tijdens de cooldown de bron niet opnieuw te belasten.
  const rateLimitUntil = openovRateLimitedUntil.get(url) ?? 0;
  if (rateLimitUntil > now) {
    const retryAfterSeconds = Math.ceil((rateLimitUntil - now) / 1000);

    if (cached) {
      console.warn("[OVLIVE_FEED_CACHE]", JSON.stringify({
        kind,
        mode: "rate_limit_cached_fallback",
        retryAfterSeconds
      }));

      return cachedOpenovFeedView(
        cached,
        true,
        "De bron beperkt verzoeken; de laatst opgehaalde feed wordt gecontroleerd op actualiteit."
      );
    }

    console.warn("[OVLIVE_FEED_CACHE]", JSON.stringify({
      kind,
      mode: "rate_limit_blocked",
      retryAfterSeconds
    }));

    return {
      ok: false,
      status: 429,
      sourceUrl: url,
      checkedAt: new Date().toISOString(),
      freshness: "unavailable",
      ageSeconds: null,
      retryAfterSeconds,
      entities: [],
      error: "De OpenOV-bron heeft tijdelijk een rate limit opgelegd."
    };
  }

  const task = (async () => {
    let result: any;

    try {
      result = await fetchOpenovFeedUncached(url, kind);
    } catch (error) {
      result = {
        ok: false,
        status: 502,
        sourceUrl: url,
        checkedAt: new Date().toISOString(),
        freshness: "unavailable",
        ageSeconds: null,
        entities: [],
        error: error instanceof Error
          ? error.message
          : "OpenOV-feed tijdelijk niet bereikbaar."
      };
    }

    if (result.ok === true) {
      const entry = {
        result,
        fetchedAtMs: Date.now()
      };

      openovFeedCache.set(url, entry);
      openovRateLimitedUntil.delete(url);

      console.log("[OVLIVE_FEED_CACHE]", JSON.stringify({
        kind,
        mode: "upstream_success",
        entityCount: result.entityCount ?? null,
        ageSeconds: result.ageSeconds ?? null
      }));

      return cachedOpenovFeedView(entry, false);
    }

    if (result.status === 429) {
      openovRateLimitedUntil.set(
        url,
        Date.now() + OPENOV_RATE_LIMIT_COOLDOWN_MS
      );
    }

    const lastGood = openovFeedCache.get(url);

    if (lastGood) {
      console.warn("[OVLIVE_FEED_CACHE]", JSON.stringify({
        kind,
        mode: result.status === 429
          ? "rate_limited_last_good_fallback"
          : "upstream_error_last_good_fallback",
        upstreamStatus: result.status ?? null
      }));

      // De oude feed wordt alleen als fresh beschouwd zolang de
      // daadwerkelijke feed-header-timestamp dat nog rechtvaardigt.
      return cachedOpenovFeedView(
        lastGood,
        true,
        result.error ?? "De bron kon niet opnieuw worden opgehaald."
      );
    }

    console.warn("[OVLIVE_FEED_CACHE]", JSON.stringify({
      kind,
      mode: "upstream_failure",
      status: result.status ?? null,
      error: result.error ?? null
    }));

    return result;
  })();

  openovFeedInflight.set(url, task);

  try {
    return await task;
  } finally {
    if (openovFeedInflight.get(url) === task) {
      openovFeedInflight.delete(url);
    }
  }
}


async function fetchOpenovFeedUncached(url: string, kind: "tripUpdates" | "alerts" | "trainUpdates" | "vehiclePositions") {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      "user-agent": "OVLive/0.1.0 (open-source Dutch transit realtime client)",
      "accept-encoding": "gzip"
    },
    signal: AbortSignal.timeout(15000),
    cf: { cacheTtl: 15, cacheEverything: true }
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      sourceUrl: url,
      checkedAt: new Date().toISOString(),
      error: response.status === 429 ? "De bron beperkt het aantal verzoeken (429)." : `Bron gaf HTTP ${response.status}.`
    };
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 502, sourceUrl: url, checkedAt: new Date().toISOString(), error: "Feed groter dan ingestelde veiligheidslimiet." };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 502, sourceUrl: url, checkedAt: new Date().toISOString(), error: "Feed groter dan ingestelde veiligheidslimiet." };
  }

  const feed = (GtfsRealtimeBindings as any).transit_realtime.FeedMessage.decode(bytes);
  const feedTimestamp = toNumber(feed.header?.timestamp);
  const ageSeconds = feedTimestamp == null ? undefined : Math.max(0, Math.round(Date.now() / 1000 - feedTimestamp));
  const isStale = ageSeconds == null || ageSeconds > 180;
  const entities = kind === "tripUpdates" || kind === "trainUpdates"
    ? normalizeTripUpdates(feed)
    : kind === "alerts"
      ? normalizeAlerts(feed)
      : (feed.entity ?? []).map((e: any) => ({
          entityId: e.id,
          vehicleId: e.vehicle?.vehicle?.id,
          tripId: e.vehicle?.trip?.tripId,
          routeId: e.vehicle?.trip?.routeId,
          stopId: e.vehicle?.stopId,
          latitude: e.vehicle?.position?.latitude,
          longitude: e.vehicle?.position?.longitude,
          timestamp: toNumber(e.vehicle?.timestamp)
        })).filter((e: any) => e.vehicleId || e.tripId || e.latitude != null);

  return {
    ok: true,
    source: "OpenOV / OVapi GTFS-Realtime",
    sourceUrl: url,
    httpStatus: response.status,
    checkedAt: new Date().toISOString(),
    fetchDurationMs: Date.now() - startedAt,
    feedTimestamp: feedTimestamp == null ? null : new Date(feedTimestamp * 1000).toISOString(),
    ageSeconds: ageSeconds ?? null,
    freshness: isStale ? "stale_or_unknown" : "fresh",
    entityCount: entities.length,
    entities
  };
}


function normalizeOpenovId(value: unknown): string {
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").trim();
}

function normalizeClock(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;

  const match = String(value).match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) return undefined;

  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}`;
}

function parseOpenovTripId(value: unknown) {
  const raw = String(value ?? "");

  // Transitous-ID: 20261009_21:59_nl-OpenOV_380014114
  const full = raw.match(
    /^(\d{8})_(\d{2}:\d{2}(?::\d{2})?)_nl-OpenOV_(.+)$/i
  );

  const suffix = raw.match(/_nl-OpenOV_(.+)$/i);

  return {
    tripId: full?.[3] ?? suffix?.[1] ?? normalizeOpenovId(raw),
    startDate: full?.[1],
    startTime: normalizeClock(full?.[2])
  };
}

function planStopId(place: any): string {
  return normalizeOpenovId(place?.stopId ?? place?.id ?? "");
}

function collectPlanLegs(plan: any): any[] {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return [];
  }

  const containers = [
    ...(Array.isArray(plan.itineraries) ? plan.itineraries : []),
    ...(Array.isArray(plan.connections) ? plan.connections : []),
    ...(Array.isArray(plan.journeys) ? plan.journeys : [])
  ];

  const legs: any[] = [];
  const seen = new Set<any>();

  for (const container of containers) {
    if (!Array.isArray(container?.legs)) continue;

    for (const leg of container.legs) {
      if (leg && typeof leg === "object" && !seen.has(leg)) {
        seen.add(leg);
        legs.push(leg);
      }
    }
  }

  if (legs.length === 0 && Array.isArray(plan.legs)) {
    return plan.legs.filter((leg: any) =>
      leg && typeof leg === "object"
    );
  }

  return legs;
}

async function safeOpenovFeed(
  url: string,
  kind: "tripUpdates" | "alerts" | "trainUpdates" | "vehiclePositions"
): Promise<any> {
  try {
    return await getOpenovFeed(url, kind);
  } catch (error) {
    return {
      ok: false,
      freshness: "stale_or_unknown",
      ageSeconds: null,
      entities: [],
      error: error instanceof Error
        ? error.message
        : "OpenOV-feed tijdelijk niet bereikbaar."
    };
  }
}

function epochSeconds(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value / 1000;
    if (value > 1e9) return value;
    return undefined;
  }

  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return milliseconds / 1000;

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (numeric > 1e12) return numeric / 1000;
      if (numeric > 1e9) return numeric;
    }
  }

  return undefined;
}

function scheduledEventAtStop(stop: any):
  { seconds: number; reconstructed: boolean } | undefined {
  if (!stop || typeof stop !== "object") return undefined;

  const events: Array<{ seconds: number; reconstructed: boolean }> = [];

  for (const kind of ["departure", "arrival"]) {
    const time = stop[`${kind}Time`];
    if (typeof time !== "number" || !Number.isFinite(time)) continue;

    const capitalizedKind = kind[0].toUpperCase() + kind.slice(1);
    const delay = stop[`effective${capitalizedKind}DelaySeconds`] ??
      stop[`${kind}DelaySeconds`];

    if (typeof delay === "number" && Number.isFinite(delay)) {
      // A reliable delay lets us reconstruct the planned event time.
      events.push({ seconds: time - delay, reconstructed: true });
    } else {
      // Without a delay, retain the absolute prediction only as a weaker
      // candidate-matching clue. It is not itself proof of punctuality.
      events.push({ seconds: time, reconstructed: false });
    }
  }

  // Prefer the event that can reconstruct the planned time.
  // Otherwise, let the matcher apply its wider 300-second candidate tolerance.
  return events.find((event) => event.reconstructed) ?? events[0];
}
function matchOpenovRealtime(leg: any, records: any[]) {
  const rawRouteId = String(leg?.routeId ?? leg?.route?.id ?? "");

  if (!/^nl-OpenOV_/i.test(rawRouteId)) {
    return { reason: "not_openov" };
  }

  const routeId = normalizeOpenovId(rawRouteId);
  const identity = parseOpenovTripId(leg.tripId);
  const fromId = planStopId(leg.from);
  const toId = planStopId(leg.to);

  // Voorkeursmethode: exacte rit-ID, met routecontrole als de
  // realtimefeed ook een route-ID bevat.
  const exact = records.filter((record: any) => {
    const recordIdentity = parseOpenovTripId(record.tripId);
    const recordTripId = recordIdentity.tripId;
    const recordRouteId = normalizeOpenovId(record.routeId);

    // Een numeriek GTFS-rit-ID kan op meerdere exploitatiedagen voorkomen.
    // Gebruik daarom geen update van morgen voor een reis van vandaag.
    const expectedDate = String(identity.startDate ?? "")
      .replace(/\D/g, "")
      .slice(0, 8);
    const recordDate = String(record.startDate ?? recordIdentity.startDate ?? "")
      .replace(/\D/g, "")
      .slice(0, 8);
    const serviceDateMatches =
      !expectedDate ||
      (recordDate.length > 0 && recordDate === expectedDate);

    return recordTripId === identity.tripId &&
      (!recordRouteId || recordRouteId === routeId) &&
      serviceDateMatches;
  });

  // TIJDELIJKE DIAGNOSE: tel kandidaten per matchingstap.
  // Deze diagnose verandert de matchbeslissing niet.
  const diagnosticPlannedValue = leg.scheduledStartTime ?? leg.startTime;
  const diagnosticPlannedTimestamp = epochSeconds(diagnosticPlannedValue);
  const diagnosticExpectedDirection = leg.directionId ?? leg.trip?.directionId;

  const diagnosticRouteRecords = records.filter(
    (record: any) => normalizeOpenovId(record.routeId) === routeId
  );

  const diagnosticDateRecords = diagnosticRouteRecords.filter(
    (record: any) => record.startDate === identity.startDate
  );

  const diagnosticDirectionRecords = diagnosticDateRecords.filter(
    (record: any) =>
      diagnosticExpectedDirection == null ||
      record.directionId == null ||
      String(record.directionId) === String(diagnosticExpectedDirection)
  );

  const diagnosticFromStopRecords = diagnosticDirectionRecords.filter(
    (record: any) => (record.stopUpdates ?? []).some(
      (stop: any) => normalizeOpenovId(stop.stopId) === fromId
    )
  );

  const diagnosticOrderedStopRecords = diagnosticFromStopRecords.filter(
    (record: any) => {
      const ids = (record.stopUpdates ?? []).map(
        (stop: any) => normalizeOpenovId(stop.stopId)
      );
      const fromIndex = ids.indexOf(fromId);
      const toIndex = toId ? ids.indexOf(toId) : -1;
      return fromIndex >= 0 && (toIndex < 0 || toIndex > fromIndex);
    }
  );

  const diagnosticTimeRecords = diagnosticOrderedStopRecords.filter(
    (record: any) => {
      if (diagnosticPlannedTimestamp == null) return false;

      const boardingUpdate = (record.stopUpdates ?? []).find(
        (stop: any) => normalizeOpenovId(stop.stopId) === fromId
      );
      const event = scheduledEventAtStop(boardingUpdate);
      if (!event) return false;

      const tolerance = event.reconstructed ? 180 : 300;
      return Math.abs(event.seconds - diagnosticPlannedTimestamp) <= tolerance;
    }
  );

  // Toon alle kandidaten met dezelfde route, datum en richting,
  // ook als hun halte-updates de vertrekhalte niet bevatten.
  const diagnosticSampleSource = diagnosticDirectionRecords;

  const diagnosticSamples = diagnosticSampleSource.slice(0, 5).map(
    (record: any) => {
      const ids = (record.stopUpdates ?? []).map(
        (stop: any) => normalizeOpenovId(stop.stopId)
      );
      const boardingUpdate = (record.stopUpdates ?? []).find(
        (stop: any) => normalizeOpenovId(stop.stopId) === fromId
      );
      const event = scheduledEventAtStop(boardingUpdate);

      return {
        tripId: record.tripId ?? null,
        routeId: record.routeId ?? null,
        startDate: record.startDate ?? null,
        startTime: record.startTime ?? null,
        directionId: record.directionId ?? null,
        scheduleRelationship: record.scheduleRelationship ?? null,
        stopUpdateCount: ids.length,
        stopIdsStart: ids.slice(0, 5),
        stopIdsEnd: ids.slice(-5),
        timestamp: record.timestamp ?? null,
        updateAgeSeconds: typeof record.timestamp === "number"
          ? Math.round(Date.now() / 1000 - record.timestamp)
          : null,
        fromStopPresent: ids.includes(fromId),
        toStopPresent: Boolean(toId) && ids.includes(toId),
        fromStopIndex: ids.indexOf(fromId),
        toStopIndex: toId ? ids.indexOf(toId) : -1,
        reconstructedBoardingTime: event
          ? new Date(event.seconds * 1000).toISOString()
          : null,
        differenceSeconds: event && diagnosticPlannedTimestamp != null
          ? Math.round(event.seconds - diagnosticPlannedTimestamp)
          : null
      };
    }
  );


  if (exact.length === 1) {
    return { record: exact[0], method: "exact_trip_id" };
  }

  if (exact.length > 1) {
    return { reason: "ambiguous_exact_id" };
  }

  // De tijd in de Transitous-trip-ID is de tijd van het reissegment,
  // niet noodzakelijk de vertrektijd vanaf de eerste halte van de rit.
  // Vergelijk daarom met de geplande tijd bij de instaphalte.
  const plannedValue = leg.scheduledStartTime ?? leg.startTime;
  const plannedTimestamp = epochSeconds(plannedValue);

  if (!identity.startDate || plannedTimestamp == null || !fromId) {
    return { reason: "insufficient_trip_identity" };
  }

  const candidates = records.filter((record: any) => {
    if (normalizeOpenovId(record.routeId) !== routeId) return false;
    if (record.startDate !== identity.startDate) return false;

    const expectedDirection = leg.directionId ?? leg.trip?.directionId;

    if (
      expectedDirection != null &&
      record.directionId != null &&
      String(expectedDirection) !== String(record.directionId)
    ) {
      return false;
    }

    const stopIds = (record.stopUpdates ?? []).map(
      (stop: any) => normalizeOpenovId(stop.stopId)
    );

    const fromIndex = stopIds.indexOf(fromId);
    const toIndex = toId ? stopIds.indexOf(toId) : -1;

    if (fromIndex < 0) return false;
    if (toIndex >= 0 && toIndex <= fromIndex) return false;

    const boardingUpdate = (record.stopUpdates ?? []).find(
      (stop: any) => normalizeOpenovId(stop.stopId) === fromId
    );

    if (!boardingUpdate) return false;

    const event = scheduledEventAtStop(boardingUpdate);
    if (!event) return false;

    // Als de bron een vertraging én een absolute tijd geeft, kunnen we
    // de geplande tijd afleiden: realtime-tijd minus vertraging.
    // Zonder vertraging gebruiken we een ruimere, conservatieve marge.
    const toleranceSeconds = event.reconstructed ? 180 : 300;

    return Math.abs(event.seconds - plannedTimestamp) <= toleranceSeconds;
  });

  if (candidates.length === 1) {
    return {
      record: candidates[0],
      method: "route_start_time_and_stops"
    };
  }

  if (candidates.length > 1) {
    return { reason: "ambiguous_fallback" };
  }

  // Tweede veilige methode:
  // dezelfde route, datum, starttijd en compatibele richting.
  // Vereis daarnaast halte-informatie voor deze rit, tenzij de rit
  // expliciet is geannuleerd. Een rit zonder voorspellingen wordt
  // nooit als op tijd beschouwd.
  const identityCandidates = identity.startTime
    ? records.filter((record: any) => {
        if (normalizeOpenovId(record.routeId) !== routeId) return false;
        if (record.startDate !== identity.startDate) return false;
        if (normalizeClock(record.startTime) !== identity.startTime) return false;

        const expectedDirection = leg.directionId ?? leg.trip?.directionId;

        if (
          expectedDirection != null &&
          record.directionId != null &&
          String(expectedDirection) !== String(record.directionId)
        ) {
          return false;
        }

        const relationship = String(
          record.scheduleRelationship ?? ""
        ).toUpperCase();

        const cancelled =
          relationship.includes("CANCEL") ||
          relationship.includes("DELETED");

        const stopUpdates = record.stopUpdates ?? [];

        // Zonder halte-updates accepteren we alleen een expliciete annulering.
        if (stopUpdates.length === 0) return cancelled;

        const stopIds = stopUpdates.map(
          (stop: any) => normalizeOpenovId(stop.stopId)
        );

        const fromIndex = fromId ? stopIds.indexOf(fromId) : -1;
        const toIndex = toId ? stopIds.indexOf(toId) : -1;

        if (fromIndex < 0 && toIndex < 0) return false;

        // Als beide haltes aanwezig zijn, moet de volgorde kloppen.
        if (
          fromIndex >= 0 &&
          toIndex >= 0 &&
          toIndex <= fromIndex
        ) {
          return false;
        }

        return true;
      })
    : [];

  if (identityCandidates.length === 1) {
    return {
      record: identityCandidates[0],
      method: "route_date_direction_start_time"
    };
  }

  return {
    reason: identityCandidates.length > 1
      ? "ambiguous_start_time_fallback"
      : "no_matching_realtime_trip"
  };
}

function findRealtimeStop(record: any, stopId: string) {
  if (!stopId) return undefined;

  return (record.stopUpdates ?? []).find(
    (stop: any) => normalizeOpenovId(stop.stopId) === stopId
  );
}

function alertIsActive(alert: any, nowSeconds: number): boolean {
  // Nieuwe GTFS-RT-velden hebben voorrang op de oudere active_period.
  const periods = alert.communicationPeriods?.length
    ? alert.communicationPeriods
    : alert.impactPeriods?.length
      ? alert.impactPeriods
      : alert.activePeriods ?? [];

  if (periods.length === 0) return true;

  return periods.some((period: any) =>
    (period.start == null || period.start <= nowSeconds) &&
    (period.end == null || period.end >= nowSeconds)
  );
}

async function enrichTransitousPlan(plan: any): Promise<any> {
  const legs = collectPlanLegs(plan);

  const openovLegs = legs.filter((leg: any) =>
    /^nl-OpenOV_/i.test(
      String(leg?.routeId ?? leg?.route?.id ?? "")
    )
  );

  if (openovLegs.length === 0) return plan;

  // Haal de feeds parallel op. Alleen verse feeds worden gebruikt
  // voor actuele reisinformatie.
  const [tripFeed, trainFeed, alertFeed] = await Promise.all([
    safeOpenovFeed(OPENOV.tripUpdates, "tripUpdates"),
    safeOpenovFeed(OPENOV.trainUpdates, "trainUpdates"),
    safeOpenovFeed(OPENOV.alerts, "alerts")
  ]);

  // TIJDELIJKE DIAGNOSE: controleer de daadwerkelijke invoer van de matcher.

  const usableFeeds = [
    tripFeed,
    trainFeed
  ].filter((feed: any) =>
    feed.ok === true && feed.freshness === "fresh"
  );

  // Combineer en dedupliceer updates uit de bus/tram- en treinfeed.
  const byIdentity = new Map<string, any>();

  const hasTripTimestamp = (record: any) =>
    typeof record.timestamp === "number" &&
    Number.isFinite(record.timestamp) &&
    record.timestamp > 0;

  for (const feed of usableFeeds) {
    const headerMs = typeof feed.feedTimestamp === "string"
      ? Date.parse(feed.feedTimestamp)
      : Number.NaN;

    const feedTimestampSeconds =
      Number.isFinite(headerMs) && headerMs > 0
        ? headerMs / 1000
        : undefined;

    for (const record of feed.entities ?? []) {
      if (!record.tripId) continue;

      const enrichedRecord = {
        ...record,
        feedTimestampSeconds,
        feedAgeSeconds: feed.ageSeconds ?? null
      };

      const identity = parseOpenovTripId(record.tripId);
      const key = [
        normalizeOpenovId(record.routeId),
        identity.tripId,
        record.startDate ?? "",
        normalizeClock(record.startTime) ?? ""
      ].join("|");

      const existing = byIdentity.get(key);
      const newHasTimestamp = hasTripTimestamp(enrichedRecord);
      const oldHasTimestamp = existing
        ? hasTripTimestamp(existing)
        : false;

      const shouldReplace =
        !existing ||
        (newHasTimestamp && !oldHasTimestamp) ||
        (
          newHasTimestamp === oldHasTimestamp &&
          (
            newHasTimestamp
              ? enrichedRecord.timestamp > existing.timestamp
              : (enrichedRecord.feedTimestampSeconds ?? 0) >
                (existing.feedTimestampSeconds ?? 0)
          )
        );

      if (shouldReplace) {
        byIdentity.set(key, enrichedRecord);
      }
    }
  }

  // TIJDELIJKE DIAGNOSE: aantallen binnen dezelfde routeaanvraag.
  const records = [...byIdentity.values()];
  let matchedCount = 0;
  let unknownCount = 0;
  let freshPredictionCount = 0;
  let unconfirmedPredictionCount = 0;
  let noPredictionCount = 0;

  const relevantRoutes = new Set<string>();
  const relevantStops = new Set<string>();
  const relevantTrips = new Set<string>();

  for (const leg of openovLegs) {
    relevantRoutes.add(normalizeOpenovId(leg.routeId ?? leg.route?.id));

    const fromId = planStopId(leg.from);
    const toId = planStopId(leg.to);

    if (fromId) relevantStops.add(fromId);
    if (toId) relevantStops.add(toId);

    const identity = parseOpenovTripId(leg.tripId);
    if (identity.tripId) relevantTrips.add(identity.tripId);

    const result = matchOpenovRealtime(leg, records);


    if (!result.record) {
      unknownCount++;
      noPredictionCount++;

      const anyFeedReachable = tripFeed.ok || trainFeed.ok;
      const anyFreshFeed = usableFeeds.length > 0;

      leg.openovRealtime = {
        source: "OpenOV GTFS-Realtime",
        status: "unknown",
        reason: !anyFeedReachable
          ? "realtime_feed_unavailable"
          : !anyFreshFeed
            ? "realtime_feed_stale"
            : result.reason ?? "no_matching_realtime_trip",
        message: "Geen betrouwbare realtime-update voor deze rit gevonden."
      };

      continue;
    }

    const record = result.record;

    // De timestamp per rit is optioneel. Gebruik anders de feed-header
    // als beperkte fallback; vermeld welke timestamp hiervoor is gebruikt.
    const recordTimestamp =
      typeof record.timestamp === "number" &&
      Number.isFinite(record.timestamp) &&
      record.timestamp > 0
        ? record.timestamp
        : null;

    const feedTimestamp =
      typeof record.feedTimestampSeconds === "number" &&
      Number.isFinite(record.feedTimestampSeconds) &&
      record.feedTimestampSeconds > 0
        ? record.feedTimestampSeconds
        : null;

    const effectiveTimestamp = recordTimestamp ?? feedTimestamp;
    const timestampBasis = recordTimestamp !== null
      ? "trip_update"
      : feedTimestamp !== null
        ? "feed_header"
        : "unknown";

    const tripUpdateAgeSeconds =
      effectiveTimestamp === null
        ? null
        : Math.round(Date.now() / 1000 - effectiveTimestamp);

    const tripUpdateIsFresh =
      tripUpdateAgeSeconds !== null &&
      tripUpdateAgeSeconds >= -60 &&
      tripUpdateAgeSeconds <= 180;

    if (!tripUpdateIsFresh) {
      unknownCount++;
      noPredictionCount++;
      leg.openovRealtime = {
        source: "OpenOV GTFS-Realtime",
        status: "unknown",
        reason: effectiveTimestamp === null
          ? "realtime_timestamp_unknown"
          : "realtime_trip_update_stale",
        message: effectiveTimestamp === null
          ? "Er is geen bruikbare timestamp voor deze rit of feed."
          : "De timestamp van de rit of feed is verouderd.",
        tripId: record.tripId ?? null,
        routeId: record.routeId ?? null,
        timestampBasis,
        updateTimestamp: effectiveTimestamp === null
          ? null
          : new Date(effectiveTimestamp * 1000).toISOString(),
        updateAgeSeconds: tripUpdateAgeSeconds
      };
      continue;
    }

    const fromUpdate = findRealtimeStop(record, fromId);
    const toUpdate = findRealtimeStop(record, toId);


    const relationship = String(
      record.scheduleRelationship ?? ""
    ).toUpperCase();

    const cancelled =
      leg.cancelled === true ||
      relationship.includes("CANCEL") ||
      relationship.includes("DELETED");

    const departurePrediction = summarizeRealtimeEvent(
      fromUpdate,
      "departure",
      leg.from?.scheduledDeparture ?? leg.scheduledStartTime ?? leg.startTime,
      { hasPerTripTimestamp: recordTimestamp !== null }
    );
    const arrivalPrediction = summarizeRealtimeEvent(
      toUpdate,
      "arrival",
      leg.to?.scheduledArrival ?? leg.scheduledEndTime ?? leg.endTime,
      { hasPerTripTimestamp: recordTimestamp !== null }
    );

    const hasExplicitStopPrediction = Boolean(
      departurePrediction?.time ||
      (departurePrediction?.delaySeconds != null &&
        Number.isFinite(Number(departurePrediction.delaySeconds))) ||
      arrivalPrediction?.time ||
      (arrivalPrediction?.delaySeconds != null &&
        Number.isFinite(Number(arrivalPrediction.delaySeconds)))
    );
    const hasPerTripTimestamp = recordTimestamp !== null;

    // Een exacte ritmatch is niet automatisch een bevestigde halteprognose.
    matchedCount++;

    if (!cancelled) {
      if (!hasExplicitStopPrediction) {
        unknownCount++;
        noPredictionCount++;
      } else if (!hasPerTripTimestamp) {
        unknownCount++;
        unconfirmedPredictionCount++;
      } else {
        freshPredictionCount++;
      }
    }

    leg.openovRealtime = {
      source: "OpenOV GTFS-Realtime",
      status: cancelled ? "cancelled" : "matched",
      timestampBasis,
      updateTimestamp: effectiveTimestamp === null
        ? null
        : new Date(effectiveTimestamp * 1000).toISOString(),
      updateAgeSeconds: tripUpdateAgeSeconds,
      freshnessNote: recordTimestamp === null
        ? "De timestamp per rit ontbreekt; de versheid is afgeleid van de feed-header."
        : null,
      matchMethod: result.method,
      tripId: record.tripId,
      routeId: record.routeId ?? null,
      startDate: record.startDate ?? null,
      startTime: record.startTime ?? null,
      directionId: record.directionId ?? null,
      scheduleRelationship: record.scheduleRelationship ?? null,
      departure: departurePrediction,
      arrival: arrivalPrediction
    };
  }

  const nowSeconds = Date.now() / 1000;

  const relevantAlerts = alertFeed.ok &&
    alertFeed.freshness === "fresh"
    ? (alertFeed.entities ?? []).filter((alert: any) => {
        if (!alertIsActive(alert, nowSeconds)) return false;

        return (alert.informedEntities ?? []).some((entity: any) => {
          const routeId = normalizeOpenovId(entity.routeId);
          const stopId = normalizeOpenovId(entity.stopId);
          const tripId = parseOpenovTripId(entity.tripId).tripId;

          return (
            (routeId && relevantRoutes.has(routeId)) ||
            (stopId && relevantStops.has(stopId)) ||
            (tripId && relevantTrips.has(tripId))
          );
        });
      }).map((alert: any) => ({
        id: alert.entityId,
        header: alert.header,
        description: alert.description,
        url: alert.url,
        cause: alert.cause,
        effect: alert.effect,
        activePeriods: alert.activePeriods,
        communicationPeriods: alert.communicationPeriods ?? [],
        impactPeriods: alert.impactPeriods ?? []
      }))
    : [];

  plan.openovAlerts = relevantAlerts;
  plan.openovRealtimeMeta = {
    source: "OpenOV GTFS-Realtime",
    checkedAt: new Date().toISOString(),
    matchedLegCount: matchedCount,
    unknownLegCount: unknownCount,
    freshPredictionLegCount: freshPredictionCount,
    unconfirmedPredictionLegCount: unconfirmedPredictionCount,
    noPredictionLegCount: noPredictionCount,
    alertCount: relevantAlerts.length,
    feeds: {
      tripUpdates: {
        ok: Boolean(tripFeed.ok),
        status: tripFeed.httpStatus ?? tripFeed.status ?? null,
        freshness: tripFeed.freshness ?? "unavailable",
        ageSeconds: tripFeed.ageSeconds ?? null,
        servedFromCache: tripFeed.servedFromCache ?? false,
        cacheAgeSeconds: tripFeed.cacheAgeSeconds ?? null,
        error: tripFeed.error ?? tripFeed.refreshWarning ?? null
      },
      trainUpdates: {
        ok: Boolean(trainFeed.ok),
        status: trainFeed.httpStatus ?? trainFeed.status ?? null,
        freshness: trainFeed.freshness ?? "unavailable",
        ageSeconds: trainFeed.ageSeconds ?? null,
        servedFromCache: trainFeed.servedFromCache ?? false,
        cacheAgeSeconds: trainFeed.cacheAgeSeconds ?? null,
        error: trainFeed.error ?? trainFeed.refreshWarning ?? null
      },
      alerts: {
        ok: Boolean(alertFeed.ok),
        status: alertFeed.httpStatus ?? alertFeed.status ?? null,
        freshness: alertFeed.freshness ?? "unavailable",
        ageSeconds: alertFeed.ageSeconds ?? null,
        servedFromCache: alertFeed.servedFromCache ?? false,
        cacheAgeSeconds: alertFeed.cacheAgeSeconds ?? null,
        error: alertFeed.error ?? alertFeed.refreshWarning ?? null
      },
    }
  };

  return plan;
}

type NdovStreamName = "kv78" | "bison";
const NDOV_SHARED_OBJECT_NAME = "ndov-shared-collector-v1";

type NdovSnapshot = Record<string, any>;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

async function callNdovHub(
  env: Env,
  stream: NdovStreamName,
  action: "start" | "status" | "continuous/enable" | "continuous/disable" | "mutations" | "rows",
  seconds?: number,
  waitForCompletion = false,
  includeAllRows = false,
): Promise<NdovSnapshot> {
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const target = new URL(`https://ndov-hub.local/${action}`);
  target.searchParams.set("stream", stream);
  if (includeAllRows) target.searchParams.set("includeAllRows", "1");
  if (seconds != null) target.searchParams.set("seconds", String(seconds));
  if (waitForCompletion) target.searchParams.set("wait", "1");
  const response = await stub.fetch(target.toString());
  const data = await response.json().catch(() => ({})) as NdovSnapshot;
  if (!response.ok) throw new Error(String(data.error ?? `NDOV-hub gaf HTTP ${response.status}.`));
  return data;
}

function correlateLocalKv17Mutations(rows: any[], mutations: any[]): any[] {
  const keyOf = (item: any): string | null => {
    if (!item || item.allLines || item.allJourneysOfLine) return null;
    const owner = String(item.dataOwnerCode ?? item.DataOwnerCode ?? "").trim();
    const rawDate = String(item.operationDate ?? item.OperationDate ?? "").trim();
    const dateParts = rawDate.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    const date = dateParts
      ? `${dateParts[1]}${dateParts[2]}${dateParts[3]}`
      : rawDate;
    const line = String(item.linePlanningNumber ?? item.LinePlanningNumber ?? "").trim();
    const journey = String(item.journeyNumber ?? item.JourneyNumber ?? "").trim();
    const reinforcement = String(item.reinforcementNumber ?? item.fortifyOrderNumber ?? item.ReinforcementNumber ?? item.FortifyOrderNumber ?? "0").trim() || "0";
    if (!owner || !date || !line || !journey) return null;
    return [owner, date, line, journey, reinforcement].join("|");
  };
  const rowsByTrip = new Map<string, any[]>();
  for (const row of rows ?? []) {
    const key = keyOf(row);
    if (key) rowsByTrip.set(key, [...(rowsByTrip.get(key) ?? []), row]);
  }
  const latest = new Map<string, { rank: number; timestamp: string | null; mutations: any[] }>();
  let order = 0;
  for (const mutation of mutations ?? []) {
    order += 1;
    const key = keyOf(mutation);
    if (!key) continue;
    const timestamp = mutation.timestamp ?? null;
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    const rank = Number.isFinite(parsed) ? parsed : order;
    const existing = latest.get(key);
    if (!existing || rank > existing.rank) latest.set(key, { rank, timestamp, mutations: [mutation] });
    else if (rank === existing.rank) {
      const signature = (m: any) => `${m.eventType ?? ""}|${m.userStopCode ?? ""}|${m.passageSequenceNumber ?? ""}`;
      if (!existing.mutations.some((m) => signature(m) === signature(mutation))) existing.mutations.push(mutation);
    }
  }
  return [...latest.entries()].map(([identity, current]) => {
    const actions = [...new Set(current.mutations.map((m) => m.eventType).filter(Boolean))].sort();
    const hasCancel = actions.includes("CANCEL");
    const hasRecover = actions.includes("RECOVER");
    const cancelled = hasCancel === hasRecover ? null : hasCancel;
    const matched = rowsByTrip.get(identity) ?? [];
    const first = current.mutations[0];
    const status = cancelled === true
      ? (matched.length ? "cancelled-exact-trip-match" : "cancelled-no-kv78-row-match")
      : cancelled === false
        ? (matched.length ? "recovered-exact-trip-match" : "recovered-no-kv78-row-match")
        : (matched.length ? "mutation-exact-trip-match" : "mutation-no-kv78-row-match");
    return {
      identity, source: "KV17+KV78", dataOwnerCode: first.dataOwnerCode,
      operationDate: first.operationDate, linePlanningNumber: first.linePlanningNumber,
      journeyNumber: first.journeyNumber, reinforcementNumber: first.reinforcementNumber ?? "0",
      lastMutationTimestamp: current.timestamp, mutationTypes: actions, cancelled,
      showCancelledTrip: first.showCancelledTrip ?? null, matchedKv78StopCount: matched.length,
      matchedKv78StopCodes: [...new Set(matched.map((r) => r.userStopCode).filter(Boolean))],
      matchedKv78Statuses: [...new Set(matched.map((r) => r.tripStopStatus).filter(Boolean))], status,
    };
  }).sort((a, b) => String(b.lastMutationTimestamp ?? "").localeCompare(String(a.lastMutationTimestamp ?? ""))).slice(0, 100);
}

function summarizeNdovSnapshot(snapshot: NdovSnapshot, stream: NdovStreamName): NdovSnapshot {
  return {
    stream: snapshot.stream ?? stream,
    label: snapshot.label ?? (stream === "kv78" ? "KV78Turbo" : "BISON KV6/KV15/KV17"),
    state: snapshot.state ?? "unknown",
    startedAt: snapshot.startedAt ?? null,
    finishedAt: snapshot.finishedAt ?? null,
    sessionSeconds: snapshot.sessionSeconds ?? null,
    messageCount: snapshot.messageCount ?? 0,
    rawBytes: snapshot.rawBytes ?? 0,
    envelopeCounts: snapshot.envelopeCounts ?? {},
    latestMessageAt: snapshot.latestMessageAt ?? null,
    latestRowsCount: Array.isArray(snapshot.latestRows) ? snapshot.latestRows.length : null,
    latestEventsCount: Array.isArray(snapshot.latestEvents) ? snapshot.latestEvents.length : null,
    storedKv6TripCount: snapshot.storedKv6TripCount ?? null,
    latestMutationsCount: Array.isArray(snapshot.latestMutations) ? snapshot.latestMutations.length : null,
    latestMutations: stream === "bison" ? (snapshot.latestMutations ?? []).slice(-30) : undefined,
    error: snapshot.error ?? null,
    warnings: snapshot.warnings ?? [],
    zmtpVersion: snapshot.zmtpVersion ?? null,
    handshake: snapshot.handshake ?? null,
    storedKv78RowCount: snapshot.storedKv78RowCount ?? null,
    storedMutationIdentityCount: snapshot.storedMutationIdentityCount ?? null,
    continuousEnabled: snapshot.continuousEnabled === true,
    nextAlarmAt: snapshot.nextAlarmAt ?? null,
    autoCollector: snapshot.autoCollector ?? null,
  };
}

async function handleLocalNdovApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/ndov/")) return null;
  // This hub is diagnostic only. Never allow public requests to open NDOV TCP subscriptions.
  if (!isLoopbackHost(url.hostname)) return new Response("Not found", { status: 404 });
  if (request.method !== "GET") return json({ ok: false, error: "Alleen GET is toegestaan." }, 405);

  if (url.pathname === "/api/ndov/start") {
    const rawSeconds = Number(url.searchParams.get("seconds") ?? "120");
    const seconds = Number.isFinite(rawSeconds) ? Math.max(10, Math.min(120, Math.floor(rawSeconds))) : 120;
    const waitForCompletion = url.searchParams.get("wait") === "1";
    const feeds = await Promise.all([
      callNdovHub(env, "kv78", "start", seconds, waitForCompletion),
      callNdovHub(env, "bison", "start", seconds, waitForCompletion),
    ]);
    return json({
      ok: feeds.every((feed) => feed.ok === true || feed.started === true || feed.alreadyRunning === true),
      seconds, waitForCompletion,
      note: waitForCompletion
        ? "Begrensde lokale diagnose afgerond; controleer daarna /api/ndov/status."
        : "Collectors gestart; controleer /api/ndov/status.",
      feeds,
    });
  }

  if (url.pathname === "/api/ndov/continuous/enable") {
    const feeds = await Promise.all([
      callNdovHub(env, "kv78", "continuous/enable"),
      callNdovHub(env, "bison", "continuous/enable"),
    ]);
    return json({ ok: feeds.every((feed) => feed.ok === true && feed.enabled === true), enabled: true, feeds,
      note: "Alarmgestuurde collector ingeschakeld: per stream een begrensde sessie, daarna rusttijd en herstel bij fouten." });
  }
  if (url.pathname === "/api/ndov/continuous/disable") {
    const feeds = await Promise.all([
      callNdovHub(env, "kv78", "continuous/disable"),
      callNdovHub(env, "bison", "continuous/disable"),
    ]);
    return json({ ok: feeds.every((feed) => feed.ok === true && feed.enabled === false), enabled: false, feeds,
      note: "Automatische collector uitgeschakeld." });
  }

  if (url.pathname === "/api/ndov/rows") {
    const identity = String(url.searchParams.get("identity") ?? "").trim();
    if (!/^[A-Za-z0-9_-]+\\|(?:\\d{8}|\\d{4}-\\d{2}-\\d{2})\\|[^|]+\\|[^|]+\\|[^|]+$/.test(identity)) {
      return json({
        ok: false,
        error: "Gebruik identity=owner|YYYY-MM-DD|line|journey|reinforcement."
      }, 400);
    }

    const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
    const stub = env.NDOV_FEEDS.get(id);
    const target = new URL("https://ndov-hub.local/rows");
    target.searchParams.set("stream", "kv78");
    target.searchParams.set("identity", identity);

    const response = await stub.fetch(target.toString());
    const data = await response.json().catch(() => ({})) as Record<string, any>;
    return json({ ...data, requestedIdentity: identity }, response.ok ? 200 : 502);
  }

  if (url.pathname === "/api/ndov/events") {
    const identity = String(url.searchParams.get("identity") ?? "").trim();
    if (!/^[A-Za-z0-9_-]+\|\d{4}-\d{2}-\d{2}\|[^|]+\|[^|]+\|[^|]+$/.test(identity)) {
      return json({ ok: false, error: "Gebruik identity=owner|YYYY-MM-DD|line|journey|reinforcement." }, 400);
    }
    const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
    const stub = env.NDOV_FEEDS.get(id);
    const target = new URL("https://ndov-hub.local/events");
    target.searchParams.set("stream", "bison");
    target.searchParams.set("identity", identity);
    const response = await stub.fetch(target.toString());
    const data = await response.json().catch(() => ({})) as NdovSnapshot;
    return json({ ...data, requestedIdentity: identity }, response.ok ? 200 : 502);
  }

  if (url.pathname === "/api/ndov/status") {
    const [kv78, bison] = await Promise.all([
      callNdovHub(env, "kv78", "status", undefined, false, true),
      callNdovHub(env, "bison", "status"),
    ]);
    const rows = Array.isArray(kv78.latestRows) ? kv78.latestRows : [];
    const mutations = Array.isArray(bison.latestMutations) ? bison.latestMutations : [];
    const tripStatuses = correlateLocalKv17Mutations(rows, mutations);

    const diagnosticDate = (value: any): string => {
      const raw = String(value ?? "").trim();
      const parts = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
      return parts ? `${parts[1]}${parts[2]}${parts[3]}` : raw;
    };

    const diagnosticParts = (item: any) => {
      if (!item) return null;
      const owner = String(item.dataOwnerCode ?? item.DataOwnerCode ?? "").trim();
      const date = diagnosticDate(item.operationDate ?? item.OperationDate);
      const line = String(item.linePlanningNumber ?? item.LinePlanningNumber ?? "").trim();
      const journey = String(item.journeyNumber ?? item.JourneyNumber ?? "").trim();
      const reinforcement = String(
        item.reinforcementNumber ?? item.fortifyOrderNumber ??
        item.ReinforcementNumber ?? item.FortifyOrderNumber ?? "0"
      ).trim() || "0";

      if (!owner || !date || !line || !journey) return null;

      return {
        owner, date, line, journey, reinforcement,
        full: [owner, date, line, journey, reinforcement].join("|"),
        withoutReinforcement: [owner, date, line, journey].join("|"),
        withoutDate: [owner, line, journey].join("|"),
        withoutJourney: [owner, date, line].join("|"),
        ownerLine: [owner, line].join("|"),
      };
    };

    const diagnosticKeys = {
      full: new Set<string>(),
      withoutReinforcement: new Set<string>(),
      withoutDate: new Set<string>(),
      withoutJourney: new Set<string>(),
      ownerLine: new Set<string>(),
    };

    for (const row of rows) {
      const p = diagnosticParts(row);
      if (!p) continue;
      diagnosticKeys.full.add(p.full);
      diagnosticKeys.withoutReinforcement.add(p.withoutReinforcement);
      diagnosticKeys.withoutDate.add(p.withoutDate);
      diagnosticKeys.withoutJourney.add(p.withoutJourney);
      diagnosticKeys.ownerLine.add(p.ownerLine);
    }

    const diagnosticMatchCounts = {
      totalMutationTrips: tripStatuses.length,
      exactNormalizedIdentity: 0,
      sameOwnerDateLineJourneyIgnoringReinforcement: 0,
      sameOwnerLineJourneyIgnoringDate: 0,
      sameOwnerDateLineIgnoringJourney: 0,
      sameOwnerAndLine: 0,
    };

    // Tel over ALLE huidige mutaties; niet alleen de 12 voorbeeldrecords.
    for (const trip of tripStatuses) {
      const p = diagnosticParts(trip);
      if (!p) continue;

      if (diagnosticKeys.full.has(p.full)) {
        diagnosticMatchCounts.exactNormalizedIdentity++;
      }
      if (diagnosticKeys.withoutReinforcement.has(p.withoutReinforcement)) {
        diagnosticMatchCounts.sameOwnerDateLineJourneyIgnoringReinforcement++;
      }
      if (diagnosticKeys.withoutDate.has(p.withoutDate)) {
        diagnosticMatchCounts.sameOwnerLineJourneyIgnoringDate++;
      }
      if (diagnosticKeys.withoutJourney.has(p.withoutJourney)) {
        diagnosticMatchCounts.sameOwnerDateLineIgnoringJourney++;
      }
      if (diagnosticKeys.ownerLine.has(p.ownerLine)) {
        diagnosticMatchCounts.sameOwnerAndLine++;
      }
    }

    const diagnosticExamples = tripStatuses
      .filter((trip: any) => !trip.matchedKv78StopCount)
      .slice(0, 12)
      .map((trip: any) => {
        const p = diagnosticParts(trip);
        if (!p) return { identity: trip.identity, error: "Onvolledige identiteit" };


        const candidates = rows
          .filter((row: any) => {
            const r = diagnosticParts(row);
            return r && r.owner === p.owner && r.line === p.line;
          })
          .slice(-3)
          .map((row: any) => {
            const r = diagnosticParts(row);
            return r ? {
              identity: r.full,
              operationDate: row.operationDate ?? null,
              reinforcement: r.reinforcement,
              stopCode: row.userStopCode ?? null,
              tripStopStatus: row.tripStopStatus ?? null,
            } : null;
          });

        return {
          identity: trip.identity,
          cancelled: trip.cancelled,
          mutationTypes: trip.mutationTypes,
          candidateRowsWithSameOwnerAndLine: candidates,
        };
      });

    const dateFormatCounts = (items: any[], getter: (item: any) => any) => {
      const counts: Record<string, number> = {
        compactYYYYMMDD: 0, dashedYYYYMMDD: 0, otherOrMissing: 0
      };
      for (const item of items) {
        const value = String(getter(item) ?? "").trim();
        if (/^\d{8}$/.test(value)) counts.compactYYYYMMDD++;
        else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) counts.dashedYYYYMMDD++;
        else counts.otherOrMissing++;
      }
      return counts;
    };

    const kv78FlagIsTrue = (value: any): boolean => {
      const normalized = String(value ?? "").trim().toLowerCase();
      return ["1", "true", "yes", "ja", "y"].includes(normalized);
    };

    const kv78ValueCounts = (field: string): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const raw = (row as any)[field];
        const value = raw == null || String(raw).trim() === ""
          ? "(missing)"
          : String(raw).trim();
        counts[value] = (counts[value] ?? 0) + 1;
      }
      return Object.fromEntries(
        Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20)
      );
    };

    const kv78JourneyStatusDiagnostics = {
      rowsChecked: rows.length,
      values: {
        vejoTripStatusType: kv78ValueCounts("vejoTripStatusType"),
        vehicleJourneyType: kv78ValueCounts("vehicleJourneyType"),
        cancelledJourney: kv78ValueCounts("cancelledJourney"),
        showCancelledJourney: kv78ValueCounts("showCancelledJourney"),
        showCancelledTrip: kv78ValueCounts("showCancelledTrip"),
        cancelledCall: kv78ValueCounts("cancelledCall"),
        monitored: kv78ValueCounts("monitored"),
      },
      trueFlagCounts: {
        cancelledJourney: rows.filter((r: any) => kv78FlagIsTrue(r.cancelledJourney)).length,
        showCancelledJourney: rows.filter((r: any) => kv78FlagIsTrue(r.showCancelledJourney)).length,
        showCancelledTrip: rows.filter((r: any) => kv78FlagIsTrue(r.showCancelledTrip)).length,
        cancelledCall: rows.filter((r: any) => kv78FlagIsTrue(r.cancelledCall)).length,
        monitored: rows.filter((r: any) => kv78FlagIsTrue(r.monitored)).length,
      },
      cancellationExamples: rows
        .filter((r: any) =>
          kv78FlagIsTrue(r.cancelledJourney) ||
          kv78FlagIsTrue(r.cancelledCall) ||
          ["CANCEL", "CANCELLED"].includes(String(r.vejoTripStatusType ?? "").trim().toUpperCase())
        )
        .slice(-15)
        .map((r: any) => ({
          identity: [
            r.dataOwnerCode,
            r.operationDate,
            r.linePlanningNumber,
            r.journeyNumber,
            r.fortifyOrderNumber ?? "0",
          ].join("|"),
          vehicleJourneyNumber: r.vehicleJourneyNumber ?? null,
          vejoTripStatusType: r.vejoTripStatusType ?? null,
          cancelledJourney: r.cancelledJourney ?? null,
          showCancelledJourney: r.showCancelledJourney ?? null,
          showCancelledTrip: r.showCancelledTrip ?? null,
          cancelledCall: r.cancelledCall ?? null,
          userStopCode: r.userStopCode ?? null,
          tripStopStatus: r.tripStopStatus ?? null,
        })),
    };

    const cancelledKv78ByTrip = new Map<string, any>();
    for (const row of rows) {
      const p = diagnosticParts(row);
      if (!p) continue;

      const status = String(row.vejoTripStatusType ?? "").trim().toUpperCase();
      const key = p.full;
      if (!cancelledKv78ByTrip.has(key)) {
        cancelledKv78ByTrip.set(key, {
          identity: key,
          dataOwnerCode: p.owner,
          operationDate: p.date,
          linePlanningNumber: p.line,
          journeyNumber: p.journey,
          reinforcementNumber: p.reinforcement,
          rowCount: 0,
          cancelledStatusRows: 0,
          showCancelledTripRows: 0,
          stopCodes: new Set<string>(),
          statuses: new Set<string>(),
        });
      }

      const trip = cancelledKv78ByTrip.get(key);
      trip.rowCount++;
      if (status === "CANCELLED" || status === "CANCEL") {
        trip.cancelledStatusRows++;
      }
      if (kv78FlagIsTrue(row.showCancelledTrip)) {
        trip.showCancelledTripRows++;
      }
      if (row.userStopCode) trip.stopCodes.add(String(row.userStopCode));
      if (status) trip.statuses.add(status);
    }

    const kv78CancelledTrips = [...cancelledKv78ByTrip.values()]
      .filter((trip) => trip.cancelledStatusRows > 0)
      .map((trip) => ({
        identity: trip.identity,
        rowCount: trip.rowCount,
        cancelledStatusRows: trip.cancelledStatusRows,
        showCancelledTripRows: trip.showCancelledTripRows,
        stopCodes: [...trip.stopCodes].slice(0, 20),
        statuses: [...trip.statuses],
      }))
      .sort((a, b) => b.cancelledStatusRows - a.cancelledStatusRows);

    const kv78CancelledTripDiagnostics = {
      sampledRows: rows.length,
      rowsWithCancelledStatus: rows.filter((r: any) =>
        ["CANCEL", "CANCELLED"].includes(
          String(r.vejoTripStatusType ?? "").trim().toUpperCase()
        )
      ).length,
      distinctCancelledTrips: kv78CancelledTrips.length,
      rowsWithShowCancelledTrip: rows.filter((r: any) =>
        kv78FlagIsTrue(r.showCancelledTrip)
      ).length,
      examples: kv78CancelledTrips.slice(0, 25),
      note: "VejoTripStatusType CANCEL/CANCELLED is een ritstatus; CancelledJourney is een ritbrede vlag; CancelledCall betreft een haltepassage. ShowCancelledJourney en ShowCancelledTrip bepalen of een vervallen rit getoond moet worden en bewijzen op zichzelf geen annulering.",
    };

    const tripMatchDiagnostics = {
      kv78JourneyStatusDiagnostics,
      kv78CancelledTripDiagnostics,
      sampledKv78Rows: rows.length,
      storedKv78Rows: kv78.storedKv78RowCount ?? rows.length,
      kv78DateFormats: dateFormatCounts(rows, (item: any) => item.operationDate),
      mutationDateFormats: dateFormatCounts(mutations, (item: any) => item.operationDate),
      matchCounts: diagnosticMatchCounts,
      unmatchedExamples: diagnosticExamples,
      note: "Losse matches zijn alleen diagnostiek; ze bewijzen niet dat twee records dezelfde rit zijn.",
    };
    const ownerLineCounts: Record<string, number> = {};
    for (const row of rows) {
      const key = `${row.dataOwnerCode ?? "?"}|${row.linePlanningNumber ?? "?"}`;
      ownerLineCounts[key] = (ownerLineCounts[key] ?? 0) + 1;
    }
    return json({
      ok: kv78.state !== "error" && bison.state !== "error",
      checkedAt: new Date().toISOString(),
      feeds: [summarizeNdovSnapshot(kv78, "kv78"), summarizeNdovSnapshot(bison, "bison")],
      kv78CaptureSummary: {
        storedStopRows: kv78.storedKv78RowCount ?? rows.length,
        sampledStopRows: rows.length,
        distinctTrips: new Set(rows.map((r: any) => [r.dataOwnerCode, r.operationDate, r.localServiceLevelCode, r.linePlanningNumber, r.journeyNumber, r.fortifyOrderNumber ?? "0"].join("|"))).size,
        rowLimit: 30000,
        ownerLineRowCounts: Object.entries(ownerLineCounts)
          .sort((a, b) => b[1] - a[1]).slice(0, 40)
          .map(([ownerLine, stopRows]) => ({ ownerLine, stopRows })),
      },
      tripStatuses,
      tripMatchDiagnostics,
      tripStatusSummary: {
        mutationTrips: tripStatuses.length,
        exactKv78Matches: tripStatuses.filter((t) => t.matchedKv78StopCount > 0).length,
        cancelledTrips: tripStatuses.filter((t) => t.cancelled === true).length,
        recoveredTrips: tripStatuses.filter((t) => t.cancelled === false).length,
        unmatchedMutationTrips: tripStatuses.filter((t) => t.matchedKv78StopCount === 0).length,
      },
      continuousCollectors: {
        enabled: kv78.continuousEnabled === true && bison.continuousEnabled === true,
        kv78: { enabled: kv78.continuousEnabled === true, nextAlarmAt: kv78.nextAlarmAt ?? null, autoCollector: kv78.autoCollector ?? null },
        bison: { enabled: bison.continuousEnabled === true, nextAlarmAt: bison.nextAlarmAt ?? null, autoCollector: bison.autoCollector ?? null },
      },
      note: "Begrensde, duurzame NDOV-cache: maximaal 30.000 KV78-rijen met 10 minuten bewaartermijn. Dekking is best-effort; ontbrekende of verouderde data blijft onbekend.",
    });
  }
  return json({ ok: false, error: "Onbekend lokaal NDOV-diagnoseendpoint.", available: ["/api/ndov/start?seconds=120&wait=1", "/api/ndov/status"] }, 404);
}


async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return json({ error: "Alleen GET is toegestaan." }, 405, headers);

  const rateLimitResponse = await enforcePublicApiRateLimit(request, env, headers);
  if (rateLimitResponse) return rateLimitResponse;

  if (url.pathname === "/api/health") {
    // Decodeer de echte feeds in plaats van alleen HEAD/HTTP te controleren.
    const entries = Object.entries(OPENOV) as Array<
      [keyof typeof OPENOV, string]
    >;

    const feedEntries: Array<[string, any]> = await Promise.all(
      entries.map(async ([key, feedUrl]): Promise<[string, any]> => {
        const result = await safeOpenovFeed(feedUrl, key);

        return [
          String(key),
          {
            ok: Boolean(result.ok),
            status: result.httpStatus ?? result.status ?? (
              result.ok ? 200 : 502
            ),
            checkedAt: result.checkedAt ?? new Date().toISOString(),
            sourceUrl: result.sourceUrl ?? feedUrl,
            feedTimestamp: result.feedTimestamp ?? null,
            ageSeconds: result.ageSeconds ?? null,
            freshness: result.freshness ?? (
              result.ok ? "stale_or_unknown" : "unavailable"
            ),
            entityCount: result.entityCount ?? (
              Array.isArray(result.entities)
                ? result.entities.length
                : null
            ),
            fetchDurationMs: result.fetchDurationMs ?? null,
            error: result.ok
              ? null
              : result.error ?? "Feed ophalen of decoderen is mislukt."
          }
        ];
      })
    );

    return json({
      service: "OVLive",
      status: "diagnostic",
      checkedAt: new Date().toISOString(),
      notes: [
        "De feeds worden opgehaald en als GTFS-Realtime-protobuf gedecodeerd.",
        "De itemaantallen zijn gedecodeerde items, niet noodzakelijk unieke ritten.",
        "Een beschikbare feed garandeert niet dat iedere rit een realtime-update heeft.",
        "Geen update voor een rit betekent NIET dat die rit op tijd rijdt."
      ],
      feeds: Object.fromEntries(feedEntries)
    }, 200, headers);
  }

  if (url.pathname === "/api/realtime") {
    const kind = url.searchParams.get("kind") ?? "tripUpdates";
    if (!["tripUpdates", "alerts", "trainUpdates", "vehiclePositions"].includes(kind)) {
      return json({ error: "Ongeldig kind. Gebruik tripUpdates, alerts, trainUpdates of vehiclePositions." }, 400, headers);
    }
    const feedUrl = OPENOV[kind as keyof typeof OPENOV];
    try {
      const data = await getOpenovFeed(feedUrl, kind as keyof typeof OPENOV);
      const { entities = [], ...meta } = data as any;

      // Optionele filters: filter de volledige gedecodeerde feed vóór de limiet.
      // Zo kunnen we een specifieke route onderzoeken zonder duizenden
      // niet-relevante realtime-items terug te sturen.
      const routeFilters = (url.searchParams.get("routeId") ?? "")
        .split(",")
        .map((value: string) => normalizeOpenovId(value))
        .filter(Boolean);

      const tripFilters = (url.searchParams.get("tripId") ?? "")
        .split(",")
        .map((value: string) => parseOpenovTripId(value).tripId)
        .filter(Boolean);

      const stopFilters = (url.searchParams.get("stopId") ?? "")
        .split(",")
        .map((value: string) => normalizeOpenovId(value))
        .filter(Boolean);

      const filteredEntities = (entities as any[]).filter((entity: any) => {
        if (
          routeFilters.length > 0 &&
          !routeFilters.includes(normalizeOpenovId(entity.routeId))
        ) return false;

        if (
          tripFilters.length > 0 &&
          !tripFilters.includes(parseOpenovTripId(entity.tripId).tripId)
        ) return false;

        if (stopFilters.length > 0) {
          const stopIds = [
            entity.stopId,
            ...(entity.stopUpdates ?? []).map((stop: any) => stop.stopId),
            ...(entity.informedEntities ?? []).map((item: any) => item.stopId)
          ]
            .map((value: unknown) => normalizeOpenovId(value))
            .filter(Boolean);

          if (!stopFilters.some((stopId: string) => stopIds.includes(stopId))) {
            return false;
          }
        }

        return true;
      });

      const limit = Math.min(
        2000,
        Math.max(1, Number(url.searchParams.get("limit") ?? 500))
      );

      return json({
        ...meta,
        appliedFilters: {
          routeIds: routeFilters,
          tripIds: tripFilters,
          stopIds: stopFilters
        },
        matchingCount: filteredEntities.length,
        entities: filteredEntities.slice(0, limit),
        returnedCount: Math.min(filteredEntities.length, limit)
      }, data.ok ? 200 : 502, headers);
    } catch (error) {
      return json({
        ok: false,
        sourceUrl: feedUrl,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Feed kon niet worden gelezen."
      }, 502, headers);
    }
  }


  if (url.pathname === "/api/geocode") {
    const query = (url.searchParams.get("q") ?? "").trim();

    if (query.length < 2 || query.length > 160) {
      return json(
        { error: "Voer minimaal 2 en maximaal 160 tekens in." },
        400,
        headers
      );
    }

    try {
      const data = await getGeocodeFeatures(query, env);

      return json(data, 200, {
        ...headers,
        "cache-control": "public, max-age=600"
      });
    } catch (error) {
      console.warn(
        "[OVLIVE_GEOCODE]",
        error instanceof Error ? error.message : "Onbekende geocoderfout"
      );

      return json(
        { error: "Plaats zoeken is tijdelijk niet beschikbaar." },
        502,
        headers
      );
    }
  }

  if (url.pathname === "/api/ns/departures") {
    if (request.method !== "GET") {
      return json({ error: "Alleen GET is toegestaan." }, 405, headers);
    }

    const subscriptionKey = String(
      env.NS_API_SUBSCRIPTION_KEY ?? ""
    ).trim();

    if (!subscriptionKey) {
      return json({
        ok: false,
        source: "NS Reisinformatie API",
        error: "NS_API_SUBSCRIPTION_KEY is niet ingesteld in de Worker-configuratie."
      }, 503, headers);
    }

    const station = String(url.searchParams.get("station") ?? "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9]{2,6}$/.test(station)) {
      return json({
        ok: false,
        error: "Geef een geldige NS-stationscode op, bijvoorbeeld GVC of UT."
      }, 400, headers);
    }

    const requestedCount = Number(
      url.searchParams.get("maxJourneys") ?? "8"
    );

    if (
      !Number.isInteger(requestedCount) ||
      requestedCount < 1 ||
      requestedCount > 10
    ) {
      return json({
        ok: false,
        error: "maxJourneys moet tussen 1 en 10 liggen."
      }, 400, headers);
    }

    const upstream = new URL(
      "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/departures"
    );
    upstream.searchParams.set("station", station);
    upstream.searchParams.set("maxJourneys", String(requestedCount));
    upstream.searchParams.set("lang", "nl");

    try {
      const response = await fetch(upstream, {
        method: "GET",
        headers: {
          "accept": "application/json",
          "Ocp-Apim-Subscription-Key": subscriptionKey,
          "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        const status = response.status === 429 ? 429 : 502;
        const message =
          response.status === 401 || response.status === 403
            ? "NS heeft de aanvraag geweigerd. Controleer of de Ns-App-sleutel toegang heeft tot de Reisinformatie API."
            : response.status === 429
              ? "De NS API heeft de aanvraaglimiet bereikt."
              : `De NS API gaf HTTP ${response.status}.`;

        console.warn("[OVLIVE_NS_API]", JSON.stringify({
          status: response.status,
          station
        }));

        return json({
          ok: false,
          source: "NS Reisinformatie API",
          station,
          upstreamStatus: response.status,
          error: message,
          checkedAt: new Date().toISOString()
        }, status, headers);
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        return json({
          ok: false,
          source: "NS Reisinformatie API",
          error: "NS gaf geen geldige JSON terug.",
          checkedAt: new Date().toISOString()
        }, 502, headers);
      }

      const payload = data?.payload ?? data;
      const rows = payload?.departures;

      if (!Array.isArray(rows)) {
        return json({
          ok: false,
          source: "NS Reisinformatie API",
          station,
          error: "Onverwachte NS-response: het veld payload.departures ontbreekt.",
          responseFields: Object.keys(data ?? {}),
          payloadFields: Object.keys(payload ?? {}),
          checkedAt: new Date().toISOString()
        }, 502, headers);
      }

      const departures = rows.slice(0, requestedCount).map((item: any) => {
        const plannedDateTime = item?.plannedDateTime ?? null;
        const actualDateTime = item?.actualDateTime ?? null;
        const plannedMs = typeof plannedDateTime === "string"
          ? Date.parse(plannedDateTime)
          : Number.NaN;
        const actualMs = typeof actualDateTime === "string"
          ? Date.parse(actualDateTime)
          : Number.NaN;

        // We berekenen alleen een afwijking als NS beide absolute tijden geeft.
        const delaySeconds =
          Number.isFinite(plannedMs) && Number.isFinite(actualMs)
            ? Math.round((actualMs - plannedMs) / 1000)
            : null;

        return {
          trainNumber: item?.product?.number
            ?? item?.trainNumber
            ?? null,
          name: item?.name ?? null,
          category: item?.trainCategory
            ?? item?.product?.category
            ?? item?.product?.longCategoryName
            ?? null,
          direction: item?.direction ?? null,
          plannedDateTime,
          actualDateTime,
          delaySeconds,
          cancelled: item?.cancelled === true,
          platformChange: item?.platformChange === true,
          plannedTrack: item?.plannedTrack ?? null,
          actualTrack: item?.actualTrack ?? null,
          journeyDetailUri: item?.journeyDetailRef?.uri ?? null,
          responseFields: Object.keys(item ?? {})
        };
      });

      return json({
        ok: true,
        source: "NS Reisinformatie API",
        station,
        checkedAt: new Date().toISOString(),
        upstreamStatus: response.status,
        count: departures.length,
        departures
      }, 200, headers);
    } catch (error) {
      console.error("[OVLIVE_NS_API]", error instanceof Error
        ? error.message
        : "Onbekende fout");

      return json({
        ok: false,
        source: "NS Reisinformatie API",
        station,
        error: "NS was niet bereikbaar of reageerde niet op tijd.",
        checkedAt: new Date().toISOString()
      }, 502, headers);
    }
  }

  if (url.pathname === "/api/plan") {
    const fromPlace = url.searchParams.get("fromPlace");
    const toPlace = url.searchParams.get("toPlace");
    if (!fromPlace || !toPlace) {
      return json({ error: "Geef fromPlace en toPlace op als latitude,longitude of een Transitous-stop-ID." }, 400, headers);
    }
    if (fromPlace.length > 200 || toPlace.length > 200) {
      return json({ error: "Locatieparameter te lang." }, 400, headers);
    }

    const upstream = new URL(`${TRANSITOUS}/plan`);
    url.searchParams.forEach((value, key) => {
      if (MAX_ROUTE_PARAMS.has(key)) upstream.searchParams.set(key, value);
    });
    upstream.searchParams.set("fromPlace", fromPlace);
    upstream.searchParams.set("toPlace", toPlace);

    if (env.APP_CONTACT && env.APP_CONTACT.includes("replace-with-contact")) {
      return json({ error: "Configureer APP_CONTACT in wrangler.toml voordat je Transitous gebruikt." }, 503, headers);
    }

    try {
      const response = await fetch(upstream, {
        headers: {
          "accept": "application/json",
          "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
        },
        signal: AbortSignal.timeout(25000)
      });
      const body = await response.text();
      const responseHeaders = {
        ...headers,
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "x-upstream": "Transitous MOTIS v6"
      };

      if (!response.ok) {
        return new Response(body, {
          status: response.status,
          headers: responseHeaders
        });
      }

      let planData: any;

      try {
        planData = JSON.parse(body);
      } catch {
        return new Response(body, {
          status: response.status,
          headers: responseHeaders
        });
      }

      try {
        planData = await enrichTransitousPlan(planData);
        await applyNdovCancellationsToPlan(planData, env);
        await enrichNsTrainPlan(planData, env);
      } catch (error) {
        console.error(
          "[OVLIVE_ENRICHMENT_ERROR]",
          error instanceof Error ? error.stack ?? error.message : error
        );

        if (
          planData &&
          typeof planData === "object" &&
          !Array.isArray(planData)
        ) {
          planData.openovRealtimeMeta = {
            status: "enrichment_failed",
            message: "De reis is opgehaald, maar realtime kon niet worden toegevoegd."
          };
        }
      }

      return json(planData, response.status, {
        ...headers,
        "x-upstream": "Transitous MOTIS v6"
      });
    } catch (error) {
      return json({
        error: "De reisplanner is tijdelijk niet bereikbaar.",
        detail: error instanceof Error ? error.message : "Onbekende fout"
      }, 502, headers);
    }
  }

  if (url.pathname === "/api/stoptimes") {
    const stopId = url.searchParams.get("stopId");
    if (!stopId || stopId.length > 200) return json({ error: "Geef een geldige stopId op." }, 400, headers);
    const upstream = new URL(`${TRANSITOUS}/stoptimes`);
    upstream.searchParams.set("stopId", stopId);
    upstream.searchParams.set("n", String(Math.min(50, Math.max(1, Number(url.searchParams.get("n") ?? 20)))));
    try {
      const response = await fetch(upstream, {
        headers: {
          "accept": "application/json",
          "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
        },
        signal: AbortSignal.timeout(15000)
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" }
      });
    } catch (error) {
      return json({ error: "Realtime vertrektijden tijdelijk niet beschikbaar." }, 502, headers);
    }
  }

  return json({ error: "API-route niet gevonden." }, 404, headers);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.NDOV_AUTOCOLLECT !== "true") {
      // Schakel ook reeds actieve Durable Object-alarmen/verbindingen uit.
      // Alleen stoppen met nieuwe alarms inplannen laat bestaande collectors lopen.
      ctx.waitUntil(Promise.all([
        callNdovHub(env, "kv78", "continuous/disable"),
        callNdovHub(env, "bison", "continuous/disable"),
      ]).then((feeds) => {
        const failed = feeds.filter((feed) => feed.ok !== true || feed.enabled !== false);
        if (failed.length) {
          console.error("[NDOV_AUTOCOLLECT] Niet alle collectors konden worden gepauzeerd.", failed);
        } else {
          console.log("[NDOV_AUTOCOLLECT] Automatische KV78- en BISON-collectors zijn gepauzeerd.");
        }
      }).catch((error) => {
        console.error("[NDOV_AUTOCOLLECT] Collectorpauze mislukt.", error);
      }));
      return;
    }

    ctx.waitUntil(Promise.all([
      callNdovHub(env, "kv78", "continuous/enable"),
      callNdovHub(env, "bison", "continuous/enable"),
    ]).then((feeds) => {
      const failed = feeds.filter((feed) => feed.ok !== true || feed.enabled !== true);
      if (failed.length) console.error("[NDOV_AUTOCOLLECT] Niet alle collectors konden worden ingeschakeld.", failed);
    }).catch((error) => {
      console.error("[NDOV_AUTOCOLLECT] Collectorinitialisatie mislukt.", error);
    }));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Beveilig alle OVAPI-experimentele routes vóór specifieke dispatch,
    // inclusief match-plan, zodat geen handler deze controle kan overslaan.
    if (
      url.pathname.startsWith("/api/ovapi-test/") &&
      !isLoopbackHost(url.hostname)
    ) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/api/ovapi-test/match-plan") {
      const matchResponse = await handleTransitousOvapiMatch(request);
      if (matchResponse) return matchResponse;
    }
    if (url.pathname.startsWith("/api/ovapi-test/")) {
      const ovapiTestResponse = await handleOvapiTestApi(request);
      if (ovapiTestResponse) return ovapiTestResponse;
    }
    if (url.pathname.startsWith("/api/ndov/")) {
      const ndovResponse = await handleLocalNdovApi(request, env);
      if (ndovResponse) return ndovResponse;
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
};

export { NdovFeedHub };
