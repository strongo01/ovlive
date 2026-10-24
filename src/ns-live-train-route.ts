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

export interface NsLiveTrainStop {
  sequence: number;
  stationCode: string | null;
  uicCode: string | null;
  name: string | null;
  plannedArrivalDateTime: string | null;
  plannedDepartureDateTime: string | null;
  actualArrivalDateTime: string | null;
  actualDepartureDateTime: string | null;
  arrivalDelaySeconds: number | null;
  departureDelaySeconds: number | null;
  platform: string | null;
  status: string | null;
  passing: boolean;
  cancelled: boolean;
}

export interface NsLiveTrainRouteResult {
  ok: true;
  source: "NS Reisinformatie + SpoorKaart API";
  trainNumber: string;
  dateTime: string;
  checkedAt: string;
  legs: NsLiveTrainRouteLeg[];
  stops: NsLiveTrainStop[];
  routeWarning?: string;
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
interface NsStationInfo {
  code: string | null;
  name: string | null;
}
const stationInfoCache = new Map<string, { expiresAt: number; promise: Promise<NsStationInfo> }>();

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number") {
      const cleaned = String(value).trim();
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const text = asText(value).toLowerCase();
  return ["true", "1", "yes", "ja", "cancelled", "canceled", "cancel", "skipped"].includes(text);
}

function normalizeDateTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  let raw = firstText(value);
  if (!raw && value && typeof value === "object") {
    const item = value as any;
    raw = firstText(item.dateTime, item.datetime, item.time, item.value);
  }
  if (!raw) return null;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function firstDateTime(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeDateTime(value);
    if (normalized) return normalized;
  }
  return null;
}

function stationNameFromObject(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  const direct = firstText(
    value.name,
    value.stationName,
    value.longName,
    value.displayName,
    value.label,
    value.value
  );
  if (direct) return direct;

  const names = value.names ?? value.localizedNames ?? value.namen;
  if (Array.isArray(names)) {
    const dutch = names.find((item: any) =>
      String(item?.language ?? item?.lang ?? item?.taal ?? "").toLowerCase().startsWith("nl")
    );
    const selected = dutch ?? names[0];
    if (selected) {
      return firstText(selected.name, selected.value, selected.text, selected.label);
    }
  } else if (names && typeof names === "object") {
    // Support both modern localized names and the older NS "namen" object,
    // where "lang" is the long station name (not a language code).
    return firstText(
      names.nl,
      names.NL,
      names.default,
      names.lang,
      names.long,
      names.middel,
      names.kort,
      names.name,
      names.value
    );
  }
  return null;
}

function getJourneyStopName(entry: any): string | null {
  const stop = entry?.stop ?? entry?.station ?? entry;
  return stationNameFromObject(stop) ??
    stationNameFromObject(entry?.station) ??
    firstText(entry?.name, entry?.stationName, entry?.stopName, entry?.displayName);
}

function journeyStopDateTime(entry: any, kind: "arrival" | "departure", actual: boolean): string | null {
  const event = entry?.[kind];
  const title = kind === "arrival" ? "Arrival" : "Departure";
  const titleLower = kind === "arrival" ? "arrival" : "departure";
  if (actual) {
    return firstDateTime(
      entry?.[`actual${title}DateTime`],
      entry?.[`actual${title}Time`],
      entry?.[`${titleLower}ActualDateTime`],
      event?.actualDateTime,
      event?.actualTime,
      entry?.[`actual${title}`]
    );
  }
  return firstDateTime(
    entry?.[`planned${title}DateTime`],
    entry?.[`planned${title}Time`],
    event?.plannedDateTime,
    event?.plannedTime,
    entry?.[`${titleLower}DateTime`],
    entry?.[`${titleLower}Time`],
    event?.dateTime,
    event?.time
  );
}

function delaySeconds(actual: string | null, planned: string | null): number | null {
  if (!actual || !planned) return null;
  const difference = Math.round((Date.parse(actual) - Date.parse(planned)) / 1000);
  return Number.isFinite(difference) ? difference : null;
}

