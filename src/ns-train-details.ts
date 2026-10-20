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

function facilityBoolean(entries: Entry[], pattern: RegExp): boolean | null {
  for (const entry of entries) {
    if (!pattern.test(entry.key)) continue;
    const parsed = parseBoolean(entry.value);
    if (parsed !== null) return parsed;
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
    /aantal.*(bak|rijtuig|treindeel|unit|carriage|vehicle)/.test(entry.key)
  );
  const listedUnits = trainEntries.find(entry =>
    /^(bakken|rijtuigen|treindelen|trainunits|carriages|units)$/.test(entry.key) &&
    (Array.isArray(entry.value) || typeof entry.value === "number" ||
      (typeof entry.value === "string" && /^\s*\d+\s*$/.test(entry.value)))
  );
  const selectedUnits = explicitUnitCount ?? listedUnits;
  const unitCount = selectedUnits ? countValue(selectedUnits.value) : null;
  const unitLabel = selectedUnits
    ? /rijtuig|carriage/.test(selectedUnits.key)
      ? "rijtuigen"
      : /bak/.test(selectedUnits.key)
        ? "bakken"
        : "treindelen"
    : null;

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
    { key: "wifi", label: "Wifi", pattern: /wifi/ },
    { key: "rolstoel", label: "Rolstoeltoegankelijk", pattern: /rolstoel|wheelchair/ },
    { key: "fiets", label: "Fietsruimte", pattern: /fietsruimte|bikefacility|bikespace/ },
    { key: "stilte", label: "Stiltezone", pattern: /stiltezone|stiltecoupe|quietzone/ },
    { key: "stopcontact", label: "Stopcontacten", pattern: /stopcontact|poweroutlet/ }
  ];
  for (const definition of facilityDefinitions) {
    const available = facilityBoolean(trainEntries, definition.pattern);
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
  env: NsTrainDetailsEnv
): Promise<NsTrainDetailsSummary> {
  const number = asText(trainNumber);
  if (!/^\d{1,6}$/.test(number)) throw new Error("NS_TRAIN_DETAILS_INVALID_TRAIN_NUMBER");
  const key = asText(env.NS_API_SUBSCRIPTION_KEY);
  if (!key) throw new Error("NS_TRAIN_DETAILS_KEY_MISSING");

  const parsedDate = dateTime ? Date.parse(dateTime) : Number.NaN;
  const stableDateTime = Number.isFinite(parsedDate)
    ? new Date(parsedDate).toISOString()
    : "";
  const cacheKey = number + "|" + stableDateTime.slice(0, 16);
  const cached = detailsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    detailsCache.delete(cacheKey);
    detailsCache.set(cacheKey, cached);
    return cached.promise;
  }
  if (cached) detailsCache.delete(cacheKey);

  const promise = (async () => {
    const trainUrl = new URL(NS_ROOT + "/trein/" + number);
    trainUrl.searchParams.set("features", "zitplaats,platformitems,cta,drukte,druktev2");
    if (stableDateTime) trainUrl.searchParams.set("dateTime", stableDateTime);

    const crowdUrl = new URL(NS_ROOT + "/prognose/" + number);
    const [trainResult, crowdResult] = await Promise.allSettled([
      requestJson(trainUrl, env),
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

    return normalizeNsTrainDetails(
      trainData,
      crowdData,
      number,
      new Date().toISOString(),
      errors
    );
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
