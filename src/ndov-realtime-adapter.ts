/**
 * Pure data adapter for NDOV KV78Turbo + BISON KV6 messages.
 *
 * This module deliberately does not open sockets, poll feeds, or modify trip-planner
 * responses. It normalizes decoded messages and performs conservative, auditable joins.
 */

export type StringRecord = Record<string, string>;

export interface Kv78StopRow {
  dataOwnerCode: string;
  operationDate: string;
  localServiceLevelCode: string;
  linePlanningNumber: string;
  journeyNumber: string;
  fortifyOrderNumber: string;
  userStopOrderNumber: number | null;
  userStopCode: string;
  lineDirection: string;
  targetArrivalTime: string | null;
  targetDepartureTime: string | null;
  expectedArrivalTime: string | null;
  expectedDepartureTime: string | null;
  recordedArrivalTime: string | null;
  recordedDepartureTime: string | null;
  tripStopStatus: string;
  lastUpdateTimeStamp: string | null;
  cancelledJourney: boolean;
  showCancelledTrip: boolean;
  cancelledCall: boolean;
  showCancelledStop: boolean;
  vehicleNumber: string | null;
  destinationCode: string | null;
  raw: StringRecord;
}

export interface Kv6Event {
  eventType: string;
  dataOwnerCode: string;
  operationDate: string | null;
  linePlanningNumber: string;
  journeyNumber: string;
  reinforcementNumber: string;
  userStopCode: string | null;
  timestamp: string | null;
  vehicleNumber: string | null;
  punctualitySeconds: number | null;
  distanceSinceLastUserStop: number | null;
  rdX: number | null;
  rdY: number | null;
  raw: StringRecord;
}

export interface LegMatchInput {
  operationDate: string;
  plannedDeparture: string;
  plannedArrival: string;
  fromUserStopCode: string;
  toUserStopCode: string;
  /** Exact BISON line-planning numbers discovered from a trusted route/GTFS crosswalk. */
  allowedLinePlanningNumbers?: string[];
  allowedDataOwnerCodes?: string[];
  maxScheduleDifferenceSeconds?: number;
  maxUpdateAgeSeconds?: number;
  nowMs?: number;
}

export interface MatchedLeg {
  matchStatus: "matched" | "ambiguous" | "not_found";
  reason: string;
  tripIdentity?: string;
  linePlanningNumber?: string;
  journeyNumber?: string;
  dataOwnerCode?: string;
  from?: Kv78StopRow;
  to?: Kv78StopRow;
  fromDelaySeconds?: number | null;
  toDelaySeconds?: number | null;
  fromUpdateAgeSeconds?: number | null;
  toUpdateAgeSeconds?: number | null;
  realtimeUsable: boolean;
  freshness: "fresh" | "stale" | "unknown";
  tripCancelled: boolean;
  fromStopCancelled: boolean;
  toStopCancelled: boolean;
  scheduleDifferenceSeconds?: { from: number; to: number };
}

export interface Kv6JoinResult {
  joinStatus: "matched" | "ambiguous" | "not_found";
  reason: string;
  tripIdentity?: string;
  event: Kv6Event;
}

const TZ = "Europe/Amsterdam";

function valueOf(raw: StringRecord, ...names: string[]): string {
  for (const name of names) {
    const direct = raw[name];
    if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
    const key = Object.keys(raw).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && raw[key].trim() !== "") return raw[key].trim();
  }
  return "";
}

function nullable(raw: StringRecord, ...names: string[]): string | null {
  const value = valueOf(raw, ...names);
  return value ? value : null;
}

function boolOf(raw: StringRecord, ...names: string[]): boolean {
  const value = valueOf(raw, ...names).toUpperCase();
  return ["TRUE", "1", "YES", "JA", "Y"].includes(value);
}

