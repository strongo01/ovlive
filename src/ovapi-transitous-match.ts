/**
 * Isolated diagnostic endpoint for candidate matching between a Transitous leg
 * and KV78turbo/OVAPI. It does not change /api/plan responses or OpenOV status.
 */
const OVAPI_BASE = "http://v0.ovapi.nl";
const USER_AGENT = "OVLive/0.3.0 (isolated Transitous-OVAPI matching diagnostics)";
const CACHE_TTL_SECONDS = 60;
const FRESHNESS_THRESHOLD_SECONDS = 300;
const MAX_BODY_CHARS = 40_000;
const MAX_LEGS = 10;
const SCHEDULE_TOLERANCE_SECONDS = 240;

type Obj = Record<string, any>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function safeText(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value);
}

function validateCode(value: unknown, label: string): string {
  const code = String(value ?? "").trim();
  if (!code || code.length > 80 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error(`Ongeldige ${label}. Gebruik alleen letters, cijfers, _ en -.`);
  }
  return code;
}

async function fetchArea(code: string): Promise<any> {
  const path = `/stopareacode/${encodeURIComponent(code)}/departures`;
  const response = await fetch(`${OVAPI_BASE}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
      "accept-encoding": "gzip"
    },
    signal: AbortSignal.timeout(15_000),
    cf: { cacheEverything: true, cacheTtl: CACHE_TTL_SECONDS }
  } as RequestInit & { cf: { cacheEverything: boolean; cacheTtl: number } });

  if (!response.ok) {
    throw new Error(`OVAPI gaf HTTP ${response.status} terug voor haltegebied ${code}.`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OVAPI gaf ongeldige JSON terug voor haltegebied ${code}.`);
  }
}

function updateFreshness(lastUpdate: string | null): { ageSeconds: number | null; freshness: string } {
  if (!lastUpdate) return { ageSeconds: null, freshness: "unknown" };
  const ms = Date.parse(lastUpdate);
  if (!Number.isFinite(ms)) return { ageSeconds: null, freshness: "unknown" };
  const ageSeconds = Math.round((Date.now() - ms) / 1000);
  if (ageSeconds < -120) return { ageSeconds, freshness: "clock_skew" };
  return ageSeconds <= FRESHNESS_THRESHOLD_SECONDS
    ? { ageSeconds, freshness: "recent" }
    : { ageSeconds, freshness: "stale" };
}

/** Converts an ISO timestamp to wall-clock fields in the Netherlands timezone. */
function amsterdamDateTime(value: unknown): { date: string; wallSeconds: number; clock: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  const wallSeconds = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    wallSeconds,
    clock: `${values.hour}:${values.minute}:${values.second}`
  };
}

/** OVAPI target times are local wall-clock strings without an explicit offset. */
function ovapiLocalDateTime(value: unknown): { date: string; wallSeconds: number; clock: string } | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, yearS, monthS, dayS, hourS, minuteS, secondS = "00"] = match;
  const year = Number(yearS), month = Number(monthS), day = Number(dayS);
  const hour = Number(hourS), minute = Number(minuteS), second = Number(secondS);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  return {
    date: `${yearS}-${monthS}-${dayS}`,
    wallSeconds: Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000),
    clock: `${hourS}:${minuteS}:${secondS}`
  };
}

function collectPasses(root: any): Obj[] {
  const output: Obj[] = [];
  const interesting = ["ExpectedDepartureTime", "TargetDepartureTime", "ExpectedArrivalTime", "TargetArrivalTime", "TripStopStatus"];
  const walk = (value: any, inheritedStop: string | null): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const stopName = safeText(value.TimingPointName) ?? safeText(value.Stop?.TimingPointName) ?? inheritedStop;
    if (interesting.some(key => Object.prototype.hasOwnProperty.call(value, key))) {
      output.push({ ...value, __stopName: stopName });
      return;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child, stopName);
    }
  };
  walk(root, null);
  return output;
}

