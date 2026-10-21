export interface NsLiveTrainRouteEnv {
  NS_API_SUBSCRIPTION_KEY?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  APP_CONTACT?: string;
}

export interface NsLiveTrainRouteLeg {
  tripId: string;
  routeId: string;
  mode: "RAIL";
  sequence: number;
  legGeometry: {
    type: "LineString";
    coordinates: number[][];
  };
}

export interface NsLiveTrainRouteResult {
  ok: true;
  source: "NS Reisinformatie + SpoorKaart API";
  trainNumber: string;
  dateTime: string;
  checkedAt: string;
  legs: NsLiveTrainRouteLeg[];
}

const NS_JOURNEY_ROOT = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/journey";
const NS_STATION_ROOT = "https://gateway.apiportal.ns.nl/nsapp-stations/v1/station";
const NS_TRAJECT_ROOT = "https://gateway.apiportal.ns.nl/Spoorkaart-API/api/v1/traject.geojson";
const MAX_STOPS = 36;
const MAX_JSON_BYTES = 5_000_000;
const ROUTE_CACHE_TTL_MS = 5 * 60_000;
const STATION_CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_ROUTE_CACHE_ENTRIES = 40;
const MAX_STATION_CACHE_ENTRIES = 120;

const routeCache = new Map<string, { expiresAt: number; promise: Promise<NsLiveTrainRouteResult> }>();
const stationCodeCache = new Map<string, { expiresAt: number; promise: Promise<string> }>();

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function unwrap(value: any): any {
  if (value && typeof value === "object") {
    if (value.payload !== undefined) return value.payload;
    if (value.data !== undefined) return value.data;
  }
  return value;
}

function normalizeStationCode(value: unknown): string {
  const code = asText(value).toUpperCase();
  return /^[A-Z0-9]{2,6}$/.test(code) ? code : "";
}

function normalizeUicCode(value: unknown): string {
  const code = asText(value);
  return /^\d{5,12}$/.test(code) ? code : "";
}

function getJourneyStops(input: any): any[] {
  const journey = unwrap(input);
  if (Array.isArray(journey?.stops)) return journey.stops;
  if (Array.isArray(journey?.journey?.stops)) return journey.journey.stops;
  return [];
}

function getStopUicCode(stopEntry: any): string {
  const stop = stopEntry?.stop ?? stopEntry?.station ?? stopEntry;
  return normalizeUicCode(
    stop?.uicCode ?? stop?.uicCdCode ?? stop?.UICCode ?? stop?.uic
  );
}

function getDirectStationCode(stopEntry: any): string {
  const stop = stopEntry?.stop ?? stopEntry?.station ?? stopEntry;
  const candidates = [
    stop?.code,
    stop?.stationCode,
    stop?.station?.code,
    stop?.id?.code
  ];
  for (const candidate of candidates) {
    const code = normalizeStationCode(candidate);
    if (code) return code;
  }
  return "";
}

function stationCodeFromPayload(input: any, requestedUic: string): string {
  const root = unwrap(input);
  const visit = (value: any, depth: number): string => {
    if (depth > 7 || value === null || value === undefined) return "";
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (typeof value !== "object") return "";

    const id = value.id && typeof value.id === "object" ? value.id : {};
    const foundUic = normalizeUicCode(
      id.uicCode ?? id.uicCdCode ?? value.uicCode ?? value.uicCdCode
    );
    const code = normalizeStationCode(
      id.code ?? value.stationCode ?? value.code
    );
    if (code && (!foundUic || foundUic === requestedUic)) return code;

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
    }
    return "";
  };
  return visit(root, 0);
}

async function requestJson(
  url: URL,
  env: NsLiveTrainRouteEnv,
  cacheTtlSeconds: number,
  fetchImpl: typeof fetch
): Promise<any> {
  const key = asText(env.NS_API_SUBSCRIPTION_KEY);
  if (!key) throw new Error("NS_LIVE_TRAIN_ROUTE_KEY_MISSING");

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: url.pathname.endsWith(".geojson") ? "application/geo+json, application/json" : "application/json",
      "Ocp-Apim-Subscription-Key": key,
      "user-agent":
        (env.APP_NAME || "OVLive") + "/" + (env.APP_VERSION || "0.1.0") +
        (env.APP_CONTACT ? " (" + env.APP_CONTACT + ")" : "")
    },
    signal: AbortSignal.timeout(9_000),
    cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true }
  });

  if (!response.ok) throw new Error("NS_LIVE_TRAIN_ROUTE_HTTP_" + response.status);
  const body = await response.text();
  if (body.length > MAX_JSON_BYTES) throw new Error("NS_LIVE_TRAIN_ROUTE_RESPONSE_TOO_LARGE");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("NS_LIVE_TRAIN_ROUTE_INVALID_JSON");
  }
}

