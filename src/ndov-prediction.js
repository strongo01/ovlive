const MAX_FRESH_MS = 180_000;
const MAX_CLOCK_DISTANCE_SECONDS = 20 * 60;

function timestampMs(value) {
  if (!value) return null;
  let text = String(value).trim();
  text = text.replace(/\.(\d{3})\d+(?=([+-]\d{2}:?\d{2}|Z)$)/, ".$1");
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedDate(value) {
  const match = String(value ?? "").trim().replace(/-/g, "").match(/^(\d{8})/);
  return match?.[1] ?? null;
}

function assignmentIsActive(record, operationDate) {
  const day = normalizedDate(operationDate);
  if (!day) return true;
  const from = normalizedDate(record?.validFrom);
  const thru = normalizedDate(record?.validThru);
  return (!from || from <= day) && (!thru || day <= thru);
}

function normalizeStopPlace(value) {
  let text = String(value ?? "").trim().toUpperCase();
  text = text.replace(/^NL-OPENOV_/, "");
  text = text.replace(/^NL:CHB:STOPPLACE:/, "NL:S:");
  if (/^\d+$/.test(text)) text = "NL:S:" + text;
  return text || null;
}

function normalizeQuay(value) {
  let text = String(value ?? "").trim().toUpperCase();
  text = text.replace(/^NL:CHB:QUAY:/, "");
  text = text.replace(/^NL:Q:/, "");
  return text || null;
}

function stripOpenovPrefix(value) {
  return String(value ?? "").trim().replace(/^nl-OpenOV_/i, "");
}

function stopPlaceKey(stopId) {
  const match = stripOpenovPrefix(stopId).match(/^(\d+)$/);
  return match?.[1] ?? null;
}

function clockSeconds(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]), seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function clockDistanceSeconds(a, b) {
  if (a === null || b === null) return Infinity;
  const left = ((a % 86400) + 86400) % 86400;
  const right = ((b % 86400) + 86400) % 86400;
  const difference = Math.abs(left - right);
  return Math.min(difference, 86400 - difference);
}

function amsterdamClockSeconds(value) {
  const ms = timestampMs(value);
  if (ms === null) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (name) => Number(parts.find((item) => item.type === name)?.value);
  const hours = part("hour"), minutes = part("minute"), seconds = part("second");
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function eventScheduleClock(event, punctualitySeconds) {
  const sourceTime = String(event?.punctualityTimestamp ?? event?.timestamp ?? "").trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(sourceTime)) return null;
  const actualClock = amsterdamClockSeconds(sourceTime);
  if (actualClock === null || !Number.isFinite(punctualitySeconds)) return null;
  return ((actualClock - punctualitySeconds) % 86400 + 86400) % 86400;
}

function candidatePatternStopIndices(pattern, event, punctualitySeconds) {
  const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
  const expectedClock = eventScheduleClock(event, punctualitySeconds);
  if (expectedClock === null) return [];
  const result = [];
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    const clocks = [clockSeconds(stop?.arrivalTime), clockSeconds(stop?.departureTime)]
      .filter((value) => value !== null);
    if (clocks.some((clock) =>
      clockDistanceSeconds(clock, expectedClock) <= MAX_CLOCK_DISTANCE_SECONDS
    )) result.push(index);
  }
  return result;
}

function uniquePatternStopIndex(pattern, stopId) {
  const wanted = stripOpenovPrefix(stopId);
  if (!wanted) return null;
  const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
  const matches = [];
  for (let index = 0; index < stops.length; index += 1) {
    if (stripOpenovPrefix(stops[index]?.stopId) === wanted) matches.push(index);
  }
  return matches.length === 1 ? matches[0] : null;
}

function scheduledInstant(leg, kind) {
  const value = kind === "departure"
    ? (leg?.from?.scheduledDeparture ?? leg?.scheduledStartTime ?? leg?.startTime ?? leg?.from?.departure)
    : (leg?.to?.scheduledArrival ?? leg?.scheduledEndTime ?? leg?.endTime ?? leg?.to?.arrival);
  const ms = timestampMs(value);
  return ms === null ? null : { value: String(value), ms };
}

function makeProjectedEndpoint(leg, kind, delaySeconds) {
  const scheduled = scheduledInstant(leg, kind);
  if (!scheduled) return null;
  return {
    time: new Date(scheduled.ms + delaySeconds * 1000).toISOString(),
    scheduledTime: new Date(scheduled.ms).toISOString(),
    delaySeconds,
    source: "NDOV BISON KV6",
    confidence: "measured-delay-projection",
    basis: "fresh_exact_trip_punctuality_propagated_to_unobserved_stop",
  };
}

