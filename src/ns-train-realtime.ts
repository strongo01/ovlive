type NsEnv = {
  NS_API_SUBSCRIPTION_KEY?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  APP_CONTACT?: string;
};

const ROOT = "https://gateway.apiportal.ns.nl/reisinformatie-api";
const CACHE_TTL = 8_000;
const STATION_TTL = 6 * 60 * 60 * 1000;
const MATCH_TOLERANCE_MS = 180_000;

let stationCache: { until: number; promise: Promise<any[]> } | null = null;
const boardCache = new Map<string, { until: number; promise: Promise<any[]> }>();

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function normalizeName(value: unknown): string {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(treinstation|station)\s+/, "")
    .replace(/[.,]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// De live NS-stationslijst is een externe afhankelijkheid. Deze kleine
// reserve-index houdt de Utrecht Centraal–Terwijde-verbinding bruikbaar
// als alleen /api/v2/stations faalt; overige stations blijven fail-closed.
const FALLBACK_STATIONS = [
  {
    code: "UT",
    UICCode: "8400621",
    name: "Utrecht Centraal",
    longName: "Utrecht Centraal",
    namen: { lang: "Utrecht Centraal", middel: "Utrecht Centraal", kort: "Utrecht" },
    synoniemen: ["Utrecht CS", "Utrecht Centraal Station"]
  },
  {
    code: "UTT",
    UICCode: "8400614",
    name: "Utrecht Terwijde",
    longName: "Utrecht Terwijde",
    namen: { lang: "Utrecht Terwijde", middel: "Utrecht Terwijde", kort: "Terwijde" },
    synoniemen: ["Station Utrecht Terwijde"]
  }
];

function safeNsError(error: unknown): string {
  const message = text(error instanceof Error ? error.message : error);
  const http = message.match(/NS API HTTP (\\d{3})/i);
  if (http) return `HTTP ${http[1]}`;
  if (/NS_API_SUBSCRIPTION_KEY ontbreekt/i.test(message)) return "API-sleutel ontbreekt";
  if (/timeout|timed out|abort/i.test(message)) return "time-out";
  if (/onverwacht formaat/i.test(message)) return "onverwacht antwoordformaat";
  return "netwerk- of JSON-fout";
}

async function nsJson(
  path: string,
  params: Record<string, string>,
  env: NsEnv
): Promise<any> {
  const key = text(env.NS_API_SUBSCRIPTION_KEY);
  if (!key) throw new Error("NS_API_SUBSCRIPTION_KEY ontbreekt.");

  const url = new URL(`${ROOT}${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "Ocp-Apim-Subscription-Key": key,
      "user-agent":
        `${env.APP_NAME || "OVLive"}/${env.APP_VERSION || "0.1.0"}` +
        (env.APP_CONTACT ? ` (${env.APP_CONTACT})` : "")
    },
    signal: AbortSignal.timeout(12_000)
  });

  if (!response.ok) {
    throw new Error(`NS API HTTP ${response.status}.`);
  }
  return response.json();
}

async function getStations(env: NsEnv): Promise<any[]> {
  if (stationCache && stationCache.until > Date.now()) {
    return stationCache.promise;
  }

  const promise = (async () => {
    const data = await nsJson("/api/v2/stations", { lang: "nl" }, env);
    const rows = Array.isArray(data?.payload)
      ? data.payload
      : Array.isArray(data?.payload?.stations)
        ? data.payload.stations
        : Array.isArray(data?.stations)
          ? data.stations
          : null;

    if (!rows) throw new Error("Onverwacht formaat van de NS-stationslijst.");
    return rows;
  })();

  stationCache = { until: Date.now() + STATION_TTL, promise };

  try {
    return await promise;
  } catch (error) {
    if (stationCache?.promise === promise) stationCache = null;
    throw error;
  }
}

type StationIndex = {
  names: Map<string, Set<string>>;
  uics: Map<string, string>;
  codes: Set<string>;
};

function makeStationIndex(rows: any[]): StationIndex {
  const names = new Map<string, Set<string>>();
  const uics = new Map<string, string>();
  const codes = new Set<string>();

  for (const station of rows) {
    const code = text(station?.code ?? station?.stationCode).toUpperCase();
    if (!code) continue;
    codes.add(code);

    const n = station?.namen ?? station?.names ?? {};
    const synonyms = Array.isArray(station?.synoniemen)
      ? station.synoniemen
      : typeof station?.synoniemen === "string"
        ? [station.synoniemen]
        : Array.isArray(station?.synonyms)
          ? station.synonyms
          : [];

    const aliases = [
      station?.name, station?.longName, station?.mediumName,
      station?.shortName, n?.lang, n?.middel, n?.kort,
      n?.long, n?.medium, n?.short, ...synonyms
    ];

    for (const alias of aliases) {
      const name = normalizeName(alias);
      if (!name) continue;
      if (!names.has(name)) names.set(name, new Set());
      names.get(name)!.add(code);
    }

    const uic = text(
      station?.UICCode ?? station?.uicCode ?? station?.uiccode
    );
    if (uic) uics.set(uic, code);
  }

  return { names, uics, codes };
}

function getStationCode(place: any, stations: StationIndex): string | null {
  const direct = text(
    place?.stationCode ?? place?.station?.code ?? place?.code
  ).toUpperCase();

  if (direct && stations.codes.has(direct)) return direct;

  const uic = text(
    place?.uicCode ?? place?.UICCode ??
    place?.station?.uicCode ?? place?.station?.UICCode
  );

  if (uic && stations.uics.has(uic)) return stations.uics.get(uic)!;

  for (const alias of [
    place?.name, place?.station?.name, place?.stationName, place?.stopName
  ]) {
    const matches = stations.names.get(normalizeName(alias));
    if (matches?.size === 1) return [...matches][0];
  }

  return null;
}

function getLegs(plan: any): any[] {
  const containers = [
    ...(Array.isArray(plan?.itineraries) ? plan.itineraries : []),
    ...(Array.isArray(plan?.connections) ? plan.connections : []),
    ...(Array.isArray(plan?.journeys) ? plan.journeys : [])
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
  return legs;
}

function isRail(leg: any): boolean {
  return [
    "RAIL", "REGIONAL_RAIL", "LONG_DISTANCE", "HIGH_SPEED_RAIL", "TRAIN"
  ].includes(String(leg?.mode ?? "").toUpperCase());
}

function nsTrainNumber(leg: any, outcomes: any[]): string | null {
  const tripId = text(leg?.tripId ?? leg?.trip?.id);
  const match = outcomes.find((item: any) => text(item?.tripId) === tripId);

  if (!match || match.source !== "openov-route-crossmatch") return null;

  if (![
    "exact_route_time_stop_match",
    "exact_openov_trip_id_match",
    "resolved_by_exact_trip_id_crosswalk"
  ].includes(String(match.reason ?? ""))) return null;

  const identity = match.parsedIdentity;
  if (text(identity?.owner).toUpperCase() !== "IFF") return null;

  const number = text(identity?.journey);
  return /^\d+$/.test(number) ? number : null;
}

async function getBoard(
  env: NsEnv,
  kind: "departures" | "arrivals",
  station: string,
  plannedMs: number
): Promise<any[]> {
  const minute = Math.floor(plannedMs / 60_000);
  const cacheKey = `${kind}|${station}|${minute}`;
  const existing = boardCache.get(cacheKey);
  if (existing && existing.until > Date.now()) return existing.promise;

  const promise = (async () => {
    const data = await nsJson(`/api/v2/${kind}`, {
      station,
      dateTime: new Date(plannedMs).toISOString(),
      maxJourneys: "20",
      lang: "nl"
    }, env);
    const payload = data?.payload ?? data;
    const rows = payload?.[kind];

    if (!Array.isArray(rows)) {
      throw new Error(`Onverwacht formaat van NS-${kind}.`);
    }
    return rows;
  })();

  boardCache.set(cacheKey, { until: Date.now() + CACHE_TTL, promise });

  try {
    return await promise;
  } catch (error) {
    if (boardCache.get(cacheKey)?.promise === promise) {
      boardCache.delete(cacheKey);
    }
    throw error;
  }
}


export function selectJourneyEventFromStops(
  stops: any[],
  trainNumber: string,
  stationCode: string,
  stations: { uics: Map<string, string> },
  plannedEventMs: number,
  kind: "departure" | "arrival"
): any | null {
  const candidates: Array<{ row: any; diff: number }> = [];
  const collectionKey = kind === "departure" ? "departures" : "arrivals";

  for (const stop of stops) {
    const place = stop?.stop ?? stop?.station ?? {};
    const uic = text(place?.uicCode ?? place?.UICCode);
    const resolvedCode = stations.uics.get(uic);
    const stopCode = (
      resolvedCode ?? text(place?.code ?? place?.stationCode)
    ).toUpperCase();

    // Alleen de exacte herkomst/bestemming uit dit reisplan accepteren.
    if (stopCode !== stationCode) continue;

    const eventRows = Array.isArray(stop?.[collectionKey])
      ? stop[collectionKey]
      : [];

    for (const row of eventRows) {
      const number = text(row?.product?.number ?? row?.trainNumber);
      if (number !== trainNumber) continue;

      // Reisdetails gebruiken plannedTime/actualTime; borden gebruiken
      // plannedDateTime/actualDateTime.
      const plannedValue = row?.plannedTime ?? row?.plannedDateTime;
      const actualValue = row?.actualTime ?? row?.actualDateTime;
      const planned = toMs(plannedValue);
      if (planned === null) continue;

      const diff = Math.abs(planned - plannedEventMs);
      if (diff > MATCH_TOLERANCE_MS) continue;

      candidates.push({
        row: {
          ...row,
          plannedDateTime: plannedValue,
          actualDateTime: actualValue ?? null
        },
        diff
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.diff - b.diff);

  // Bij een even goede dubbele match niet gokken.
  if (
    candidates.length > 1 &&
    candidates[0].diff === candidates[1].diff
  ) {
    return null;
  }

  return candidates[0].row;
}

async function getJourneyStops(
  env: NsEnv,
  trainNumber: string,
  departureMs: number
): Promise<any[]> {
  const data = await nsJson("/api/v2/journey", {
    train: trainNumber,
    dateTime: new Date(departureMs).toISOString(),
    lang: "nl"
  }, env);

  const body = data?.payload ?? data;
  return Array.isArray(body?.stops) ? body.stops : [];
}

function selectBoardRow(
  rows: any[],
  trainNumber: string,
  plannedMs: number
): any | null {
  const candidates = rows
    .filter((row: any) => {
      const number = text(row?.product?.number ?? row?.trainNumber);
      const rowMs = toMs(row?.plannedDateTime);
      return number === trainNumber &&
        rowMs !== null &&
        Math.abs(rowMs - plannedMs) <= MATCH_TOLERANCE_MS;
    })
    .map((row: any) => ({
      row,
      diff: Math.abs((toMs(row?.plannedDateTime) ?? 0) - plannedMs)
    }))
    .sort((a: any, b: any) => a.diff - b.diff);

  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].diff === candidates[1].diff) {
    return null;
  }
  return candidates[0].row;
}

export function eventFrom(row: any, kind: "departure" | "arrival"): any {
  if (!row) return null;

  const plannedMs = toMs(row?.plannedDateTime);
  const actualMs = toMs(row?.actualDateTime);
  const cancelled = row?.cancelled === true;
  const status = row?.[
    kind === "departure" ? "departureStatus" : "arrivalStatus"
  ] ?? null;
  const normalizedStatus = text(status).toUpperCase();
  const hasKnownStatus = Boolean(
    normalizedStatus && normalizedStatus !== "UNKNOWN"
  );

  const reportedDelay =
    typeof row?.delayInSeconds === "number" &&
    Number.isFinite(row.delayInSeconds)
      ? row.delayInSeconds
      : null;

  const differenceMs =
    plannedMs !== null && actualMs !== null
      ? actualMs - plannedMs
      : null;

  // Gelijke tijden zijn niet zelfstandig bewijs van een actuele
  // prognose als de NS-status ontbreekt of UNKNOWN is.
  const unconfirmedScheduleEcho =
    !cancelled &&
    differenceMs !== null &&
    Math.abs(differenceMs) < 1000 &&
    !hasKnownStatus &&
    reportedDelay === null;

  let delaySeconds: number | null = null;

  if (!cancelled) {
    if (reportedDelay !== null) {
      delaySeconds = reportedDelay;
    } else if (differenceMs !== null && Math.abs(differenceMs) >= 1000) {
      delaySeconds = Math.round(differenceMs / 1000);
  }
  }

  const usableActualMs = unconfirmedScheduleEcho ? null : actualMs;

  return {
    source: "NS Reisinformatie API",
    time: !cancelled && usableActualMs !== null
      ? new Date(usableActualMs).toISOString()
      : null,
    plannedTime: plannedMs !== null
      ? new Date(plannedMs).toISOString()
      : null,
    actualTime: usableActualMs !== null
      ? new Date(usableActualMs).toISOString()
      : null,
    delaySeconds,
    cancelled,
    plannedTrack: row?.plannedTrack ?? null,
    actualTrack: row?.actualTrack ?? null,
    track: row?.actualTrack ?? row?.plannedTrack ?? null,
    platformChange: row?.platformChange === true ||
      Boolean(row?.actualTrack && row?.plannedTrack &&
        String(row.actualTrack) !== String(row.plannedTrack)),
    status
  };
}

export function hasKnownPunctualityDeviation(event: any): boolean {
  return Boolean(
    event &&
    event.cancelled !== true &&
    typeof event.delaySeconds === "number" &&
    Number.isFinite(event.delaySeconds)
  );
}

function scheduledMs(leg: any, kind: "departure" | "arrival"): number | null {
  const place = kind === "departure" ? leg?.from : leg?.to;
  const value = kind === "departure"
    ? place?.scheduledDeparture ?? leg?.scheduledStartTime ??
      place?.departure ?? leg?.startTime
    : place?.scheduledArrival ?? leg?.scheduledEndTime ??
      place?.arrival ?? leg?.endTime;
  return toMs(value);
}

function markUnknown(leg: any, number: string | null, message: string): void {
  leg.nsRealtime = {
    source: "NS Reisinformatie API",
    status: "unknown",
    trainNumber: number,
    message,
    departure: null,
    arrival: null
  };
}

export async function enrichNsTrainPlan(plan: any, env: NsEnv): Promise<any> {
  const legs = getLegs(plan).filter(isRail);
  const outcomes = Array.isArray(plan?.ndovRealtimeMeta?.routeCrosswalkOutcomes)
    ? plan.ndovRealtimeMeta.routeCrosswalkOutcomes
    : [];

  const candidates = legs
    .map((leg: any) => ({ leg, number: nsTrainNumber(leg, outcomes) }))
    .filter((item: any) => item.number !== null);

  plan.nsRealtimeMeta = {
    source: "NS Reisinformatie API",
    status: candidates.length ? "unknown" : "not_applicable",
    checkedAt: new Date().toISOString(),
    candidateLegCount: candidates.length,
    matchedLegCount: 0,
    departureMatchedLegCount: 0,
    arrivalMatchedLegCount: 0,
    departureDeviationKnownLegCount: 0,
    arrivalDeviationKnownLegCount: 0,
    partlyUnknownDeviationLegCount: candidates.length,
    cancelledLegCount: 0,
    unknownLegCount: candidates.length,
    message: candidates.length
      ? "NS-treinen worden gecontroleerd op treinnummer, station en geplande tijd."
      : "Geen exact gekruisverwezen NS-treinnummer gevonden.",
    stationLookupSource: "not_checked",
    stationListError: null
  };

  // Een rit zonder betrouwbaar NS-treinnummer krijgt geen OpenOV-fallback
  // als de route wel aan een IFF/NS-rit is gekoppeld.
  if (!candidates.length) return plan;

  if (!text(env.NS_API_SUBSCRIPTION_KEY)) {
    for (const item of candidates) {
      markUnknown(item.leg, item.number,
        "De NS-API-sleutel ontbreekt in de lokale Worker-configuratie.");
    }
    plan.nsRealtimeMeta.status = "unavailable";
    plan.nsRealtimeMeta.message = "NS_API_SUBSCRIPTION_KEY ontbreekt.";
    return plan;
  }

  let stations: StationIndex;
  let stationLookupSource = "ns_api";
  let stationListError: string | null = null;
  try {
    stations = makeStationIndex(await getStations(env));
  } catch (error) {
    stationLookupSource = "builtin_fallback";
    stationListError = safeNsError(error);
    stations = makeStationIndex(FALLBACK_STATIONS);
    plan.nsRealtimeMeta.stationLookupSource = stationLookupSource;
    plan.nsRealtimeMeta.stationListError = stationListError;
    plan.nsRealtimeMeta.stationListFallbackStationCount = FALLBACK_STATIONS.length;
  }
  plan.nsRealtimeMeta.stationLookupSource = stationLookupSource;
  plan.nsRealtimeMeta.stationListError = stationListError;

  const results = await Promise.all(candidates.map(async (item: any) => {
    const leg = item.leg;
    const number = item.number as string;
    const fromCode = getStationCode(leg?.from, stations);
    const toCode = getStationCode(leg?.to, stations);
    const departMs = scheduledMs(leg, "departure");
    const arriveMs = scheduledMs(leg, "arrival");

    if (!fromCode || !toCode || departMs === null || arriveMs === null) {
      const unresolved = [
        !fromCode ? `vertrekstation (${text(leg?.from?.name ?? leg?.from?.stationName) || "onbekend"})` : null,
        !toCode ? `aankomststation (${text(leg?.to?.name ?? leg?.to?.stationName) || "onbekend"})` : null,
        departMs === null || arriveMs === null ? "geplande tijd" : null
      ].filter(Boolean).join(", ");
      const diagnostic = stationLookupSource === "builtin_fallback"
        ? ` NS-stationslijst faalde (${stationListError}); voor deze halte bestaat geen lokale reservekoppeling.`
        : "";
      markUnknown(leg, number,
        `NS-match niet mogelijk: ${unresolved} ontbreekt of kan niet worden gekoppeld.${diagnostic}`);
      leg.nsRealtime.stationLookupSource = stationLookupSource;
      leg.nsRealtime.stationListError = stationListError;
      return { matched: false, dep: false, arr: false, cancelled: false, depDeviationKnown: false, arrDeviationKnown: false };
    }

    try {
      const [departures, arrivals] = await Promise.all([
        getBoard(env, "departures", fromCode, departMs),
        getBoard(env, "arrivals", toCode, arriveMs)
      ]);

      let depRow = selectBoardRow(departures, number, departMs);
      let arrRow = selectBoardRow(arrivals, number, arriveMs);
      let departure = eventFrom(depRow, "departure");
      let arrival = eventFrom(arrRow, "arrival");
      let departureUsedJourney = false;
      let arrivalUsedJourney = false;

      // De vertrek-/aankomstborden bevatten soms alleen de geplande tijd
      // en geen delayInSeconds. Vraag dan één keer de volledige NS-reis op
      // en zoek daarin de juiste halte + trein + geplande tijd.
      const needsDepartureJourney =
        departure?.cancelled !== true &&
        (!depRow || !hasKnownPunctualityDeviation(departure));
      const needsArrivalJourney =
        arrival?.cancelled !== true &&
        (!arrRow || !hasKnownPunctualityDeviation(arrival));

      if (needsDepartureJourney || needsArrivalJourney) {
        try {
          const journeyStops = await getJourneyStops(env, number, departMs);

          if (needsDepartureJourney) {
            const journeyDeparture = selectJourneyEventFromStops(
              journeyStops, number, fromCode, stations, departMs, "departure"
            );
            if (journeyDeparture) {
              const journeyEvent = eventFrom(journeyDeparture, "departure");
              // Vervang een bestaande bordregel alleen als reisdetails
              // daadwerkelijk een afwijking (ook expliciet 0 seconden) geven.
              if (!depRow || hasKnownPunctualityDeviation(journeyEvent)) {
                depRow = journeyDeparture;
                departure = journeyEvent;
                departureUsedJourney = true;
              }
            }
          }

          if (needsArrivalJourney) {
            const journeyArrival = selectJourneyEventFromStops(
              journeyStops, number, toCode, stations, arriveMs, "arrival"
            );
            if (journeyArrival) {
              const journeyEvent = eventFrom(journeyArrival, "arrival");
              if (!arrRow || hasKnownPunctualityDeviation(journeyEvent)) {
                arrRow = journeyArrival;
                arrival = journeyEvent;
                arrivalUsedJourney = true;
              }
            }
          }
        } catch {
          // Behoud elke bruikbare bordmatch als reisdetails niet beschikbaar zijn.
        }
      }

      const cancelled =
        departure?.cancelled === true || arrival?.cancelled === true;
      const matched = Boolean(depRow || arrRow);

      leg.nsRealtime = {
        source: "NS Reisinformatie API",
        status: cancelled ? "cancelled" : matched ? "matched" : "unknown",
        trainNumber: number,
        checkedAt: new Date().toISOString(),
        stationLookupSource,
        stationListError,
        matchMethod: departureUsedJourney || arrivalUsedJourney
          ? "NS-reisdetails: treinnummer + stationcode + geplande tijd binnen 3 minuten"
          : "NS-treinnummer + stationcode + geplande tijd binnen 3 minuten",
        departure,
        arrival,
        message: matched
          ? null
          : `Geen unieke NS-vertrek- of aankomstregel bij deze trein gevonden.${stationLookupSource === "builtin_fallback" ? ` Lokale stationcodes gebruikt; NS-stationslijst faalde (${stationListError}).` : ""}`
      };

      return {
        matched,
        dep: Boolean(depRow),
        arr: Boolean(arrRow),
        cancelled,
        depDeviationKnown: hasKnownPunctualityDeviation(departure),
        arrDeviationKnown: hasKnownPunctualityDeviation(arrival)
      };
    } catch (error) {
      const boardError = safeNsError(error);
      const stationWarning = stationLookupSource === "builtin_fallback"
        ? ` Stationcodes kwamen uit de lokale reservekoppeling omdat de NS-stationslijst faalde (${stationListError}).`
        : "";
      markUnknown(leg, number,
        `NS-vertrek-/aankomstgegevens niet beschikbaar (${boardError}).${stationWarning}`);
      leg.nsRealtime.stationLookupSource = stationLookupSource;
      leg.nsRealtime.stationListError = stationListError;
      leg.nsRealtime.boardError = boardError;
      return { matched: false, dep: false, arr: false, cancelled: false, depDeviationKnown: false, arrDeviationKnown: false };
    }
  }));

  const meta = plan.nsRealtimeMeta;
  meta.checkedAt = new Date().toISOString();
  meta.matchedLegCount = results.filter((r: any) => r.matched).length;
  meta.departureMatchedLegCount = results.filter((r: any) => r.dep).length;
  meta.arrivalMatchedLegCount = results.filter((r: any) => r.arr).length;
  meta.cancelledLegCount = results.filter((r: any) => r.cancelled).length;
  meta.unknownLegCount = results.filter((r: any) => !r.matched).length;
  meta.departureDeviationKnownLegCount =
    results.filter((r: any) => r.depDeviationKnown).length;
  meta.arrivalDeviationKnownLegCount =
    results.filter((r: any) => r.arrDeviationKnown).length;
  meta.partlyUnknownDeviationLegCount = results.filter(
    (r: any) => !r.cancelled &&
      (!r.depDeviationKnown || !r.arrDeviationKnown)
  ).length;
  meta.status = meta.matchedLegCount ? "ok" : "unknown";
  meta.message = meta.matchedLegCount
    ? `NS leverde unieke bordmatches voor ${meta.matchedLegCount} van ${candidates.length} treinreisdelen.`
    : "Geen unieke NS-bordmatch gevonden; de geplande tijden blijven staan.";

  return plan;
}