async function resolveStationCode(
  uicCode: string,
  env: NsLiveTrainRouteEnv,
  fetchImpl: typeof fetch
): Promise<string> {
  const cached = stationCodeCache.get(uicCode);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) stationCodeCache.delete(uicCode);

  const promise = (async () => {
    const url = new URL(NS_STATION_ROOT);
    url.searchParams.set("uicCode", uicCode);
    const payload = await requestJson(url, env, Math.round(STATION_CACHE_TTL_MS / 1000), fetchImpl);
    const code = stationCodeFromPayload(payload, uicCode);
    if (!code) throw new Error("NS_LIVE_TRAIN_ROUTE_STATION_UNRESOLVED_" + uicCode);
    return code;
  })();

  stationCodeCache.set(uicCode, { expiresAt: Date.now() + STATION_CACHE_TTL_MS, promise });
  while (stationCodeCache.size > MAX_STATION_CACHE_ENTRIES) {
    const oldest = stationCodeCache.keys().next().value;
    if (oldest === undefined) break;
    stationCodeCache.delete(oldest);
  }
  try {
    return await promise;
  } catch (error) {
    if (stationCodeCache.get(uicCode)?.promise === promise) stationCodeCache.delete(uicCode);
    throw error;
  }
}

function lineCoordinates(geometry: any): number[][][] {
  const validLine = (line: any): line is number[][] =>
    Array.isArray(line) && line.length > 1 && line.every(point =>
      Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) &&
      Math.abs(Number(point[0])) <= 180 && Math.abs(Number(point[1])) <= 90
    );

  if (geometry?.type === "LineString" && validLine(geometry.coordinates)) {
    return [geometry.coordinates.map((point: number[]) => [Number(point[0]), Number(point[1])])];
  }
  if (geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates
      .filter(validLine)
      .map((line: number[][]) => line.map(point => [Number(point[0]), Number(point[1])]));
  }
  return [];
}

function featurePairIndex(fromValue: unknown, toValue: unknown, stationCodes: string[]): {
  index: number;
  reverse: boolean;
} | null {
  const from = normalizeStationCode(fromValue);
  const to = normalizeStationCode(toValue);
  if (!from || !to) return null;
  for (let index = 0; index < stationCodes.length - 1; index += 1) {
    if (stationCodes[index] === from && stationCodes[index + 1] === to) {
      return { index, reverse: false };
    }
    if (stationCodes[index] === to && stationCodes[index + 1] === from) {
      return { index, reverse: true };
    }
  }
  return null;
}

function extractOrderedRouteLines(input: any, stationCodes: string[]): number[][][] {
  const root = unwrap(input);
  const features = Array.isArray(root?.features)
    ? root.features
    : root?.type === "Feature"
      ? [root]
      : root?.geometry
        ? [{ geometry: root.geometry, properties: root.properties ?? {} }]
        : root?.type === "LineString" || root?.type === "MultiLineString"
          ? [{ geometry: root, properties: {} }]
          : [];

  const lines: Array<{ sequence: number; featureIndex: number; lineIndex: number; coordinates: number[][] }> = [];
  features.forEach((feature: any, featureIndex: number) => {
    const match = featurePairIndex(
      feature?.properties?.from ?? feature?.properties?.fromCode,
      feature?.properties?.to ?? feature?.properties?.toCode,
      stationCodes
    );
    const lineGeometries = lineCoordinates(feature?.geometry);
    lineGeometries.forEach((coordinates, lineIndex) => {
      const oriented = match?.reverse ? [...coordinates].reverse() : coordinates;
      lines.push({
        sequence: match?.index ?? featureIndex,
        featureIndex,
        lineIndex,
        coordinates: oriented
      });
    });
  });

  lines.sort((left, right) =>
    left.sequence - right.sequence ||
    left.featureIndex - right.featureIndex ||
    left.lineIndex - right.lineIndex
  );
  return lines.map(line => line.coordinates);
}