function normalizeRow(pass: Obj, area: string): Obj {
  const targetTime = safeText(pass.TargetDepartureTime) ?? safeText(pass.TargetArrivalTime);
  const sourceExpectedTime = safeText(pass.ExpectedDepartureTime) ?? safeText(pass.ExpectedArrivalTime);
  const lastUpdate = safeText(pass.LastUpdateTimeStamp);
  const status = safeText(pass.TripStopStatus);
  const statusUpper = String(status ?? "").toUpperCase();
  const cancelled = statusUpper.includes("CANCEL") || statusUpper.includes("DELETED");
  const freshness = updateFreshness(lastUpdate);
  let rawDifferenceSeconds: number | null = null;
  const expectedLocal = ovapiLocalDateTime(sourceExpectedTime);
  const targetLocal = ovapiLocalDateTime(targetTime);
  if (expectedLocal && targetLocal) rawDifferenceSeconds = expectedLocal.wallSeconds - targetLocal.wallSeconds;
  const isRecent = freshness.freshness === "recent";
  const plannedButUnconfirmed = statusUpper.includes("PLANNED") && rawDifferenceSeconds === 0;
  const currentCancellation = isRecent && cancelled;
  const differenceSeconds = isRecent && !cancelled && !plannedButUnconfirmed ? rawDifferenceSeconds : null;

  return {
    area,
    stop: safeText(pass.TimingPointName) ?? safeText(pass.__stopName) ?? safeText(pass.UserStopCode),
    line: safeText(pass.LinePublicNumber) ?? safeText(pass.LinePlanningNumber),
    destination: safeText(pass.DestinationName50),
    operationDate: safeText(pass.OperationDate),
    dataOwner: safeText(pass.DataOwnerCode),
    planningNumber: safeText(pass.LinePlanningNumber),
    journeyNumber: safeText(pass.JourneyNumber),
    targetTime,
    sourceExpectedTime,
    expectedTime: isRecent && !cancelled ? sourceExpectedTime : null,
    differenceSeconds,
    sourceDifferenceSeconds: rawDifferenceSeconds,
    status,
    cancelled,
    currentCancellation,
    lastUpdate,
    updateAgeSeconds: freshness.ageSeconds,
    updateFreshness: freshness.freshness
  };
}

function uniqueIdentity(row: Obj): string | null {
  const parts = [row.operationDate, row.dataOwner, row.planningNumber, row.journeyNumber];
  if (parts.some(v => typeof v !== "string" || !v.trim())) return null;
  return parts.join("|");
}

function safeSummary(row: Obj): Obj {
  return {
    stop: row.stop,
    area: row.area,
    line: row.line,
    destination: row.destination,
    operationDate: row.operationDate,
    dataOwner: row.dataOwner,
    planningNumber: row.planningNumber,
    journeyNumber: row.journeyNumber,
    targetTime: row.targetTime,
    expectedTime: row.expectedTime,
    sourceExpectedTime: row.sourceExpectedTime,
    differenceSeconds: row.differenceSeconds,
    sourceDifferenceSeconds: row.sourceDifferenceSeconds,
    status: row.status,
    cancelled: row.cancelled,
    currentCancellation: row.currentCancellation,
    lastUpdate: row.lastUpdate,
    updateAgeSeconds: row.updateAgeSeconds,
    updateFreshness: row.updateFreshness
  };
}

