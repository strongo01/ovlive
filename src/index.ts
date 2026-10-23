import {
  findExactVehiclePositionForLeg,
  findRealtimeStopByScheduledEvent,
  summarizeRealtimeEvent,
  findPropagatedRealtimeEvent,
} from "./openov-realtime-prediction.js";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { decodeOpenovVehiclePositions } from "./openov-vehicle-position-fast-decode.js";
import { decodeOpenovTripUpdates } from "./openov-trip-update-fast-decode.js";
import { handleOvapiTestApi } from "./ovapi-test";
import { NdovFeedHub } from "./ndov-stream-hub.js";
import { handleTransitousOvapiMatch } from "./ovapi-transitous-match";

import { applyNdovCancellationsToPlan, prepareNsTrainIdentities } from "./ndov-plan-cancellation.js";
import { enrichNsTrainPlan } from "./ns-train-realtime";
import { fetchNsLiveVehiclePositions } from "./ns-live-vehicle-positions";
import { fetchNsTrainDetails } from "./ns-train-details";
import { fetchNsLiveTrainRoute } from "./ns-live-train-route.js";
import { mergeTransitousAndMapFeatureCollections, transitousMatchesToFeatureCollection } from "./transitous-geocode.js";
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
  DEVICE_API_RATE_LIMITER?: ApiRateLimitBinding;
  DEVICE_PLAN_RATE_LIMITER?: ApiRateLimitBinding;
}

const OPENOV = {
  tripUpdates: "https://gtfs.openov.nl/gtfs-rt/tripUpdates.pb",
  alerts: "https://gtfs.openov.nl/gtfs-rt/alerts.pb",
  trainUpdates: "https://gtfs.openov.nl/gtfs-rt/trainUpdates.pb",
  vehiclePositions: "https://gtfs.openov.nl/gtfs-rt/vehiclePositions.pb"
};

const TRANSITOUS = "https://api.transitous.org/api/v6";

function normalizeLineSearchTripId(value: unknown): string {
  // Transitous/OpenOV composite IDs can start with the service date and trip start time.
  // Those timestamp digits must not be mistaken for a requested line/trip number.
  return String(value ?? "").trim().replace(/^\d{8}_\d{2}:\d{2}(?::\d{2})?_/, "");
}

interface OpenovRouteMetadataEntry {
  routeShortName?: string;
  routeLongName?: string;
  routeType?: string | number;
  agencyId?: string;
  agencyName?: string;
}

let openovLineSearchRouteMetadataPromise: Promise<Record<string, OpenovRouteMetadataEntry>> | null = null;

async function getOpenovLineSearchRouteMetadata(
  env: Env
): Promise<Record<string, OpenovRouteMetadataEntry>> {
  if (!openovLineSearchRouteMetadataPromise) {
    openovLineSearchRouteMetadataPromise = (async () => {
      const response = await env.ASSETS.fetch(new Request(
        "https://ovlive-assets.local/ndov-openov-route-crosswalk/route-metadata.json",
        { method: "GET", headers: { accept: "application/json" } }
      ));
      if (!response.ok) {
        throw new Error("OpenOV route-metadata gaf HTTP " + response.status + " terug.");
      }
      const payload = await response.json() as {
        format?: number;
        routes?: Record<string, OpenovRouteMetadataEntry>;
      };
      if (payload?.format !== 1 || !payload.routes ||
          typeof payload.routes !== "object" || Array.isArray(payload.routes)) {
        throw new Error("OpenOV route-metadata heeft een ongeldig formaat.");
      }
      return payload.routes;
    })().catch((error) => {
      openovLineSearchRouteMetadataPromise = null;
      throw error;
    });
  }
  return openovLineSearchRouteMetadataPromise;
}

function openovRouteMetadataForId(
  routeMetadata: Record<string, OpenovRouteMetadataEntry>,
  routeId: unknown
): OpenovRouteMetadataEntry | null {
  const key = String(routeId ?? "").trim().replace(/^nl-OpenOV_/i, "");
  if (!key) return null;
  return routeMetadata[key] ?? null;
}

function openovRouteMatchesLine(
  routeMetadata: Record<string, OpenovRouteMetadataEntry>,
  routeId: unknown,
  query: unknown
): boolean {
  const wanted = String(query ?? "").trim().toLocaleLowerCase("nl-NL");
  if (!wanted) return false;
  const shortName = String(openovRouteMetadataForId(routeMetadata, routeId)?.routeShortName ?? "")
    .trim().toLocaleLowerCase("nl-NL");
  return shortName !== "" && shortName === wanted;
}

function openovAgencyNameForLine(
  routeMetadata: Record<string, OpenovRouteMetadataEntry>,
  line: unknown,
  operatorCode: unknown
): string {
  const wantedLine = String(line ?? "").trim().toLocaleLowerCase("nl-NL");
  if (!wantedLine) return "";
  const wantedOperator = String(operatorCode ?? "").trim().toLocaleLowerCase("nl-NL");
  const matches = Object.values(routeMetadata).filter((route) =>
    String(route?.routeShortName ?? "").trim().toLocaleLowerCase("nl-NL") === wantedLine
  );
  const operatorMatches = wantedOperator
    ? matches.filter((route) =>
        String(route?.agencyId ?? "").trim().toLocaleLowerCase("nl-NL") === wantedOperator
      )
    : [];
  const named = (operatorMatches.length ? operatorMatches : matches)
    .map((route) => String(route?.agencyName ?? "").trim())
    .filter(Boolean);
  const uniqueNames = [...new Set(named)];
  return uniqueNames.length === 1 ? uniqueNames[0] : "";
}

function normalizeTransitousLineSearchStops(legValue: unknown): Array<Record<string, any>> {
  if (!legValue || typeof legValue !== "object" || Array.isArray(legValue)) return [];
  const leg = legValue as Record<string, any>;
  const entries: Array<{ place: Record<string, any>; kind: "departure" | "intermediate" | "arrival" }> = [];
  const asPlace = (value: unknown): Record<string, any> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
  const from = asPlace(leg.from);
  if (from) entries.push({ place: from, kind: "departure" });
  if (Array.isArray(leg.intermediateStops)) {
    for (const value of leg.intermediateStops) {
      const stop = asPlace(value);
      if (stop) entries.push({ place: stop, kind: "intermediate" });
    }
  }
  const to = asPlace(leg.to);
  if (to) entries.push({ place: to, kind: "arrival" });
  const firstText = (...values: unknown[]): string | null => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  return entries.map(({ place, kind }, index) => {
    const scheduledArrival = firstText(
      place.scheduledArrival, place.scheduledArrivalTime,
      kind === "arrival" ? leg.scheduledEndTime : null
    );
    const scheduledDeparture = firstText(
      place.scheduledDeparture, place.scheduledDepartureTime,
      kind === "departure" ? leg.scheduledStartTime : null
    );
    const arrival = firstText(
      place.arrival, place.arrivalTime,
      kind === "arrival" ? leg.arrivalTime : null,
      scheduledArrival
    );
    const departure = firstText(
      place.departure, place.departureTime,
      kind === "departure" ? (leg.departureTime ?? leg.startTime) : null,
      scheduledDeparture
    );
    const rawId = firstText(place.id, place.stopId, place.stop_id);
    const openovId = rawId?.match(/^nl-OpenOV_(.+)$/i)?.[1] ?? null;
    const stopCode = firstText(
      place.userStopCode, place.UserStopCode, place.stopCode, place.stop_code,
      place.code, place.stop?.code
    ) ?? openovId ?? (/^\d+$/.test(rawId ?? "") ? rawId : null);
    return {
      name: firstText(place.name, place.stopName, place.displayName, place.label) ?? "",
      userStopCode: stopCode,
      timingPointCode: stopCode,
      expectedArrival: arrival,
      targetArrival: scheduledArrival,
      expectedDeparture: departure,
      targetDeparture: scheduledDeparture,
      status: place.cancelled === true ? "CANCELLED" : firstText(place.status) ?? "",
      stopOrder: index + 1,
      isCurrent: false,
      isAtStop: false
    };
  }).filter((stop) => stop.name);
}

function lineSearchDelaySeconds(expectedValue: unknown, targetValue: unknown): number | null {
  const expected = Date.parse(String(expectedValue ?? ""));
  const target = Date.parse(String(targetValue ?? ""));
  if (!Number.isFinite(expected) || !Number.isFinite(target)) return null;
  return Math.round((expected - target) / 1000);
}

function normalizeOvapiJourneyStops(
  rawStops: unknown,
  currentStopCodeValue: unknown
): { stops: Array<Record<string, any>>; numberOfCoaches: number | string | null; blockCode: string | null } {
  const stopsObject = rawStops && typeof rawStops === "object" && !Array.isArray(rawStops)
    ? rawStops as Record<string, any>
    : {};
  const orderedStops: Array<Record<string, any>> = Object.entries(stopsObject)
    .filter(([, stop]) => stop && typeof stop === "object" && !Array.isArray(stop))
    .map(([key, stop]) => ({ key, ...(stop as Record<string, any>) } as Record<string, any>))
    .sort((a, b) =>
      Number(a.UserStopOrderNumber ?? a.StopSequence ?? a.key) -
      Number(b.UserStopOrderNumber ?? b.StopSequence ?? b.key)
    );
  const currentStopCode = String(currentStopCodeValue ?? "").trim().toLocaleLowerCase("nl-NL");
  const currentIndex = currentStopCode
    ? orderedStops.findIndex((stop) => [
        stop.TimingPointCode, stop.UserStopCode, stop.StopId
      ].some((value) => String(value ?? "").trim().toLocaleLowerCase("nl-NL") === currentStopCode))
    : -1;
  const remainingStops = (currentIndex >= 0
    ? orderedStops.slice(currentIndex)
    : orderedStops.filter((stop) => !["PASSED", "CANCEL", "CANCELLED"].includes(
        String(stop.TripStopStatus ?? "").trim().toUpperCase()
      ))).filter((stop) => !["CANCEL", "CANCELLED"].includes(
        String(stop.TripStopStatus ?? "").trim().toUpperCase()
      ));
  const stops = remainingStops.map((stop, index) => ({
    name: String(stop.TimingPointName ?? stop.StopName ?? stop.Name ?? "").trim(),
    userStopCode: String(stop.UserStopCode ?? stop.TimingPointCode ?? stop.StopId ?? "").trim(),
    timingPointCode: String(stop.TimingPointCode ?? "").trim(),
    expectedArrival: String(stop.ExpectedArrivalTime ?? "").trim() || null,
    targetArrival: String(stop.TargetArrivalTime ?? "").trim() || null,
    expectedDeparture: String(stop.ExpectedDepartureTime ?? "").trim() || null,
    targetDeparture: String(stop.TargetDepartureTime ?? "").trim() || null,
    status: String(stop.TripStopStatus ?? "").trim(),
    stopOrder: Number(stop.UserStopOrderNumber ?? stop.StopSequence ?? index + 1),
    isCurrent: currentIndex >= 0 && index === 0,
    isAtStop: currentIndex >= 0 && index === 0 &&
      ["ARRIVED", "ONSTOP", "ATSTOP"].includes(String(stop.TripStopStatus ?? "").trim().toUpperCase())
  })).filter((stop) => stop.name);
  const coachValue = remainingStops.find((stop) => stop.NumberOfCoaches != null)?.NumberOfCoaches ??
    orderedStops.find((stop) => stop.NumberOfCoaches != null)?.NumberOfCoaches ?? null;
  const coaches = coachValue == null || String(coachValue).trim() === "" ? null :
    Number.isFinite(Number(coachValue)) ? Number(coachValue) : String(coachValue).trim();
  const blockValue = remainingStops.find((stop) => stop.BlockCode != null)?.BlockCode ??
    orderedStops.find((stop) => stop.BlockCode != null)?.BlockCode ?? null;
  const blockCode = blockValue == null || String(blockValue).trim() === "" ? null : String(blockValue).trim();
  return { stops, numberOfCoaches: coaches, blockCode };
}

function lineSearchTripIdMatches(value: unknown, query: unknown): boolean {
  const wanted = String(query ?? "").trim().toLocaleLowerCase("nl-NL");
  if (!wanted) return false;
  const normalized = normalizeLineSearchTripId(value).toLocaleLowerCase("nl-NL");
  if (normalized === wanted) return true;
  const openovSuffix = normalized.match(/^nl-openov_(.+)$/i)?.[1];
  // A GTFS trip ID is opaque: only match its complete suffix, never an arbitrary
  // substring that happens to contain digits from an unrelated trip identity.
  return Boolean(openovSuffix && openovSuffix === wanted);
}

