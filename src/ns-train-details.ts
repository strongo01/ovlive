export interface NsTrainDetailsEnv {
  NS_API_SUBSCRIPTION_KEY?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  APP_CONTACT?: string;
}

export interface NsTrainFacility {
  key: string;
  label: string;
  available: boolean;
}

export interface NsTrainDetailsSummary {
  ok: boolean;
  source: "NS Virtual Train API";
  trainNumber: string;
  checkedAt: string;
  status: "available" | "partial" | "no_details";
  crowdForecast: { level: "low" | "medium" | "high" | "unknown"; label: string; rawValue: string } | null;
  trainType: string | null;
  composition: string | null;
  unitCount: number | null;
  unitLabel: string | null;
  lengthMeters: number | null;
  facilities: NsTrainFacility[];
  errors: string[];
  message: string | null;
  stationCode?: string | null;
  stationContextUsed?: boolean;
}

const NS_ROOT = "https://gateway.apiportal.ns.nl/virtual-train-api/v1";
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 80;

const detailsCache = new Map<string, { expiresAt: number; promise: Promise<NsTrainDetailsSummary> }>();

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: string): string {
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function unwrap(input: any): any {
  if (input && typeof input === "object") {
    if (input.payload !== undefined) return input.payload;
    if (input.data !== undefined) return input.data;
  }
  return input;
}

interface Entry {
  key: string;
  value: any;
}

function flatten(input: any, depth = 0, output: Entry[] = []): Entry[] {
  if (depth > 7 || input === null || input === undefined) return output;
  if (Array.isArray(input)) {
    input.forEach((item) => {
      if (item !== null && typeof item === "object") {
        flatten(item, depth + 1, output);
      }
    });
    return output;
  }
  if (typeof input !== "object") return output;

  for (const [rawKey, value] of Object.entries(input)) {
    const key = normalizeKey(rawKey);
    output.push({ key, value });
    if (value !== null && typeof value === "object") {
      flatten(value, depth + 1, output);
    }
  }
  return output;
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function findScalar(entries: Entry[], pattern: RegExp): { key: string; value: string } | null {
  for (const entry of entries) {
    if (!pattern.test(entry.key)) continue;
    const value = scalar(entry.value);
    if (value !== null) return { key: entry.key, value };
  }
  return null;
}

function countValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
    return Number(value.trim());
  }
  if (Array.isArray(value)) return value.length;
  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value !== "string") return null;
  const normalized = normalizeKey(value);
  if (["true", "yes", "ja", "aanwezig", "beschikbaar", "available"].includes(normalized)) return true;
  if (["false", "no", "nee", "afwezig", "nietaanwezig", "nietbeschikbaar", "unavailable"].includes(normalized)) return false;
  return null;
}

function crowdLabel(value: unknown): NsTrainDetailsSummary["crowdForecast"] {
  const rawValue = scalar(value);
  if (!rawValue) return null;
  const normalized = normalizeKey(rawValue);
  if (["unknown", "onbekend", "nvt", "na", "none", "null"].includes(normalized)) return null;

  if (/(^|)(low|laag|rustig|weinig|lagebezetting|lage drukte)/.test(normalized)) {
    return { level: "low", label: "Rustig", rawValue };
  }
  if (/(medium|normal|gemiddeld|matig|normaal|gemiddeldedrukte)/.test(normalized)) {
    return { level: "medium", label: "Gemiddelde drukte", rawValue };
  }
  if (/(high|hoog|druk|vol|hoge bezetting)/.test(normalized)) {
    return { level: "high", label: "Druk", rawValue };
  }
  return { level: "unknown", label: rawValue, rawValue };
}

function formatCrowdFromEntries(entries: Entry[]): NsTrainDetailsSummary["crowdForecast"] {
  const found = findScalar(
    entries,
    /crowdforecast|crowdlevel|crowdstatus|drukteprognose|verwachtedrukte|drukte|occupancystatus|prognose/
  );
  return found ? crowdLabel(found.value) : null;
}

const FACILITY_STATUS_KEYS =
  /^(available|beschikbaar|aanwezig|present|enabled|exists|isavailable|isbeschikbaar|isaanwezig|ispresent|beschikbaarheid|status|heeft|has)$/;
const FACILITY_NAME_KEYS =
  /^(type|name|label|code|feature|facility|voorziening|naam|id|item|omschrijving|description|titel)$/;