/**
 * Fetch crosswalks only for the leg endpoints and the small timetable window
 * around the exact KV6 event, not for every stop on a full route pattern.
 */
export function getNdovPredictionStopIds(leg, pattern, event, punctualitySeconds) {
  const ids = new Set();
  for (const stopId of [leg?.from?.stopId, leg?.to?.stopId]) {
    const key = stopPlaceKey(stopId);
    if (key) ids.add(key);
  }
  const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
  for (const index of candidatePatternStopIndices(pattern, event, punctualitySeconds)) {
    const key = stopPlaceKey(stops[index]?.stopId);
    if (key) ids.add(key);
  }
  return [...ids];
}

/**
 * Project fresh operator punctuality only when current KV6 stop identity can
 * be joined to one route-pattern stop via official PSA/CHB and OpenOV mappings.
 */
export function deriveNdovKv6Prediction({
  leg,
  pattern,
  event,
  assignmentIndex,
  stopPlaceIndex,
  operationDate,
  nowMs = Date.now(),
  maxAgeMs = MAX_FRESH_MS,
}) {
  const rawDelay = event?.punctualitySeconds;
  const delaySeconds = typeof rawDelay === "number" && Number.isFinite(rawDelay)
    ? Math.trunc(rawDelay)
    : (typeof rawDelay === "string" && /^-?\d+$/.test(rawDelay.trim()) ? Number(rawDelay) : null);
  if (delaySeconds === null) return null;

  const receivedAt = timestampMs(event?.punctualityReceivedAt ?? event?.receivedAt);
  if (receivedAt === null) return null;
  const ageMs = nowMs - receivedAt;
  if (ageMs < -30_000 || ageMs > maxAgeMs) return null;

  const sourceTime = String(event?.punctualityTimestamp ?? event?.timestamp ?? "").trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(sourceTime)) {
    const sourceMs = timestampMs(sourceTime);
    if (sourceMs !== null) {
      const sourceAgeMs = nowMs - sourceMs;
      if (sourceAgeMs < -30_000 || sourceAgeMs > maxAgeMs) return null;
    }
  }

  const owner = String(event?.dataOwnerCode ?? "").trim().toUpperCase();
  const stopCode = String(event?.userStopCode ?? "").trim();
  if (!owner || !stopCode) return null;

  const records = assignmentIndex?.assignments?.[owner + "|" + stopCode];
  if (!Array.isArray(records) || !records.length) return null;
  const activeRecords = records.filter((record) => assignmentIsActive(record, operationDate));
  if (!activeRecords.length) return null;

  const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
  const candidateIndices = candidatePatternStopIndices(pattern, event, delaySeconds);
  if (!candidateIndices.length) return null;

  const candidates = [];
  for (const record of activeRecords) {
    const recordPlace = normalizeStopPlace(record?.stopPlaceCode ?? record?.stopPlaceRef);
    const recordQuay = normalizeQuay(record?.quayCode ?? record?.quayRef);
    if (!recordPlace) continue;

    for (const index of candidateIndices) {
      const stop = stops[index];
      const key = stopPlaceKey(stop?.stopId);
      const mapping = key ? stopPlaceIndex?.stopPlaces?.[key] : null;
      const mappedPlace = normalizeStopPlace(mapping?.stopPlaceCode);
      if (!mappedPlace || mappedPlace !== recordPlace) continue;

      const mappedQuay = normalizeQuay(mapping?.quayCode ?? mapping?.quayRef);
      if (mappedQuay && recordQuay && mappedQuay !== recordQuay) continue;
      candidates.push({
        index,
        exactQuay: Boolean(mappedQuay && recordQuay && mappedQuay === recordQuay),
        stopPlaceCode: mappedPlace,
      });
    }
  }

  const exactQuayIndices = [...new Set(candidates.filter((item) => item.exactQuay).map((item) => item.index))];
  const allCandidateIndices = [...new Set(candidates.map((item) => item.index))];
  let currentStopIndex = null;
  let quayConfirmed = false;
  let scheduleTimeFallback = null;
  if (exactQuayIndices.length === 1) {
    currentStopIndex = exactQuayIndices[0];
    quayConfirmed = true;
  } else if (exactQuayIndices.length > 1) {
    return null;
  } else if (allCandidateIndices.length === 1) {
    currentStopIndex = allCandidateIndices[0];
  } else if (allCandidateIndices.length === 0) {
    // Narrow fallback for a missing static OpenOV/CHB mapping: the operator
    // must report a stop-specific DEPARTURE/ARRIVAL, its active PSA assignment
    // must resolve to exactly one official StopPlace+Quay, and its scheduled
    // clock must uniquely identify one route stop within 30 seconds. A present
    // but conflicting static mapping is never overridden by this fallback.
    const eventType = String(event?.eventType ?? "").trim().toUpperCase();
    const expectedClock = eventScheduleClock(event, delaySeconds);
    const nearestStops = stops.map((stop, index) => {
      const clocks = [clockSeconds(stop?.arrivalTime), clockSeconds(stop?.departureTime)]
        .filter((value) => value !== null);
      return {
        index,
        distanceSeconds: clocks.length
          ? Math.min(...clocks.map((value) => clockDistanceSeconds(value, expectedClock)))
          : Infinity,
      };
    }).filter((item) => Number.isFinite(item.distanceSeconds))
      .sort((a, b) => a.distanceSeconds - b.distanceSeconds);

    const best = nearestStops[0];
    const second = nearestStops[1];
    const activeQuayBindings = activeRecords.map((record) => ({
      stopPlaceCode: normalizeStopPlace(record?.stopPlaceCode ?? record?.stopPlaceRef),
      quayCode: normalizeQuay(record?.quayCode ?? record?.quayRef),
    }));
    const uniqueBindings = [...new Map(
      activeQuayBindings
        .filter((item) => item.stopPlaceCode && item.quayCode)
        .map((item) => [item.stopPlaceCode + "|" + item.quayCode, item])
    ).values()];
    const allAssignmentsResolved = activeQuayBindings.length === activeRecords.length
      && activeQuayBindings.every((item) => item.stopPlaceCode && item.quayCode);
    const bindingIsUnique = allAssignmentsResolved && uniqueBindings.length === 1;
    const bestStopId = best ? stopPlaceKey(stops[best.index]?.stopId) : null;
    const bestStopMapping = bestStopId ? stopPlaceIndex?.stopPlaces?.[bestStopId] : null;
    const hasStaticMapping = Boolean(bestStopMapping);
    const timeIsUnique = Boolean(best)
      && best.distanceSeconds <= 30
      && (!second || second.distanceSeconds - best.distanceSeconds >= 30);

    if (
      (eventType === "DEPARTURE" || eventType === "ARRIVAL")
      && expectedClock !== null
      && timeIsUnique
      && bindingIsUnique
      && !hasStaticMapping
    ) {
      currentStopIndex = best.index;
      scheduleTimeFallback = uniqueBindings[0];
    } else {
      return null;
    }
  } else {
    return null;
  }

  const fromIndex = uniquePatternStopIndex(pattern, leg?.from?.stopId);
  const toIndex = uniquePatternStopIndex(pattern, leg?.to?.stopId);
  if (fromIndex === null || toIndex === null || fromIndex >= toIndex) return null;
  if (currentStopIndex > toIndex) return null;

  const departure = currentStopIndex <= fromIndex
    ? makeProjectedEndpoint(leg, "departure", delaySeconds)
    : null;
  const arrival = currentStopIndex <= toIndex
    ? makeProjectedEndpoint(leg, "arrival", delaySeconds)
    : null;
  if (!departure && !arrival) return null;

  const currentStop = stops[currentStopIndex];
  return {
    status: departure && arrival ? "available" : "partial",
    source: "NDOV BISON KV6",
    confidence: quayConfirmed ? "high" : "medium",
    method: scheduleTimeFallback
      ? "exact trip identity + unique near-exact scheduled stop time + active official PSA/CHB quay (OpenOV stop mapping missing)"
      : quayConfirmed
        ? "exact trip identity + current KV6 stop + PSA/CHB quay + OpenOV route-stop order"
        : "exact trip identity + unique PSA/CHB StopPlace + OpenOV route-stop order",
    measuredDelaySeconds: delaySeconds,
    currentStop: {
      stopId: currentStop?.stopId ?? null,
      stopSequence: currentStop?.stopSequence ?? null,
      userStopCode: stopCode,
      stopPlaceCode: candidates.find((item) => item.index === currentStopIndex)?.stopPlaceCode
        ?? scheduleTimeFallback?.stopPlaceCode
        ?? null,
      quayCode: scheduleTimeFallback?.quayCode ?? null,
    },
    measuredAt: sourceTime || String(event?.punctualityReceivedAt ?? event?.receivedAt),
    receivedAt: String(event?.punctualityReceivedAt ?? event?.receivedAt),
    feedAgeSeconds: Math.max(0, Math.round(ageMs / 1000)),
    note: scheduleTimeFallback
      ? "De routepositie is bepaald met een unieke dienstregelingstijd binnen 30 seconden en een actieve officiële PSA/CHB-halteverwijzing. De statische OpenOV/CHB-stopkoppeling ontbreekt; de voorspelling heeft daarom middelmatige zekerheid."
      : "De actuele punctualiteit is alleen naar haltes op of na de waargenomen routepositie doorberekend; dit is een voorspelling, geen gemeten haltepassage.",
    departure,
    arrival,
  };
}