function transitousTripIdForVehiclePosition(
  tripIdValue: unknown,
  startDateValue: unknown,
  startTimeValue: unknown
): string {
  const raw = String(tripIdValue ?? "").trim();
  if (!raw) return "";
  if (/^\d{8}_\d{2}:\d{2}(?::\d{2})?_nl-OpenOV_.+$/i.test(raw)) return raw;

  const date = String(startDateValue ?? "").replace(/\D/g, "").slice(0, 8);
  const time = String(startTimeValue ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const idSuffix = raw.match(/(?:^|_)nl-OpenOV_(.+)$/i)?.[1] ??
    (/^\d+$/.test(raw) ? raw : "");
  if (!/^\d{8}$/.test(date) || !time || !idSuffix) return raw;

  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  const seconds = Number(time[3] ?? "0");
  if (hours > 99 || minutes > 59 || seconds > 59) return raw;
  const clock = String(hours).padStart(2, "0") + ":" + time[2] +
    (seconds > 0 ? ":" + String(seconds).padStart(2, "0") : "");
  return date + "_" + clock + "_nl-OpenOV_" + idSuffix;
}

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


// Native Transitous stop search. The result IDs can be sent directly to /api/v6/plan;
// coordinate geocoders remain available below as address/place fallbacks.
const TRANSITOUS_GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000;
const TRANSITOUS_GEOCODE_MAX_CACHE_ENTRIES = 200;
const transitousGeocodeCache = new Map<string, { expiresAtMs: number; data: any }>();
const transitousGeocodeInflight = new Map<string, Promise<any>>();

async function getTransitousStopFeatures(query: string, env: Env): Promise<any> {
  const cacheKey = query.trim().toLocaleLowerCase("nl-NL");
  const now = Date.now();
  const cached = transitousGeocodeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.data;
  if (cached) transitousGeocodeCache.delete(cacheKey);

  const inflight = transitousGeocodeInflight.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    const upstream = new URL("https://api.transitous.org/api/v1/geocode");
    upstream.searchParams.set("text", query);
    upstream.searchParams.set("language", "nl");
    upstream.searchParams.set("type", "STOP");
    upstream.searchParams.set("mode", "TRANSIT");
    upstream.searchParams.set("numResults", "8");

    const response = await fetch(upstream, {
      headers: {
        "accept": "application/json",
        "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
      },
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 600, cacheEverything: true }
    });

    if (!response.ok) {
      throw new Error(`Transitous geocoder gaf HTTP ${response.status}.`);
    }

    const matches = await response.json();
    if (!Array.isArray(matches)) {
      throw new Error("Transitous geocoder gaf geen geldige lijst met haltes.");
    }

    const data = transitousMatchesToFeatureCollection(matches);
    if (transitousGeocodeCache.size >= TRANSITOUS_GEOCODE_MAX_CACHE_ENTRIES) {
      const oldestKey = transitousGeocodeCache.keys().next().value;
      if (oldestKey) transitousGeocodeCache.delete(oldestKey);
    }
    transitousGeocodeCache.set(cacheKey, {
      expiresAtMs: Date.now() + TRANSITOUS_GEOCODE_CACHE_TTL_MS,
      data
    });
    return data;
  })();

  transitousGeocodeInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (transitousGeocodeInflight.get(cacheKey) === task) {
      transitousGeocodeInflight.delete(cacheKey);
    }
  }
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_ROUTE_PARAMS = new Set([
  "fromPlace", "toPlace", "time", "arriveBy", "realtimeMode", "transitModes",
  "maxTransfers", "maxTravelTime", "timetableView", "numItineraries",
  "maxItineraries", "searchWindow", "pageCursor", "preTransitModes", "postTransitModes",
  "maxPreTransitTime", "maxPostTransitTime", "pedestrianSpeed",
  "minTransferTime", "additionalTransferTime", "transferTimeFactor",
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
    scheduleRelationship: enumName(rt.TripUpdate?.StopTimeUpdate?.ScheduleRelationship, s.scheduleRelationship)
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

function normalizeVehiclePositions(feed: any): any[] {
  return (feed.entity ?? []).map((entity: any) => ({
    entityId: entity.id,
    vehicleId: entity.vehicle?.vehicle?.id,
    tripId: entity.vehicle?.trip?.tripId,
    routeId: entity.vehicle?.trip?.routeId,
    startDate: entity.vehicle?.trip?.startDate,
    startTime: entity.vehicle?.trip?.startTime,
    directionId: entity.vehicle?.trip?.directionId,
    stopId: entity.vehicle?.stopId,
    latitude: entity.vehicle?.position?.latitude,
    longitude: entity.vehicle?.position?.longitude,
    timestamp: toNumber(entity.vehicle?.timestamp)
  })).filter((entity: any) => entity.vehicleId || entity.tripId || entity.latitude != null);
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

type OpenovFeedFilters = {
  tripIds?: string[];
  routeIds?: string[];
  routeDateKeys?: string[];
};

function openovFeedCacheKey(
  url: string,
  kind: OpenovFeedKind,
  filters?: OpenovFeedFilters
): string {
  if (kind === "vehiclePositions" &&
      (filters?.tripIds?.length || filters?.routeIds?.length)) {
    const tripIds = [...new Set(filters.tripIds ?? [])].sort();
    const routeIds = [...new Set(filters.routeIds ?? [])].sort();
    return url + "#vehicle-position-filter:" + JSON.stringify({ tripIds, routeIds });
  }

  if ((kind === "tripUpdates" || kind === "trainUpdates") &&
      (filters?.tripIds?.length || filters?.routeIds?.length || filters?.routeDateKeys?.length)) {
    const tripIds = [...new Set(filters.tripIds ?? [])].sort();
    const routeIds = [...new Set(filters.routeIds ?? [])].sort();
    const routeDateKeys = [...new Set(filters.routeDateKeys ?? [])].sort();
    return url + "#trip-update-filter:" + JSON.stringify({ tripIds, routeIds, routeDateKeys });
  }

  return url;
}

// Full trip/train feeds contain thousands of records and decoding them on
// every 10-second UI poll can exceed the Workers Free CPU budget. Their source
// timestamps already lag by tens of seconds, so reusing the decoded feed for
// 30 seconds is safer than repeatedly downloading and decoding the same data.
const OPENOV_FEED_CACHE_TTL_MS = 30_000;
// Slightly longer than the map's 10-second poll so a repeated identical feed
// is not decoded again on the very next tick. Per-vehicle timestamps still
// decide whether a point may be displayed as live-confirmed.
const OPENOV_VEHICLE_POSITION_CACHE_TTL_MS = 12_000;
// Disruption alerts change less frequently than live trip updates.
const OPENOV_ALERTS_CACHE_TTL_MS = 30_000;
// Een lopende bron mag niet de hele 10-seconden-plannerpoll ophouden.
// De daadwerkelijke fetch heeft daarnaast zijn eigen 15-seconden abort-timeout.
const OPENOV_FEED_WAIT_TIMEOUT_MS = 10_000;
const OPENOV_RATE_LIMIT_COOLDOWN_MS = 30_000;

const openovFeedCache = new Map<string, OpenovFeedCacheEntry>();
const openovFeedInflight = new Map<string, Promise<any>>();
const openovFeedInflightStartedAt = new Map<string, number>();
const OPENOV_FEED_INFLIGHT_MAX_AGE_MS = 18_000;
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
  kind: OpenovFeedKind,
  filters?: OpenovFeedFilters
): Promise<any> {
  const now = Date.now();
  const cacheKey = openovFeedCacheKey(url, kind, filters);
  const cached = openovFeedCache.get(cacheKey);

  // 1. Hergebruik een recent resultaat. Alerts do not need a full refresh
  // every 10 seconds; trip and vehicle feeds keep their shorter live cache.
  const cacheTtlMs = kind === "alerts"
    ? OPENOV_ALERTS_CACHE_TTL_MS
    : kind === "vehiclePositions"
      ? OPENOV_VEHICLE_POSITION_CACHE_TTL_MS
      : OPENOV_FEED_CACHE_TTL_MS;
  if (cached && now - cached.fetchedAtMs < cacheTtlMs) {
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

  // 2. Deel een download als meerdere aanvragen tegelijk dezelfde volledige
  // feed óf exact dezelfde getargete route/ritset nodig hebben. Filters moeten
  // onderdeel zijn van de key; een full-feed promise mag niet een gefilterde
  // aanvraag overschrijven (of andersom).
  const inflight = openovFeedInflight.get(cacheKey);
  if (inflight) {
    const inflightAgeMs = now - (openovFeedInflightStartedAt.get(cacheKey) ?? 0);
    if (inflightAgeMs <= OPENOV_FEED_INFLIGHT_MAX_AGE_MS) {
      console.log("[OVLIVE_FEED_CACHE]", JSON.stringify({
        kind,
        mode: "single_flight_join",
        inflightAgeMs
      }));
      return inflight;
    }

    // A Worker CPU-limit termination can leave the isolate-local single-flight
    // promise without a settlement. Never let that stale promise poison every
    // refresh for the rest of the isolate lifetime.
    console.warn("[OVLIVE_FEED_CACHE]", JSON.stringify({
      kind,
      mode: "stale_single_flight_evicted",
      inflightAgeMs
    }));
    openovFeedInflight.delete(cacheKey);
    openovFeedInflightStartedAt.delete(cacheKey);
  }

  // 3. Probeer tijdens de cooldown de bron niet opnieuw te belasten.
  const rateLimitUntil = openovRateLimitedUntil.get(url) ?? 0;
  if (rateLimitUntil > now) {
    const retryAfterSeconds = Math.ceil((rateLimitUntil - now) / 1000);

    const fallbackCache = cached ?? (kind === "vehiclePositions" && cacheKey !== url ? openovFeedCache.get(url) : undefined);
    if (fallbackCache) {
      console.warn("[OVLIVE_FEED_CACHE]", JSON.stringify({
        kind,
        mode: "rate_limit_cached_fallback",
        filteredCacheAvailable: Boolean(cached),
        retryAfterSeconds
      }));

      return cachedOpenovFeedView(
        fallbackCache,
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
      result = await fetchOpenovFeedUncached(url, kind, filters);
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

      openovFeedCache.set(cacheKey, entry);
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

    const lastGood = openovFeedCache.get(cacheKey) ??
      (kind === "vehiclePositions" && cacheKey !== url ? openovFeedCache.get(url) : undefined);

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

  openovFeedInflight.set(cacheKey, task);
  openovFeedInflightStartedAt.set(cacheKey, Date.now());

  try {
    return await task;
  } finally {
    if (openovFeedInflight.get(cacheKey) === task) {
      openovFeedInflight.delete(cacheKey);
      openovFeedInflightStartedAt.delete(cacheKey);
    }
  }
}


async function fetchOpenovFeedUncached(
  url: string,
  kind: "tripUpdates" | "alerts" | "trainUpdates" | "vehiclePositions",
  filters?: OpenovFeedFilters
) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      "user-agent": "OVLive/0.1.0 (open-source Dutch transit realtime client)",
      "accept-encoding": "gzip"
    },
    signal: AbortSignal.timeout(15000),
    cf: { cacheTtl: 5, cacheEverything: true }
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

  let feedTimestamp: number | undefined;
  let sourceEntityCount: number | undefined;
  let entities: any[];
  let decoder = "gtfs-realtime-bindings";
  console.log("[OVLIVE_OPENOV_RESPONSE]", JSON.stringify({
    kind,
    httpStatus: response.status,
    contentLengthBytes: Number(response.headers.get("content-length") ?? 0)
  }));
  const decodeStartedAt = performance.now();
  console.log("[OVLIVE_OPENOV_DECODE_START]", JSON.stringify({
    kind,
    byteCount: bytes.byteLength,
    targeted: kind === "vehiclePositions"
      ? Boolean(filters?.tripIds?.length || filters?.routeIds?.length)
      : Boolean(filters?.tripIds?.length || filters?.routeIds?.length || filters?.routeDateKeys?.length)
  }));
  const normalizedVehicleFilters = kind === "vehiclePositions" &&
    (filters?.tripIds?.length || filters?.routeIds?.length)
    ? {
        tripIds: new Set((filters.tripIds ?? []).map(normalizeOpenovId)),
        routeIds: new Set((filters.routeIds ?? []).map(normalizeOpenovId)),
      }
    : undefined;

  const normalizedTripUpdateFilters = (kind === "tripUpdates" || kind === "trainUpdates") &&
    (filters?.tripIds?.length || filters?.routeIds?.length || filters?.routeDateKeys?.length)
    ? {
        tripIds: new Set((filters.tripIds ?? []).map(normalizeOpenovId)),
        routeIds: new Set((filters.routeIds ?? []).map(normalizeOpenovId)),
        routeDateKeys: new Set((filters.routeDateKeys ?? []).map((key) => {
          const separator = key.lastIndexOf("|");
          if (separator < 0) return key;
          const route = normalizeOpenovId(key.slice(0, separator));
          const date = key.slice(separator + 1).replace(/\D/g, "").slice(0, 8);
          return route + "|" + date;
        }))
      }
    : undefined;

  if (kind === "vehiclePositions") {
    try {
      // Decode only the protobuf nested position/vehicle fields for the exact
      // requested trip+route set; unrelated entity position objects are skipped.
      const decoded = decodeOpenovVehiclePositions(bytes, normalizedVehicleFilters);
      feedTimestamp = decoded.feedTimestamp;
      sourceEntityCount = decoded.sourceEntityCount;
      entities = decoded.entities;
      decoder = normalizedVehicleFilters ? "selective-protobuf-targeted" : "selective-protobuf";
    } catch (error) {
      // Keep the existing generated decoder as a compatibility fallback if an
      // upstream schema/encoding changes. The fallback is logged so it cannot
      // silently hide a regression in the selective decoder.
      console.warn("[OVLIVE_VEHICLE_POSITION_FAST_DECODE_FALLBACK]", JSON.stringify({
        byteCount: bytes.byteLength,
        error: error instanceof Error ? error.message : String(error)
      }));
      const feed = (GtfsRealtimeBindings as any).transit_realtime.FeedMessage.decode(bytes);
      feedTimestamp = toNumber(feed.header?.timestamp);
      const allEntities = normalizeVehiclePositions(feed);
      sourceEntityCount = allEntities.length;
      entities = normalizedVehicleFilters
        ? allEntities.filter((entity: any) =>
            (!normalizedVehicleFilters.tripIds.size ||
              normalizedVehicleFilters.tripIds.has(normalizeOpenovId(parseOpenovTripId(entity.tripId).tripId))) &&
            (!normalizedVehicleFilters.routeIds.size ||
              normalizedVehicleFilters.routeIds.has(normalizeOpenovId(entity.routeId)))
          )
        : allEntities;
      decoder = "gtfs-realtime-bindings-fallback";
    }
  } else if (kind === "tripUpdates" || kind === "trainUpdates") {
    if (normalizedTripUpdateFilters) {
      try {
        // The planner only needs matching trip IDs and same-route/service-date
        // candidates. Skip normalizing thousands of unrelated stop updates.
        const decoded = decodeOpenovTripUpdates(bytes, normalizedTripUpdateFilters);
        feedTimestamp = decoded.feedTimestamp;
        sourceEntityCount = decoded.sourceEntityCount;
        entities = decoded.entities;
        decoder = "selective-protobuf-targeted";
      } catch (error) {
        console.error("[OVLIVE_TRIP_UPDATE_FAST_DECODE_ERROR]", JSON.stringify({
          kind,
          byteCount: bytes.byteLength,
          error: error instanceof Error ? error.message : String(error)
        }));
        // Do not fall back to full-feed object decoding in a production planner
        // request: that is the CPU-heavy path this targeted decoder replaces.
        return {
          ok: false,
          status: 502,
          source: "OpenOV / OVapi GTFS-Realtime",
          sourceUrl: url,
          checkedAt: new Date().toISOString(),
          freshness: "unavailable",
          ageSeconds: null,
          entityCount: 0,
          entities: [],
          error: "De gerichte OpenOV-ritdecoder kon deze feed niet verwerken."
        };
      }
    } else {
      const feed = (GtfsRealtimeBindings as any).transit_realtime.FeedMessage.decode(bytes);
      feedTimestamp = toNumber(feed.header?.timestamp);
      entities = normalizeTripUpdates(feed);
    }
  } else {
    const feed = (GtfsRealtimeBindings as any).transit_realtime.FeedMessage.decode(bytes);
    feedTimestamp = toNumber(feed.header?.timestamp);
    entities = normalizeAlerts(feed);
  }

  if (kind === "vehiclePositions") {
    console.log("[OVLIVE_VEHICLE_POSITION_DECODE]", JSON.stringify({
      decoder,
      byteCount: bytes.byteLength,
      sourceEntityCount: sourceEntityCount ?? entities.length,
      decodedEntityCount: entities.length,
      targeted: Boolean(normalizedVehicleFilters),
      decodeDurationMs: Number((performance.now() - decodeStartedAt).toFixed(2))
    }));
  } else if ((kind === "tripUpdates" || kind === "trainUpdates") && normalizedTripUpdateFilters) {
    console.log("[OVLIVE_TRIP_UPDATE_DECODE]", JSON.stringify({
      kind,
      decoder,
      byteCount: bytes.byteLength,
      sourceEntityCount: sourceEntityCount ?? entities.length,
      decodedEntityCount: entities.length,
      targeted: true,
      decodeDurationMs: Number((performance.now() - decodeStartedAt).toFixed(2))
    }));
  }

  const ageSeconds = feedTimestamp == null ? undefined : Math.max(0, Math.round(Date.now() / 1000 - feedTimestamp));
  const isStale = ageSeconds == null || ageSeconds > 180;

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
    entityCount: normalizedTripUpdateFilters
      ? entities.length
      : sourceEntityCount ?? entities.length,
    ...(sourceEntityCount != null ? { sourceEntityCount } : {}),
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
  kind: "tripUpdates" | "alerts" | "trainUpdates" | "vehiclePositions",
  filters?: OpenovFeedFilters
): Promise<any> {
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const feedPromise = getOpenovFeed(url, kind, filters);
  const timeoutPromise = new Promise<any>((resolve) => {
    timeoutHandle = setTimeout(() => {
      const cacheKey = openovFeedCacheKey(url, kind, filters);
      const cached = openovFeedCache.get(cacheKey) ??
        (kind === "vehiclePositions" && cacheKey !== url ? openovFeedCache.get(url) : undefined);
      console.warn("[OVLIVE_OPENOV_FEED_WAIT_TIMEOUT]", JSON.stringify({
        kind,
        timeoutMs: OPENOV_FEED_WAIT_TIMEOUT_MS,
        waitedMs: Date.now() - startedAt,
        cachedFallback: Boolean(cached)
      }));

      if (cached) {
        resolve(cachedOpenovFeedView(
          cached,
          true,
          "OpenOV reageerde niet op tijd; eerder opgehaalde gegevens worden opnieuw gecontroleerd op actualiteit."
        ));
        return;
      }

      resolve({
        ok: false,
        status: 504,
        sourceUrl: url,
        checkedAt: new Date().toISOString(),
        freshness: "unavailable",
        ageSeconds: null,
        entities: [],
        error: "OpenOV-feed reageerde niet binnen de ingestelde wachttijd."
      });
    }, OPENOV_FEED_WAIT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([feedPromise, timeoutPromise]);
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
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
type OpenovRealtimeMatcherIndexes = {
  byTripId: Map<string, any[]>;
  byRouteDate: Map<string, any[]>;
};

function addOpenovIndexedRecord(index: Map<string, any[]>, key: string, record: any): void {
  if (!key) return;
  const existing = index.get(key);
  if (existing) existing.push(record);
  else index.set(key, [record]);
}

function buildOpenovRealtimeMatcherIndexes(records: any[]): OpenovRealtimeMatcherIndexes {
  const byTripId = new Map<string, any[]>();
  const byRouteDate = new Map<string, any[]>();

  // One pass over the large GTFS-Realtime feed replaces repeated full-feed
  // scans for every itinerary leg.
  for (const record of records) {
    const tripId = parseOpenovTripId(record?.tripId).tripId;
    if (tripId) addOpenovIndexedRecord(byTripId, tripId, record);

    const routeId = normalizeOpenovId(record?.routeId);
    const serviceDate = String(record?.startDate ?? "");
    if (routeId && serviceDate) {
      addOpenovIndexedRecord(byRouteDate, `${routeId}|${serviceDate}`, record);
    }
  }

  return { byTripId, byRouteDate };
}
type OpenovRealtimeFeedIndexCacheEntry = {
  tripEntities: any[] | null;
  trainEntities: any[] | null;
  records: any[];
  indexes: OpenovRealtimeMatcherIndexes;
};

let openovRealtimeFeedIndexCache: OpenovRealtimeFeedIndexCacheEntry | null = null;

function getOpenovRealtimeFeedIndexCache(tripFeed: any, trainFeed: any): {
  records: any[];
  indexes: OpenovRealtimeMatcherIndexes;
} {
  const tripEntities = tripFeed?.ok === true && tripFeed?.freshness === "fresh"
    ? tripFeed.entities ?? []
    : null;
  const trainEntities = trainFeed?.ok === true && trainFeed?.freshness === "fresh"
    ? trainFeed.entities ?? []
    : null;

  // Feed-cache hits preserve the decoded entities array identity. Reuse the
  // 7k-record deduplication/index work across consecutive 10-second polls.
  if (
    openovRealtimeFeedIndexCache &&
    openovRealtimeFeedIndexCache.tripEntities === tripEntities &&
    openovRealtimeFeedIndexCache.trainEntities === trainEntities
  ) {
    return {
      records: openovRealtimeFeedIndexCache.records,
      indexes: openovRealtimeFeedIndexCache.indexes
    };
  }

  const byIdentity = new Map<string, any>();
  for (const feed of [tripFeed, trainFeed]) {
    if (feed?.ok !== true || feed?.freshness !== "fresh") continue;

    const headerMs = typeof feed.feedTimestamp === "string"
      ? Date.parse(feed.feedTimestamp)
      : Number.NaN;
    const feedTimestampSeconds = Number.isFinite(headerMs) && headerMs > 0
      ? headerMs / 1000
      : undefined;

    for (const record of feed.entities ?? []) {
      if (!record.tripId) continue;
      const enrichedRecord = { ...record, feedTimestampSeconds };
      const identity = parseOpenovTripId(record.tripId);
      const key = [
        normalizeOpenovId(record.routeId),
        identity.tripId,
        record.startDate ?? "",
        normalizeClock(record.startTime) ?? ""
      ].join("|");

      const existing = byIdentity.get(key);
      const newHasTimestamp =
        typeof enrichedRecord.timestamp === "number" &&
        Number.isFinite(enrichedRecord.timestamp) &&
        enrichedRecord.timestamp > 0;
      const oldHasTimestamp = existing
        ? typeof existing.timestamp === "number" &&
          Number.isFinite(existing.timestamp) &&
          existing.timestamp > 0
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
      if (shouldReplace) byIdentity.set(key, enrichedRecord);
    }
  }

  const records = [...byIdentity.values()];
  const indexes = buildOpenovRealtimeMatcherIndexes(records);
  openovRealtimeFeedIndexCache = { tripEntities, trainEntities, records, indexes };
  return { records, indexes };
}


function normalizeVehiclePositionLookupPart(value: any): string {
  // Keep parity with findExactVehiclePositionForLeg's ID normalization.
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").trim();
}

function vehiclePositionLookupKey(tripId: any, routeId: any): string {
  const normalizedTrip = normalizeVehiclePositionLookupPart(tripId);
  const normalizedRoute = normalizeVehiclePositionLookupPart(routeId);
  return normalizedTrip && normalizedRoute
    ? `${normalizedTrip}|${normalizedRoute}`
    : "";
}

function buildVehiclePositionIndex(positions: any[]): Map<string, any[]> {
  const index = new Map<string, any[]>();
  for (const position of positions) {
    const key = vehiclePositionLookupKey(position?.tripId, position?.routeId);
    if (key) addOpenovIndexedRecord(index, key, position);
  }
  return index;
}

function vehiclePositionCandidatesForLeg(
  leg: any,
  index: Map<string, any[]>
): any[] {
  const tripMatch = String(leg?.tripId ?? "").match(
    /^(\d{8})_(\d{2}:\d{2}(?::\d{2})?)_nl-OpenOV_(.+)$/i
  );
  if (!tripMatch) return [];
  const key = vehiclePositionLookupKey(tripMatch[3], leg?.routeId ?? leg?.route?.id);
  return key ? (index.get(key) ?? []) : [];
}

function matchOpenovRealtime(leg: any, indexes: OpenovRealtimeMatcherIndexes) {
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
  const exactCandidates = identity.tripId ? (indexes.byTripId.get(identity.tripId) ?? []) : [];
  const exact = exactCandidates.filter((record: any) => {
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

  const routeDateRecords = indexes.byRouteDate.get(`${routeId}|${identity.startDate}`) ?? [];
  const candidates = routeDateRecords.filter((record: any) => {
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
    ? routeDateRecords.filter((record: any) => {
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

type OpenovLegFeedFamily = "train" | "trip" | "unknown";

const OPENOV_TRAIN_LEG_MODES = new Set([
  "RAIL",
  "REGIONAL_RAIL",
  "REGIONAL_FAST_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "SUBURBAN",
  "HIGHSPEED_RAIL",
  "HIGH_SPEED_RAIL"
]);
const OPENOV_TRIP_LEG_MODES = new Set([
  "BUS",
  "COACH",
  "TRAM",
  "METRO",
  "SUBWAY",
  "FERRY"
]);

function openovRealtimeLegFeedFamily(leg: any): OpenovLegFeedFamily {
  for (const rawMode of [
    leg?.mode,
    leg?.transportMode,
    leg?.route?.mode,
    leg?.trip?.mode
  ]) {
    const mode = String(rawMode ?? "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    if (!mode) continue;
    if (OPENOV_TRAIN_LEG_MODES.has(mode)) return "train";
    if (OPENOV_TRIP_LEG_MODES.has(mode)) return "trip";
  }

  // Unknown mode metadata must fail open: keep the previous broad feed set
  // rather than risk silently missing an official update for this journey.
  return "unknown";
}

function skippedOpenovFeedResult(): any {
  return {
    ok: false,
    status: "not_requested",
    httpStatus: null,
    freshness: "not_requested",
    ageSeconds: null,
    servedFromCache: false,
    cacheAgeSeconds: null,
    entityCount: 0,
    entities: [],
    error: null
  };
}

function buildOpenovTripUpdateFilters(openovLegs: any[]): OpenovFeedFilters | undefined {
  const tripIds = new Set<string>();
  const routeIds = new Set<string>();
  const routeDateKeys = new Set<string>();

  for (const leg of openovLegs) {
    const routeId = normalizeOpenovId(leg?.routeId ?? leg?.route?.id ?? "");
    const rawTripId = String(leg?.tripId ?? "").trim();
    const identity = rawTripId ? parseOpenovTripId(rawTripId) : { tripId: "", startDate: undefined };

    if (identity.tripId) tripIds.add(normalizeOpenovId(identity.tripId));
    const startDate = String(identity.startDate ?? "").replace(/\D/g, "").slice(0, 8);
    if (routeId && startDate) routeDateKeys.add(routeId + "|" + startDate);
    else if (routeId && !identity.tripId) routeIds.add(routeId);
  }

  if (tripIds.size === 0 && routeIds.size === 0 && routeDateKeys.size === 0) {
    return undefined;
  }
  return {
    tripIds: [...tripIds].sort(),
    routeIds: [...routeIds].sort(),
    routeDateKeys: [...routeDateKeys].sort()
  };
}

async function enrichTransitousPlan(
  plan: any,
  options: { includeVehiclePositions?: boolean } = {}
): Promise<any> {
  const includeVehiclePositions = options.includeVehiclePositions !== false;
  const legs = collectPlanLegs(plan);

  const openovLegs = legs.filter((leg: any) =>
    /^nl-OpenOV_/i.test(
      String(leg?.routeId ?? leg?.route?.id ?? "")
    )
  );

  if (openovLegs.length === 0) return plan;

  // Haal alleen de ritfeeds op die passen bij de OpenOV-modi in de
  // gevonden reis. Trein-only routes hoeven geen grote bus/tram-ritfeed en
  // voertuigposities te decoderen; de kaart vraagt posities apart op.
  // Bij onbekende modusmetadata behouden we de brede, veilige fallback.
  const feedFamilies = new Set(openovLegs.map(openovRealtimeLegFeedFamily));
  const needsTripUpdates =
    feedFamilies.has("trip") || feedFamilies.has("unknown");
  const needsTrainUpdates =
    feedFamilies.has("train") || feedFamilies.has("unknown");
  const tripUpdateFilters = buildOpenovTripUpdateFilters(
    openovLegs.filter((leg: any) => {
      const family = openovRealtimeLegFeedFamily(leg);
      return family === "trip" || family === "unknown";
    })
  );
  const trainUpdateFilters = buildOpenovTripUpdateFilters(
    openovLegs.filter((leg: any) => {
      const family = openovRealtimeLegFeedFamily(leg);
      return family === "train" || family === "unknown";
    })
  );
  const [tripFeed, trainFeed, alertFeed, vehicleFeed] = await Promise.all([
    needsTripUpdates
      ? safeOpenovFeed(OPENOV.tripUpdates, "tripUpdates", tripUpdateFilters)
      : Promise.resolve(skippedOpenovFeedResult()),
    needsTrainUpdates
      ? safeOpenovFeed(OPENOV.trainUpdates, "trainUpdates", trainUpdateFilters)
      : Promise.resolve(skippedOpenovFeedResult()),
    safeOpenovFeed(OPENOV.alerts, "alerts"),
    needsTripUpdates && includeVehiclePositions
      ? safeOpenovFeed(OPENOV.vehiclePositions, "vehiclePositions")
      : Promise.resolve(skippedOpenovFeedResult())
  ]);

  // The normalized feed and its trip matcher index are memoized until source data changes.

  const usableFeeds = [
    tripFeed,
    trainFeed
  ].filter((feed: any) =>
    feed.ok === true && feed.freshness === "fresh"
  );

  // Reuse deduplication and matcher indexes until a source feed actually changes.
  const { indexes: realtimeMatcherIndexes } =
    getOpenovRealtimeFeedIndexCache(tripFeed, trainFeed);
  // Gebruik alleen posities uit een verse feedheader. De helper controleert
  // daarnaast de individuele tijdstempel van iedere voertuigpositie.
  const vehiclePositions =
    includeVehiclePositions &&
    vehicleFeed.ok === true &&
    vehicleFeed.freshness === "fresh"
      ? (vehicleFeed.entities ?? [])
      : [];
  const vehiclePositionsByTripRoute = buildVehiclePositionIndex(vehiclePositions);
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

    const result = matchOpenovRealtime(leg, realtimeMatcherIndexes);
    const vehicleObservation = findExactVehiclePositionForLeg(
      leg,
      vehiclePositionCandidatesForLeg(leg, vehiclePositionsByTripRoute)
    );


    if (!result.record && vehicleObservation) {
      // We hebben bewijs dat het voertuig van exact deze rit recent is
      // waargenomen, ook al is er geen bruikbare halteprognose.
      matchedCount++;
      unknownCount++;
      noPredictionCount++;

      leg.openovRealtime = {
        source: "OpenOV GTFS-Realtime",
        status: "vehicle_observed",
        reason: "vehicle_observed_without_stop_prediction",
        message: "Voertuig van deze exacte rit recent waargenomen; halteprognose ontbreekt.",
        timestampBasis: "vehicle_position",
        updateTimestamp: vehicleObservation.observedAt,
        updateAgeSeconds: vehicleObservation.ageSeconds,
        matchMethod: "exact_trip_id_vehicle_position",
        tripId: vehicleObservation.tripId,
        routeId: vehicleObservation.routeId,
        departure: null,
        arrival: null,
        vehiclePosition: vehicleObservation
      };

      continue;
    }

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

    const scheduledDepartureValue =
      leg.from?.scheduledDeparture ?? leg.scheduledStartTime ?? leg.startTime;
    const scheduledArrivalValue =
      leg.to?.scheduledArrival ?? leg.scheduledEndTime ?? leg.endTime;

    const exactFromUpdate = findRealtimeStop(record, fromId);
    const exactToUpdate = findRealtimeStop(record, toId);

    const fromStopMatch = exactFromUpdate
      ? { stop: exactFromUpdate, method: "exact_stop_id", deltaSeconds: 0 }
      : fromId
        ? findRealtimeStopByScheduledEvent(
            record, "departure", scheduledDepartureValue
          )
        : null;

    const toStopMatch = exactToUpdate
      ? { stop: exactToUpdate, method: "exact_stop_id", deltaSeconds: 0 }
      : toId
        ? findRealtimeStopByScheduledEvent(
            record, "arrival", scheduledArrivalValue
          )
        : null;

    const fromUpdate = fromStopMatch?.stop;
    const toUpdate = toStopMatch?.stop;


    const relationship = String(
      record.scheduleRelationship ?? ""
    ).toUpperCase();

    const cancelled =
      leg.cancelled === true ||
      relationship.includes("CANCEL") ||
      relationship.includes("DELETED");

    const propagationScheduledDeparture =
      leg.from?.scheduledDeparture ?? leg.scheduledStartTime ?? leg.startTime;
    const propagationScheduledArrival =
      leg.to?.scheduledArrival ?? leg.scheduledEndTime ?? leg.endTime;

    let departurePrediction = summarizeRealtimeEvent(
      fromUpdate,
      "departure",
      propagationScheduledDeparture,
      { hasPerTripTimestamp: recordTimestamp !== null }
    );
    let arrivalPrediction = summarizeRealtimeEvent(
      toUpdate,
      "arrival",
      propagationScheduledArrival,
      { hasPerTripTimestamp: recordTimestamp !== null }
    );

    const usablePrediction = (p: any) =>
      Boolean(p?.time ||
        (p?.delaySeconds != null && Number.isFinite(Number(p.delaySeconds))));

    if (!usablePrediction(departurePrediction)) {
      const propagated = findPropagatedRealtimeEvent(
        record, "departure", propagationScheduledDeparture,
        {
          nowSeconds: Date.now() / 1000,
          targetStopId: fromId ?? "",
          maxLookaheadSeconds: 2700,
          maxSourceEventAgeSeconds: 900
        }
      );
      if (propagated) departurePrediction = propagated;
    }

    if (!usablePrediction(arrivalPrediction)) {
      const propagated = findPropagatedRealtimeEvent(
        record, "arrival", propagationScheduledArrival,
        {
          nowSeconds: Date.now() / 1000,
          targetStopId: toId ?? "",
          maxLookaheadSeconds: 2700,
          maxSourceEventAgeSeconds: 900
        }
      );
      if (propagated) arrivalPrediction = propagated;
    }

    const propagatedNotes: string[] = [];
    for (const [label, prediction] of [
      ["vertrek", departurePrediction],
      ["aankomst", arrivalPrediction]
    ] as Array<[string, any]>) {
      if (prediction?.predictionMethod !== "gtfsrt_delay_propagation") continue;
      propagatedNotes.push(
        `${label} doorgetrokken vanaf halte ${prediction.sourceStopId ?? "onbekend"}` +
        (prediction.sourceEventTime ? ` (gebeurtenis ${prediction.sourceEventTime})` : "")
      );
    }

    const realtimeFreshnessNotes: string[] = [];
    if (recordTimestamp === null) {
      realtimeFreshnessNotes.push(
        "De timestamp per rit ontbreekt; de versheid is afgeleid van de feed-header."
      );
    }
    if (propagatedNotes.length) {
      realtimeFreshnessNotes.push(
        "Vertraging doorgetrokken volgens GTFS-Realtime vanaf een eerdere halte: " +
        propagatedNotes.join("; ") +
        ". Dit is geen afzonderlijke voorspelling die de bron rechtstreeks voor de doelhalte meldde."
      );
    }
    const realtimeFreshnessNote = realtimeFreshnessNotes.join(" ") || null;

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
      freshnessNote: realtimeFreshnessNote,
      matchMethod: result.method,
      tripId: record.tripId,
      routeId: record.routeId ?? null,
      startDate: record.startDate ?? null,
      startTime: record.startTime ?? null,
      directionId: record.directionId ?? null,
      scheduleRelationship: record.scheduleRelationship ?? null,
      departure: departurePrediction,
      arrival: arrivalPrediction,
      vehiclePosition: vehicleObservation,
      departureStopMatchMethod: fromStopMatch?.method ?? null,
      departureStopMatchDeltaSeconds: fromStopMatch?.deltaSeconds ?? null,
      arrivalStopMatchMethod: toStopMatch?.method ?? null,
      arrivalStopMatchDeltaSeconds: toStopMatch?.deltaSeconds ?? null
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
      vehiclePositions: {
        ok: Boolean(vehicleFeed.ok),
        status: vehicleFeed.httpStatus ?? vehicleFeed.status ?? null,
        freshness: vehicleFeed.freshness ?? "unavailable",
        ageSeconds: vehicleFeed.ageSeconds ?? null,
        servedFromCache: vehicleFeed.servedFromCache ?? false,
        cacheAgeSeconds: vehicleFeed.cacheAgeSeconds ?? null,
        error: vehicleFeed.error ?? vehicleFeed.refreshWarning ?? null
      }
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


const LIVE_MAP_OPENOV_CACHE_TTL_MS = 15_000;
const LIVE_MAP_OPENOV_CACHE_TTL_SECONDS = 15;
const LIVE_MAP_OPENOV_MAX_POSITIONS = 2000;

type LiveMapOpenovCachedBody = {
  body: string;
  status: number;
  headers: Record<string, string>;
};

let liveMapOpenovMemoryCache: {
  expiresAtMs: number;
  value: LiveMapOpenovCachedBody;
} | null = null;
let liveMapOpenovInFlight: Promise<LiveMapOpenovCachedBody> | null = null;
let liveMapOpenovInFlightStartedAtMs = 0;

function defaultLiveMapOpenovCache(): Cache | null {
  if (typeof caches === "undefined") return null;
  return (caches as unknown as { default?: Cache }).default ?? null;
}

function respondLiveMapOpenov(
  value: LiveMapOpenovCachedBody,
  requestHeaders: Record<string, string>,
  cacheState: string
): Response {
  const headers = new Headers(value.headers);
  for (const [name, headerValue] of Object.entries(requestHeaders)) {
    headers.set(name, headerValue);
  }
  headers.set("x-ovlive-live-map-cache", cacheState);
  return new Response(value.body, { status: value.status, headers });
}

async function handleLiveMapOpenovApi(
  url: URL,
  headers: Record<string, string>
): Promise<Response> {
  const cacheKey = new Request(new URL(
    "/__ovlive-internal/live-map-openov-v1",
    url.origin
  ).toString());
  const edgeCache = defaultLiveMapOpenovCache();
  const now = Date.now();

  if (liveMapOpenovMemoryCache &&
      liveMapOpenovMemoryCache.expiresAtMs > now) {
    return respondLiveMapOpenov(
      liveMapOpenovMemoryCache.value,
      headers,
      "memory-hit"
    );
  }

  if (edgeCache) {
    try {
      const cached = await edgeCache.match(cacheKey);
      if (cached && cached.status === 200) {
        const cachedHeaders = new Headers(cached.headers);
        for (const [name, headerValue] of Object.entries(headers)) {
          cachedHeaders.set(name, headerValue);
        }
        cachedHeaders.set("x-ovlive-live-map-cache", "edge-hit");
        return new Response(cached.body, {
          status: cached.status,
          headers: cachedHeaders
        });
      }
    } catch (error) {
      console.warn("[OVLIVE_LIVE_MAP_CACHE_READ_ERROR]", error instanceof Error ? error.message : String(error));
    }
  }

  if (liveMapOpenovInFlight) {
    const inflightAgeMs = now - liveMapOpenovInFlightStartedAtMs;
    if (inflightAgeMs <= 18_000) {
      const shared = await liveMapOpenovInFlight;
      return respondLiveMapOpenov(shared, headers, "single-flight");
    }

    // Do not let a request which appears abandoned after a Worker/CPU failure
    // block all later map refreshes in this isolate.
    console.warn("[OVLIVE_LIVE_MAP_OPENOV_STALE_INFLIGHT]", JSON.stringify({
      inflightAgeMs
    }));
    liveMapOpenovInFlight = null;
    liveMapOpenovInFlightStartedAtMs = 0;
  }

  const task = (async (): Promise<LiveMapOpenovCachedBody> => {
    try {
      const startedAt = Date.now();
      const response = await fetch(OPENOV.vehiclePositions, {
        headers: {
          "user-agent": "OVLive/0.1.0 (open-source Dutch transit realtime client)",
          "accept-encoding": "gzip"
        },
        signal: AbortSignal.timeout(12_000),
        cf: { cacheTtl: 5, cacheEverything: true }
      });

      if (!response.ok) {
        const status = response.status === 429 ? 429 : 502;
        const body = JSON.stringify({
          ok: false,
          source: "OpenOV / OVapi GTFS-Realtime",
          upstreamStatus: response.status,
          checkedAt: new Date().toISOString(),
          error: response.status === 429
            ? "De OpenOV-bron beperkt tijdelijk het aantal verzoeken."
            : "De OpenOV-voertuigfeed is tijdelijk niet beschikbaar."
        });
        return {
          status,
          body,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          }
        };
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_BODY_BYTES) {
        throw new Error("De voertuigfeed is groter dan de ingestelde veiligheidslimiet.");
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) {
        throw new Error("De voertuigfeed is groter dan de ingestelde veiligheidslimiet.");
      }

      const decodeStartedAt = performance.now();
      // Gebruik hier bewust uitsluitend de selectieve decoder. Bij een wijziging
      // in het bronschema falen we veilig in plaats van een zware volledige
      // GTFS-RT-objectboom op te bouwen en opnieuw een CPU-limit te riskeren.
      const decoded = decodeOpenovVehiclePositions(bytes);
      const decodeDurationMs = Number((performance.now() - decodeStartedAt).toFixed(2));
      // Avoid sorting the entire national feed on the CPU-limited Worker.
      // Every returned point is independently age-checked by the UI; a stable
      // capped source-order sample is preferable to an expensive global sort.
      const entities = decoded.entities
        .filter((entity: any) =>
          Number.isFinite(entity.latitude) &&
          Number.isFinite(entity.longitude) &&
          entity.latitude >= 49 &&
          entity.latitude <= 56 &&
          entity.longitude >= 2 &&
          entity.longitude <= 9.5
        )
        .slice(0, LIVE_MAP_OPENOV_MAX_POSITIONS);

      const feedTimestamp = decoded.feedTimestamp;
      const rawAgeSeconds = typeof feedTimestamp === "number"
        ? Date.now() / 1000 - feedTimestamp
        : Number.NaN;
      const ageSeconds = Number.isFinite(rawAgeSeconds)
        ? Math.max(0, Math.round(rawAgeSeconds))
        : null;
      const freshness = Number.isFinite(rawAgeSeconds) &&
          rawAgeSeconds >= -60 &&
          rawAgeSeconds <= 180
        ? "fresh"
        : "stale_or_unknown";

      console.log("[OVLIVE_LIVE_MAP_OPENOV_DECODE]", JSON.stringify({
        decoder: "selective-protobuf",
        byteCount: bytes.byteLength,
        sourceEntityCount: decoded.sourceEntityCount,
        validPositionCount: entities.length,
        decodeDurationMs,
        totalDurationMs: Date.now() - startedAt,
        freshness
      }));

      const body = JSON.stringify({
        ok: true,
        source: "OpenOV / OVapi GTFS-Realtime",
        checkedAt: new Date().toISOString(),
        feedTimestamp: typeof feedTimestamp === "number" && feedTimestamp > 0
          ? new Date(feedTimestamp * 1000).toISOString()
          : null,
        ageSeconds,
        freshness,
        entityCount: decoded.sourceEntityCount,
        returnedCount: entities.length,
        decoder: "selective-protobuf",
        entities
      });

      return {
        status: 200,
        body,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=" + LIVE_MAP_OPENOV_CACHE_TTL_SECONDS,
          "x-content-type-options": "nosniff"
        }
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[OVLIVE_LIVE_MAP_OPENOV_ERROR]", JSON.stringify({
        error: detail,
        kind: "vehiclePositions"
      }));
      return {
        status: 502,
        body: JSON.stringify({
          ok: false,
          source: "OpenOV / OVapi GTFS-Realtime",
          checkedAt: new Date().toISOString(),
          error: "De snelle voertuigdecoder kon de feed niet veilig verwerken."
        }),
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      };
    }
  })();

  liveMapOpenovInFlight = task;
  liveMapOpenovInFlightStartedAtMs = Date.now();
  try {
    const value = await task;
    if (value.status === 200) {
      liveMapOpenovMemoryCache = {
        expiresAtMs: Date.now() + LIVE_MAP_OPENOV_CACHE_TTL_MS,
        value
      };
      if (edgeCache) {
        try {
          await edgeCache.put(cacheKey, new Response(value.body, {
            status: value.status,
            headers: value.headers
          }));
        } catch (error) {
          console.warn("[OVLIVE_LIVE_MAP_CACHE_WRITE_ERROR]", error instanceof Error ? error.message : String(error));
        }
      }
    }
    return respondLiveMapOpenov(value, headers, "miss");
  } finally {
    if (liveMapOpenovInFlight === task) {
      liveMapOpenovInFlight = null;
      liveMapOpenovInFlightStartedAtMs = 0;
    }
  }
}


async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const isRealtimeRefresh = url.pathname === "/api/realtime-refresh";
  if (request.method !== "GET" &&
      !(isRealtimeRefresh && request.method === "POST")) {
    return json({ error: "Deze API-route accepteert alleen de gedocumenteerde HTTP-methode." }, 405, headers);
  }

  const rateLimitResponse = await enforcePublicApiRateLimit(request, env, headers);
  if (rateLimitResponse) return rateLimitResponse;

  if (url.pathname === "/api/ns/train-details") {
    const trainNumber = String(url.searchParams.get("trainNumber") ?? "").trim();
    if (!/^\d{1,6}$/.test(trainNumber)) {
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: "Geef één exact NS-treinnummer op."
      }, 400, { ...headers, "cache-control": "no-store" });
    }

    const dateTime = String(url.searchParams.get("dateTime") ?? "").trim();
    if (dateTime && (dateTime.length > 50 || !Number.isFinite(Date.parse(dateTime)))) {
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: "De geplande treintijd is ongeldig."
      }, 400, { ...headers, "cache-control": "no-store" });
    }

    const stationCode = String(url.searchParams.get("stationCode") ?? "")
      .trim()
      .toUpperCase();
    if (stationCode && !/^[A-Z0-9]{2,6}$/.test(stationCode)) {
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: "De NS-stationscode is ongeldig."
      }, 400, { ...headers, "cache-control": "no-store" });
    }

    if (!String(env.NS_API_SUBSCRIPTION_KEY ?? "").trim()) {
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: "De NS API-sleutel is niet ingesteld in de Worker."
      }, 503, { ...headers, "cache-control": "no-store" });
    }

    try {
      const info = await fetchNsTrainDetails(
        trainNumber,
        dateTime || null,
        env,
        stationCode || null
      );
      return json(info, 200, {
        ...headers,
        "cache-control": "private, max-age=15"
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const statusMatch = detail.match(/NS_TRAIN_DETAILS_HTTP_(\d{3})/);
      const upstreamStatus = statusMatch ? Number(statusMatch[1]) : null;
      const status = upstreamStatus === 429 ? 429 : 502;
      const message =
        detail === "NS_TRAIN_DETAILS_KEY_MISSING"
          ? "De NS API-sleutel ontbreekt."
          : detail === "NS_TRAIN_DETAILS_INVALID_TRAIN_NUMBER"
            ? "Het NS-treinnummer is ongeldig."
            : detail === "NS_TRAIN_DETAILS_INVALID_STATION_CODE"
              ? "De NS-stationscode is ongeldig."
              : upstreamStatus === 401 || upstreamStatus === 403
              ? "NS heeft deze treininfo-aanvraag geweigerd. Controleer of de bestaande sleutel toegang heeft tot de Virtual Train-detail-API."
              : upstreamStatus === 429
                ? "De NS Virtual Train API heeft de aanvraaglimiet bereikt."
                : /timeout|timed out|abort/i.test(detail)
                  ? "De NS Virtual Train API reageert niet op tijd."
                  : "De aanvullende NS-treininformatie is tijdelijk niet beschikbaar.";

      console.warn("[OVLIVE_NS_TRAIN_DETAILS]", JSON.stringify({
        trainNumber,
        stationCode: stationCode || null,
        upstreamStatus,
        errorCode: detail.match(/NS_TRAIN_DETAILS_[A-Z_]+/)?.[0] ?? "unexpected_error"
      }));
      return json({
        ok: false,
        source: "NS Virtual Train API",
        trainNumber,
        error: message,
        upstreamStatus,
        checkedAt: new Date().toISOString()
      }, status, { ...headers, "cache-control": "no-store" });
    }
  }

  if (url.pathname === "/api/ns/train-route") {
    const trainNumber = String(url.searchParams.get("trainNumber") ?? "").trim();
    if (!/^\d{1,6}$/.test(trainNumber)) {
      return json({
        ok: false,
        source: "NS Reisinformatie + SpoorKaart API",
        error: "Geef één exact NS-treinnummer op."
      }, 400, { ...headers, "cache-control": "no-store" });
    }

    const dateTime = String(url.searchParams.get("dateTime") ?? "").trim();
    if (dateTime && (dateTime.length > 50 || !Number.isFinite(Date.parse(dateTime)))) {
      return json({
        ok: false,
        source: "NS Reisinformatie + SpoorKaart API",
        error: "Het tijdstip van deze treinpositie is ongeldig."
      }, 400, { ...headers, "cache-control": "no-store" });
    }

    if (!String(env.NS_API_SUBSCRIPTION_KEY ?? "").trim()) {
      return json({
        ok: false,
        source: "NS Reisinformatie + SpoorKaart API",
        error: "De NS API-sleutel is niet ingesteld in de Worker."
      }, 503, { ...headers, "cache-control": "no-store" });
    }

    try {
      const route = await fetchNsLiveTrainRoute(trainNumber, dateTime || null, env);
      return json(route, 200, {
        ...headers,
        "cache-control": "private, max-age=60"
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const statusMatch = detail.match(/NS_LIVE_TRAIN_ROUTE_HTTP_(\d{3})/);
      const upstreamStatus = statusMatch ? Number(statusMatch[1]) : null;
      const status = upstreamStatus === 429 ? 429 : 502;
      const message =
        detail === "NS_LIVE_TRAIN_ROUTE_KEY_MISSING"
          ? "De NS API-sleutel ontbreekt."
          : detail === "NS_LIVE_TRAIN_ROUTE_INVALID_TRAIN_NUMBER"
            ? "Het NS-treinnummer is ongeldig."
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "NS heeft de routeaanvraag geweigerd. Controleer of de bestaande NS-sleutel toegang heeft tot Reisinformatie, NS-APP Stations en SpoorKaart."
              : upstreamStatus === 429
                ? "De NS API heeft de aanvraaglimiet bereikt. Probeer de treinroute later opnieuw."
                : detail === "NS_LIVE_TRAIN_ROUTE_NO_JOURNEY"
                  ? "NS vond op dit tijdstip geen bijpassende treinrit."
                  : detail === "NS_LIVE_TRAIN_ROUTE_GEOMETRY_MISSING"
                    ? "NS gaf geen bruikbare spoorgeometrie voor deze treinrit terug."
                    : detail.startsWith("NS_LIVE_TRAIN_ROUTE_STATION_UNRESOLVED_")
                      ? "Een station in de exacte NS-rit kon niet naar een spoorwegcode worden vertaald."
                      : detail === "NS_LIVE_TRAIN_ROUTE_STOPS_MISSING_CODES"
                        ? "NS leverde niet voor alle stations een bruikbare stationscode; de spoorroute is daarom niet getekend."
                        : detail === "NS_LIVE_TRAIN_ROUTE_TOO_MANY_STOPS"
                          ? "Deze treinrit heeft te veel stations om veilig in één routeaanvraag op te halen."
                          : /timeout|timed out|abort/i.test(detail)
                            ? "De NS-routegegevens reageren niet op tijd."
                            : "De exacte NS-treinroute is tijdelijk niet beschikbaar.";

      console.warn("[OVLIVE_NS_LIVE_TRAIN_ROUTE]", JSON.stringify({
        trainNumber,
        upstreamStatus,
        errorCode: detail.match(/NS_LIVE_TRAIN_ROUTE_[A-Z_]+/)?.[0] ?? "unexpected_error"
      }));
      return json({
        ok: false,
        source: "NS Reisinformatie + SpoorKaart API",
        trainNumber,
        error: message,
        upstreamStatus,
        checkedAt: new Date().toISOString()
      }, status, { ...headers, "cache-control": "no-store" });
    }
  }

  if (url.pathname === "/api/live-map/openov") {
    return handleLiveMapOpenovApi(url, headers);
  }

  if (url.pathname === "/api/ns/vehicle-positions") {
    const includeAllPositions = url.searchParams.get("all") === "1";
    const rawTrainNumbers = String(url.searchParams.get("trainNumbers") ?? "");
    const requestedTrainNumbers = [...new Set(
      rawTrainNumbers.split(",").map(value => value.trim()).filter(Boolean)
    )];

    if (
      (!includeAllPositions && requestedTrainNumbers.length < 1) ||
      requestedTrainNumbers.length > 20 ||
      requestedTrainNumbers.some(value => !/^\d{1,6}$/.test(value))
    ) {
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: "Geef 1–20 geldige treinnummers op, of gebruik all=1 voor de live kaart."
      }, 400, headers);
    }

    if (!String(env.NS_API_SUBSCRIPTION_KEY ?? "").trim()) {
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: "De bestaande NS-sleutel is niet ingesteld in de Worker."
      }, 503, { ...headers, "cache-control": "no-store" });
    }

    try {
      const feed = await fetchNsLiveVehiclePositions(env, url.origin);
      const requested = new Set(requestedTrainNumbers);
      const positions = includeAllPositions
        ? feed.positions.slice(0, 2000)
        : feed.positions.filter(position => requested.has(position.trainNumber));
      return json({
        ok: true,
        source: "NS Virtual Train API",
        checkedAt: feed.fetchedAt,
        allPositions: includeAllPositions,
        positions
      }, 200, { ...headers, "cache-control": "no-store" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const statusMatch = detail.match(/NS_VIRTUAL_TRAIN_HTTP_(\d{3})/);
      const upstreamStatus = statusMatch ? Number(statusMatch[1]) : null;
      const status = upstreamStatus === 429 ? 429 : 502;
      const message =
        detail === "NS_VIRTUAL_TRAIN_KEY_MISSING"
          ? "De bestaande NS-sleutel ontbreekt."
          : upstreamStatus === 401 || upstreamStatus === 403
            ? "NS heeft de aanvraag geweigerd. Controleer of de bestaande NS-sleutel toegang heeft tot de Virtual Train API."
            : upstreamStatus === 429
              ? "De NS Virtual Train API heeft de aanvraaglimiet bereikt."
              : /timeout|timed out|abort/i.test(detail)
                ? "De NS Virtual Train API reageert niet op tijd."
                : "De live treinposities van NS zijn tijdelijk niet beschikbaar.";

      console.warn("[OVLIVE_NS_VEHICLE_POSITIONS]", JSON.stringify({
        upstreamStatus,
        errorCode: detail.match(/NS_VIRTUAL_TRAIN_[A-Z_]+/)?.[0] ?? "unexpected_error",
        requestedCount: includeAllPositions ? null : requestedTrainNumbers.length,
        includeAllPositions
      }));
      return json({
        ok: false,
        source: "NS Virtual Train API",
        error: message,
        upstreamStatus,
        checkedAt: new Date().toISOString()
      }, status, { ...headers, "cache-control": "no-store" });
    }
  }

  if (isRealtimeRefresh && request.method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    const maxRefreshBytes = 4 * 1024 * 1024;
    if (Number.isFinite(declaredLength) && declaredLength > maxRefreshBytes) {
      return json({ error: "De reisgegevens voor de realtime-update zijn te groot." }, 413, headers);
    }
    if (!String(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return json({ error: "Verstuur de reisgegevens als application/json." }, 415, headers);
    }

    let planData: any;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > maxRefreshBytes) {
        return json({ error: "De reisgegevens voor de realtime-update zijn te groot." }, 413, headers);
      }
      planData = JSON.parse(body);
    } catch {
      return json({ error: "De reisgegevens voor de realtime-update zijn geen geldige JSON." }, 400, headers);
    }

    const itineraries = Array.isArray(planData?.itineraries)
      ? planData.itineraries
      : Array.isArray(planData?.journeys)
        ? planData.journeys
        : [];
    if (!planData || typeof planData !== "object" || Array.isArray(planData) ||
        itineraries.length === 0 || itineraries.length > 12) {
      return json({ error: "De reisgegevens zijn ongeldig of bevatten te veel reisopties." }, 400, headers);
    }

    const refreshLegCount = itineraries.reduce((count: number, itinerary: any) => {
      const legs = Array.isArray(itinerary?.legs)
        ? itinerary.legs
        : Array.isArray(itinerary?.transitLegs)
          ? itinerary.transitLegs
          : [];
      return count + legs.length;
    }, 0);
    if (refreshLegCount < 1 || refreshLegCount > 240) {
      return json({ error: "De reisgegevens bevatten een ongeldig aantal reisdelen." }, 400, headers);
    }

    // Strip alle vorige live-uitkomsten zodat een mislukte nieuwe feed geen
    // oude vertraging of annulering als actuele informatie blijft tonen.
    delete planData.openovRealtimeMeta;
    delete planData.openovAlerts;
    delete planData.nsRealtimeMeta;
    delete planData.ndovRealtimeMeta;
    for (const leg of collectPlanLegs(planData)) {
      const wasNdovCancelled = leg.ndovRealtime?.status === "cancelled";
      delete leg.openovRealtime;
      delete leg.nsRealtime;
      delete leg.ndovRealtime;
      delete leg.ndovRealtimeMatch;
      delete leg.realtimePrediction;
      if (wasNdovCancelled) delete leg.cancelled;
    }

    // Elke realtimebron is onafhankelijk. Een fout in bijvoorbeeld NDOV mag
    // verse OpenOV-bus/tramprognoses niet weggooien of de hele update laten falen.
    const sourceErrors: Array<{ source: string; error: string }> = [];
    let successfulSources = 0;
    const refreshStartedAt = Date.now();
    console.log("[OVLIVE_REALTIME_REFRESH_START]", JSON.stringify({
      itineraryCount: itineraries.length,
      legCount: refreshLegCount,
      startedAt: new Date(refreshStartedAt).toISOString()
    }));
    const errorText = (error: unknown) =>
      error instanceof Error ? error.message : String(error ?? "Onbekende fout");

    const nsStartedAt = Date.now();
    try {
      const nsPrepareStartedAt = Date.now();
      console.log("[OVLIVE_REALTIME_REFRESH_STEP_START]", JSON.stringify({
        source: "NS",
        step: "prepare-identities",
        startedAt: new Date(nsPrepareStartedAt).toISOString()
      }));
      await prepareNsTrainIdentities(planData, env);
      console.log("[OVLIVE_REALTIME_REFRESH_STEP_COMPLETE]", JSON.stringify({
        source: "NS",
        step: "prepare-identities",
        durationMs: Date.now() - nsPrepareStartedAt
      }));

      const nsEnrichStartedAt = Date.now();
      console.log("[OVLIVE_REALTIME_REFRESH_STEP_START]", JSON.stringify({
        source: "NS",
        step: "enrich-train-plan",
        candidateLegCount: planData.nsRealtimeMeta?.candidateLegCount ?? 0
      }));
      await enrichNsTrainPlan(planData, env);
      console.log("[OVLIVE_REALTIME_REFRESH_STEP_COMPLETE]", JSON.stringify({
        source: "NS",
        step: "enrich-train-plan",
        durationMs: Date.now() - nsEnrichStartedAt
      }));
      successfulSources++;
      console.log("[OVLIVE_REALTIME_REFRESH_STAGE]", JSON.stringify({
        source: "NS",
        status: "ok",
        durationMs: Date.now() - nsStartedAt,
        candidateLegCount: planData.nsRealtimeMeta?.candidateLegCount ?? 0
      }));
    } catch (error) {
      const message = errorText(error);
      sourceErrors.push({ source: "NS", error: message });
      console.warn("[OVLIVE_REALTIME_REFRESH_STAGE]", JSON.stringify({
        source: "NS", status: "error", durationMs: Date.now() - nsStartedAt
      }));
      planData.nsRealtimeMeta = {
        status: "unavailable",
        error: message,
        checkedAt: new Date().toISOString()
      };
      console.error("[OVLIVE_REALTIME_REFRESH_NS_ERROR]", message);
    }

    const openovStartedAt = Date.now();
    console.log("[OVLIVE_REALTIME_REFRESH_OPENOV_START]", JSON.stringify({
      startedAt: new Date(openovStartedAt).toISOString()
    }));
    try {
      // The map has its own 10-second, exact-trip vehicle-position endpoint.
      // Do not download/decode the entire vehiclePositions feed again during
      // each full-plan refresh; keep trip predictions and alerts independent.
      planData = await enrichTransitousPlan(planData, { includeVehiclePositions: false });
      successfulSources++;
      console.log("[OVLIVE_REALTIME_REFRESH_STAGE]", JSON.stringify({
        source: "OpenOV",
        status: "ok",
        durationMs: Date.now() - openovStartedAt,
        matchedLegCount: planData.openovRealtimeMeta?.matchedLegCount ?? 0,
        freshPredictionLegCount: planData.openovRealtimeMeta?.freshPredictionLegCount ?? 0,
        vehiclePositionsSkipped: true
      }));
    } catch (error) {
      const message = errorText(error);
      sourceErrors.push({ source: "OpenOV", error: message });
      console.warn("[OVLIVE_REALTIME_REFRESH_STAGE]", JSON.stringify({
        source: "OpenOV", status: "error", durationMs: Date.now() - openovStartedAt
      }));
      planData.openovRealtimeMeta = {
        source: "OpenOV GTFS-Realtime",
        status: "enrichment_failed",
        message: "OpenOV kon deze realtimecontrole niet afronden.",
        error: message,
        checkedAt: new Date().toISOString()
      };
      console.error("[OVLIVE_REALTIME_REFRESH_OPENOV_ERROR]", message);
    }

    const ndovStartedAt = Date.now();
    try {
      console.log("[OVLIVE_REALTIME_REFRESH_STEP_START]", JSON.stringify({
        source: "NDOV",
        step: "apply-cancellations",
        candidateLegCount: refreshLegCount
      }));
      await applyNdovCancellationsToPlan(planData, env, {
        // This route is polled frequently. Avoid expensive static route matching
        // when the live BISON snapshot is already stale or unavailable.
        preflightBisonBeforeCrosswalk: true,
      });
      successfulSources++;
      console.log("[OVLIVE_REALTIME_REFRESH_STAGE]", JSON.stringify({
        source: "NDOV",
        status: "ok",
        durationMs: Date.now() - ndovStartedAt,
        statusDetail: planData.ndovRealtimeMeta?.status ?? "unknown",
        crosswalkSkipped: planData.ndovRealtimeMeta?.crosswalkSkipped === true
      }));
    } catch (error) {
      const message = errorText(error);
      sourceErrors.push({ source: "NDOV", error: message });
      console.warn("[OVLIVE_REALTIME_REFRESH_STAGE]", JSON.stringify({
        source: "NDOV", status: "error", durationMs: Date.now() - ndovStartedAt
      }));
      planData.ndovRealtimeMeta = {
        status: "unavailable",
        error: message,
        checkedAt: new Date().toISOString()
      };
      console.error("[OVLIVE_REALTIME_REFRESH_NDOV_ERROR]", message);
    }

    planData.realtimeRefreshMeta = {
      status: sourceErrors.length === 0 ? "complete" : "partial",
      checkedAt: new Date().toISOString(),
      successfulSources,
      errors: sourceErrors
    };
    console.log("[OVLIVE_REALTIME_REFRESH_COMPLETE]", JSON.stringify({
      status: planData.realtimeRefreshMeta.status,
      durationMs: Date.now() - refreshStartedAt,
      successfulSources,
      errors: sourceErrors.map((item) => item.source),
      itineraryCount: itineraries.length,
      legCount: refreshLegCount
    }));

    if (successfulSources === 0) {
      return json({
        error: "Geen enkele realtimebron kon de update afronden.",
        detail: sourceErrors.map((item) => `${item.source}: ${item.error}`).join(" | "),
        sourceErrors,
        checkedAt: planData.realtimeRefreshMeta.checkedAt
      }, 502, headers);
    }

    return json(planData, 200, {
      ...headers,
      "cache-control": "no-store",
      "x-upstream": "OVLive realtime refresh",
      "x-ovlive-refresh-status": sourceErrors.length === 0 ? "complete" : "partial"
    });
  }

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

    const vehiclePositionFilters = kind === "vehiclePositions" &&
      (routeFilters.length > 0 || tripFilters.length > 0)
      ? { routeIds: routeFilters, tripIds: tripFilters }
      : undefined;

    try {
      const data = await getOpenovFeed(
        feedUrl,
        kind as keyof typeof OPENOV,
        vehiclePositionFilters
      );
      const { entities = [], ...meta } = data as any;

      // Vehicle-position requests with exact trip/route filters were filtered
      // during protobuf decoding. This final guard keeps the public API contract
      // and handles the compatibility fallback / unfiltered diagnostics too.
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
      // Zoek eerst echte Transitous-OV-haltes en houd adres-/kaartlocaties als fallback.
      // Zo wordt een gekozen bushalte als stop-ID doorgestuurd in plaats van alleen als coördinaat.
      const [transitousResult, mapResult] = await Promise.allSettled([
        getTransitousStopFeatures(query, env),
        getGeocodeFeatures(query, env)
      ]);

      if (transitousResult.status === "rejected") {
        console.warn("[OVLIVE_TRANSITOUS_GEOCODE]",
          transitousResult.reason instanceof Error
            ? transitousResult.reason.message
            : "Transitous-haltezoeking mislukt.");
      }
      if (mapResult.status === "rejected") {
        console.warn("[OVLIVE_MAP_GEOCODE]",
          mapResult.reason instanceof Error
            ? mapResult.reason.message
            : "Adres-/kaartzoeking mislukt.");
      }

      if (transitousResult.status === "rejected" && mapResult.status === "rejected") {
        throw new Error("Transitous en de adreszoekdiensten zijn tijdelijk niet beschikbaar.");
      }

      const emptyFeatureCollection = { type: "FeatureCollection", features: [] };
      const data = mergeTransitousAndMapFeatureCollections(
        transitousResult.status === "fulfilled"
          ? transitousResult.value
          : emptyFeatureCollection,
        mapResult.status === "fulfilled"
          ? mapResult.value
          : emptyFeatureCollection
      );

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


  if (url.pathname === "/api/line-search") {
    const query = String(url.searchParams.get("q") ?? "").trim();
    if (!query || query.length > 24 || !/^[A-Za-z0-9 -]+$/.test(query)) {
      return json({ error: "Vul een geldig lijnnummer, voertuignummer of ritnummer in." }, 400, {
        ...headers,
        "cache-control": "no-store"
      });
    }

    const limitValue = Number(url.searchParams.get("limit") ?? 30);
    const limit = Number.isFinite(limitValue) ? Math.min(50, Math.max(1, Math.trunc(limitValue))) : 30;
    const needle = query.toLocaleLowerCase("nl-NL");
    const results = new Map<string, Record<string, any>>();
    const warnings: string[] = [];
    let ovapiAvailable = false;
    let openovAvailable = false;
    let ovapiLineResultsFound = false;
    let routeMetadata: Record<string, OpenovRouteMetadataEntry> = {};
    try {
      routeMetadata = await getOpenovLineSearchRouteMetadata(env);
    } catch (error) {
      warnings.push("OpenOV openbare lijnnamen niet beschikbaar: " +
        (error instanceof Error ? error.message : "onbekende fout"));
    }

    const addResult = (row: Record<string, any>) => {
      const line = String(row.line ?? "").trim();
      const destination = String(row.destination ?? "").trim();
      const vehicleNumber = String(row.vehicleNumber ?? "").trim();
      const tripNumber = String(row.tripNumber ?? "").trim();
      const key = [
        line.toLocaleLowerCase("nl-NL"),
        destination.toLocaleLowerCase("nl-NL"),
        vehicleNumber,
        tripNumber,
        String(row.tripId ?? "")
      ].join("|");
      const existing = results.get(key);
      if (!existing || (Number(row.timestamp ?? 0) > Number(existing.timestamp ?? 0))) {
        results.set(key, row);
      }
    };

    const ovapiCandidates: Array<{
      unique: string;
      journeyKey: string;
      row: Record<string, any>;
    }> = [];

    // OVAPI provides public line names/destinations and live journey passes.
    // Ask the API for details only for the exact public line number entered.
    try {
      const directoryResponse = await fetch("http://v0.ovapi.nl/line/", {
        headers: {
          "accept": "application/json",
          "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
        },
        signal: AbortSignal.timeout(9000),
        cf: { cacheEverything: true, cacheTtl: 60 }
      });
      if (!directoryResponse.ok) throw new Error("OVAPI gaf HTTP " + directoryResponse.status + " terug voor de lijnenlijst.");
      const directory = await directoryResponse.json() as Record<string, any>;
      ovapiAvailable = true;
      const matchingLines = Object.entries(directory).filter(([, value]) => {
        const meta = value?.Line && typeof value.Line === "object" ? value.Line : value;
        const publicNumber = String(meta?.LinePublicNumber ?? "").trim();
        return publicNumber.toLocaleLowerCase("nl-NL") === needle;
      });
      if (matchingLines.length) {
        // Veel Nederlandse vervoerders gebruiken hetzelfde openbare lijnnummer.
        // Onderzoek daarom veel meer dan de eerste 24 routes, in begrensde batches.
        const allRouteKeys = [...new Set(
          matchingLines.map(([key]) => key).filter(key => /^[A-Za-z0-9_-]+$/.test(key))
        )];
        const MAX_OVAPI_LINE_SEARCH_ROUTES = 160;
        const OVAPI_LINE_SEARCH_BATCH_SIZE = 20;
        const OVAPI_LINE_SEARCH_BATCH_CONCURRENCY = 3;
        const routeKeys = allRouteKeys.slice(0, MAX_OVAPI_LINE_SEARCH_ROUTES);
        if (allRouteKeys.length > routeKeys.length) {
          warnings.push("OVAPI: er zijn " + allRouteKeys.length + " routevarianten voor lijn " + query +
            "; vanwege een limiet zijn de eerste " + MAX_OVAPI_LINE_SEARCH_ROUTES + " gecontroleerd.");
        }
        if (routeKeys.length) {
          const routeBatches: string[][] = [];
          for (let index = 0; index < routeKeys.length; index += OVAPI_LINE_SEARCH_BATCH_SIZE) {
            routeBatches.push(routeKeys.slice(index, index + OVAPI_LINE_SEARCH_BATCH_SIZE));
          }
          const details: Record<string, any> = {};
          for (let batchIndex = 0; batchIndex < routeBatches.length; batchIndex += OVAPI_LINE_SEARCH_BATCH_CONCURRENCY) {
            const batchResults = await Promise.all(routeBatches
              .slice(batchIndex, batchIndex + OVAPI_LINE_SEARCH_BATCH_CONCURRENCY)
              .map(async (batch) => {
                try {
                  const detailsResponse = await fetch("http://v0.ovapi.nl/line/" + batch.join(","), {
                    headers: {
                      "accept": "application/json",
                      "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
                    },
                    signal: AbortSignal.timeout(9000),
                    cf: { cacheEverything: true, cacheTtl: 10 }
                  });
                  if (!detailsResponse.ok) {
                    throw new Error("HTTP " + detailsResponse.status);
                  }
                  return {
                    data: await detailsResponse.json() as Record<string, any>,
                    error: ""
                  };
                } catch (error) {
                  return {
                    data: null,
                    error: error instanceof Error ? error.message : "onbekende fout"
                  };
                }
              }));
            for (let index = 0; index < batchResults.length; index++) {
              const batchResult = batchResults[index];
              if (!batchResult.data) {
                warnings.push("OVAPI-lijnbatch " + (batchIndex + index + 1) + " niet beschikbaar: " + batchResult.error);
                continue;
              }
              Object.assign(details, batchResult.data);
            }
          }
          for (const [routeKey, routeData] of Object.entries(details)) {
            const meta = routeData?.Line ?? directory[routeKey]?.Line ?? directory[routeKey] ?? {};
            const line = String(meta?.LinePublicNumber ?? query).trim();
            const actuals = routeData?.Actuals && typeof routeData.Actuals === "object"
              ? Object.entries(routeData.Actuals)
              : [];
            for (const [actualId, actualValue] of actuals) {
              if (!actualValue || typeof actualValue !== "object" || Array.isArray(actualValue)) continue;
              const actual = actualValue as Record<string, any>;
              const updatedAt = String(actual.LastUpdateTimeStamp ?? "");
              const updatedAtMs = Date.parse(updatedAt);
              const ageSeconds = Number.isFinite(updatedAtMs)
                ? Math.round((Date.now() - updatedAtMs) / 1000)
                : null;
              // Ignore very old passes; an out-of-date observation is not a live vehicle.
              if (ageSeconds !== null && (ageSeconds < -120 || ageSeconds > 600)) continue;
              const destination = String(actual.DestinationName50 ?? meta.DestinationName50 ?? "").trim();
              const journeyNumber = actual.JourneyNumber == null ? "" : String(actual.JourneyNumber).trim();
              const vehicleNumber = String(
                actual.VehicleNumber ?? actual.VehicleNumberOnTrip ?? actual.VehicleCode ?? actual.VehicleId ?? ""
              ).trim();
              const operatorCode = String(actual.OperatorCode ?? meta.OperatorCode ?? actual.DataOwnerCode ?? meta.DataOwnerCode ?? "").trim();
              const operatorName = openovAgencyNameForLine(routeMetadata, line, operatorCode) ||
                String(actual.OperatorName ?? meta.OperatorName ?? operatorCode ?? "").trim();
              const mode = String(actual.TransportType ?? meta.TransportType ?? "").trim();
              const expectedDepartureTime = String(actual.ExpectedDepartureTime ?? "").trim();
              const expectedArrivalTime = String(actual.ExpectedArrivalTime ?? "").trim();
              const targetTime = String(
                expectedDepartureTime
                  ? actual.TargetDepartureTime ?? ""
                  : expectedArrivalTime
                    ? actual.TargetArrivalTime ?? ""
                    : ""
              ).trim();
              const expectedTime = expectedDepartureTime || expectedArrivalTime;
              const tripId = String(actualId ?? "");
              const currentStopCode = String(actual.UserStopCode ?? actual.TimingPointCode ?? "").trim();
              const permalink = operatorCode && vehicleNumber &&
                /^[A-Za-z0-9_-]+$/.test(operatorCode) && /^[A-Za-z0-9_-]+$/.test(vehicleNumber)
                  ? "https://ovzoeker.nl/voertuig/" + operatorCode + ":" + vehicleNumber
                  : null;
              const row: Record<string, any> = {
                id: "ovapi|" + routeKey + "|" + (actual.OperationDate ?? "") + "|" + (journeyNumber || actualId),
                line,
                lineName: String(actual.LineName ?? meta.LineName ?? "").trim() || null,
                destination: destination || "Bestemming onbekend",
                operatorCode: operatorCode || null,
                operatorName: operatorName || null,
                mode,
                vehicleNumber: vehicleNumber || null,
                tripNumber: journeyNumber || null,
                blockCode: String(actual.BlockCode ?? "").trim() || null,
                numberOfCoaches: actual.NumberOfCoaches ?? null,
                vehicleLabel: vehicleNumber
                  ? (mode === "BUS" ? "Bus " : mode === "TRAM" ? "Tram " : mode === "METRO" ? "Metro " : mode === "TRAIN" ? "Trein " : "Voertuig ") + vehicleNumber
                  : journeyNumber
                    ? "Voertuig met ritnummer " + journeyNumber
                    : "Voertuig",
                stop: String(actual.TimingPointName ?? ""),
                stopTown: String(actual.TimingPointTown ?? ""),
                currentStopCode,
                status: String(actual.TripStopStatus ?? ""),
                expectedTime,
                targetTime,
                delaySeconds: lineSearchDelaySeconds(expectedTime, targetTime),
                updatedAt: updatedAt || null,
                updateAgeSeconds: ageSeconds,
                timestamp: Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : 0,
                source: "OVAPI",
                tripId,
                permalink,
                stops: [],
                matchKind: "line"
              };
              const unique = [
                line,
                destination,
                actual.OperationDate ?? "",
                actual.DataOwnerCode ?? meta.DataOwnerCode ?? "",
                journeyNumber || actualId
              ].join("|");
              ovapiCandidates.push({ unique, journeyKey: tripId, row });
            }
          }
        }
      }

      // OVAPI's journey endpoint returns the remaining stop sequence. Fetch all
      // selected journeys in one comma-separated request instead of one request per bus.
      const deduplicatedCandidates = new Map<string, typeof ovapiCandidates[number]>();
      for (const candidate of ovapiCandidates) {
        const existing = deduplicatedCandidates.get(candidate.unique);
        if (!existing || Number(candidate.row.timestamp ?? 0) > Number(existing.row.timestamp ?? 0)) {
          deduplicatedCandidates.set(candidate.unique, candidate);
        }
      }
      const selectedCandidates = [...deduplicatedCandidates.values()]
        .sort((a, b) => Number(b.row.timestamp ?? 0) - Number(a.row.timestamp ?? 0))
        .slice(0, limit);
      const journeyKeys = [...new Set(selectedCandidates
        .map((candidate) => candidate.journeyKey)
        .filter((key) => /^[A-Za-z0-9_-]+$/.test(key)))];
      const journeysByKey: Record<string, any> = {};
      if (journeyKeys.length) {
        try {
          const journeysResponse = await fetch("http://v0.ovapi.nl/journey/" + journeyKeys.join(","), {
            headers: {
              "accept": "application/json",
              "user-agent": env.APP_NAME + "/" + env.APP_VERSION + " (" + env.APP_CONTACT + ")"
            },
            signal: AbortSignal.timeout(8000),
            cf: { cacheEverything: true, cacheTtl: 10 }
          });
          if (!journeysResponse.ok) {
            throw new Error("OVAPI gaf HTTP " + journeysResponse.status + " terug voor ritdetails.");
          }
          Object.assign(journeysByKey, await journeysResponse.json() as Record<string, any>);
        } catch (error) {
          warnings.push("OVAPI-ritdetails tijdelijk niet beschikbaar: " +
            (error instanceof Error ? error.message : "onbekende fout"));
        }
      }

      for (const candidate of selectedCandidates) {
        const journey = journeysByKey[candidate.journeyKey];
        const normalizedStops = normalizeOvapiJourneyStops(
          journey?.Stops,
          candidate.row.currentStopCode
        );
        candidate.row.stops = normalizedStops.stops;
        if (candidate.row.numberOfCoaches == null || String(candidate.row.numberOfCoaches).trim() === "") {
          candidate.row.numberOfCoaches = normalizedStops.numberOfCoaches;
        }
        if (candidate.row.blockCode == null || String(candidate.row.blockCode).trim() === "") {
          candidate.row.blockCode = normalizedStops.blockCode;
        }
        candidate.row.stopCount = candidate.row.stops.length;
        const existing = results.get(candidate.unique);
        if (!existing || Number(candidate.row.timestamp ?? 0) > Number(existing.timestamp ?? 0)) {
          results.set(candidate.unique, candidate.row);
        }
      }
      ovapiLineResultsFound = selectedCandidates.length > 0;
    } catch (error) {
      warnings.push("OVAPI-lijngegevens niet beschikbaar: " + (error instanceof Error ? error.message : "onbekende fout"));
    }

    // Search OpenOV's current vehicle feed for matching vehicle IDs and trip IDs,
    // so a search like "73" can also find vehicle 7305 or trip 7346 on another line.
    try {
      // When OVAPI returned authoritative live journeys for the exact public line,
      // those rows already have better stop-by-stop data. Avoid duplicate Transitous
      // enrichment calls; keep OpenOV as a fallback if OVAPI had no live rows.
      if (ovapiLineResultsFound) {
        openovAvailable = false;
      } else {
      const feed = await getOpenovFeed(OPENOV.vehiclePositions, "vehiclePositions");
      if (!feed || feed.ok !== true || !Array.isArray(feed.entities)) {
        throw new Error("De OpenOV-voertuigposities zijn momenteel niet beschikbaar.");
      }
      openovAvailable = true;
      const matchedVehicles = (feed.entities as any[])
        .filter((entity: any) => {
          const vehicleId = String(entity?.vehicleId ?? "");
          const lineMatches = openovRouteMatchesLine(routeMetadata, entity?.routeId, query);
          const tripMatches = lineSearchTripIdMatches(entity?.tripId, query);
          return vehicleId.toLocaleLowerCase("nl-NL").includes(needle) ||
            lineMatches || tripMatches;
        })
        .sort((a: any, b: any) => {
          const aLine = openovRouteMatchesLine(routeMetadata, a?.routeId, query) ? 0 : 1;
          const bLine = openovRouteMatchesLine(routeMetadata, b?.routeId, query) ? 0 : 1;
          return aLine - bLine || Number(b?.timestamp ?? 0) - Number(a?.timestamp ?? 0);
        })
        .slice(0, Math.min(20, limit));

      // Keep upstream detail calls bounded; unknown IDs remain visible as unknown
      // rather than being assigned a guessed public line or destination.
      for (let index = 0; index < matchedVehicles.length; index += 4) {
        const batch = matchedVehicles.slice(index, index + 4);
        const enriched = await Promise.all(batch.map(async (entity: any) => {
          const tripId = String(entity?.tripId ?? "").trim();
          const vehicleId = String(entity?.vehicleId ?? "").trim();
          let itinerary: any = null;
          if (tripId) {
            try {
              const upstream = new URL(TRANSITOUS + "/trip");
              upstream.searchParams.set("tripId", transitousTripIdForVehiclePosition(
                tripId,
                entity?.startDate,
                entity?.startTime
              ));
              upstream.searchParams.set("detailedLegs", "true");
              upstream.searchParams.set("joinInterlinedLegs", "false");
              upstream.searchParams.set("withScheduledSkippedStops", "true");
              const response = await fetch(upstream, {
                headers: {
                  "accept": "application/json",
                  "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
                },
                signal: AbortSignal.timeout(6000),
                cf: { cacheTtl: 10, cacheEverything: true }
              });
              if (response.ok) itinerary = await response.json();
            } catch {
              // A position is still useful when the schedule lookup is missing.
            }
          }
          const legs = Array.isArray(itinerary?.legs) ? itinerary.legs : [];
          const leg = legs.find((value: any) =>
            String(value?.mode ?? "").toUpperCase() !== "WALK" &&
            String(value?.mode ?? "").toUpperCase() !== "FOOT"
          ) ?? legs[0] ?? {};
          const displayLine = String(
            leg?.routeShortName ?? leg?.tripShortName ?? leg?.displayName ?? ""
          ).trim();
          const routeId = String(entity?.routeId ?? "").trim();
          const routeMetadataEntry = openovRouteMetadataForId(routeMetadata, routeId);
          const publicRouteName = String(routeMetadataEntry?.routeShortName ?? "").trim();
          const routeMatchesQuery = publicRouteName.toLocaleLowerCase("nl-NL") === needle ||
            displayLine.toLocaleLowerCase("nl-NL") === needle;
          const line = displayLine || publicRouteName ||
            (String(leg?.mode ?? "").toUpperCase() === "TRAIN" ? "Trein" : "Lijn onbekend");
          const destination = String(
            leg?.headsign ?? leg?.tripTo?.name ?? leg?.tripTo?.displayName ??
            leg?.to?.name ?? leg?.destination?.name ?? itinerary?.to?.name ?? ""
          ).trim() || "Bestemming onbekend";
          const suffixMatch = tripId.match(/_nl-OpenOV_(.+)$/i);
          const tripNumber = suffixMatch?.[1] ?? "";
          const vehicleMatched = vehicleId.toLocaleLowerCase("nl-NL").includes(needle);
          const tripMatched = lineSearchTripIdMatches(tripId, query);
          const vehicleLabel = vehicleId
            ? (vehicleMatched ? "Voertuig met nummer " : "Voertuig-ID ") + vehicleId
            : tripNumber
              ? "Rit-ID " + tripNumber
              : tripId
                ? "Rit-ID " + tripId
                : "Identificatie niet beschikbaar";
          const timestamp = Number(entity?.timestamp ?? 0);
          return {
            id: "openov|" + (tripId || "no-trip") + "|" + (vehicleId || "no-vehicle"),
            line,
            destination,
            mode: String(leg?.mode ?? ""),
            vehicleNumber: vehicleId || null,
            tripNumber: tripNumber || null,
            routeId: routeId || null,
            vehicleLabel,
            stop: String(leg?.from?.name ?? ""),
            status: "",
            expectedTime: "",
            updatedAt: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
            updateAgeSeconds: timestamp > 0 ? Math.max(0, Math.round(Date.now() / 1000 - timestamp)) : null,
            timestamp,
            source: "OpenOV GTFS-Realtime",
            tripId: tripId || null,
            matchKind: routeMatchesQuery ? "line" : vehicleMatched ? "vehicle" : tripMatched ? "trip" : "vehicle",
            stops: normalizeTransitousLineSearchStops(leg),
            stopDataSource: "Transitous-dienstregeling",
            position: {
              latitude: typeof entity?.latitude === "number" ? entity.latitude : null,
              longitude: typeof entity?.longitude === "number" ? entity.longitude : null
            }
          } as Record<string, any>;
        }));
        for (const row of enriched) addResult(row);
      }
      }
    } catch (error) {
      warnings.push("OpenOV-voertuiggegevens niet beschikbaar: " + (error instanceof Error ? error.message : "onbekende fout"));
    }

    if (!ovapiAvailable && !openovAvailable) {
      return json({
        ok: false,
        query,
        error: "De lijn- en voertuigbronnen zijn momenteel niet bereikbaar.",
        warnings
      }, 502, { ...headers, "cache-control": "no-store" });
    }

    const sorted = [...results.values()].sort((a, b) => {
      const lineMatch = (a.matchKind === "line" ? 0 : 1) - (b.matchKind === "line" ? 0 : 1);
      if (lineMatch !== 0) return lineMatch;
      return Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0);
    });
    return json({
      ok: true,
      query,
      source: "OVAPI-lijndata en OpenOV-voertuigposities; voertuigen worden alleen opgenomen met een gevonden ID of lijnmatch",
      checkedAt: new Date().toISOString(),
      resultCount: Math.min(limit, sorted.length),
      results: sorted.slice(0, limit),
      partial: warnings.length > 0,
      warnings
    }, 200, { ...headers, "cache-control": "no-store" });
  }

  if (url.pathname === "/api/trip-shape") {
    const tripId = String(url.searchParams.get("tripId") ?? "").trim();
    if (!tripId || tripId.length > 256) {
      return json({ error: "Geef een geldige Transitous-rit-ID op." }, 400, headers);
    }

    // Fixed upstream endpoint, never a user-supplied URL. Only request this
    // when a user opens a live map. Do not force-cache upstream errors: a
    // temporary Transitous 5xx must not poison later route requests.
    const tripIdCandidates: string[] = [tripId];
    const appendCandidate = (candidate: string): void => {
      const cleaned = candidate.trim();
      if (cleaned && !tripIdCandidates.includes(cleaned)) tripIdCandidates.push(cleaned);
    };
    const withoutLeadingNamespace = tripId.replace(/^nl-OpenOV_/i, "");
    appendCandidate(withoutLeadingNamespace);
    const wrappedTrip = tripId.match(/^(\d{8})_(\d{1,2}:\d{2}(?::\d{2})?)_(.+)$/);
    if (wrappedTrip) {
      appendCandidate(`${wrappedTrip[1]}_${wrappedTrip[2]}_${wrappedTrip[3].replace(/^nl-OpenOV_/i, "")}`);
    }
    const boundedCandidates = tripIdCandidates.slice(0, 3);

    try {
      let response: Response | null = null;
      let lastFetchError: unknown = null;
      let successfulTripId: string | null = null;

      for (let candidateIndex = 0; candidateIndex < boundedCandidates.length; candidateIndex++) {
        const candidateTripId = boundedCandidates[candidateIndex];
        const upstream = new URL(`${TRANSITOUS}/trip`);
        upstream.searchParams.set("tripId", candidateTripId);
        upstream.searchParams.set("detailedLegs", "true");
        upstream.searchParams.set("joinInterlinedLegs", "false");
        upstream.searchParams.set("withScheduledSkippedStops", "true");

        // Retry one transient upstream/server failure once; try an ID alias
        // only after a not-found/bad-request result or repeated server failure.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await fetch(upstream, {
              headers: {
                "accept": "application/json",
                "user-agent": `${env.APP_NAME}/${env.APP_VERSION} (${env.APP_CONTACT})`
              },
              signal: AbortSignal.timeout(6500)
            });
            lastFetchError = null;
          } catch (error) {
            lastFetchError = error;
            response = null;
            if (attempt === 0) continue;
            break;
          }

          if (response.ok) {
            successfulTripId = candidateTripId;
            break;
          }

          const isServerFailure = response.status >= 500 || response.status === 429;
          if (isServerFailure && attempt === 0) continue;
          if ((response.status === 400 || response.status === 404) &&
              candidateIndex + 1 < boundedCandidates.length) {
            break;
          }
          // If a retryable failure persists, still allow the next exact-ID
          // alias to be tried; never infer a route from another trip.
          break;
        }

        if (response?.ok) break;
        if (lastFetchError && candidateIndex + 1 < boundedCandidates.length) continue;
        if (response && (response.status >= 500 || response.status === 429) &&
            candidateIndex + 1 < boundedCandidates.length) continue;
        if (response && (response.status === 400 || response.status === 404) &&
            candidateIndex + 1 < boundedCandidates.length) continue;
        break;
      }

      if (!response?.ok || !successfulTripId) {
        const upstreamStatus = response?.status ?? null;
        console.warn("[OVLIVE_TRIP_SHAPE_UPSTREAM]", JSON.stringify({
          status: upstreamStatus,
          tripIdLength: tripId.length,
          candidateCount: boundedCandidates.length,
          fetchError: lastFetchError instanceof Error ? lastFetchError.message : undefined
        }));
        return json({
          ok: false,
          upstreamStatus,
          error: upstreamStatus === 404
            ? "Transitous kent deze exacte rit-ID niet; er is geen route getekend."
            : "De volledige lijnroute is tijdelijk niet beschikbaar."
        }, upstreamStatus === 404 ? 404 : 502, {
          ...headers,
          "cache-control": "no-store",
          "x-upstream": "Transitous MOTIS v6 /trip"
        });
      }

      const itinerary: any = await response.json();
      const legs = Array.isArray(itinerary?.legs) ? itinerary.legs : [];
      const shapes = legs
        .filter((leg: any) =>
          String(leg?.mode ?? "").toUpperCase() !== "WALK" &&
          String(leg?.mode ?? "").toUpperCase() !== "FOOT" &&
          leg?.legGeometry &&
          (typeof leg.legGeometry === "string" ||
           typeof leg.legGeometry?.points === "string" ||
           (Array.isArray(leg.legGeometry) && leg.legGeometry.length > 1))
        )
        .slice(0, 12)
        .map((leg: any) => ({
          tripId: String(leg?.tripId ?? ""),
          routeId: String(leg?.routeId ?? ""),
          mode: String(leg?.mode ?? ""),
          legGeometry: leg.legGeometry
        }));

      return json({
        ok: true,
        requestedTripId: tripId,
        resolvedTripId: successfulTripId,
        legs: shapes
      }, 200, {
        ...headers,
        "cache-control": "public, max-age=1800",
        "x-upstream": "Transitous MOTIS v6 /trip"
      });
    } catch (error) {
      console.warn("[OVLIVE_TRIP_SHAPE_ERROR]", JSON.stringify({
        tripIdLength: tripId.length,
        error: error instanceof Error ? error.message : String(error)
      }));
      return json({
        ok: false,
        error: "De volledige lijnroute kon niet worden opgehaald."
      }, 502, { ...headers, "cache-control": "no-store" });
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

      // Route-only mode lets the UI show valid Transitous itineraries first.
      // Realtime enrichment is requested separately via /api/realtime-refresh,
      // so a slow NDOV/OpenOV source cannot keep the entire planner spinning.
      // "deferRealtime" is intentionally not in MAX_ROUTE_PARAMS and is never
      // forwarded to Transitous.
      if (url.searchParams.get("deferRealtime") === "1") {
        if (planData && typeof planData === "object" && !Array.isArray(planData)) {
          planData.openovRealtimeMeta = {
            status: "deferred",
            message: "Reisopties zijn geladen; realtimecontrole wordt apart uitgevoerd."
          };
        }
        return json(planData, response.status, {
          ...headers,
          "cache-control": "no-store",
          "x-upstream": "Transitous MOTIS v6",
          "x-ovlive-realtime": "deferred"
        });
      }

      try {
        // Prioritize the exact NS train identity and NS board requests before
        // OpenOV/NDOV enrichment loads route shards for many bus/tram legs.
        await prepareNsTrainIdentities(planData, env);
        await enrichNsTrainPlan(planData, env);
        planData = await enrichTransitousPlan(planData);
        await applyNdovCancellationsToPlan(planData, env, {
          includeIdentityDiagnostics: url.searchParams.get("ndovIdentityDiagnostics") === "1",
        });
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
    const stopId = String(url.searchParams.get("stopId") ?? "").trim();
    if (!stopId || stopId.length > 200) {
      return json({ error: "Geef een geldige Transitous-stop-ID op." }, 400, headers);
    }

    const requestedCount = Number(url.searchParams.get("n") ?? 20);
    const count = Number.isFinite(requestedCount)
      ? Math.min(50, Math.max(1, Math.trunc(requestedCount)))
      : 20;
    const upstream = new URL(`${TRANSITOUS}/stoptimes`);
    upstream.searchParams.set("stopId", stopId);
    upstream.searchParams.set("n", String(count));

    const booleanParams = ["arriveBy", "fetchStop", "withScheduledSkippedStops"];
    for (const key of booleanParams) {
      const value = url.searchParams.get(key);
      if (value === null) continue;
      if (value !== "true" && value !== "false") {
        return json({ error: `Ongeldige waarde voor ${key}; gebruik true of false.` }, 400, headers);
      }
      upstream.searchParams.set(key, value);
    }

    const requestedDirection = String(url.searchParams.get("direction") ?? "").trim().toUpperCase();
    if (requestedDirection) {
      if (requestedDirection !== "EARLIER" && requestedDirection !== "LATER") {
        return json({ error: "Ongeldige waarde voor direction; gebruik EARLIER of LATER." }, 400, headers);
      }
      upstream.searchParams.set("direction", requestedDirection);
    }

    const requestedTime = url.searchParams.get("time");
    if (requestedTime) {
      if (requestedTime.length > 64 || !Number.isFinite(Date.parse(requestedTime))) {
        return json({ error: "Geef een geldige datum en tijd op." }, 400, headers);
      }
      upstream.searchParams.set("time", requestedTime);
    }

    const pageCursor = url.searchParams.get("pageCursor");
    if (pageCursor !== null) {
      if (!pageCursor.trim() || pageCursor.length > 512) {
        return json({ error: "Ongeldige of te lange pagina-cursor." }, 400, headers);
      }
      upstream.searchParams.set("pageCursor", pageCursor);
    }

    const language = String(url.searchParams.get("language") ?? "nl").trim().slice(0, 20);
    if (language) upstream.searchParams.set("language", language);

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
        headers: {
          ...headers,
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store"
        }
      });
    } catch (error) {
      return json({
        error: "Haltevertrektijden tijdelijk niet beschikbaar.",
        detail: error instanceof Error ? error.message : "Onbekende fout"
      }, 502, headers);
    }
  }

  return json({ error: "API-route niet gevonden." }, 404, headers);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const disableLegacyCollector = async (stream: NdovStreamName): Promise<Record<string, any>> => {
      const legacyId = env.NDOV_FEEDS.idFromName(stream);
      const legacyStub = env.NDOV_FEEDS.get(legacyId);
      const target = new URL("https://ndov-hub.local/continuous/disable");
      target.searchParams.set("stream", stream);
      const response = await legacyStub.fetch(target.toString());
      const data = await response.json().catch(() => ({})) as Record<string, any>;

      if (!response.ok || data.ok !== true || data.enabled !== false) {
        throw new Error(
          `Legacy ${stream}-collector stop mislukt: HTTP ${response.status} ${JSON.stringify(data)}`
        );
      }
      return { stream, legacy: true, ...data };
    };

    if (env.NDOV_AUTOCOLLECT !== "true") {
      ctx.waitUntil(Promise.all([
        callNdovHub(env, "kv78", "continuous/disable"),
        callNdovHub(env, "bison", "continuous/disable"),
        disableLegacyCollector("kv78"),
        disableLegacyCollector("bison"),
      ]).then((feeds) => {
        const failed = feeds.filter((feed) => feed.ok !== true || feed.enabled !== false);
        if (failed.length) {
          console.error("[NDOV_AUTOCOLLECT] Niet alle gedeelde/legacy collectors konden worden gepauzeerd.", failed);
        } else {
          console.log("[NDOV_AUTOCOLLECT] Gedeelde en legacy collectors zijn gepauzeerd.");
        }
      }).catch((error) => {
        console.error("[NDOV_AUTOCOLLECT] Collectorpauze mislukt.", error);
      }));
      return;
    }

    // Nooit twee collectors tegelijk starten: oude object-ID's eerst stoppen.
    ctx.waitUntil(Promise.all([
      disableLegacyCollector("kv78"),
      disableLegacyCollector("bison"),
    ]).then(async (legacyFeeds) => {
      const legacyFailures = legacyFeeds.filter(
        (feed) => feed.ok !== true || feed.enabled !== false
      );
      if (legacyFailures.length) {
        throw new Error(
          "Gedeelde collector blijft uit totdat de oude object-ID's gestopt zijn: " +
          JSON.stringify(legacyFailures)
        );
      }

      const feeds = await Promise.all([
        callNdovHub(env, "kv78", "continuous/enable"),
        callNdovHub(env, "bison", "continuous/enable"),
      ]);
      const failed = feeds.filter((feed) => feed.ok !== true || feed.enabled !== true);
      if (failed.length) {
        console.error("[NDOV_AUTOCOLLECT] Niet alle gedeelde collectors konden worden ingeschakeld.", failed);
      } else {
        console.log("[NDOV_AUTOCOLLECT] Gedeelde collector ingeschakeld; oude object-ID's gestopt.", feeds);
      }
    }).catch((error) => {
      console.error("[NDOV_AUTOCOLLECT] Veilige collectorstart mislukt.", error);
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
