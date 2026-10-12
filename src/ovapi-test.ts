/**
 * OVLive OVAPI parallel test module.
 * This module only serves /api/ovapi-test/* and does not alter existing
 * OpenOV/Transitous enrichment or responses.
 */
const OVAPI_BASE = "http://v0.ovapi.nl";
const OVAPI_USER_AGENT = "OVLive/0.2.0 (isolated KV78turbo-OVAPI diagnostics)";
const CACHE_TTL_SECONDS = 60;
const FRESHNESS_THRESHOLD_SECONDS = 300;

type JsonObject = Record<string, any>;

function responseJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

async function upstreamJson(path: string): Promise<any> {
  const url = `${OVAPI_BASE}${path}`;
  try {
    const init = {
      headers: {
        accept: "application/json",
        "user-agent": OVAPI_USER_AGENT,
        "accept-encoding": "gzip"
      },
      signal: AbortSignal.timeout(15000),
      // Keep upstream traffic modest; no history is stored by this module.
      cf: { cacheEverything: true, cacheTtl: CACHE_TTL_SECONDS }
    } as RequestInit & { cf: { cacheEverything: boolean; cacheTtl: number } };

    const upstream = await fetch(url, init);
    if (!upstream.ok) {
      throw new Error(`OVAPI antwoordde met HTTP ${upstream.status} voor ${path}.`);
    }
    const text = await upstream.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`OVAPI gaf geen geldige JSON terug voor ${path}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OVAPI ")) throw error;
    throw new Error(`OVAPI kon niet worden bereikt: ${error instanceof Error ? error.message : "onbekende netwerkfout"}.`);
  }
}

function objectEntries(value: any): [string, JsonObject][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, JsonObject] =>
    Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1])
  );
}

function safeText(value: any): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value);
}

function differenceSeconds(expected: any, target: any): number | null {
  if (typeof expected !== "string" || typeof target !== "string") return null;
  const e = Date.parse(expected);
  const t = Date.parse(target);
  if (!Number.isFinite(e) || !Number.isFinite(t)) return null;
  return Math.round((e - t) / 1000);
}

function updateFreshness(lastUpdate: string | null): { ageSeconds: number | null; freshness: string } {
  if (!lastUpdate) return { ageSeconds: null, freshness: "unknown" };
  const timestamp = Date.parse(lastUpdate);
  if (!Number.isFinite(timestamp)) return { ageSeconds: null, freshness: "unknown" };
  const ageSeconds = Math.round((Date.now() - timestamp) / 1000);
  if (ageSeconds < -120) return { ageSeconds, freshness: "clock_skew" };
  if (ageSeconds <= FRESHNESS_THRESHOLD_SECONDS) return { ageSeconds, freshness: "recent" };
  return { ageSeconds, freshness: "stale" };
}

function summarizePass(id: string, pass: JsonObject, inheritedStopName?: string | null): JsonObject {
  const expected = safeText(pass.ExpectedDepartureTime) ?? safeText(pass.ExpectedArrivalTime);
  const target = safeText(pass.TargetDepartureTime) ?? safeText(pass.TargetArrivalTime);
  const lastUpdate = safeText(pass.LastUpdateTimeStamp);
  const status = safeText(pass.TripStopStatus);
  const statusUpper = String(status ?? "").toUpperCase();
  const cancelled = statusUpper.includes("CANCEL");
  const freshness = updateFreshness(lastUpdate);
  const rawDifferenceSeconds = differenceSeconds(expected, target);
  const plannedButUnconfirmed = statusUpper.includes("PLANNED") && rawDifferenceSeconds === 0;
  const isRecent = freshness.freshness === "recent";
  const currentCancellation = isRecent && cancelled;
  const reliableDelaySeconds = isRecent && !cancelled && !plannedButUnconfirmed
    ? rawDifferenceSeconds
    : null;

  return {
    id,
    line: safeText(pass.LinePublicNumber) ?? safeText(pass.LinePlanningNumber),
    transportType: safeText(pass.TransportType),
    destination: safeText(pass.DestinationName50),
    stop: safeText(pass.TimingPointName) ?? inheritedStopName ?? safeText(pass.UserStopCode),
    status,
    cancelled,
    currentCancellation,
    targetTime: target,
    expectedTime: isRecent && !cancelled ? expected : null,
    sourceExpectedTime: expected,
    differenceSeconds: reliableDelaySeconds,
    sourceDifferenceSeconds: rawDifferenceSeconds,
    lastUpdate,
    updateAgeSeconds: freshness.ageSeconds,
    updateFreshness: freshness.freshness,
    operationDate: safeText(pass.OperationDate),
    dataOwner: safeText(pass.DataOwnerCode),
    planningNumber: safeText(pass.LinePlanningNumber),
    journeyNumber: safeText(pass.JourneyNumber),
    raw: pass
  };
}

function collectPassesDeep(root: any): Array<{ id: string; pass: JsonObject; stopName: string | null }> {
  const output: Array<{ id: string; pass: JsonObject; stopName: string | null }> = [];
  const passKeys = ["ExpectedDepartureTime", "TargetDepartureTime", "ExpectedArrivalTime", "TargetArrivalTime", "TripStopStatus"];

  const visit = (value: any, path: string[], inheritedStopName: string | null): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const stopName = safeText(value.TimingPointName) ?? safeText(value.Stop?.TimingPointName) ?? inheritedStopName;
    if (passKeys.some(key => Object.prototype.hasOwnProperty.call(value, key))) {
      output.push({ id: path[path.length - 1] ?? `pass-${output.length + 1}`, pass: value as JsonObject, stopName });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") visit(child, [...path, key], stopName);
    }
  };

  visit(root, [], null);
  return output;
}

function validateCode(value: string | null, label: string): string {
  const code = (value ?? "").trim();
  if (!code || code.length > 80 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error(`Ongeldige of ontbrekende ${label}. Gebruik alleen letters, cijfers, _ en -.`);
  }
  return code;
}

function collectRows(source: any, stopAreaCode: string): JsonObject[] {
  return collectPassesDeep(source).map(({ id, pass, stopName }) => ({
    ...summarizePass(id, pass, stopName),
    stopAreaCode
  }));
}

function identity(row: JsonObject): string | null {
  // All four fields must be explicitly present. Do not guess when the owner
  // is missing, or when there is more than one record for the same identity.
  const date = safeText(row.operationDate);
  const owner = safeText(row.dataOwner);
  const planning = safeText(row.planningNumber);
  const journey = safeText(row.journeyNumber);
  if (!date || !owner || !planning || !journey) return null;
  return [date, owner, planning, journey].join("|");
}

function compact(row: JsonObject): JsonObject {
  return {
    stopAreaCode: row.stopAreaCode,
    stop: row.stop,
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

function buildComparison(fromCode: string, toCode: string, lineFilter: string | null, fromSource: any, toSource: any): JsonObject {
  const filterLine = (row: JsonObject) => !lineFilter || String(row.line ?? "").toLowerCase() === lineFilter.toLowerCase();
  const fromRows = collectRows(fromSource, fromCode).filter(filterLine);
  const toRows = collectRows(toSource, toCode).filter(filterLine);
  const fromMap = new Map<string, JsonObject[]>();
  const toMap = new Map<string, JsonObject[]>();

  for (const row of fromRows) {
    const key = identity(row);
    if (key) fromMap.set(key, [...(fromMap.get(key) ?? []), row]);
  }
  for (const row of toRows) {
    const key = identity(row);
    if (key) toMap.set(key, [...(toMap.get(key) ?? []), row]);
  }

  const matches: JsonObject[] = [];
  const matchedFrom = new Set<JsonObject>();
  const matchedTo = new Set<JsonObject>();
  for (const [key, starts] of fromMap.entries()) {
    const ends = toMap.get(key) ?? [];
    if (starts.length !== 1 || ends.length !== 1) continue;
    const from = starts[0];
    const to = ends[0];
    matchedFrom.add(from);
    matchedTo.add(to);
    const delta = typeof from.differenceSeconds === "number" && typeof to.differenceSeconds === "number"
      ? to.differenceSeconds - from.differenceSeconds
      : null;
    const reliable = delta !== null &&
      from.updateFreshness === "recent" && to.updateFreshness === "recent" &&
      from.currentCancellation !== true && to.currentCancellation !== true &&
      from.cancelled !== true && to.cancelled !== true;

    matches.push({
      identity: key,
      line: from.line ?? to.line,
      destination: from.destination ?? to.destination,
      operationDate: from.operationDate,
      dataOwner: from.dataOwner,
      planningNumber: from.planningNumber,
      journeyNumber: from.journeyNumber,
      from: compact(from),
      to: compact(to),
      delayChangeSeconds: reliable ? delta : null,
      comparisonReliable: reliable,
      note: !reliable
        ? "De rit is herkend, maar niet alle updates zijn actueel en betrouwbaar."
        : "Verschil tussen twee voorspelde afwijkingen; dit is geen bewijs van de uiteindelijke aankomsttijd."
    });
  }

  matches.sort((a, b) => String(a.from.targetTime ?? "").localeCompare(String(b.from.targetTime ?? "")));
  return {
    ok: true,
    source: "KV78turbo/OVAPI",
    queriedAt: new Date().toISOString(),
    freshnessThresholdSeconds: FRESHNESS_THRESHOLD_SECONDS,
    from: { code: fromCode, count: fromRows.length },
    to: { code: toCode, count: toRows.length },
    lineFilter,
    matchingMethod: "exact OperationDate + DataOwnerCode + LinePlanningNumber + JourneyNumber; missing/duplicate identities are not joined",
    matchCount: matches.length,
    matches: matches.slice(0, 100),
    unmatched: {
      from: fromRows.filter(row => !matchedFrom.has(row)).map(compact).slice(0, 40),
      to: toRows.filter(row => !matchedTo.has(row)).map(compact).slice(0, 40)
    }
  };
}

export async function handleOvapiTestApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = "/api/ovapi-test";
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  if (request.method !== "GET") return responseJson({ error: "Alleen GET-verzoeken zijn toegestaan." }, 405);

  try {
    if (url.pathname === `${prefix}/health`) {
      return responseJson({
        ok: true,
        module: "OVLive parallel OVAPI-test",
        source: "KV78turbo/OVAPI",
        baseUrl: OVAPI_BASE,
        cacheTtlSeconds: CACHE_TTL_SECONDS,
        freshnessThresholdSeconds: FRESHNESS_THRESHOLD_SECONDS,
        checkedAt: new Date().toISOString(),
        note: "Deze status controleert de moduleconfiguratie. /departures en /compare doen een echte upstream-aanvraag."
      });
    }

    if (url.pathname === `${prefix}/departures`) {
      const code = validateCode(url.searchParams.get("code"), "haltegebiedcode");
      const source = await upstreamJson(`/stopareacode/${encodeURIComponent(code)}/departures`);
      const passes = collectRows(source, code).sort((a, b) => String(a.expectedTime ?? a.targetTime ?? "").localeCompare(String(b.expectedTime ?? b.targetTime ?? "")));
      const counts = {
        total: passes.length,
        recent: passes.filter(row => row.updateFreshness === "recent").length,
        stale: passes.filter(row => row.updateFreshness === "stale").length,
        unknownFreshness: passes.filter(row => row.updateFreshness === "unknown" || row.updateFreshness === "clock_skew").length,
        currentCancellations: passes.filter(row => row.currentCancellation).length,
        oldCancellationStatuses: passes.filter(row => row.cancelled && !row.currentCancellation).length,
        reliableDelay: passes.filter(row => row.differenceSeconds !== null).length
      };
      return responseJson({
        ok: true,
        source: "KV78turbo/OVAPI /stopareacode/{code}/departures",
        queriedAt: new Date().toISOString(),
        stopAreaCode: code,
        freshnessThresholdSeconds: FRESHNESS_THRESHOLD_SECONDS,
        rule: "Alleen updates van maximaal 5 minuten oud leveren een actuele verwachte tijd, vertraging of bevestigde annulering op.",
        counts,
        passCount: passes.length,
        passes: passes.slice(0, 150).map(compact)
      });
    }

    if (url.pathname === `${prefix}/compare`) {
      const fromCode = validateCode(url.searchParams.get("from"), "eerste haltegebiedcode");
      const toCode = validateCode(url.searchParams.get("to"), "tweede haltegebiedcode");
      if (fromCode.toLowerCase() === toCode.toLowerCase()) {
        return responseJson({ ok: false, error: "Kies twee verschillende haltegebiedcodes." }, 400);
      }
      const lineFilter = (url.searchParams.get("line") ?? "").trim();
      if (lineFilter.length > 20 || (lineFilter && !/^[A-Za-z0-9_-]+$/.test(lineFilter))) {
        return responseJson({ ok: false, error: "Ongeldig lijnnummer. Gebruik letters, cijfers, _ en -." }, 400);
      }
      const [fromSource, toSource] = await Promise.all([
        upstreamJson(`/stopareacode/${encodeURIComponent(fromCode)}/departures`),
        upstreamJson(`/stopareacode/${encodeURIComponent(toCode)}/departures`)
      ]);
      return responseJson(buildComparison(fromCode, toCode, lineFilter || null, fromSource, toSource));
    }

    return responseJson({
      error: "Onbekend OVAPI-testendpoint.",
      available: [
        `${prefix}/health`,
        `${prefix}/departures?code=utrmyl`,
        `${prefix}/compare?from=utrler&to=utrmyl&line=5`
      ]
    }, 404);
  } catch (error) {
    return responseJson({
      ok: false,
      source: "KV78turbo/OVAPI",
      queriedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Onbekende fout bij OVAPI-test."
    }, 502);
  }
}