function normalizeJourneyStop(
  entry: any,
  sequence: number,
  station: NsStationInfo,
  directCode: string,
  uicCode: string
): NsLiveTrainStop {
  const stopStatus = firstText(
    entry?.status,
    entry?.stopStatus,
    entry?.scheduleRelationship,
    entry?.arrivalStatus,
    entry?.departureStatus
  );
  const statusText = (stopStatus ?? "").toLowerCase();
  const plannedArrivalDateTime = journeyStopDateTime(entry, "arrival", false);
  const plannedDepartureDateTime = journeyStopDateTime(entry, "departure", false);
  const actualArrivalDateTime = journeyStopDateTime(entry, "arrival", true);
  const actualDepartureDateTime = journeyStopDateTime(entry, "departure", true);
  const platformValue = entry?.actualDepartureTrack ??
    entry?.plannedDepartureTrack ??
    entry?.actualArrivalTrack ??
    entry?.plannedArrivalTrack ??
    entry?.departurePlatform ??
    entry?.arrivalPlatform ??
    entry?.plannedTrack ??
    entry?.platform ??
    entry?.track;
  const platform = typeof platformValue === "object"
    ? firstText(platformValue?.name, platformValue?.code, platformValue?.number, platformValue?.label)
    : firstText(platformValue);

  return {
    sequence,
    stationCode: directCode || station.code,
    uicCode: uicCode || null,
    name: getJourneyStopName(entry) ?? station.name,
    plannedArrivalDateTime,
    plannedDepartureDateTime,
    actualArrivalDateTime,
    actualDepartureDateTime,
    arrivalDelaySeconds: delaySeconds(actualArrivalDateTime, plannedArrivalDateTime) ??
      (typeof entry?.arrivalDelaySeconds === "number" ? entry.arrivalDelaySeconds : null),
    departureDelaySeconds: delaySeconds(actualDepartureDateTime, plannedDepartureDateTime) ??
      (typeof entry?.departureDelaySeconds === "number" ? entry.departureDelaySeconds : null),
    platform,
    status: stopStatus,
    passing: truthy(entry?.passing ?? entry?.passThrough),
    cancelled: truthy(entry?.cancelled ?? entry?.canceled ?? entry?.skipped ?? entry?.cancelledStop) ||
      /cancel|annul|skip|vervallen/.test(statusText)
  };
}