function numOf(raw: StringRecord, ...names: string[]): number | null {
  const value = valueOf(raw, ...names);
  if (!value) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function cleanCell(value: string): string {
  const cleaned = value.replace(/\r/g, "").replace(/\uFEFF/g, "").trim();
  return ["\\0", "-", "NULL", "null"].includes(cleaned) ? "" : cleaned;
}

/** Parse decoded KV78Turbo table payloads. Each \L record defines its own columns. */
export function parseKv78Payload(payload: string): Kv78StopRow[] {
  const rows: Kv78StopRow[] = [];
  let headers: string[] | null = null;

  for (const sourceLine of payload.split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/^\uFEFF/, "");
    if (!line) continue;

    if (line.startsWith("\\L")) {
      headers = line.slice(2).split("|").map((part) => part.trim());
      continue;
    }
    // Ignore envelope/control records (\G, \T, etc.); data rows are pipe-delimited.
    if (line.startsWith("\\") || !headers || !line.includes("|")) continue;

    const cells = line.split("|");
    const raw: StringRecord = {};
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i]) continue;
      raw[headers[i]] = cleanCell(cells[i] ?? "");
    }

    const dataOwnerCode = valueOf(raw, "DataOwnerCode");
    const operationDate = valueOf(raw, "OperationDate");
    const linePlanningNumber = valueOf(raw, "LinePlanningNumber");
    const journeyNumber = valueOf(raw, "JourneyNumber");
    const userStopCode = valueOf(raw, "UserStopCode");
    if (!dataOwnerCode || !operationDate || !linePlanningNumber || !journeyNumber || !userStopCode) continue;

    rows.push({
      dataOwnerCode,
      operationDate,
      localServiceLevelCode: valueOf(raw, "LocalServiceLevelCode"),
      linePlanningNumber,
      journeyNumber,
      fortifyOrderNumber: valueOf(raw, "FortifyOrderNumber") || "0",
      userStopOrderNumber: numOf(raw, "UserStopOrderNumber"),
      userStopCode,
      lineDirection: valueOf(raw, "LineDirection"),
      targetArrivalTime: nullable(raw, "TargetArrivalTime"),
      targetDepartureTime: nullable(raw, "TargetDepartureTime"),
      expectedArrivalTime: nullable(raw, "ExpectedArrivalTime"),
      expectedDepartureTime: nullable(raw, "ExpectedDepartureTime"),
      recordedArrivalTime: nullable(raw, "RecordedArrivalTime"),
      recordedDepartureTime: nullable(raw, "RecordedDepartureTime"),
      tripStopStatus: valueOf(raw, "TripStopStatus").toUpperCase(),
      lastUpdateTimeStamp: nullable(raw, "LastUpdateTimeStamp"),
      cancelledJourney: boolOf(raw, "CancelledJourney"),
      showCancelledTrip: boolOf(raw, "ShowCancelledTrip"),
      cancelledCall: boolOf(raw, "CancelledCall"),
      showCancelledStop: boolOf(raw, "ShowCancelledStop"),
      vehicleNumber: nullable(raw, "VehicleNumber"),
      destinationCode: nullable(raw, "DestinationCode"),
      raw,
    });
  }
  return rows;
}