function validOpenovPrediction(leg, kind, direct) {
  const openov = leg?.openovRealtime;
  if (openov?.status !== "matched") return null;
  const item = openov?.[kind];
  const timeMs = timestampMs(item?.time);
  if (!item || timeMs === null) return null;

  const age = typeof openov.updateAgeSeconds === "number" ? openov.updateAgeSeconds : null;
  if (age !== null && (age < -30 || age > 180)) return null;

  const delayBasis = String(item.delayBasis ?? "");
  const isDirect = delayBasis === "absolute_prediction_minus_scheduled_time"
    || delayBasis === "source_or_gtfs_propagated_delay";
  if (direct !== isDirect) return null;

  return {
    time: new Date(timeMs).toISOString(),
    scheduledTime: scheduledInstant(leg, kind)?.value ?? null,
    delaySeconds: typeof item.delaySeconds === "number" && Number.isFinite(item.delaySeconds)
      ? item.delaySeconds
      : null,
    source: "OpenOV GTFS-Realtime",
    confidence: isDirect ? "high" : "medium",
    basis: delayBasis || "openov_realtime",
    sourceStopId: item.sourceStopId ?? null,
    sourceStopSequence: item.sourceStopSequence ?? null,
    sourceEventTime: item.sourceEventTime ?? openov.updateTimestamp ?? null,
  };
}