export async function fetchNsLiveTrainRoute(
  trainNumberValue: string,
  dateTimeValue: string | null | undefined,
  env: NsLiveTrainRouteEnv,
  fetchImpl: typeof fetch = fetch
): Promise<NsLiveTrainRouteResult> {
  const trainNumber = asText(trainNumberValue);
  if (!/^\d{1,6}$/.test(trainNumber)) throw new Error("NS_LIVE_TRAIN_ROUTE_INVALID_TRAIN_NUMBER");
  if (!asText(env.NS_API_SUBSCRIPTION_KEY)) throw new Error("NS_LIVE_TRAIN_ROUTE_KEY_MISSING");

  const parsedDateTime = Date.parse(asText(dateTimeValue));
  const sourceMs = Number.isFinite(parsedDateTime) ? parsedDateTime : Date.now();
  const minuteMs = Math.floor(sourceMs / 60_000) * 60_000;
  const dateTime = new Date(minuteMs).toISOString();
  const cacheKey = trainNumber + "|" + dateTime;
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) routeCache.delete(cacheKey);

  const promise = (async (): Promise<NsLiveTrainRouteResult> => {
    const journeyUrl = new URL(NS_JOURNEY_ROOT);
    journeyUrl.searchParams.set("train", trainNumber);
    journeyUrl.searchParams.set("dateTime", dateTime);
    journeyUrl.searchParams.set("omitCrowdForecast", "true");
    const journeyPayload = await requestJson(journeyUrl, env, 300, fetchImpl);
    const stops = getJourneyStops(journeyPayload);
    if (stops.length < 2) throw new Error("NS_LIVE_TRAIN_ROUTE_NO_JOURNEY");
    if (stops.length > MAX_STOPS) throw new Error("NS_LIVE_TRAIN_ROUTE_TOO_MANY_STOPS");

    const stopInfos = stops.map(entry => ({
      uicCode: getStopUicCode(entry),
      directCode: getDirectStationCode(entry)
    }));
    if (stopInfos.some(stop => !stop.uicCode && !stop.directCode)) {
      throw new Error("NS_LIVE_TRAIN_ROUTE_STOPS_MISSING_CODES");
    }

    const stationCodes = await Promise.all(stopInfos.map(async stop =>
      stop.directCode || await resolveStationCode(stop.uicCode, env, fetchImpl)
    ));
    const orderedStationCodes: string[] = [];
    for (const code of stationCodes) {
      if (orderedStationCodes[orderedStationCodes.length - 1] !== code) {
        orderedStationCodes.push(code);
      }
    }
    if (orderedStationCodes.length < 2) throw new Error("NS_LIVE_TRAIN_ROUTE_TOO_FEW_STATIONS");

    const trajectUrl = new URL(NS_TRAJECT_ROOT);
    trajectUrl.searchParams.set("stations", orderedStationCodes.join(","));
    const trajectPayload = await requestJson(trajectUrl, env, 86_400, fetchImpl);
    const lines = extractOrderedRouteLines(trajectPayload, orderedStationCodes);
    if (!lines.length) throw new Error("NS_LIVE_TRAIN_ROUTE_GEOMETRY_MISSING");

    return {
      ok: true,
      source: "NS Reisinformatie + SpoorKaart API",
      trainNumber,
      dateTime,
      checkedAt: new Date().toISOString(),
      legs: lines.map((coordinates, sequence) => ({
        tripId: trainNumber,
        routeId: "NS-SPOORKAART-" + sequence,
        mode: "RAIL",
        sequence,
        legGeometry: { type: "LineString", coordinates }
      }))
    };
  })();

  routeCache.set(cacheKey, { expiresAt: Date.now() + ROUTE_CACHE_TTL_MS, promise });
  while (routeCache.size > MAX_ROUTE_CACHE_ENTRIES) {
    const oldest = routeCache.keys().next().value;
    if (oldest === undefined) break;
    routeCache.delete(oldest);
  }
  try {
    return await promise;
  } catch (error) {
    if (routeCache.get(cacheKey)?.promise === promise) routeCache.delete(cacheKey);
    throw error;
  }
}