function explicitFacilityState(value: unknown, depth = 0): boolean | null {
  if (depth > 6 || value === null || value === undefined) return null;
  const direct = parseBoolean(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) {
    const states = value
      .map(item => explicitFacilityState(item, depth + 1))
      .filter((item): item is boolean => item !== null);
    if (states.includes(true)) return true;
    if (states.length && states.every(item => item === false)) return false;
    return null;
  }
  if (typeof value !== "object") return null;

  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (!FACILITY_STATUS_KEYS.test(normalizeKey(rawKey))) continue;
    const parsed = parseBoolean(child);
    if (parsed !== null) return parsed;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const nested = explicitFacilityState(child, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function isNegativeFacilityDescription(value: string): boolean {
  return /^(?:geen|niet|zonder|no|not|non|without|unavailable|afwezig|nietaanwezig)/.test(
    normalizeKey(value)
  );
}

function facilityTokenMatches(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== "string" || isNegativeFacilityDescription(value)) return false;
  return pattern.test(normalizeKey(value));
}

function facilityStateFromPayload(
  input: unknown,
  pattern: RegExp,
  depth = 0
): boolean | null {
  if (depth > 8 || input === null || input === undefined) return null;

  if (Array.isArray(input)) {
    // Sommige NS-features leveren voorzieningen als lijst met namen in plaats
    // van als { voorziening: true }. Een genoemd item betekent dat het aanwezig is.
    for (const item of input) {
      if (facilityTokenMatches(item, pattern)) return true;
      if (item && typeof item === "object") {
        const described = facilityStateFromPayload(item, pattern, depth + 1);
        if (described !== null) return described;
      }
    }
    return null;
  }

  if (typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const entries = Object.entries(record);

  // Prioriteit voor expliciete vlaggen: een false mag niet later door een
  // naam- of labelveld per ongeluk als true worden geïnterpreteerd.
  for (const [rawKey, value] of entries) {
    const key = normalizeKey(rawKey);
    if (!pattern.test(key)) continue;

    const direct = parseBoolean(value);
    if (direct !== null) return direct;

    if (typeof value === "number" && Number.isFinite(value) &&
        /aantal|count|quantity|number/.test(key)) {
      return value > 0;
    }

    if (Array.isArray(value)) {
      const nestedState = explicitFacilityState(value);
      if (nestedState !== null) return nestedState;
      if (value.some(item => facilityTokenMatches(item, pattern))) return true;
      if (value.length === 0) return false;
    } else if (value && typeof value === "object") {
      const nestedState = explicitFacilityState(value);
      if (nestedState !== null) return nestedState;
      // Een concreet object onder een expliciete toilet/wifi/etc.-sleutel
      // beschrijft die voorziening, tenzij het expliciet anders zegt.
      return Object.keys(value as Record<string, unknown>).length > 0;
    }
  }

  // In platformitems/CTA-achtige responses staat de voorziening soms in een
  // waarde zoals { type: "WC", beschikbaar: true } in plaats van in de sleutel.
  const descriptor = entries.some(([rawKey, value]) =>
    FACILITY_NAME_KEYS.test(normalizeKey(rawKey)) &&
    facilityTokenMatches(value, pattern)
  );
  if (descriptor) {
    const state = explicitFacilityState(record);
    return state ?? true;
  }

  // Ondersteun geneste objecten en arrays, inclusief train-delen met eigen
  // voorzieningen. Niet herkend betekent onbekend; er wordt niets afgeleid
  // uit alleen het materieeltype.
  for (const [, value] of entries) {
    const nested = facilityStateFromPayload(value, pattern, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

export function normalizeNsTrainDetails(
  trainInput: unknown,
  crowdInput: unknown,
  trainNumber: string,
  checkedAt = new Date().toISOString(),
  errors: string[] = []
): NsTrainDetailsSummary {
  const trainPayload = unwrap(trainInput);
  const crowdPayload = unwrap(crowdInput);
  const trainEntries = flatten(trainPayload);
  const crowdEntries = flatten(crowdPayload);

  let crowdForecast = formatCrowdFromEntries(crowdEntries);
  if (!crowdForecast && (typeof crowdPayload === "string" || typeof crowdPayload === "number")) {
    crowdForecast = crowdLabel(crowdPayload);
  }
  if (!crowdForecast) crowdForecast = formatCrowdFromEntries(trainEntries);

  const typeEntry =
    findScalar(trainEntries, /materieeltype|treinsteltype|treintype|materieelserie|rollingstocktype|trainmodel/) ??
    findScalar(trainEntries, /^(serie|model|materieel)$/);
  const trainType = typeEntry?.value ?? null;

  const explicitUnitCount = trainEntries.find(entry =>
    /aantal.*(bak|deel|rijtuig|unit|carriage|vehicle)/.test(entry.key)
  );
  const listedUnits = trainEntries.find(entry =>
    /^(delen|bakken|rijtuigen|treindelen|materieeldelen|trainunits|carriages|units)$/.test(entry.key) &&
    (Array.isArray(entry.value) || typeof entry.value === "number" ||
      (typeof entry.value === "string" && /^\s*\d+\s*$/.test(entry.value)))
  );
  const selectedUnits = explicitUnitCount ?? listedUnits;
  const unitCount = selectedUnits ? countValue(selectedUnits.value) : null;
  // NS beschrijft de opbouw als treindelen; gebruik dat woord ook als het
  // bronveld intern een andere naam heeft (bijvoorbeeld aantalBakken).
  const unitLabel = selectedUnits ? "delen" : null;

  const compositionEntry = findScalar(trainEntries, /^(samenstelling|composition|formation)$/);
  const composition = compositionEntry?.value ?? null;

  const lengthEntry = trainEntries.find(entry =>
    /^(trein)?lengte(in)?(meters?|m|cm|mm)$/.test(entry.key) ||
    /^length(in)?(meters?|m|cm|mm)$/.test(entry.key)
  );
  let lengthMeters: number | null = null;
  if (lengthEntry) {
    const numeric = Number(lengthEntry.value);
    if (Number.isFinite(numeric) && numeric > 0) {
      if (/(cm)$/.test(lengthEntry.key)) lengthMeters = numeric / 100;
      else if (/(mm)$/.test(lengthEntry.key)) lengthMeters = numeric / 1000;
      else lengthMeters = numeric;
      if (lengthMeters > 1000) lengthMeters = null;
      if (lengthMeters !== null) lengthMeters = Math.round(lengthMeters * 10) / 10;
    }
  }

  const facilities: NsTrainFacility[] = [];
  const facilityDefinitions: Array<{ key: string; label: string; pattern: RegExp }> = [
    { key: "toilet", label: "Toilet", pattern: /toilet|wc/ },
    { key: "wifi", label: "Wifi", pattern: /wifi|draadloosinternet/ },
    { key: "rolstoel", label: "Rolstoeltoegankelijk", pattern: /rolstoel|wheelchair|toegankelijk/ },
    { key: "fiets", label: "Fietsruimte", pattern: /fietsruimte|fiets|bicycle|bike/ },
    { key: "stilte", label: "Stiltezone", pattern: /stiltezone|stiltecoupe|quietzone|quietarea/ },
    { key: "stopcontact", label: "Stopcontacten / USB", pattern: /stopcontact|poweroutlet|usb|laadpunt|oplaadpunt/ },
    { key: "airco", label: "Airconditioning", pattern: /airco|airconditioning|klimaatregeling/ }
  ];
  for (const definition of facilityDefinitions) {
    const available = facilityStateFromPayload(trainPayload, definition.pattern);
    if (available !== null) {
      facilities.push({ key: definition.key, label: definition.label, available });
    }
  }

  const hasDetails = Boolean(
    crowdForecast || trainType || composition || unitCount !== null ||
    lengthMeters !== null || facilities.length
  );
  const successfulPayload = trainInput !== null && trainInput !== undefined ||
    crowdInput !== null && crowdInput !== undefined;

  return {
    ok: Boolean(successfulPayload),
    source: "NS Virtual Train API",
    trainNumber,
    checkedAt,
    status: hasDetails
      ? errors.length ? "partial" : "available"
      : "no_details",
    crowdForecast,
    trainType,
    composition,
    unitCount,
    unitLabel,
    lengthMeters,
    facilities,
    errors,
    message: hasDetails
      ? null
      : "De NS API leverde geen herkenbare drukte- of samenstellingsgegevens voor deze rit."
  };
}

function safeFailure(error: unknown): string {
  const message = asText(error instanceof Error ? error.message : error);
  const match = message.match(/NS_TRAIN_DETAILS_HTTP_(\d{3})/);
  if (match) return "HTTP " + match[1];
  if (/timeout|timed out|abort/i.test(message)) return "time-out";
  if (/INVALID_JSON/.test(message)) return "ongeldig antwoord";
  return "tijdelijk niet beschikbaar";
}

async function requestJson(url: URL, env: NsTrainDetailsEnv): Promise<any> {
  const key = asText(env.NS_API_SUBSCRIPTION_KEY);
  if (!key) throw new Error("NS_TRAIN_DETAILS_KEY_MISSING");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "Ocp-Apim-Subscription-Key": key,
      "user-agent":
        (env.APP_NAME || "OVLive") + "/" + (env.APP_VERSION || "0.1.0") +
        (env.APP_CONTACT ? " (" + env.APP_CONTACT + ")" : "")
    },
    signal: AbortSignal.timeout(9_000)
  });

  if (!response.ok) throw new Error("NS_TRAIN_DETAILS_HTTP_" + response.status);
  try {
    return await response.json();
  } catch {
    throw new Error("NS_TRAIN_DETAILS_INVALID_JSON");
  }
}

export async function fetchNsTrainDetails(
  trainNumber: string,
  dateTime: string | null | undefined,
  env: NsTrainDetailsEnv,
  stationCode?: string | null
): Promise<NsTrainDetailsSummary> {
  const number = asText(trainNumber);
  if (!/^\d{1,6}$/.test(number)) throw new Error("NS_TRAIN_DETAILS_INVALID_TRAIN_NUMBER");
  const key = asText(env.NS_API_SUBSCRIPTION_KEY);
  if (!key) throw new Error("NS_TRAIN_DETAILS_KEY_MISSING");
  const requestedStation = asText(stationCode).toUpperCase();
  if (requestedStation && !/^[A-Z0-9]{2,6}$/.test(requestedStation)) {
    throw new Error("NS_TRAIN_DETAILS_INVALID_STATION_CODE");
  }
  const stableStationCode = requestedStation || null;

  const parsedDate = dateTime ? Date.parse(dateTime) : Number.NaN;
  const stableDateTime = Number.isFinite(parsedDate)
    ? new Date(parsedDate).toISOString()
    : "";
  const cacheKey = number + "|" + stableDateTime.slice(0, 16) + "|" + (stableStationCode ?? "");
  const cached = detailsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    detailsCache.delete(cacheKey);
    detailsCache.set(cacheKey, cached);
    return cached.promise;
  }
  if (cached) detailsCache.delete(cacheKey);

  const promise = (async () => {
    const makeTrainUrl = (withStation: boolean): URL => {
      const path = NS_ROOT + "/trein/" + number +
        (withStation && stableStationCode ? "/" + stableStationCode : "");
      const trainUrl = new URL(path);
      trainUrl.searchParams.set("features", "zitplaats,platformitems,cta,drukte,druktev2");
      if (stableDateTime) trainUrl.searchParams.set("dateTime", stableDateTime);
      return trainUrl;
    };

    let stationContextUsed = false;
    const trainRequest = (async () => {
      if (stableStationCode) {
        try {
          const result = await requestJson(makeTrainUrl(true), env);
          stationContextUsed = true;
          return result;
        } catch (stationError) {
          // Sommige ritten hebben geen station-specifieke details. Probeer dan
          // de algemene ritgegevens, zodat samenstelling/lengte niet verloren gaan.
          try {
            return await requestJson(makeTrainUrl(false), env);
          } catch {
            throw stationError;
          }
        }
      }
      return requestJson(makeTrainUrl(false), env);
    })();

    const crowdUrl = new URL(NS_ROOT + "/prognose/" + number);
    const [trainResult, crowdResult] = await Promise.allSettled([
      trainRequest,
      requestJson(crowdUrl, env)
    ]);

    const trainData = trainResult.status === "fulfilled" ? trainResult.value : null;
    const crowdData = crowdResult.status === "fulfilled" ? crowdResult.value : null;
    const errors: string[] = [];
    if (trainResult.status === "rejected") {
      errors.push("Samenstelling: " + safeFailure(trainResult.reason));
    }
    if (crowdResult.status === "rejected") {
      errors.push("Drukteprognose: " + safeFailure(crowdResult.reason));
    }
    if (trainResult.status === "rejected" && crowdResult.status === "rejected") {
      const firstError = trainResult.reason instanceof Error
        ? trainResult.reason.message
        : String(trainResult.reason);
      throw new Error(firstError);
    }

    return {
      ...normalizeNsTrainDetails(
        trainData,
        crowdData,
        number,
        new Date().toISOString(),
        errors
      ),
      stationCode: stableStationCode,
      stationContextUsed: trainResult.status === "fulfilled" && stationContextUsed
    };
  })();

  detailsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  while (detailsCache.size > MAX_CACHE_ENTRIES) {
    const oldest = detailsCache.keys().next().value;
    if (oldest === undefined) break;
    detailsCache.delete(oldest);
  }
  try {
    return await promise;
  } catch (error) {
    if (detailsCache.get(cacheKey)?.promise === promise) detailsCache.delete(cacheKey);
    throw error;
  }
}