function localName(tag: string): string {
  return tag.replace(/^.*:/, "").toLowerCase();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function xmlField(block: string, wanted: string): string {
  const re = new RegExp(`<([\\w.-]+:)?${wanted}\\b[^>]*>([\\s\\S]*?)<\\/([\\w.-]+:)?${wanted}\\s*>`, "i");
  const match = re.exec(block);
  return match ? decodeXml(match[2].trim()) : "";
}

/** Parse the common KV6 XML event types without requiring an XML package in Workers. */
export function parseKv6XmlPayload(payload: string): Kv6Event[] {
  const xml = payload.replace(/^\uFEFF/, "");
  const eventPattern = /<(?:[\w.-]+:)?(ONROUTE|ONSTOP|OFFROUTE|DEPARTURE|ARRIVAL|INIT|END|UNIT|RECOVERED|NODATA)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi;
  const output: Kv6Event[] = [];
  let match: RegExpExecArray | null;

  while ((match = eventPattern.exec(xml)) !== null) {
    const block = match[2];
    const raw: StringRecord = {};
    const keys = [
      "dataownercode", "operatingday", "lineplanningnumber", "journeynumber",
      "reinforcementnumber", "userstopcode", "timestamp", "vehiclenumber",
      "punctuality", "distancesincelastuserstop", "rd-x", "rd-y",
    ];
    for (const key of keys) {
      const v = xmlField(block, key);
      if (v) raw[key] = v;
    }
    const dataOwnerCode = valueOf(raw, "dataownercode");
    const linePlanningNumber = valueOf(raw, "lineplanningnumber");
    const journeyNumber = valueOf(raw, "journeynumber");
    if (!dataOwnerCode || !linePlanningNumber || !journeyNumber) continue;

    const parseCoordinate = (value: string): number | null => {
      const parsed = Number(value);
      // BISON uses -1/-1 to indicate missing RD coordinates.
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };

    output.push({
      eventType: localName(match[1]).toUpperCase(),
      dataOwnerCode,
      operationDate: nullable(raw, "operatingday"),
      linePlanningNumber,
      journeyNumber,
      reinforcementNumber: valueOf(raw, "reinforcementnumber") || "0",
      userStopCode: nullable(raw, "userstopcode"),
      timestamp: nullable(raw, "timestamp"),
      vehicleNumber: nullable(raw, "vehiclenumber"),
      punctualitySeconds: numOf(raw, "punctuality"),
      distanceSinceLastUserStop: numOf(raw, "distancesincelastuserstop"),
      rdX: parseCoordinate(valueOf(raw, "rd-x")),
      rdY: parseCoordinate(valueOf(raw, "rd-y")),
      raw,
    });
  }
  return output;
}

/** Full KV78 identity, including LocalServiceLevelCode and FortifyOrderNumber. */
export function kv78TripIdentity(row: Kv78StopRow): string {
  return [
    row.dataOwnerCode,
    row.operationDate,
    row.localServiceLevelCode,
    row.linePlanningNumber,
    row.journeyNumber,
    row.fortifyOrderNumber || "0",
  ].join("|");
}

/** KV6 does not necessarily supply LocalServiceLevelCode or OperationDate. */
function commonKv6Key(values: {
  dataOwnerCode: string;
  operationDate?: string | null;
  linePlanningNumber: string;
  journeyNumber: string;
  reinforcementNumber?: string | null;
}): string {
  return [
    values.dataOwnerCode,
    values.operationDate ?? "",
    values.linePlanningNumber,
    values.journeyNumber,
    values.reinforcementNumber || "0",
  ].join("|");
}

function rowKv6Key(row: Kv78StopRow): string {
  return commonKv6Key({
    dataOwnerCode: row.dataOwnerCode,
    operationDate: row.operationDate,
    linePlanningNumber: row.linePlanningNumber,
    journeyNumber: row.journeyNumber,
    reinforcementNumber: row.fortifyOrderNumber,
  });
}

function eventKv6Key(event: Kv6Event): string {
  return commonKv6Key({
    dataOwnerCode: event.dataOwnerCode,
    operationDate: event.operationDate,
    linePlanningNumber: event.linePlanningNumber,
    journeyNumber: event.journeyNumber,
    reinforcementNumber: event.reinforcementNumber,
  });
}

/** Join KV6 to KV78 only if the shared identity fields point to one full KV78 identity. */
export function joinKv6ToKv78(rows: Kv78StopRow[], events: Kv6Event[]): Kv6JoinResult[] {
  const tripIdentitiesByCommonKey = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = rowKv6Key(row);
    const set = tripIdentitiesByCommonKey.get(key) ?? new Set<string>();
    set.add(kv78TripIdentity(row));
    tripIdentitiesByCommonKey.set(key, set);
  }

  return events.map((event) => {
    const key = eventKv6Key(event);
    let matches = tripIdentitiesByCommonKey.get(key);
    if (!matches && !event.operationDate) {
      const candidateSets: Set<string> = new Set();
      for (const [candidateKey, identities] of tripIdentitiesByCommonKey.entries()) {
        const parts = candidateKey.split("|");
        if (
          parts[0] === event.dataOwnerCode &&
          parts[2] === event.linePlanningNumber &&
          parts[3] === event.journeyNumber &&
          parts[4] === (event.reinforcementNumber || "0")
        ) {
          for (const identity of identities) candidateSets.add(identity);
        }
      }
      matches = candidateSets;
    }
    const identities = [...(matches ?? [])];
    if (identities.length === 1) {
      return { joinStatus: "matched", reason: "unique_shared_BISON_identity", tripIdentity: identities[0], event };
    }
    if (identities.length > 1) {
      return { joinStatus: "ambiguous", reason: "KV6_missing_fields_match_multiple_KV78_trips", event };
    }
    return { joinStatus: "not_found", reason: "no_KV78_trip_with_matching_shared_identity", event };
  });
}

function isTrue(value: boolean): boolean {
  return value === true;
}