function unwrap(value: any) {
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

function stationInfoFromPayload(input: any, requestedUic: string): NsStationInfo {
  const root = unwrap(input);

  const visit = (value: any, depth: number): NsStationInfo | null => {
    if (depth > 8 || value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;

    const id = value.id && typeof value.id === "object" ? value.id : {};
    const foundUic = normalizeUicCode(
      id.uicCode ?? id.uicCdCode ?? value.uicCode ?? value.uicCdCode
    );
    const code = normalizeStationCode(id.code ?? value.stationCode ?? value.code);
    const name = stationNameFromObject(value) ?? stationNameFromObject(id);

    if (foundUic === requestedUic && (code || name)) {
      return { code: code || null, name: name || null };
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const matched = visit(root, 0);
  if (matched) return matched;
  return { code: stationCodeFromPayload(input, requestedUic) || null, name: null };
}

async function resolveStationInfo(
  uicCode: string,
  env: NsLiveTrainRouteEnv,
  fetchImpl: typeof fetch
): Promise<NsStationInfo> {
  const cached = stationInfoCache.get(uicCode);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) stationInfoCache.delete(uicCode);

  const promise = (async () => {
    const url = new URL(NS_STATION_ROOT);
    url.searchParams.set("uicCode", uicCode);
    const payload = await requestJson(url, env, Math.round(STATION_CACHE_TTL_MS / 1000), fetchImpl);
    const info = stationInfoFromPayload(payload, uicCode);
    if (!info.code && !info.name) {
      throw new Error("NS_LIVE_TRAIN_ROUTE_STATION_UNRESOLVED_" + uicCode);
    }
    return info;
  })();

  stationInfoCache.set(uicCode, { expiresAt: Date.now() + STATION_CACHE_TTL_MS, promise });
  while (stationInfoCache.size > MAX_STATION_CACHE_ENTRIES) {
    const oldest = stationInfoCache.keys().next().value;
    if (oldest === undefined) break;
    stationInfoCache.delete(oldest);
  }
  try {
    return await promise;
  } catch (error) {
    if (stationInfoCache.get(uicCode)?.promise === promise) stationInfoCache.delete(uicCode);
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

  // Spoorkaart can return additional track features around a requested route.
  // A feature whose station pair is not one of the journey's adjacent stops
  // must never be inserted into the train line: ordering it by feature index
  // used to draw unrelated tracks and could make a train appear on the wrong
  // route. Only allow an unlabelled geometry when the response is a single
  // standalone route geometry, where there is no competing segment to guess.
  const hasStationPairMetadata = features.some((feature: any) => {
    const properties = feature?.properties ?? {};
    const from = properties.from ?? properties.fromCode;
    const to = properties.to ?? properties.toCode;
    return Boolean(normalizeStationCode(from) && normalizeStationCode(to));
  });

  const lines: Array<{ sequence: number; featureIndex: number; lineIndex: number; coordinates: number[][] }> = [];
  features.forEach((feature: any, featureIndex: number) => {
    const properties = feature?.properties ?? {};
    const from = properties.from ?? properties.fromCode;
    const to = properties.to ?? properties.toCode;
    const match = featurePairIndex(from, to, stationCodes);
    if (hasStationPairMetadata && !match) return;
    if (!hasStationPairMetadata && features.length > 1) return;

    const lineGeometries = lineCoordinates(feature?.geometry);
    lineGeometries.forEach((coordinates, lineIndex) => {
      const oriented = match?.reverse ? [...coordinates].reverse() : coordinates;
      lines.push({
        sequence: match?.index ?? 0,
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
      entry,
      uicCode: getStopUicCode(entry),
      directCode: getDirectStationCode(entry),
      name: getJourneyStopName(entry)
    }));

    // The NS journey endpoint is the source of the ordered station list and
    // timetable. Resolve station metadata once per UIC code, and retain the
    // timetable even if Spoorkaart cannot supply geometry for one section.
    const stationMetadata = await Promise.all(stopInfos.map(async stop => {
      if (stop.uicCode && (!stop.directCode || !stop.name)) {
        try {
          return await resolveStationInfo(stop.uicCode, env, fetchImpl);
        } catch {
          return { code: stop.directCode || null, name: stop.name || null };
        }
      }
      return { code: stop.directCode || null, name: stop.name || null };
    }));

    const normalizedStops = stopInfos.map((stop, index) =>
      normalizeJourneyStop(
        stop.entry,
        index,
        stationMetadata[index],
        stop.directCode,
        stop.uicCode
      )
    );

    const orderedStationCodes: string[] = [];
    const haveAllStationCodes = normalizedStops.every(stop => Boolean(stop.stationCode));
    if (haveAllStationCodes) {
      for (const stop of normalizedStops) {
        const code = stop.stationCode!;
        if (orderedStationCodes[orderedStationCodes.length - 1] !== code) {
          orderedStationCodes.push(code);
        }
      }
    }

    let legs: NsLiveTrainRouteLeg[] = [];
    let routeWarning: string | undefined;
    if (!haveAllStationCodes || orderedStationCodes.length < 2) {
      routeWarning = "Stations en geplande tijden zijn beschikbaar, maar niet alle stationscodes zijn beschikbaar om de spoorroute te tekenen.";
    } else {
      try {
        const trajectUrl = new URL(NS_TRAJECT_ROOT);
        trajectUrl.searchParams.set("stations", orderedStationCodes.join(","));
        const trajectPayload = await requestJson(trajectUrl, env, 86_400, fetchImpl);
        const lines = extractOrderedRouteLines(trajectPayload, orderedStationCodes);
        legs = lines.map((coordinates, sequence) => ({
          tripId: trainNumber,
          routeId: "NS-SPOORKAART-" + sequence,
          mode: "RAIL",
          sequence,
          legGeometry: { type: "LineString" as const, coordinates }
        }));
        if (!legs.length) {
          routeWarning = "Stations en geplande tijden zijn beschikbaar, maar NS leverde geen bruikbare spoorgeometrie terug.";
        }
      } catch {
        routeWarning = "Stations en geplande tijden zijn beschikbaar, maar de spoorroute kon tijdelijk niet worden opgehaald.";
      }
    }

    return {
      ok: true,
      source: "NS Reisinformatie + SpoorKaart API",
      trainNumber,
      dateTime,
      checkedAt: new Date().toISOString(),
      legs,
      stops: normalizedStops,
      ...(routeWarning ? { routeWarning } : {})
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