function validKv78Prediction(leg, kind, confirmedOnly, nowMs) {
  const ndov = leg?.ndovRealtime;
  const kv78 = ndov?.kv78 ?? (ndov?.source === "NDOV KV78Turbo" ? ndov : null);
  const item = kv78?.[kind];
  if (!item || typeof item.delaySeconds !== "number" || !Number.isFinite(item.delaySeconds)) return null;
  const receivedAt = timestampMs(item.receivedAt);
  if (receivedAt === null) return null;
  const ageMs = nowMs - receivedAt;
  if (ageMs < -30_000 || ageMs > MAX_FRESH_MS) return null;
  const assignmentStatus = String(item.stopAssignmentStatus ?? "");
  const confirmed = assignmentStatus.startsWith("confirmed_");
  if (confirmedOnly !== confirmed) return null;
  const scheduled = scheduledInstant(leg, kind);
  if (!scheduled) return null;
  return {
    time: new Date(scheduled.ms + item.delaySeconds * 1000).toISOString(),
    scheduledTime: new Date(scheduled.ms).toISOString(),
    delaySeconds: item.delaySeconds,
    source: "NDOV KV78Turbo",
    confidence: assignmentStatus === "confirmed_quay_platform" ? "high"
      : confirmed ? "medium" : "low",
    basis: "exact_trip_identity + scheduled target time + " + (confirmed ? "confirmed PSA/CHB stop" : "unverified stop assignment"),
    stopCode: item.stopCode ?? null,
    matchMethod: item.matchMethod ?? null,
    receivedAt: item.receivedAt ?? null,
  };
}

/** Build one consistent per-stop view without mutating source-specific observations. */
export function buildUnifiedRealtimePrediction(leg, generatedAt = new Date().toISOString()) {
  if (leg?.cancelled === true || leg?.ndovRealtime?.status === "cancelled") return null;
  const nowMs = Date.now();

  const selectEndpoint = (kind) => {
    const candidates = [
      { priority: 1, item: validOpenovPrediction(leg, kind, true) },
      { priority: 2, item: validKv78Prediction(leg, kind, true, nowMs) },
      { priority: 3, item: leg?.ndovRealtime?.prediction?.[kind] ?? null },
      { priority: 4, item: validOpenovPrediction(leg, kind, false) },
      { priority: 5, item: validKv78Prediction(leg, kind, false, nowMs) },
    ].filter((entry) => entry.item && timestampMs(entry.item.time) !== null);
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0]?.item ?? null;
  };

  const departure = selectEndpoint("departure");
  const arrival = selectEndpoint("arrival");
  if (!departure && !arrival) return null;
  const sources = [...new Set([departure?.source, arrival?.source].filter(Boolean))];
  return {
    status: departure && arrival ? "available" : "partial",
    generatedAt,
    source: sources.length === 1 ? sources[0] : "mixed",
    departure,
    arrival,
    note: "Per halte gekozen uit verse realtime voorspellingen; een exacte voorspelling op de doelhalte krijgt voorrang op een doorberekende vertraging.",
  };
}