/** Convert either a local wall-clock time or an ISO timestamp to an Amsterdam wall-clock value. */
export function amsterdamWallClockMs(value: string | null | undefined, operationDate?: string): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;

  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  if (timeOnly) {
    if (!operationDate) return null;
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(operationDate);
    if (!d) return null;
    return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3] ?? 0), Number((timeOnly[4] ?? "0").padEnd(3, "0")));
  }

  // Naive timestamps in KV78 represent Dutch local time. Do not let Date.parse treat them as UTC.
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (naive && !hasZone) {
    return Date.UTC(Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]), Number(naive[4]), Number(naive[5]), Number(naive[6] ?? 0), Number((naive[7] ?? "0").padEnd(3, "0")));
  }

  const instant = Date.parse(text);
  if (!Number.isFinite(instant)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const y = get("year"), m = get("month"), d = get("day"), h = get("hour"), min = get("minute"), sec = get("second");
  if (![y, m, d, h, min, sec].every(Number.isFinite)) return null;
  return Date.UTC(y, m - 1, d, h, min, sec, new Date(instant).getUTCMilliseconds());
}

function timestampInstantMs(value: string | null): number | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  if (hasZone) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // A timestamp without offset is presumed to use Amsterdam local time.
  const wall = amsterdamWallClockMs(value);
  if (wall == null) return null;
  const candidate = new Date(wall);
  const localParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(candidate);
  const get = (type: string): number => Number(localParts.find((part) => part.type === type)?.value ?? NaN);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = localAsUtc - wall;
  return wall - offset;
}

function updateAgeSeconds(row: Kv78StopRow, nowMs: number): number | null {
  const timestamp = timestampInstantMs(row.lastUpdateTimeStamp);
  return timestamp == null ? null : Math.round((nowMs - timestamp) / 1000);
}

function rowIsFresh(row: Kv78StopRow, nowMs: number, maxAgeSeconds: number): boolean | null {
  const age = updateAgeSeconds(row, nowMs);
  if (age == null) return null;
  return age >= -15 && age <= maxAgeSeconds;
}

function eventTarget(row: Kv78StopRow, prefer: "arrival" | "departure"): { target: string | null; expected: string | null } {
  const order = prefer === "departure" ? ["departure", "arrival"] as const : ["arrival", "departure"] as const;
  for (const kind of order) {
    const target = kind === "departure" ? row.targetDepartureTime : row.targetArrivalTime;
    if (!target) continue;
    const expected = kind === "departure" ? row.expectedDepartureTime : row.expectedArrivalTime;
    return { target, expected };
  }
  return { target: null, expected: null };
}

function delaySeconds(row: Kv78StopRow, prefer: "arrival" | "departure"): number | null {
  const event = eventTarget(row, prefer);
  const target = amsterdamWallClockMs(event.target, row.operationDate);
  const expected = amsterdamWallClockMs(event.expected, row.operationDate);
  if (target == null || expected == null) return null;
  return Math.round((expected - target) / 1000);
}

function scheduleDifferenceSeconds(row: Kv78StopRow, prefer: "arrival" | "departure", planned: string): number | null {
  const sourceEvent = eventTarget(row, prefer);
  const target = amsterdamWallClockMs(sourceEvent.target, row.operationDate);
  const plannedWall = amsterdamWallClockMs(planned, row.operationDate);
  if (target == null || plannedWall == null) return null;
  return Math.round((target - plannedWall) / 1000);
}

function uniqueLatest(rows: Kv78StopRow[]): Kv78StopRow[] {
  const latest = new Map<string, Kv78StopRow>();
  for (const row of rows) {
    const key = `${kv78TripIdentity(row)}|${row.userStopCode}|${row.userStopOrderNumber ?? "?"}`;
    const nextMs = timestampInstantMs(row.lastUpdateTimeStamp) ?? -Infinity;
    const current = latest.get(key);
    const currentMs = current ? timestampInstantMs(current.lastUpdateTimeStamp) ?? -Infinity : -Infinity;
    if (!current || nextMs > currentMs) latest.set(key, row);
  }
  return [...latest.values()];
}

function stopCancelled(row: Kv78StopRow): boolean {
  return isTrue(row.cancelledCall) || isTrue(row.showCancelledStop) || row.tripStopStatus === "CANCEL";
}

function tripCancelled(row: Kv78StopRow): boolean {
  // ShowCancelledTrip is a display policy flag, not proof that the trip was cancelled.
  // CancelledJourney is the explicit trip-level cancellation indicator.
  return isTrue(row.cancelledJourney);
}

/**
 * Match only when both exact BISON stop codes and their schedule times agree.
 * Transitous stop IDs must be converted to UserStopCode using an explicit, trusted crosswalk.
 */