function groupByIdentity(rows: Obj[], line: string, date: string): Map<string, Obj[]> {
  const map = new Map<string, Obj[]>();
  for (const row of rows) {
    if (String(row.line ?? "") !== line) continue;
    if (row.operationDate !== date) continue;
    const id = uniqueIdentity(row);
    if (!id) continue;
    map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
}

function compareLeg(leg: Obj, fromRows: Obj[], toRows: Obj[], fromCode: string, toCode: string): Obj {
  const line = String(leg.line ?? "").trim();
  const depart = amsterdamDateTime(leg.departure);
  const arrive = amsterdamDateTime(leg.arrival);
  if (!/^\d{1,8}[A-Za-z]?$/.test(line) || !depart || !arrive) {
    return { ...leg, fromArea: fromCode, toArea: toCode, status: "invalid_leg", candidates: [], note: "Lijnnummer of geplande vertrek-/aankomsttijd ontbreekt of is ongeldig." };
  }
  if (depart.date !== arrive.date) {
    return { ...leg, fromArea: fromCode, toArea: toCode, status: "cross_midnight_not_supported", candidates: [], note: "Deze test vergelijkt alleen ritsegmenten waarvan vertrek en aankomst op dezelfde lokale datum vallen." };
  }

  const fromMap = groupByIdentity(fromRows, line, depart.date);
  const toMap = groupByIdentity(toRows, line, arrive.date);
  const allIds = new Set([...fromMap.keys(), ...toMap.keys()]);
  const candidates: Obj[] = [];
  for (const id of allIds) {
    const aRows = fromMap.get(id) ?? [];
    const bRows = toMap.get(id) ?? [];
    // Refuse duplicated or incomplete identities at either mapped stop.
    if (aRows.length !== 1 || bRows.length !== 1) continue;
    const from = aRows[0], to = bRows[0];
    const fromTarget = ovapiLocalDateTime(from.targetTime);
    const toTarget = ovapiLocalDateTime(to.targetTime);
    if (!fromTarget || !toTarget) continue;
    const departureOffsetSeconds = fromTarget.wallSeconds - depart.wallSeconds;
    const arrivalOffsetSeconds = toTarget.wallSeconds - arrive.wallSeconds;
    if (Math.abs(departureOffsetSeconds) > SCHEDULE_TOLERANCE_SECONDS || Math.abs(arrivalOffsetSeconds) > SCHEDULE_TOLERANCE_SECONDS) continue;
    if (from.operationDate !== to.operationDate || from.dataOwner !== to.dataOwner || from.planningNumber !== to.planningNumber || from.journeyNumber !== to.journeyNumber) continue;
    if (from.destination && to.destination && from.destination !== to.destination) continue;
    const predictionFresh = from.updateFreshness === "recent" && to.updateFreshness === "recent";
    const trustedCurrentDelay = predictionFresh && from.differenceSeconds !== null && to.differenceSeconds !== null && !from.cancelled && !to.cancelled;
    candidates.push({
      identity: id,
      journeyNumber: from.journeyNumber,
      planningNumber: from.planningNumber,
      dataOwner: from.dataOwner,
      operationDate: from.operationDate,
      line: from.line,
      destination: from.destination ?? to.destination,
      departureScheduleOffsetSeconds: departureOffsetSeconds,
      arrivalScheduleOffsetSeconds: arrivalOffsetSeconds,
      scoreSeconds: Math.abs(departureOffsetSeconds) + Math.abs(arrivalOffsetSeconds),
      currentRealtimeAvailableAtBothStops: predictionFresh,
      reliableDelayAtBothStops: trustedCurrentDelay,
      from: safeSummary(from),
      to: safeSummary(to)
    });
  }

  candidates.sort((a, b) => a.scoreSeconds - b.scoreSeconds);
  if (candidates.length === 1) {
    const match = candidates[0];
    return {
      ...leg,
      fromArea: fromCode,
      toArea: toCode,
      status: "unique_schedule_candidate",
      match,
      candidates: [match],
      note: match.reliableDelayAtBothStops
        ? "Unieke kandidaat op basis van lijn, datum, dezelfde OVAPI-ritidentiteit op beide haltes en geplande tijden binnen 4 minuten. Beide OVAPI-updates zijn recent. Dit is nog een cross-source kandidaat, geen formeel gedeelde rit-ID."
        : "Unieke dienstregelingskandidaat op basis van lijn, datum, dezelfde OVAPI-ritidentiteit op beide haltes en geplande tijden binnen 4 minuten. De realtimevertraging is niet op beide haltes betrouwbaar beschikbaar. Dit is geen formeel gedeelde rit-ID."
    };
  }
  if (candidates.length > 1) {
    return {
      ...leg,
      fromArea: fromCode,
      toArea: toCode,
      status: "ambiguous",
      candidates: candidates.slice(0, 5),
      note: "Meerdere OVAPI-ritten passen binnen de tijdmarge. Er wordt niet automatisch één rit gekozen."
    };
  }
  return {
    ...leg,
    fromArea: fromCode,
    toArea: toCode,
    status: "no_candidate",
    candidates: [],
    note: `Geen unieke OVAPI-rit gevonden die op beide haltegebieden bij lijn ${line}, de lokale datum en de geplande tijden binnen ±${SCHEDULE_TOLERANCE_SECONDS} seconden past. Mogelijke oorzaken: dienstregelingsverschil, ontbrekende passage of andere haltegebiedmapping.`
  };
}

export async function handleTransitousOvapiMatch(request: Request): Promise<Response | null> {
  const expectedPath = "/api/ovapi-test/match-plan";
  const url = new URL(request.url);
  if (url.pathname !== expectedPath) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ ok: false, error: "Gebruik POST voor de Transitous-OVAPI-koppelingstest." }, 405);

  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_CHARS) return json({ ok: false, error: "Verzoek te groot." }, 413);
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_CHARS) return json({ ok: false, error: "Verzoek te groot." }, 413);
    let body: Obj;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ ok: false, error: "Ongeldige JSON-body." }, 400);
    }
    const fromCode = validateCode(body.fromArea, "eerste haltegebiedcode");
    const toCode = validateCode(body.toArea, "tweede haltegebiedcode");
    if (fromCode.toLowerCase() === toCode.toLowerCase()) return json({ ok: false, error: "Kies twee verschillende haltegebieden." }, 400);
    if (!Array.isArray(body.legs) || body.legs.length === 0 || body.legs.length > MAX_LEGS) {
      return json({ ok: false, error: `Geef 1 tot ${MAX_LEGS} Transitous-busritten op.` }, 400);
    }
    const legs = body.legs.map((leg: any, index: number) => {
      const line = String(leg?.line ?? "").trim();
      const departure = safeText(leg?.departure);
      const arrival = safeText(leg?.arrival);
      if (!/^\d{1,8}[A-Za-z]?$/.test(line) || !departure || !arrival || departure.length > 80 || arrival.length > 80) {
        throw new Error(`Rit ${index + 1} heeft een ongeldig lijnnummer of ongeldige tijden.`);
      }
      return {
        itinerary: Math.max(1, Math.floor(Number(leg.itinerary) || index + 1)),
        line,
        mode: safeText(leg.mode),
        fromName: safeText(leg.fromName),
        toName: safeText(leg.toName),
        fromStopId: safeText(leg.fromStopId),
        toStopId: safeText(leg.toStopId),
        routeId: safeText(leg.routeId),
        tripId: safeText(leg.tripId),
        headsign: safeText(leg.headsign),
        departure,
        arrival
      };
    });

    const [fromSource, toSource] = await Promise.all([fetchArea(fromCode), fetchArea(toCode)]);
    const fromRows = collectPasses(fromSource).map(pass => normalizeRow(pass, fromCode));
    const toRows = collectPasses(toSource).map(pass => normalizeRow(pass, toCode));
    const comparisons = legs.map(leg => compareLeg(leg, fromRows, toRows, fromCode, toCode));
    return json({
      ok: true,
      source: "KV78turbo/OVAPI + Transitous plan response",
      queriedAt: new Date().toISOString(),
      fromArea: { code: fromCode, passCount: fromRows.length },
      toArea: { code: toCode, passCount: toRows.length },
      freshnessThresholdSeconds: FRESHNESS_THRESHOLD_SECONDS,
      scheduleToleranceSeconds: SCHEDULE_TOLERANCE_SECONDS,
      matchingMethod: "same line + Amsterdam local date + unique OperationDate/DataOwnerCode/LinePlanningNumber/JourneyNumber at both mapped stop areas + target times within ±240s",
      safetyNote: "This is a schedule-based cross-source candidate. Transitous tripId is not equated to OVAPI JourneyNumber. Only recent OVAPI updates are shown as current; no result is written back into /api/plan.",
      matchCount: comparisons.filter(c => c.status === "unique_schedule_candidate").length,
      ambiguousCount: comparisons.filter(c => c.status === "ambiguous").length,
      noCandidateCount: comparisons.filter(c => c.status === "no_candidate").length,
      comparisons
    });
  } catch (error) {
    return json({
      ok: false,
      source: "KV78turbo/OVAPI cross-source test",
      queriedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Koppelingstest mislukt."
    }, 502);
  }
}