export function matchKv78Leg(rowsInput: Kv78StopRow[], input: LegMatchInput): MatchedLeg {
  const maxScheduleDifference = input.maxScheduleDifferenceSeconds ?? 240;
  const maxUpdateAge = input.maxUpdateAgeSeconds ?? 120;
  const nowMs = input.nowMs ?? Date.now();
  const fromCode = input.fromUserStopCode.trim();
  const toCode = input.toUserStopCode.trim();
  if (!fromCode || !toCode || fromCode === toCode) {
    return unknownResult("missing_or_invalid_stop_code_crosswalk");
  }

  const allowedLines = input.allowedLinePlanningNumbers?.map((x) => x.trim().toUpperCase()).filter(Boolean);
  const allowedOwners = input.allowedDataOwnerCodes?.map((x) => x.trim().toUpperCase()).filter(Boolean);
  const dateRows = uniqueLatest(rowsInput).filter((row) => {
    if (row.operationDate !== input.operationDate) return false;
    if (allowedLines?.length && !allowedLines.includes(row.linePlanningNumber.toUpperCase())) return false;
    if (allowedOwners?.length && !allowedOwners.includes(row.dataOwnerCode.toUpperCase())) return false;
    return true;
  });

  const grouped = new Map<string, Kv78StopRow[]>();
  for (const row of dateRows) {
    const key = kv78TripIdentity(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const candidates: Array<{
    identity: string; from: Kv78StopRow; to: Kv78StopRow; fromDiff: number; toDiff: number; score: number;
  }> = [];

  for (const [identity, tripRows] of grouped.entries()) {
    const fromRows = tripRows.filter((row) => row.userStopCode === fromCode);
    const toRows = tripRows.filter((row) => row.userStopCode === toCode);
    for (const from of fromRows) {
      const fromDiff = scheduleDifferenceSeconds(from, "departure", input.plannedDeparture);
      if (fromDiff == null || Math.abs(fromDiff) > maxScheduleDifference) continue;
      for (const to of toRows) {
        if (from.userStopOrderNumber == null || to.userStopOrderNumber == null || from.userStopOrderNumber >= to.userStopOrderNumber) continue;
        const toDiff = scheduleDifferenceSeconds(to, "arrival", input.plannedArrival);
        if (toDiff == null || Math.abs(toDiff) > maxScheduleDifference) continue;
        candidates.push({ identity, from, to, fromDiff, toDiff, score: Math.abs(fromDiff) + Math.abs(toDiff) });
      }
    }
  }

  if (candidates.length === 0) return unknownResult("no_unique_trip_matching_both_stops_and_schedule");
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const competing = candidates.filter((candidate) => candidate.identity !== best.identity && candidate.score <= best.score + 1);
  if (competing.length > 0) {
    return unknownResult("multiple_trip_identities_match_both_stops_and_schedule", "ambiguous");
  }

  const fromFresh = rowIsFresh(best.from, nowMs, maxUpdateAge);
  const toFresh = rowIsFresh(best.to, nowMs, maxUpdateAge);
  const freshness: MatchedLeg["freshness"] = fromFresh === true && toFresh === true
    ? "fresh"
    : fromFresh === false || toFresh === false
      ? "stale"
      : "unknown";
  const cancelled = tripCancelled(best.from) || tripCancelled(best.to);
  return {
    matchStatus: "matched",
    reason: "unique_full_KV78_identity_and_both_stop_schedule_times",
    tripIdentity: best.identity,
    linePlanningNumber: best.from.linePlanningNumber,
    journeyNumber: best.from.journeyNumber,
    dataOwnerCode: best.from.dataOwnerCode,
    from: best.from,
    to: best.to,
    fromDelaySeconds: delaySeconds(best.from, "departure"),
    toDelaySeconds: delaySeconds(best.to, "arrival"),
    fromUpdateAgeSeconds: updateAgeSeconds(best.from, nowMs),
    toUpdateAgeSeconds: updateAgeSeconds(best.to, nowMs),
    realtimeUsable: freshness === "fresh" && !cancelled,
    freshness,
    tripCancelled: cancelled,
    fromStopCancelled: stopCancelled(best.from),
    toStopCancelled: stopCancelled(best.to),
    scheduleDifferenceSeconds: { from: best.fromDiff, to: best.toDiff },
  };
}

function unknownResult(reason: string, matchStatus: "ambiguous" | "not_found" = "not_found"): MatchedLeg {
  return {
    matchStatus,
    reason,
    realtimeUsable: false,
    freshness: "unknown",
    tripCancelled: false,
    fromStopCancelled: false,
    toStopCancelled: false,
  };
}
