// Conservative NDOV KV17 cancellation enrichment for Transitous/OpenOV legs.
// This reads the existing collector snapshot; it never opens/starts a feed connection.
import { buildUnifiedRealtimePrediction, deriveNdovKv6Prediction, getNdovPredictionStopIds } from "./ndov-prediction.js";
const MAX_BISON_AGE_MS = 180_000;
const ACTIVE_KV6_EVENT_TYPES = new Set(["ONROUTE", "ONSTOP", "DEPARTURE", "ARRIVAL"]);
const CROSSWALK_ROOT = "/ndov-trip-crosswalk";
const OPENOV_ROUTE_CROSSWALK_ROOT = "/ndov-openov-route-crosswalk";
const ASSET_ORIGIN = "https://ovlive-assets.local";
const NDOV_SHARED_OBJECT_NAME = "ndov-shared-collector-v1";

let manifestPromise = null;
const shardCache = new Map();
let openovRouteManifestPromise = null;
const openovRouteCache = new Map();
let lastKv6NoExactMatchDiagnosticAt = 0;

// The route cache contains parsed GTFS patterns, which use substantially more
// memory than their 512 KiB JSON shards. Keep only a few route buckets per
// isolate; otherwise a sequence of different itineraries can exhaust Workers
// memory (Error 1102). Smaller ancillary caches avoid retaining whole datasets.
const MAX_OPENOV_ROUTE_CACHE_ENTRIES = 2;
const MAX_TRIP_CROSSWALK_SHARD_CACHE_ENTRIES = 4;
const MAX_STOP_ASSIGNMENT_SHARD_CACHE_ENTRIES = 4;
const MAX_OPENOV_STOP_PLACE_SHARD_CACHE_ENTRIES = 4;

export function getLruCacheValue(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function setBoundedLruCacheValue(cache, key, value, maxEntries) {
  const limit = Number.isInteger(maxEntries) ? Math.max(1, maxEntries) : 1;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return value;
}

// Keep exact NS train identities separate from the bounded diagnostic list of
// route-crosswalk outcomes. Mixed-mode plans can contain more than 12 legs;
// truncating diagnostics must never make an otherwise exact train invisible
// to the NS real-time enricher.
export function buildNsTrainIdentities(outcomes) {
  const acceptedReasons = new Set([
    "exact_route_time_stop_match",
    "exact_openov_trip_id_match",
    "resolved_by_exact_trip_id_crosswalk",
  ]);
  const numbersByTripId = new Map();

  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    const tripId = String(outcome?.tripId ?? "").trim();
    const reason = String(outcome?.reason ?? "");
    const owner = String(outcome?.parsedIdentity?.owner ?? "").trim().toUpperCase();
    const trainNumber = String(outcome?.parsedIdentity?.journey ?? "").trim();

    if (
      !tripId ||
      outcome?.source !== "openov-route-crossmatch" ||
      !acceptedReasons.has(reason) ||
      owner !== "IFF" ||
      !/^\d+$/.test(trainNumber)
    ) {
      continue;
    }

    if (!numbersByTripId.has(tripId)) {
      numbersByTripId.set(tripId, new Set());
    }
    numbersByTripId.get(tripId).add(trainNumber);
  }

  // Fail closed if a single Transitous trip ID somehow points to multiple
  // different NS train numbers.
  return [...numbersByTripId.entries()]
    .filter(([, numbers]) => numbers.size === 1)
    .map(([tripId, numbers]) => ({
      tripId,
      trainNumber: [...numbers][0],
    }));
}

function jsonResponseError(message) {
  return { ok: false, status: "unavailable", message };
}

function getItineraries(plan) {
  if (Array.isArray(plan?.itineraries)) return plan.itineraries;
  if (Array.isArray(plan?.journeys)) return plan.journeys;
  return [];
}

function getLegs(itinerary) {
  if (Array.isArray(itinerary?.legs)) return itinerary.legs;
  if (Array.isArray(itinerary?.transitLegs)) return itinerary.transitLegs;
  return [];
}

function transitousTripIdentity(leg) {
  const tripId = String(leg?.tripId ?? leg?.trip?.id ?? "").trim();
  // Typical ID: 20261012_09:03_nl-OpenOV_382969676
  const dateMatch = tripId.match(/^(\d{8})_/);
  const idMatch = tripId.match(/(?:^|_)nl-OpenOV_(\d+)$/i);
  if (!dateMatch || !idMatch) return null;
  return { serviceDate: dateMatch[1], tripId: idMatch[1], originalTripId: tripId };
}

function normalizeDate(value) {
  const raw = String(value ?? "").trim();
  const compact = raw.replace(/-/g, "");
  const match = compact.match(/^(\d{8})/);
  return match?.[1] ?? null;
}

function valueOf(object, ...names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function toIdentity(owner, date, line, journey, reinforcement = "0") {
  if (!owner || !date || !line || !journey) return null;
  return [String(owner).trim(), normalizeDate(date), String(line).trim(), String(journey).trim(), String(reinforcement ?? "0").trim() || "0"].join("|");
}

function mutationIdentity(mutation) {
  if (!mutation || mutation.allLines === true || mutation.allJourneysOfLine === true) return null;
  const owner = valueOf(mutation, "dataOwnerCode", "DataOwnerCode");
  const date = valueOf(mutation, "operationDate", "OperationDate");
  const line = valueOf(mutation, "linePlanningNumber", "LinePlanningNumber");
  const journey = valueOf(mutation, "journeyNumber", "JourneyNumber");
  const reinforcement = valueOf(mutation, "reinforcementNumber", "fortifyOrderNumber", "ReinforcementNumber", "FortifyOrderNumber") ?? "0";
  return toIdentity(owner, date, line, journey, reinforcement);
}

function parseRealtimeTripId(value) {
  const parts = String(value ?? "").trim().split(/[:|]/).map((part) => part.trim());
  // The OpenOV GTFS-NL crosswalk currently exposes owner:line:journey.
  // Without a fortification field we must not guess a non-zero reinforcement.
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return { owner: parts[0], line: parts[1], journey: parts[2] };
}

function stripOpenovPrefix(value) {
  const raw = String(value ?? "").trim();
  return raw.replace(/^nl-OpenOV_/i, "");
}

function routeNumericId(leg) {
  const raw = String(valueOf(leg, "routeId") ?? valueOf(leg?.route, "id") ?? "").trim();
  const match = raw.match(/(\d+)$/);
  return match?.[1] ?? null;
}

let openovServiceCalendarPromise = null;

async function getOpenovServiceCalendar(env) {
  if (!openovServiceCalendarPromise) {
    openovServiceCalendarPromise = readAssetJson(
      env,
      `${OPENOV_ROUTE_CROSSWALK_ROOT}/service-calendar.json`
    ).catch((error) => {
      openovServiceCalendarPromise = null;
      throw error;
    });
  }

  const calendar = await openovServiceCalendarPromise;
  if (!calendar || typeof calendar !== "object" || Array.isArray(calendar)) {
    throw new Error("OpenOV-servicekalender heeft een ongeldig formaat.");
  }
  return calendar;
}

export function openovTripStartBucket(tripId) {
  const match = String(tripId ?? "").trim().match(/^\d{8}_(\d{1,3}):\d{2}(?::\d{2})?_/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 0) return null;
  return hour >= 24 ? "24" : hour >= 12 ? "12" : "00";
}

async function getOpenovRouteCrosswalk(env, routeId, originalTripId = null) {
  let manifest;
  try {
    if (!openovRouteManifestPromise) {
      openovRouteManifestPromise = readAssetJson(
        env,
        OPENOV_ROUTE_CROSSWALK_ROOT + "/manifest.json"
      ).catch((error) => {
        openovRouteManifestPromise = null;
        throw error;
      });
    }
    manifest = await openovRouteManifestPromise;
  } catch (error) {
    return {
      indexedRoute: false,
      patterns: [],
      generatedAt: null,
      error: error instanceof Error ? error.message : "OpenOV-routeindex niet beschikbaar.",
    };
  }

  const routeKey = String(routeId);
  const bucketIndex = manifest?.routesByStartBucket?.[routeKey];
  const bucket = openovTripStartBucket(originalTripId);
  const useBucket = Boolean(bucketIndex && bucket);
  let files = useBucket
    ? bucketIndex[bucket]
    : manifest?.routes?.[routeKey];

  if (useBucket && (!Array.isArray(files) || files.length === 0)) {
    return {
      indexedRoute: true,
      patterns: [],
      generatedAt: manifest?.generatedAt ?? null,
      serviceCalendarDateCount: Number(manifest?.serviceCalendarDateCount ?? 0),
      error: null,
    };
  }

  if (!Array.isArray(files) || !files.length) {
    return {
      indexedRoute: false,
      patterns: [],
      generatedAt: manifest?.generatedAt ?? null,
      error: null,
    };
  }

  // Cache each route+time bucket separately so a morning request cannot reuse
  // an afternoon shard list for the same route.
  const cacheKey = useBucket ? routeKey + ":" + bucket : routeKey;
  let promise = getLruCacheValue(openovRouteCache, cacheKey);
  if (!promise) {
    promise = (async () => {
      const all = [];
      for (const filename of files) {
        const name = String(filename ?? "").trim();
        if (!name || name.includes("..") || name.includes("/")) {
          throw new Error("Ongeldige route-shardnaam in OpenOV-manifest.");
        }
        const rows = await readAssetJson(
          env,
          OPENOV_ROUTE_CROSSWALK_ROOT + "/routes/" + name
        );
        if (!Array.isArray(rows)) {
          throw new Error("OpenOV-route-shard " + name + " is geen JSON-array.");
        }
        if (
          Number(manifest?.serviceCalendarDateCount ?? 0) > 0 &&
          manifest?.serviceIdsEmbedded !== true
        ) {
          const servicesName = name.replace(/\.json$/i, "-services.json");
          const serviceRows = await readAssetJson(
            env,
            OPENOV_ROUTE_CROSSWALK_ROOT + "/routes/" + servicesName
          );
          if (!Array.isArray(serviceRows) || serviceRows.length !== rows.length) {
            throw new Error(
              "OpenOV-service-sidecar " + servicesName + " ontbreekt of is niet uitgelijnd."
            );
          }
          all.push(...rows.map((row, index) => ({
            ...row,
            serviceIds: Array.isArray(serviceRows[index])
              ? serviceRows[index].map(String)
              : [],
          })));
        } else {
          all.push(...rows);
        }
      }
      return all;
    })().catch((error) => {
      openovRouteCache.delete(cacheKey);
      throw error;
    });
    setBoundedLruCacheValue(
      openovRouteCache, cacheKey, promise, MAX_OPENOV_ROUTE_CACHE_ENTRIES
    );
  }

  try {
    const patterns = await promise;
    return {
      indexedRoute: true,
      patterns,
      generatedAt: manifest?.generatedAt ?? null,
      serviceCalendarDateCount: Number(manifest?.serviceCalendarDateCount ?? 0),
      error: null,
    };
  } catch (error) {
    // A missing expected shard is not safe to resolve through a numeric fallback.
    return {
      indexedRoute: true,
      patterns: [],
      generatedAt: manifest?.generatedAt ?? null,
      error: error instanceof Error ? error.message : "OpenOV-route-shard niet beschikbaar.",
    };
  }
}
function stopTimeValue(stop, kind) {
  if (!stop) return null;
  if (kind === "departure") return valueOf(stop, "departureTime", "departure", "arrivalTime", "arrival");
  return valueOf(stop, "arrivalTime", "arrival", "departureTime", "departure");
}

function timeWithinSeconds(expected, actual, tolerance = 120) {
  const expectedSeconds = wallClockSeconds(expected);
  const actualSeconds = wallClockSeconds(actual);
  const difference = clockDistanceSeconds(expectedSeconds, actualSeconds);
  return difference !== null && difference <= tolerance;
}

function findPatternStop(pattern, stopId, afterIndex = -1) {
  const id = stripOpenovPrefix(stopId);
  if (!id) return null;
  const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
  for (let i = Math.max(0, afterIndex + 1); i < stops.length; i += 1) {
    if (stripOpenovPrefix(stops[i]?.stopId) === id) return { stop: stops[i], index: i };
  }
  return null;
}

/**
 * Resolve a Transitous leg against current OpenOV static GTFS using the full trip
 * origin/terminus, route, headsign, scheduled clocks and boarded segment stop order.
 * It returns a realtimeTripId only if every available anchor agrees and all best
 * candidates point to one unique realtime_trip_id.
 */
export function matchOpenovRoutePattern(leg, patterns, activeServiceIds = null) {
  const wantedRoute = routeNumericId(leg);
  const from = leg?.tripFrom ?? null;
  const to = leg?.tripTo ?? null;
  const fromStop = stripOpenovPrefix(from?.stopId);
  const toStop = stripOpenovPrefix(to?.stopId);
  const originTime = valueOf(from, "scheduledDeparture", "departure");
  const terminalTime = valueOf(to, "scheduledArrival", "arrival");
  const startFromId = String(leg?.tripId ?? leg?.trip?.id ?? "").match(/^\d{8}_(\d{2}:\d{2})_/)?.[1] ?? null;
  if (!wantedRoute || !fromStop || !toStop || !originTime || !terminalTime) {
    return { realtimeTripId: null, reason: "missing_trip_anchors", candidateCount: 0 };
  }
  const headsign = String(leg?.headsign ?? "").trim().toLocaleLowerCase("nl-NL");
  const direction = leg?.directionId == null ? null : String(leg.directionId).trim();
  const legFromStop = stripOpenovPrefix(leg?.from?.stopId);
  const legToStop = stripOpenovPrefix(leg?.to?.stopId);
  const legDeparture = valueOf(leg?.from, "scheduledDeparture", "departure") ?? valueOf(leg, "scheduledStartTime", "startTime");
  const legArrival = valueOf(leg?.to, "scheduledArrival", "arrival") ?? valueOf(leg, "scheduledEndTime", "endTime");
  const intermediates = Array.isArray(leg?.intermediateStops) ? leg.intermediateStops : [];
  // Selecteer actieve diensten vóór de route- en haltevergelijkingen.
  // Zonder kalenderinformatie blijft legacygedrag behouden.
  const allPatterns = Array.isArray(patterns) ? patterns : [];
  const patternsForMatching = activeServiceIds instanceof Set
    ? allPatterns.filter((pattern) =>
        Array.isArray(pattern?.serviceIds) &&
        pattern.serviceIds.some((id) => activeServiceIds.has(String(id)))
      )
    : allPatterns;

  const matches = [];

  for (const pattern of patternsForMatching) {
    if (String(pattern?.routeId ?? "") !== wantedRoute) continue;
    if (!Array.isArray(pattern?.stops) || pattern.stops.length < 2 || !pattern?.realtimeTripId) continue;
    if (headsign && String(pattern.headsign ?? "").trim().toLocaleLowerCase("nl-NL") !== headsign) continue;
    if (direction !== null && pattern.directionId != null && String(pattern.directionId).trim() !== direction) continue;
    const first = pattern.stops[0];
    const last = pattern.stops[pattern.stops.length - 1];
    if (stripOpenovPrefix(first.stopId) !== fromStop || stripOpenovPrefix(last.stopId) !== toStop) continue;
    const firstDeparture = stopTimeValue(first, "departure");
    const lastArrival = stopTimeValue(last, "arrival");
    if (!timeWithinSeconds(originTime, firstDeparture, 90) || !timeWithinSeconds(terminalTime, lastArrival, 90)) continue;
    // The trip ID contains HH:mm; reject a neighboring scheduled minute.
    if (startFromId && !timeWithinSeconds(`${startFromId}:00`, firstDeparture, 45)) continue;

    // Confirm the actual boarded/alighted part of the trip, not only its endpoints.
    let cursor = -1;
    if (legFromStop) {
      const board = findPatternStop(pattern, legFromStop, cursor);
      if (!board || (legDeparture && !timeWithinSeconds(legDeparture, stopTimeValue(board.stop, "departure"), 120))) continue;
      cursor = board.index;
    }
    let validIntermediates = true;
    for (const intermediate of intermediates) {
      const found = findPatternStop(pattern, intermediate?.stopId, cursor);
      const expected = valueOf(intermediate, "scheduledArrival", "arrival", "scheduledDeparture", "departure");
      const actual = found ? stopTimeValue(found.stop, "arrival") : null;
      if (!found || (expected && !timeWithinSeconds(expected, actual, 120))) {
        validIntermediates = false;
        break;
      }
      cursor = found.index;
    }
    if (!validIntermediates) continue;
    if (legToStop) {
      const alight = findPatternStop(pattern, legToStop, cursor);
      if (!alight || (legArrival && !timeWithinSeconds(legArrival, stopTimeValue(alight.stop, "arrival"), 120))) continue;
      cursor = alight.index;
    }
    matches.push(pattern);
  }

  // Prefer the original OpenOV GTFS trip ID when it uniquely identifies
  // one of the candidates already matching route, times and stop sequence.
  const sourceTripId = String(leg?.tripId ?? leg?.trip?.id ?? "")
    .match(/(?:^|_)nl-OpenOV_(\d+)$/i)?.[1] ?? null;

  if (sourceTripId) {
    const exactMatches = matches.filter(
      (pattern) => String(pattern?.openovTripId ?? "").trim() === sourceTripId
    );
    const exactIds = [...new Set(
      exactMatches
        .map((pattern) => String(pattern?.realtimeTripId ?? "").trim())
        .filter(Boolean)
    )];

    if (exactMatches.length > 0 && exactIds.length === 1) {
      return {
        realtimeTripId: exactIds[0],
        reason: "exact_openov_trip_id_match",
        candidateCount: exactMatches.length,
        pattern: exactMatches[0],
      };
    }
  }

  const ids = [...new Set(matches.map((pattern) => String(pattern.realtimeTripId).trim()).filter(Boolean))];
  if (ids.length !== 1) {
    const candidatePatternDetails = matches.map((pattern) => {
      const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
      const first = stops[0] ?? null;
      const last = stops.length ? stops[stops.length - 1] : null;
      const boardMatch = legFromStop ? findPatternStop(pattern, legFromStop, 0) : null;
      const alightMatch = legToStop && boardMatch
        ? findPatternStop(pattern, legToStop, boardMatch.index)
        : null;
      const segmentStops = boardMatch && alightMatch && alightMatch.index >= boardMatch.index
        ? stops.slice(boardMatch.index, alightMatch.index + 1).map((stop, offset) => ({
            index: boardMatch.index + offset,
            stopId: stop?.stopId ?? stop?.stop_id ?? stop?.id ?? stop?.gtfsStopId ?? null,
            arrival: stop ? stopTimeValue(stop, "arrival") : null,
            departure: stop ? stopTimeValue(stop, "departure") : null,
          }))
        : [];
      return {
        realtimeTripId: String(pattern?.realtimeTripId ?? ""),
        routeId: pattern?.routeId ?? null,
        headsign: pattern?.headsign ?? null,
        directionId: pattern?.directionId ?? null,
        stopCount: stops.length,
        fullTripStart: first ? {
          stopId: first.stopId ?? first.stop_id ?? first.id ?? first.gtfsStopId ?? null,
          departure: stopTimeValue(first, "departure"),
        } : null,
        fullTripEnd: last ? {
          stopId: last.stopId ?? last.stop_id ?? last.id ?? last.gtfsStopId ?? null,
          arrival: stopTimeValue(last, "arrival"),
        } : null,
        segmentFromIndex: boardMatch?.index ?? null,
        segmentToIndex: alightMatch?.index ?? null,
        segmentStops,
      };
    });
    return {
      realtimeTripId: null,
      reason: ids.length > 1 ? "ambiguous_route_time_stop_match" : "no_exact_route_time_stop_match",
      candidateCount: matches.length,
      candidateRealtimeTripIds: ids,
      candidatePatternDetails,
    };
  }
  return { realtimeTripId: ids[0], reason: "exact_route_time_stop_match", candidateCount: matches.length, pattern: matches[0] };
}

async function resolveRealtimeTripForLeg(env, item) {
  const routeId = routeNumericId(item?.leg);
  if (routeId) {
    const crosswalk = await getOpenovRouteCrosswalk(env, routeId, item?.identity?.originalTripId);
    if (crosswalk.indexedRoute) {
      if (crosswalk.error) return { parsed: null, source: "openov-route-crosswalk", generatedAt: crosswalk.generatedAt, error: crosswalk.error, indexedRoute: true };
      let activeServiceIds = null;

      if (Number(crosswalk.serviceCalendarDateCount ?? 0) > 0) {
        const serviceDate = String(item?.identity?.serviceDate ?? "")
          .replace(/\D/g, "")
          .slice(0, 8);

        if (!/^\d{8}$/.test(serviceDate)) {
          return {
            parsed: null,
            realtimeTripId: null,
            source: "openov-route-crossmatch",
            reason: "missing_service_date_for_calendar_filter",
            generatedAt: crosswalk.generatedAt,
            indexedRoute: true
          };
        }

        let serviceCalendar;
        try {
          serviceCalendar = await getOpenovServiceCalendar(env);
        } catch (error) {
          return {
            parsed: null,
            realtimeTripId: null,
            source: "openov-route-crossmatch",
            reason: "service_calendar_unavailable",
            error: error instanceof Error ? error.message : String(error),
            generatedAt: crosswalk.generatedAt,
            indexedRoute: true
          };
        }

        const activeForDate = serviceCalendar[serviceDate];
        if (!Array.isArray(activeForDate) || activeForDate.length === 0) {
          return {
            parsed: null,
            realtimeTripId: null,
            source: "openov-route-crossmatch",
            reason: "service_date_not_in_calendar",
            generatedAt: crosswalk.generatedAt,
            indexedRoute: true
          };
        }

        activeServiceIds = new Set(activeForDate.map((id) => String(id)));
      }

      const match = matchOpenovRoutePattern(
        item.leg,
        crosswalk.patterns,
        activeServiceIds
      );

      // If the full route pattern is ambiguous, use the exact original
      // Transitous/OpenOV trip-ID crosswalk only as a validated tie-breaker.
      // The mapped realtime ID must already be one of the route matcher candidates.
      if (
        !match.realtimeTripId &&
        match.reason === "ambiguous_route_time_stop_match" &&
        item?.identity?.tripId
      ) {
        try {
          const numericEntry = await getCrosswalkEntry(env, item.identity.tripId);
          const numericRealtimeTripId = String(
            numericEntry?.realtimeTripId ?? ""
          ).trim();
          const candidateIds = match.candidateRealtimeTripIds ?? [];

          if (
            numericRealtimeTripId &&
            candidateIds.includes(numericRealtimeTripId)
          ) {
            const parsed = parseRealtimeTripId(numericRealtimeTripId);

            if (parsed) {
              return {
                parsed,
                realtimeTripId: numericRealtimeTripId,
                source: "openov-route-crossmatch",
                method: "exact route + full-trip times + stops + validated original trip-ID crosswalk",
                generatedAt:
                  crosswalk.generatedAt ??
                  numericEntry?.manifest?.generatedAt ??
                  null,
                indexedRoute: true,
                reason: "resolved_by_exact_trip_id_crosswalk",
                candidateCount: match.candidateCount,
                candidateRealtimeTripIds: candidateIds,
                candidatePatternDetails: match.candidatePatternDetails ?? [],
              };
            }
          }
        } catch {
          // An unavailable legacy crosswalk must never force a guess.
        }
      }

      return {
        parsed: parseRealtimeTripId(match.realtimeTripId),
        realtimeTripId: match.realtimeTripId,
        source: "openov-route-crossmatch",
        method: "exact route + full-trip time + endpoints + segment stop order",
        generatedAt: crosswalk.generatedAt,
        indexedRoute: true,
        reason: match.reason,
        candidateCount: match.candidateCount,
        candidateRealtimeTripIds: match.candidateRealtimeTripIds ?? [],
        candidatePatternDetails: match.candidatePatternDetails ?? [],
        pattern: match.pattern ?? null,
      };
    }
    if (crosswalk.error) return { parsed: null, source: "openov-route-crosswalk", generatedAt: crosswalk.generatedAt, error: crosswalk.error, indexedRoute: false };
  }
  // Legacy numeric crosswalk only when there is no OpenOV route index for this route.
  const identity = item?.identity;
  if (!identity?.tripId) return { parsed: null, source: "legacy-crosswalk", indexedRoute: false, reason: "no_trip_id" };
  const entry = await getCrosswalkEntry(env, identity.tripId);
  const parsed = parseRealtimeTripId(entry.realtimeTripId);
  return { parsed, realtimeTripId: entry.realtimeTripId, source: "legacy-crosswalk", generatedAt: entry.manifest?.generatedAt ?? null, indexedRoute: false, reason: parsed ? "legacy_exact_numeric_id" : "no_legacy_id_match" };
}

function timestampMs(value) {
  if (!value) return null;
  let text = String(value).trim();
  // Date.parse implementations vary for fractional seconds longer than 3 digits.
  text = text.replace(/\.(\d{3})\d+(?=([+-]\d{2}:?\d{2}|Z)$)/, ".$1");
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readAssetJson(env, path) {
  // Normalize asset paths so callers may pass either "folder/file.json"
  // or "/folder/file.json". ASSETS.fetch matches the URL pathname.
  const assetPath = String(path).startsWith("/") ? String(path) : `/${path}`;
  const response = await env.ASSETS.fetch(new Request(`${ASSET_ORIGIN}${assetPath}`, {
    method: "GET",
    headers: { accept: "application/json" },
  }));
  if (!response.ok) throw new Error(`Crosswalk asset ${assetPath}: HTTP ${response.status}`);
  return response.json();
}

async function getManifest(env) {
  if (!manifestPromise) {
    manifestPromise = readAssetJson(env, `${CROSSWALK_ROOT}/manifest.json`).catch((error) => {
      manifestPromise = null;
      throw error;
    });
  }
  return manifestPromise;
}

async function getCrosswalkEntry(env, numericTripId) {
  const manifest = await getManifest(env);
  const shardPrefixes = Array.isArray(manifest?.shards) ? manifest.shards : [];
  const prefix = shardPrefixes
    .filter((candidate) => numericTripId.startsWith(String(candidate)))
    .sort((a, b) => String(b).length - String(a).length)[0];
  if (!prefix) return { manifest, realtimeTripId: null };

  let shardPromise = getLruCacheValue(shardCache, prefix);
  if (!shardPromise) {
    shardPromise = readAssetJson(env, `${CROSSWALK_ROOT}/trips-${prefix}.json`).catch((error) => {
      shardCache.delete(prefix);
      throw error;
    });
    setBoundedLruCacheValue(
      shardCache, prefix, shardPromise, MAX_TRIP_CROSSWALK_SHARD_CACHE_ENTRIES
    );
  }
  const shard = await shardPromise;
  return { manifest, realtimeTripId: shard?.[numericTripId] ?? null };
}

async function getBisonSnapshot(env) {
  if (!env?.NDOV_FEEDS) throw new Error("De NDOV_FEEDS-binding ontbreekt.");
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const response = await stub.fetch(`${ASSET_ORIGIN}/status?stream=bison`);
  const snapshot = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(snapshot?.error ?? `BISON-status gaf HTTP ${response.status}.`);
  return snapshot;
}

async function getBisonIdentityDiagnostics(env) {
  if (!env?.NDOV_FEEDS) throw new Error("De NDOV_FEEDS-binding ontbreekt.");
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const response = await stub.fetch(`${ASSET_ORIGIN}/status?stream=bison&identityDiagnostics=1`);
  const snapshot = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(snapshot?.error ?? `BISON-identiteitsdiagnose gaf HTTP ${response.status}.`);
  return snapshot.bisonIdentityDiagnostics ?? null;
}

async function getCurrentBisonMutations(env, identities) {
  const unique = [...new Set(identities.filter(Boolean))];
  if (!unique.length) return [];
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const all = [];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const url = new URL(`${ASSET_ORIGIN}/mutations`);
    url.searchParams.set("stream", "bison");
    for (const identity of unique.slice(offset, offset + 20)) url.searchParams.append("identity", identity);
    const response = await stub.fetch(url.toString());
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error ?? `BISON-mutaties gaven HTTP ${response.status}.`);
    if (!Array.isArray(data?.mutations)) throw new Error("BISON gaf geen actuele mutatielijst terug.");
    all.push(...data.mutations);
  }
  return all;
}


async function getKv78Snapshot(env) {
  if (!env?.NDOV_FEEDS) throw new Error("De NDOV_FEEDS-binding ontbreekt.");
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const response = await stub.fetch(`${ASSET_ORIGIN}/status?stream=kv78&identityDiagnostics=1`);
  const snapshot = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(snapshot?.error ?? `KV78-status gaf HTTP ${response.status}.`);
  return snapshot;
}

async function getCurrentKv78Rows(env, identity) {
  if (!identity || !env?.NDOV_FEEDS) return [];
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const url = new URL(`${ASSET_ORIGIN}/rows`);
  url.searchParams.set("stream", "kv78");
  url.searchParams.set("identity", identity);
  const response = await stub.fetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error ?? `KV78-halterijen gaven HTTP ${response.status}.`);
  if (!Array.isArray(data?.rows)) throw new Error("KV78 gaf geen lijst met halterijen terug.");
  return data.rows;
}

async function getCurrentKv78RowsByVehicle(env, lookup) {
  if (!lookup || !env?.NDOV_FEEDS) return [];
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const url = new URL(`${ASSET_ORIGIN}/rows`);
  url.searchParams.set("stream", "kv78");
  url.searchParams.set("vehicleNumber", lookup.vehicleNumber);
  url.searchParams.set("owner", lookup.owner);
  url.searchParams.set("date", lookup.operationDate);
  if (lookup.linePlanningNumber) url.searchParams.set("line", lookup.linePlanningNumber);
  const response = await stub.fetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error ?? `KV78-voertuighalterijen gaven HTTP ${response.status}.`);
  if (!Array.isArray(data?.rows)) throw new Error("KV78 gaf geen lijst met voertuig-haltes terug.");
  return data.rows;
}

function routeLineNumber(value) {
  const match = String(value ?? "").trim().toUpperCase().match(/(\d+)\s*$/);
  return match ? String(Number(match[1])) : null;
}

function kv78VehicleLookupForItem(item) {
  // Exact trip identity remains authoritative. Vehicle fallback is only for
  // the specific gap where the static NDOV trip crosswalk did not resolve.
  if (item?.identityKey) return null;

  const position = item?.leg?.openovRealtime?.vehiclePosition;
  const vehicleId = String(position?.vehicleId ?? "").replace(/^nl-OpenOV_/i, "").trim();
  const vehicleMatch = vehicleId.match(/^([A-Za-z0-9_-]+):([^:]+)$/);
  if (!vehicleMatch || !item?.identity?.serviceDate) return null;

  const observedAt = timestampMs(position?.observedAt);
  const ageMs = observedAt === null ? null : Date.now() - observedAt;
  if (ageMs === null || ageMs < -30_000 || ageMs > MAX_BISON_AGE_MS) return null;

  const owner = vehicleMatch[1].toUpperCase();
  const vehicleNumber = vehicleMatch[2].trim();
  const routeNumber = routeLineNumber(
    item?.leg?.routeShortName ??
    item?.leg?.route?.shortName ??
    item?.leg?.route?.publicCode ??
    item?.leg?.line?.publicCode
  );
  const linePlanningNumber = String(item?.realtimeIdentity?.line ?? "").trim().toUpperCase() || null;
  if (!vehicleNumber || (!linePlanningNumber && !routeNumber)) return null;

  return {
    owner,
    vehicleNumber,
    operationDate: item.identity.serviceDate,
    linePlanningNumber,
    routeNumber,
  };
}

function kv78RowMatchesVehicleLookup(row, item, lookup) {
  if (!row || !lookup) return false;
  if (String(row.dataOwnerCode ?? "").trim().toUpperCase() !== lookup.owner) return false;
  if (normalizeDate(row.operationDate) !== lookup.operationDate) return false;
  if (String(row.vehicleNumber ?? "").trim().split(":").pop() !== lookup.vehicleNumber) return false;

  const rowLine = String(row.linePlanningNumber ?? "").trim().toUpperCase();
  if (lookup.linePlanningNumber) {
    if (rowLine !== lookup.linePlanningNumber) return false;
  } else if (routeLineNumber(rowLine) !== lookup.routeNumber) {
    return false;
  }
  return true;
}

function kv78RowWithinLegTimeWindow(row, item, toleranceSeconds = 180) {
  const scheduledDeparture = valueOf(item?.leg?.from, "departure") ??
    valueOf(item?.leg, "startTime", "departureTime");
  const scheduledArrival = valueOf(item?.leg?.to, "arrival") ??
    valueOf(item?.leg, "endTime", "arrivalTime");
  const departureDistance = row?.targetDepartureTime
    ? clockDistanceSeconds(wallClockSeconds(scheduledDeparture), wallClockSeconds(row.targetDepartureTime))
    : null;
  const arrivalDistance = row?.targetArrivalTime
    ? clockDistanceSeconds(wallClockSeconds(scheduledArrival), wallClockSeconds(row.targetArrivalTime))
    : null;
  return (departureDistance !== null && departureDistance <= toleranceSeconds) ||
    (arrivalDistance !== null && arrivalDistance <= toleranceSeconds);
}

function sameKv78TripIdentity(row, item) {
  if (!row || !item?.identityKey) return false;
  const rowIdentity = toIdentity(
    row.dataOwnerCode,
    row.operationDate,
    row.linePlanningNumber,
    row.journeyNumber,
    row.fortifyOrderNumber ?? row.reinforcementNumber ?? "0"
  );
  return rowIdentity === item.identityKey;
}

let stopAssignmentManifestPromise = null;
const stopAssignmentShardCache = new Map();

function stopAssignmentShardNumber(key, shardCount) {
  // Hash UTF-8 bytes, exactly matching Python's key.encode("utf-8").
  const bytes = new TextEncoder().encode(key);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

async function getStopAssignmentIndex(env, keys = []) {
  if (!stopAssignmentManifestPromise) {
    stopAssignmentManifestPromise = readAssetJson(env, "ndov-stop-crosswalk/manifest.json").catch((error) => {
      stopAssignmentManifestPromise = null;
      throw error;
    });
  }
  const manifest = await stopAssignmentManifestPromise;
  const shardCount = Number(manifest?.shardCount);
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 256) {
    throw new Error("Ongeldige PSA/CHB crosswalk-manifest (shardCount).");
  }
  const shardNumbers = [...new Set((Array.isArray(keys) ? keys : [])
    .filter((key) => typeof key === "string" && key.includes("|"))
    .map((key) => stopAssignmentShardNumber(key, shardCount)))];
  const assignments = Object.create(null);
  await Promise.all(shardNumbers.map(async (shardNumber) => {
    const cacheKey = String(shardNumber);
    let shardPromise = getLruCacheValue(stopAssignmentShardCache, cacheKey);
    if (!shardPromise) {
      shardPromise = readAssetJson(env, `ndov-stop-crosswalk/shards/stop-assignments-${shardNumber}.json`).catch((error) => {
        stopAssignmentShardCache.delete(cacheKey);
        throw error;
      });
      setBoundedLruCacheValue(
        stopAssignmentShardCache, cacheKey, shardPromise, MAX_STOP_ASSIGNMENT_SHARD_CACHE_ENTRIES
      );
    }
    const shard = await shardPromise;
    Object.assign(assignments, shard?.assignments ?? {});
  }));
  return { ...manifest, assignments };
}

function normalizeStopPlaceIdentity(value) {
  let text = String(value ?? "").trim().toUpperCase();
  text = text.replace(/^NL-OPENOV_/, "");
  text = text.replace(/^NL:CHB:STOPPLACE:/, "NL:S:");
  if (/^\d+$/.test(text)) text = `NL:S:${text}`;
  return text || null;
}

function normalizeStopSide(value) {
  return String(value ?? "").trim().toUpperCase()
    .replace(/^(?:PERRON|PLATFORM|HALTEZIJDE)\s*/i, "")
    .trim();
}



// Generated OpenOV GTFS stop_id -> official NDOV CHB StopPlace crosswalk.
const OPENOV_STOP_PLACE_CROSSWALK_ROOT = "ndov-openov-stopplace-crosswalk";
let openovStopPlaceManifestPromise = null;
const openovStopPlaceShardCache = new Map();

function openovStopPlaceKey(value) {
  const match = String(value ?? "").trim().match(/^(?:nl-openov_)?(\d+)$/i);
  return match ? match[1] : null;
}

function openovStopPlaceShardNumber(key, shardCount) {
  // Must match the Python FNV-1a UTF-8 hash used by the generator.
  const bytes = new TextEncoder().encode(key);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

async function getOpenovStopPlaceIndex(env, stopIds = []) {
  if (!openovStopPlaceManifestPromise) {
    openovStopPlaceManifestPromise = readAssetJson(
      env,
      `${OPENOV_STOP_PLACE_CROSSWALK_ROOT}/manifest.json`,
    ).catch((error) => {
      openovStopPlaceManifestPromise = null;
      throw error;
    });
  }

  const manifest = await openovStopPlaceManifestPromise;
  const shardCount = Number(manifest?.shardCount);

  if (
    manifest?.schemaVersion !== 1 ||
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    shardCount > 256
  ) {
    throw new Error("Ongeldig OpenOV/CHB-stopcrosswalkmanifest.");
  }

  const keys = [...new Set(
    (Array.isArray(stopIds) ? stopIds : [])
      .map(openovStopPlaceKey)
      .filter(Boolean),
  )];

  const shardNumbers = [...new Set(
    keys.map((key) => openovStopPlaceShardNumber(key, shardCount)),
  )];

  const stopPlaces = Object.create(null);

  await Promise.all(shardNumbers.map(async (shardNumber) => {
    const cacheKey = String(shardNumber);
    let shardPromise = getLruCacheValue(openovStopPlaceShardCache, cacheKey);

    if (!shardPromise) {
      shardPromise = readAssetJson(
        env,
        `${OPENOV_STOP_PLACE_CROSSWALK_ROOT}/shards/openov-stop-places-${shardNumber}.json`,
      ).catch((error) => {
        openovStopPlaceShardCache.delete(cacheKey);
        throw error;
      });

      setBoundedLruCacheValue(
        openovStopPlaceShardCache, cacheKey, shardPromise, MAX_OPENOV_STOP_PLACE_SHARD_CACHE_ENTRIES
      );
    }

    const shard = await shardPromise;
    Object.assign(stopPlaces, shard?.stopPlaces ?? {});
  }));

  return { ...manifest, stopPlaces };
}

function expectedStopWithOpenovStopPlaceCrosswalk(stop, index) {
  if (!stop || typeof stop !== "object") return stop;

  const key = openovStopPlaceKey(stop.stopId);
  const mapping = key ? index?.stopPlaces?.[key] : null;

  // Unmapped stops remain untouched. Never infer a mapping from name alone.
  if (!mapping) return stop;

  const mappedPlace = normalizeStopPlaceIdentity(mapping.stopPlaceCode);
  const existingPlace = normalizeStopPlaceIdentity(
    stop.parentId ?? stop.parentStation ?? stop.stopPlaceRef ?? stop.stopPlaceCode,
  );

  // If Transitous already provides a conflicting parent identity, fail closed.
  if (existingPlace && existingPlace !== mappedPlace) return stop;

  return {
    ...stop,
    stopPlaceCode: mapping.stopPlaceCode,
    stopPlaceRef: `NL:CHB:StopPlace:${String(mapping.stopPlaceCode).replace(/^NL:S:/, "")}`,
    ndovOpenovStopCrosswalk: {
      method: mapping.method ?? "generated_openov_chb_crosswalk",
      quayCode: mapping.quayCode ?? null,
      distanceMeters: mapping.distanceMeters ?? null,
      generatedAt: index.generatedAt ?? null,
    },
  };
}


function assignmentDateKey(value) {
  const match = String(value ?? "").match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

function assignmentIsActive(record, operationDate) {
  const day = assignmentDateKey(operationDate);
  if (!day) return true;
  const from = assignmentDateKey(record?.validFrom);
  const thru = assignmentDateKey(record?.validThru);
  return (!from || from <= day) && (!thru || day <= thru);
}

function resolveKv78StopAssignment(row, context) {
  const index = context?.assignmentIndex;
  const owner = String(row?.dataOwnerCode ?? "").trim().toUpperCase();
  const code = String(row?.userStopCode ?? "").trim();
  const key = `${owner}|${code}`;
  const records = index?.assignments?.[key];
  if (!Array.isArray(records) || !records.length) {
    return { matched: true, assignment: null, status: "time_only_unverified", matchMethod: "unique-scheduled-time-only (no PSA mapping)" };
  }
  const active = records.filter((record) => assignmentIsActive(record, context?.operationDate));
  if (!active.length) return { matched: false, reason: "no_active_psa_assignment" };
  const expectedStop = context?.expectedStop;
  const expectedPlace = normalizeStopPlaceIdentity(
    expectedStop?.parentId ?? expectedStop?.parentStation ?? expectedStop?.stopPlaceRef ?? expectedStop?.stopPlaceCode,
  );
  if (!expectedPlace) {
    return { matched: true, assignment: null, status: "time_only_unverified", matchMethod: "unique-scheduled-time-only (planned parent station unavailable)" };
  }
  const samePlace = active.filter((record) => normalizeStopPlaceIdentity(
    record.stopPlaceCode ?? record.stopPlaceRef,
  ) === expectedPlace);
  if (!samePlace.length) return { matched: false, reason: "psa_stopplace_mismatch" };
  const expectedSide = normalizeStopSide(
    expectedStop?.scheduledTrack || expectedStop?.track || expectedStop?.platform_code,
  );
  const recordsWithSide = samePlace.filter((record) => normalizeStopSide(record.stopSideCode));
  if (expectedSide && recordsWithSide.length) {
    const sameSide = recordsWithSide.filter((record) => normalizeStopSide(record.stopSideCode) === expectedSide);
    if (!sameSide.length) return { matched: false, reason: "psa_quay_side_mismatch" };
    const distinctQuays = new Set(sameSide.map((record) => record.quayRef || record.quayCode || "")).size;
    if (distinctQuays > 1) return { matched: false, reason: "ambiguous_psa_quay_side" };
    return {
      matched: true,
      assignment: sameSide[0],
      status: "confirmed_quay_platform",
      matchMethod: "PSA/CHB StopPlace + Quay/haltezijde + dienstregelingstijd",
    };
  }
  const distinctQuays = new Set(samePlace.map((record) => record.quayRef || record.quayCode || "")).size;
  return {
    matched: true,
    assignment: distinctQuays === 1 ? samePlace[0] : null,
    status: "confirmed_stopplace",
    matchMethod: "PSA/CHB StopPlace + dienstregelingstijd (haltezijde niet bevestigd)",
  };
}
function wallClockSeconds(value) {
  const text = String(value ?? "").trim();
  const m = text.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]), sec = Number(m[3]);
    if (min > 59 || sec > 59) return null;
    return h * 3600 + min * 60 + sec;
  }
  const ms = timestampMs(text);
  if (ms === null) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type) => Number(parts.find((p) => p.type === type)?.value);
  const h = part("hour"), min = part("minute"), sec = part("second");
  if (![h, min, sec].every(Number.isFinite)) return null;
  return h * 3600 + min * 60 + sec;
}

function clockDistanceSeconds(a, b) {
  if (a === null || b === null) return null;
  let difference = Math.abs(a - b);
  if (difference > 43200) difference = 86400 - difference;
  return difference;
}

/**
 * KV78 has its own stop code namespace. Until a stop-ID crosswalk is available,
 * only use a unique scheduled-time match within an exact trip identity. Ambiguous
 * matches intentionally return null; this is not advertised as exact stop-ID matching.
 */
export function matchKv78RowByScheduleTime(rows, scheduledInstant, targetField, maxDistanceSeconds = 180, stopContext = null) {
  const targetSeconds = wallClockSeconds(scheduledInstant);
  if (targetSeconds === null) return null;
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowSeconds = wallClockSeconds(row?.[targetField]);
    const distanceSeconds = clockDistanceSeconds(targetSeconds, rowSeconds);
    if (distanceSeconds === null || distanceSeconds > maxDistanceSeconds) continue;
    if (!row?.receivedAt || !Number.isFinite(Date.parse(row.receivedAt))) continue;
    const receivedMs = timestampMs(row.receivedAt);
    const ageMs = receivedMs === null ? null : Date.now() - receivedMs;
    if (ageMs === null || ageMs < -30_000 || ageMs > MAX_BISON_AGE_MS) continue;
    const sourceUpdatedAt = valueOf(row, "lastUpdateTimeStamp", "LastUpdateTimeStamp");
    // Only enforce source-time freshness if the source timestamp declares a timezone.
    // Parsing a timezone-less local clock as UTC would reject valid Dutch updates.
    if (sourceUpdatedAt && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(sourceUpdatedAt).trim())) {
      const sourceUpdatedMs = timestampMs(sourceUpdatedAt);
      if (sourceUpdatedMs !== null) {
        const sourceAgeMs = Date.now() - sourceUpdatedMs;
        if (sourceAgeMs < -30_000 || sourceAgeMs > MAX_BISON_AGE_MS) continue;
      }
    }
    const stopResolution = resolveKv78StopAssignment(row, stopContext);
    if (!stopResolution.matched) continue;
    candidates.push({
      row,
      distanceSeconds,
      stopAssignment: stopResolution.assignment ?? null,
      stopAssignmentStatus: stopResolution.status ?? "time_only_unverified",
      matchMethod: stopResolution.matchMethod ?? "unique-scheduled-time-only (PSA mapping unavailable)",
    });
  }
  candidates.sort((a, b) => a.distanceSeconds - b.distanceSeconds);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[1].distanceSeconds - candidates[0].distanceSeconds < 30) return null;
  return candidates[0];
}

function numericDelay(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function kv78StopEvent(row, delayField, match = null) {
  if (!row) return null;
  const delaySeconds = numericDelay(row[delayField]);
  if (delaySeconds === null) return null;
  const assignment = match?.stopAssignment ?? null;
  return {
    delaySeconds,
    stopCode: valueOf(row, "userStopCode", "UserStopCode"),
    targetTime: valueOf(row, delayField === "departureDelaySeconds" ? "targetDepartureTime" : "targetArrivalTime"),
    receivedAt: row.receivedAt ?? null,
    stopSideCode: assignment?.stopSideCode ?? null,
    quayName: assignment?.quayName ?? null,
    quayCode: assignment?.quayCode ?? null,
    quayRef: assignment?.quayRef ?? null,
    stopPlaceCode: assignment?.stopPlaceCode ?? null,
    stopPlaceRef: assignment?.stopPlaceRef ?? null,
    stopAssignmentStatus: match?.stopAssignmentStatus ?? "time_only_unverified",
    matchMethod: match?.matchMethod ?? "unique-scheduled-time-only (PSA mapping unavailable)",
  };
}

async function getCurrentBisonEvents(env, identities) {
  const unique = [...new Set(identities.filter(Boolean))];
  if (!unique.length) return [];
  const id = env.NDOV_FEEDS.idFromName(NDOV_SHARED_OBJECT_NAME);
  const stub = env.NDOV_FEEDS.get(id);
  const all = [];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const url = new URL(`${ASSET_ORIGIN}/events`);
    url.searchParams.set("stream", "bison");
    for (const identity of unique.slice(offset, offset + 20)) url.searchParams.append("identity", identity);
    const response = await stub.fetch(url.toString());
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error ?? `BISON-KV6-events gaven HTTP ${response.status}.`);
    if (!Array.isArray(data?.events)) throw new Error("BISON gaf geen lijst met actuele KV6-events terug.");
    all.push(...data.events);
  }
  return all;
}

function mutationIsTripWide(mutation) {
  const stopCode = valueOf(mutation, "userStopCode", "UserStopCode");
  const sequence = valueOf(mutation, "passageSequenceNumber", "PassageSequenceNumber");
  if (!stopCode && !sequence) return true;
  const showTrip = String(valueOf(mutation, "showCancelledTrip", "ShowCancelledTrip") ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "ja"].includes(showTrip);
}

function chooseLatestMutation(mutations, exactIdentity) {
  const matching = [];
  for (const mutation of Array.isArray(mutations) ? mutations : []) {
    if (mutationIdentity(mutation) !== exactIdentity) continue;
    if (!mutationIsTripWide(mutation)) continue;
    const eventType = String(valueOf(mutation, "eventType", "mutationType", "type") ?? "").toUpperCase();
    if (eventType !== "CANCEL" && eventType !== "RECOVER") continue;
    const timestamp = valueOf(mutation, "timestamp", "timeStamp", "mutationTimestamp");
    const timeMs = timestampMs(timestamp);
    if (timeMs === null) continue;
    matching.push({ mutation, eventType, timestamp: String(timestamp), timeMs });
  }
  if (!matching.length) return null;
  matching.sort((a, b) => b.timeMs - a.timeMs);
  const newestTime = matching[0].timeMs;
  const newest = matching.filter((item) => item.timeMs === newestTime);
  const actions = [...new Set(newest.map((item) => item.eventType))];
  if (actions.length !== 1) return { status: "conflict", timestamp: matching[0].timestamp };
  return {
    status: actions[0] === "CANCEL" ? "cancelled" : "recovered",
    timestamp: newest[0].timestamp,
    mutation: newest[0].mutation,
  };
}

function legsWithTransitousId(plan) {
  const found = [];
  for (const itinerary of getItineraries(plan)) {
    for (const leg of getLegs(itinerary)) {
      const identity = transitousTripIdentity(leg);
      if (identity) found.push({ leg, identity });
    }
  }
  return found;
}

const NS_RAIL_MODES_FOR_IDENTITY = new Set([
  "RAIL", "REGIONAL_RAIL", "LONG_DISTANCE", "HIGH_SPEED_RAIL",
  "HIGHSPEED_RAIL", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "SUBURBAN", "TRAIN",
]);

/**
 * Resolve exact NS train identities before the larger bus/tram crosswalk pass.
 * On Cloudflare Workers, static-asset reads count toward the per-invocation
 * subrequest budget. A mixed-mode plan with many bus routes must not consume
 * that budget before NS station/board lookups can run.
 */
export async function prepareNsTrainIdentities(plan, env) {
  const railCandidates = legsWithTransitousId(plan).filter(({ leg }) =>
    NS_RAIL_MODES_FOR_IDENTITY.has(String(leg?.mode ?? "").toUpperCase())
  );
  const outcomes = [];

  for (const item of railCandidates) {
    let resolution;
    try {
      resolution = await resolveRealtimeTripForLeg(env, item);
    } catch (error) {
      // Identity preparation is best-effort; one unavailable asset must not
      // stop OpenOV feed enrichment or the later full NDOV pass.
      resolution = {
        parsed: null,
        source: "openov-route-crossmatch",
        reason: "identity_preparation_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    outcomes.push({
      tripId: item.identity.originalTripId,
      source: resolution.source,
      reason: resolution.reason ?? null,
      realtimeTripId: resolution.realtimeTripId ?? null,
      parsedIdentity: resolution.parsed ?? null,
    });
  }

  if (!plan.ndovRealtimeMeta || typeof plan.ndovRealtimeMeta !== "object" ||
      Array.isArray(plan.ndovRealtimeMeta)) {
    plan.ndovRealtimeMeta = {};
  }
  plan.ndovRealtimeMeta.nsTrainIdentities = buildNsTrainIdentities(outcomes);
  plan.ndovRealtimeMeta.nsTrainIdentityPreparation = {
    candidateLegCount: railCandidates.length,
    identityCount: plan.ndovRealtimeMeta.nsTrainIdentities.length,
  };
  return plan;
}

/** Mutates plan legs only for an exact, current KV17 cancellation. */
export async function applyNdovCancellationsToPlan(plan, env) {
  const candidates = legsWithTransitousId(plan);
  const baseMeta = {
    status: "unknown",
    source: "NDOV BISON KV17",
    checkedAt: new Date().toISOString(),
    candidateLegCount: candidates.length,
    matchedLegCount: 0,
    kv17MatchedLegCount: 0,
    cancelledLegCount: 0,
    recoveredLegCount: 0,
    kv6MatchedLegCount: 0,
    kv6DelayLegCount: 0,
    kv6ObservedLegCount: 0,
    ndovPredictionLegCount: 0,
    combinedPredictionLegCount: 0,
    message: "Geen bevestigde NDOV-koppeling toegepast.",
  };
  if (!candidates.length) {
    plan.ndovRealtimeMeta = { ...baseMeta, status: "not_applicable", message: "Geen Transitous/OpenOV-trip-ID's gevonden om te koppelen." };
    return plan;
  }

  let routeCrosswalkMatchedLegCount = 0;
  let routeCrosswalkGeneratedAt = null;
  let routeCrosswalkError = null;
  const routeCrosswalkOutcomes = [];
  const routeCrosswalkMeta = () => ({
    openovRouteCrosswalkGeneratedAt: routeCrosswalkGeneratedAt,
    routeCrosswalkMatchedLegCount,
    routeCrosswalkError,
    // Full compact exact identities for NS; detailed diagnostic candidates
    // remain bounded to protect the public API payload.
    nsTrainIdentities: buildNsTrainIdentities(routeCrosswalkOutcomes),
    routeCrosswalkOutcomes: routeCrosswalkOutcomes.slice(0, 12),
  });
  try {
    for (const item of candidates) {
      const resolution = await resolveRealtimeTripForLeg(env, item);
      if (resolution.generatedAt) routeCrosswalkGeneratedAt = resolution.generatedAt;
      if (resolution.error) routeCrosswalkError = resolution.error;
      routeCrosswalkOutcomes.push({
        tripId: item.identity.originalTripId,
        source: resolution.source,
        reason: resolution.reason ?? null,
        realtimeTripId: resolution.realtimeTripId ?? null,
        parsedIdentity: resolution.parsed ?? null,
        serviceDate: item.identity.serviceDate ?? null,
        candidateCount: resolution.candidateCount ?? null,
        candidateRealtimeTripIds: resolution.candidateRealtimeTripIds ?? [],
        candidatePatternDetails: resolution.candidatePatternDetails ?? [],
      });
      if (!resolution.parsed) {
        // Keep the failure reason attached to the affected leg. A missing or
        // stale mapping is not proof that NDOV has no live data for this trip.
        const reason = resolution.reason ??
          (resolution.error ? "crosswalk_asset_unavailable" : "no_exact_realtime_trip_match");
        item.leg.ndovRealtimeMatch = {
          status: reason === "ambiguous_route_time_stop_match"
            ? "ambiguous"
            : resolution.error
              ? "unavailable"
              : "unmatched",
          source: resolution.source ?? "openov-route-crossmatch",
          reason,
          error: resolution.error ?? null,
          serviceDate: item.identity.serviceDate ?? null,
          originalTripId: item.identity.originalTripId ?? null,
          candidateCount: resolution.candidateCount ?? 0,
          candidateRealtimeTripIds: resolution.candidateRealtimeTripIds ?? [],
        };
        continue;
      }
      item.realtimeIdentity = resolution.parsed;
      item.routePattern = resolution.pattern ?? null;
      item.crosswalkGeneratedAt = resolution.generatedAt ?? null;
      item.crosswalkMatchMethod = resolution.method ?? resolution.source;
      item.identityKey = toIdentity(resolution.parsed.owner, item.identity.serviceDate, resolution.parsed.line, resolution.parsed.journey, "0");
      if (resolution.source === "openov-route-crossmatch") routeCrosswalkMatchedLegCount += 1;
    }
  } catch (error) {
    routeCrosswalkError = error instanceof Error
      ? error.message
      : "onbekende fout";
    plan.ndovRealtimeMeta = {
      ...baseMeta,
      ...routeCrosswalkMeta(),
      status: "crosswalk_unavailable",
      message: `GTFS-crosswalk niet beschikbaar: ${routeCrosswalkError}`,
    };
    return plan;
  }
  let snapshot;
  try {
    snapshot = await getBisonSnapshot(env);
  } catch (error) {
    plan.ndovRealtimeMeta = {
      ...baseMeta,
      ...routeCrosswalkMeta(),
      status: "unavailable",
      message: error instanceof Error ? error.message : "BISON-status niet beschikbaar.",
    };
    return plan;
  }

  const latestMessageAt = valueOf(snapshot, "latestMessageAt");
  const feedTimeMs = timestampMs(latestMessageAt);
  const feedAgeMs = feedTimeMs === null ? null : Date.now() - feedTimeMs;
  if (snapshot.state === "error" || feedAgeMs === null || feedAgeMs < -30_000 || feedAgeMs > MAX_BISON_AGE_MS) {
    console.log("[OVLIVE_BISON_STALE_DIAG]", JSON.stringify({
      state: snapshot.state ?? null,
      latestMessageAt: latestMessageAt ?? null,
      feedAgeSeconds: feedAgeMs === null ? null : Math.round(feedAgeMs / 1000),
      startedAt: snapshot.startedAt ?? null,
      finishedAt: snapshot.finishedAt ?? null,
      sessionSeconds: snapshot.sessionSeconds ?? null,
      messageCount: snapshot.messageCount ?? null,
      rawBytes: snapshot.rawBytes ?? null,
      envelopeCounts: snapshot.envelopeCounts ?? null,
      continuousEnabled: snapshot.continuousEnabled ?? null,
      nextAlarmAt: snapshot.nextAlarmAt ?? null,
      storedKv6TripCount: snapshot.storedKv6TripCount ?? null,
      error: snapshot.error ?? null,
      warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice(-5) : [],
    }));
    plan.ndovRealtimeMeta = {
      ...baseMeta,
      ...routeCrosswalkMeta(),
      status: "stale",
      feedState: snapshot.state ?? "unknown",
      feedAgeSeconds: feedAgeMs === null ? null : Math.round(feedAgeMs / 1000),
      message: "BISON-feed is niet recent genoeg; er wordt geen NDOV-status toegepast.",
    };
    return plan;
  }


  let mutations = [];
  try {
    const exactIdentities = [...new Set(candidates.map((item) => item.identityKey).filter(Boolean))];
    mutations = await getCurrentBisonMutations(env, exactIdentities);
  } catch (error) {
    plan.ndovRealtimeMeta = {
      ...baseMeta,
      ...routeCrosswalkMeta(),
      status: "mutation_lookup_unavailable",
      feedAgeSeconds: Math.round(feedAgeMs / 1000),
      message: `Exacte KV17-mutaties niet opvraagbaar: ${error instanceof Error ? error.message : "onbekende fout"}`,
    };
    return plan;
  }
  let matched = 0;
  let cancelled = 0;
  let recovered = 0;
  let kv78MatchedLegCount = 0;
  let kv78DataLegCount = 0;
  let kv78ConfirmedStopLegCount = 0;
  let kv78VehicleFallbackLegCount = 0;
  let kv78DelayLegCount = 0;
  let kv78FeedAgeSeconds = null;
  let kv78FeedState = "unknown";
  for (const item of candidates) {
    if (!item.identityKey) continue;
    const result = chooseLatestMutation(mutations, item.identityKey);
    if (!result) continue;
    if (result.status === "conflict") continue;
    matched += 1;
    if (result.status === "cancelled") {
      const reason = valueOf(result.mutation, "reasonContent", "reason", "adviceContent");
      const note = `Exacte ritmatch via GTFS-NL realtime_trip_id en NDOV KV17. Rit ${item.identity.tripId}; NDOV-identiteit ${item.realtimeIdentity.owner}:${item.realtimeIdentity.line}:${item.realtimeIdentity.journey}; exploitatiedatum ${item.identity.serviceDate.slice(0, 4)}-${item.identity.serviceDate.slice(4, 6)}-${item.identity.serviceDate.slice(6, 8)}; mutatie ${result.timestamp}${reason ? `; reden: ${reason}` : ""}.`;
      item.leg.cancelled = true;
      item.leg.ndovRealtime = {
        status: "cancelled",
        source: "NDOV BISON KV17",
        identity: item.identityKey,
        timestamp: result.timestamp,
        note,
      };
      cancelled += 1;
    } else {
      item.leg.ndovRealtime = {
        status: "recovered",
        source: "NDOV BISON KV17",
        identity: item.identityKey,
        timestamp: result.timestamp,
        note: "De meest recente exacte KV17-mutatie is RECOVER; er wordt geen annulering getoond.",
      };
      recovered += 1;
    }
  }

  // KV6 is the same underlying BISON punctuality/vehicle stream used by
  // live vehicle visualisations. It supplies a measured operator delay in seconds
  // for the exact trip identity; it is not inferred from route timing.
  let kv6Error = null;
  let kv6MatchedLegCount = 0;
  let kv6DelayLegCount = 0;
  let kv6ObservedLegCount = 0;
  let kv6RequestedIdentityKeys = [];
  let kv6ReturnedEventCount = null;
  try {
    const liveItems = candidates.filter((item) => item.identityKey && item.leg.ndovRealtime?.status !== "cancelled");
    kv6RequestedIdentityKeys = [...new Set(liveItems.map((item) => item.identityKey))];
    const events = await getCurrentBisonEvents(env, kv6RequestedIdentityKeys);
    kv6ReturnedEventCount = events.length;
    const eventByIdentity = new Map(events.map((event) => [
      toIdentity(event.dataOwnerCode, event.operationDate, event.linePlanningNumber, event.journeyNumber, event.reinforcementNumber ?? "0"),
      event,
    ]));
    for (const item of liveItems) {
      const event = eventByIdentity.get(item.identityKey);
      if (!event) continue;
      const nowMs = Date.now();
      const punctualitySeconds = numericDelay(event.punctualitySeconds);
      const punctualityReceivedMs = timestampMs(event.punctualityReceivedAt);
      const punctualityAgeMs = punctualityReceivedMs === null
        ? null
        : nowMs - punctualityReceivedMs;
      let hasFreshPunctuality = punctualitySeconds !== null &&
        punctualityAgeMs !== null &&
        punctualityAgeMs >= -30_000 &&
        punctualityAgeMs <= MAX_BISON_AGE_MS;

      const eventType = String(valueOf(event, "eventType") ?? "").trim().toUpperCase();
      const receivedMs = timestampMs(event.receivedAt);
      const activityAgeMs = receivedMs === null ? null : nowMs - receivedMs;
      let hasFreshActivity = ACTIVE_KV6_EVENT_TYPES.has(eventType) &&
        activityAgeMs !== null &&
        activityAgeMs >= -30_000 &&
        activityAgeMs <= MAX_BISON_AGE_MS;

      const punctualityTime = valueOf(event, "punctualityTimestamp");
      if (hasFreshPunctuality && punctualityTime &&
          /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(punctualityTime).trim())) {
        const sourceMs = timestampMs(punctualityTime);
        if (sourceMs !== null) {
          const sourceAge = nowMs - sourceMs;
          if (sourceAge < -30_000 || sourceAge > MAX_BISON_AGE_MS) {
            hasFreshPunctuality = false;
          }
        }
      }

      // Source event times can identify a delayed/replayed message even when
      // the local collector received the envelope moments ago.
      const eventTime = valueOf(event, "timestamp");
      if (hasFreshActivity && eventTime &&
          /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(eventTime).trim())) {
        const sourceMs = timestampMs(eventTime);
        if (sourceMs !== null) {
          const sourceAge = nowMs - sourceMs;
          if (sourceAge < -30_000 || sourceAge > MAX_BISON_AGE_MS) {
            hasFreshActivity = false;
          }
        }
      }

      if (!hasFreshPunctuality && !hasFreshActivity) continue;

      const delaySeconds = hasFreshPunctuality
        ? Math.trunc(punctualitySeconds)
        : null;
      const observedAt = hasFreshPunctuality
        ? (punctualityTime || eventTime || event.punctualityReceivedAt)
        : (eventTime || event.receivedAt);
      const observationAgeMs = hasFreshPunctuality && !hasFreshActivity
        ? punctualityAgeMs
        : activityAgeMs ?? punctualityAgeMs;
      if (hasFreshPunctuality && delaySeconds !== null && item.routePattern && valueOf(event, "userStopCode")) {
        item.kv6PredictionContext = { event, delaySeconds, observedAt, observationAgeMs };
      }

      console.log("[OVLIVE_KV6_MATCH_RESULT]", JSON.stringify({
        transitousTripId: item.identity?.originalTripId ?? null,
        ndovIdentity: item.identityKey ?? null,
        punctualitySeconds: delaySeconds,
        vehicleNumber: valueOf(event, "vehicleNumber") ?? null,
        currentStopCode: valueOf(event, "userStopCode") ?? null,
        passageSequenceNumber: valueOf(event, "passageSequenceNumber") ?? null,
        eventType: eventType || null,
        sourceTimestamp: observedAt ?? null,
        receivedAt: event.receivedAt ?? event.punctualityReceivedAt ?? null,
        feedAgeSeconds: observationAgeMs === null ? null : Math.round(observationAgeMs / 1000),
      }));

      const kv6Observation = {
        status: delaySeconds === null ? "kv6_observed" : "kv6_live",
        source: "NDOV BISON KV6",
        identity: item.identityKey,
        matchMethod: item.crosswalkMatchMethod ?? "exact-trip-identity via GTFS-NL realtime_trip_id",
        punctualitySeconds: delaySeconds,
        vehicleNumber: valueOf(event, "vehicleNumber") ?? null,
        blockCode: valueOf(event, "blockCode") ?? null,
        currentStopCode: valueOf(event, "userStopCode") ?? null,
        passageSequenceNumber: valueOf(event, "passageSequenceNumber") ?? null,
        distanceSinceLastStop: valueOf(event, "distanceSinceLastStop") ?? null,
        rdX: valueOf(event, "rdX") ?? null,
        rdY: valueOf(event, "rdY") ?? null,
        eventType: eventType || null,
        timestamp: observedAt ?? null,
        receivedAt: event.receivedAt ?? event.punctualityReceivedAt ?? null,
        feedAgeSeconds: observationAgeMs === null ? null : Math.round(observationAgeMs / 1000),
        note: delaySeconds === null
          ? "NDOV heeft een verse ONROUTE/ONSTOP/DEPARTURE/ARRIVAL-waarneming voor deze exact gematchte rit. Deze gebeurtenis bevat geen verse punctuality; vertraging en aankomsttijd blijven onbekend."
          : "Actuele punctualiteit van de vervoerder, gekoppeld via de exacte GTFS-NL realtime_trip_id. Een positieve waarde is vertraging in seconden; een negatieve waarde is te vroeg.",
      };
      item.leg.ndovRealtime = {
        ...(item.leg.ndovRealtime ?? {}),
        kv6: kv6Observation,
        ...kv6Observation,
      };
      kv6MatchedLegCount += 1;
      if (delaySeconds === null) kv6ObservedLegCount += 1;
      else if (delaySeconds > 0) kv6DelayLegCount += 1;
    }
  } catch (error) {
    kv6Error = error instanceof Error ? error.message : "KV6-actuele ritgegevens niet beschikbaar.";
  }

  // Log alleen een begrensde identiteitsdiagnose als geen enkele geplande rit
  // een KV6-event matcht. Geen voertuigpositie, haltecode of voertuignummer loggen.
  if (
    kv6MatchedLegCount === 0 &&
    kv6RequestedIdentityKeys.length > 0 &&
    Date.now() - lastKv6NoExactMatchDiagnosticAt >= 60_000
  ) {
    lastKv6NoExactMatchDiagnosticAt = Date.now();
    const bisonIdentityDiagnostics = await getBisonIdentityDiagnostics(env).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const latestStoredEvents = Array.isArray(snapshot.latestEvents) ? snapshot.latestEvents : [];
    const storedEventIdentitySamples = latestStoredEvents.slice(-12).map((event) => ({
      identity: toIdentity(
        valueOf(event, "dataOwnerCode", "DataOwnerCode"),
        valueOf(event, "operationDate", "OperationDate"),
        valueOf(event, "linePlanningNumber", "LinePlanningNumber"),
        valueOf(event, "journeyNumber", "JourneyNumber"),
        valueOf(event, "reinforcementNumber", "ReinforcementNumber") ?? "0"
      ),
      eventType: valueOf(event, "eventType", "EventType") ?? null,
      receivedAt: valueOf(event, "receivedAt") ?? null,
    }));
    console.log("[OVLIVE_KV6_NO_EXACT_MATCH_DIAG]", JSON.stringify({
      feedState: snapshot.state ?? null,
      latestMessageAt: snapshot.latestMessageAt ?? null,
      messageCount: snapshot.messageCount ?? null,
      rawBytes: snapshot.rawBytes ?? null,
      envelopeCounts: snapshot.envelopeCounts ?? {},
      storedKv6TripCount: snapshot.storedKv6TripCount ?? latestStoredEvents.length,
      bisonIdentityDiagnostics,
      storedEventSampleCount: storedEventIdentitySamples.length,
      requestedIdentityKeys: kv6RequestedIdentityKeys.slice(0, 8),
      returnedExactEventCount: kv6ReturnedEventCount,
      storedEventIdentitySamples,
      kv6Error,
    }));
  }

  // Delay enrichment is independent of the KV17 state: it reads already-collected
  // fresh KV78 rows and never opens a feed connection from /api/plan.
  let kv78Error = null;
  let stopAssignmentIndex = null;
  let openovStopPlaceIndex = null;
  try {
    const kv78Snapshot = await getKv78Snapshot(env);
    const kv78CachedRows = Array.isArray(kv78Snapshot.latestRows)
      ? kv78Snapshot.latestRows
      : [];
    const kv78WatchedRows = kv78CachedRows.filter((row) => {
      const owner = String(row?.dataOwnerCode ?? "").trim().toUpperCase();
      const line = String(row?.linePlanningNumber ?? "").trim().toUpperCase();
      return owner === "CXX" && ["U005", "U011", "U073"].includes(line);
    });

    kv78FeedState = kv78Snapshot.state ?? "unknown";
    const kv78LatestMs = timestampMs(valueOf(kv78Snapshot, "latestMessageAt"));
    const kv78AgeMs = kv78LatestMs === null ? null : Date.now() - kv78LatestMs;
    kv78FeedAgeSeconds = kv78AgeMs === null ? null : Math.round(kv78AgeMs / 1000);
    if (kv78Snapshot.state !== "error" && kv78AgeMs !== null && kv78AgeMs >= -30_000 && kv78AgeMs <= MAX_BISON_AGE_MS) {
      const delayItems = candidates.filter((item) =>
        item.leg.ndovRealtime?.status !== "cancelled" &&
        (item.identityKey || kv78VehicleLookupForItem(item))
      );
      const rowResults = await Promise.all(delayItems.map(async (item) => {
        const vehicleLookup = kv78VehicleLookupForItem(item);
        const exactRows = item.identityKey
          ? await getCurrentKv78Rows(env, item.identityKey)
          : [];
        let vehicleRows = [];
        let vehicleLookupError = null;
        if (vehicleLookup) {
          try {
            vehicleRows = await getCurrentKv78RowsByVehicle(env, vehicleLookup);
          } catch (error) {
            vehicleLookupError = error instanceof Error ? error.message : String(error);
          }
        }
        const filteredVehicleRows = vehicleRows.filter((row) =>
          kv78RowMatchesVehicleLookup(row, item, vehicleLookup) &&
          kv78RowWithinLegTimeWindow(row, item)
        );
        const uniqueRows = new Map();
        for (const row of [...exactRows, ...filteredVehicleRows]) {
          const identity = toIdentity(
            row.dataOwnerCode,
            row.operationDate,
            row.linePlanningNumber,
            row.journeyNumber,
            row.fortifyOrderNumber ?? row.reinforcementNumber ?? "0"
          );
          const key = [identity, row.userStopOrderNumber ?? "", row.userStopCode ?? ""].join("|");
          if (!uniqueRows.has(key)) uniqueRows.set(key, row);
        }
        return {
          item,
          rows: [...uniqueRows.values()],
          vehicleLookup,
          vehicleLookupError,
        };
      }));
      const vehicleLookupErrors = [...new Set(rowResults
        .map((result) => result.vehicleLookupError)
        .filter(Boolean))];
      if (vehicleLookupErrors.length) {
        kv78Error = vehicleLookupErrors.slice(0, 3).join("; ");
      }

      const kv6PredictionItems = candidates.filter((item) => item.routePattern && item.kv6PredictionContext);
      try {
        const kv6RouteStopIds = kv6PredictionItems.flatMap((item) => getNdovPredictionStopIds(
          item.leg, item.routePattern, item.kv6PredictionContext.event, item.kv6PredictionContext.delaySeconds,
        ));
        const plannedStopIds = [
          ...rowResults.flatMap(({ item }) => [item?.leg?.from?.stopId, item?.leg?.to?.stopId]),
          ...kv6RouteStopIds,
        ];
        openovStopPlaceIndex = await getOpenovStopPlaceIndex(env, plannedStopIds);
      } catch (error) {
        kv78Error = [
          kv78Error,
          `OpenOV/CHB-stopcrosswalk niet beschikbaar: ${
            error instanceof Error ? error.message : "onbekende fout"
          }`,
        ].filter(Boolean).join("; ");
      }
      const kv6AssignmentKeys = kv6PredictionItems.map((item) => {
        const event = item.kv6PredictionContext?.event;
        const owner = String(event?.dataOwnerCode ?? "").trim().toUpperCase();
        const stopCode = String(event?.userStopCode ?? "").trim();
        return owner && stopCode ? `${owner}|${stopCode}` : null;
      }).filter(Boolean);
      const assignmentKeys = [...new Set([
        ...rowResults.flatMap((entry) => entry.rows.map((row) => {
          const owner = String(row?.dataOwnerCode ?? "").trim().toUpperCase();
          const stopCode = String(row?.userStopCode ?? "").trim();
          return owner && stopCode ? `${owner}|${stopCode}` : null;
        }).filter(Boolean)),
        ...kv6AssignmentKeys,
      ])];
      try {
        stopAssignmentIndex = await getStopAssignmentIndex(env, assignmentKeys);
      } catch (error) {
        kv78Error = `PSA/CHB-haltecrosswalk niet beschikbaar; tijdmatching blijft ongeverifieerd: ${error instanceof Error ? error.message : "onbekende fout"}`;
      }

      for (const { item, rows, vehicleLookup } of rowResults) {
        if (!rows.length) {
          continue;
        }
        const scheduledDeparture = valueOf(item.leg.from, "departure") ?? valueOf(item.leg, "startTime", "departureTime");
        const scheduledArrival = valueOf(item.leg.to, "arrival") ?? valueOf(item.leg, "endTime", "arrivalTime");
        const operationDate = item.identity?.serviceDate ?? item.realtimeIdentity?.operationDate ?? item.identity?.operationDate ?? null;
        const departureMatch = matchKv78RowByScheduleTime(rows, scheduledDeparture, "targetDepartureTime", 180, {
          expectedStop: expectedStopWithOpenovStopPlaceCrosswalk(item.leg.from, openovStopPlaceIndex), assignmentIndex: stopAssignmentIndex, operationDate,
        });
        const arrivalMatch = matchKv78RowByScheduleTime(rows, scheduledArrival, "targetArrivalTime", 180, {
          expectedStop: expectedStopWithOpenovStopPlaceCrosswalk(item.leg.to, openovStopPlaceIndex), assignmentIndex: stopAssignmentIndex, operationDate,
        });
        let departure = kv78StopEvent(departureMatch?.row, "departureDelaySeconds", departureMatch);
        let arrival = kv78StopEvent(arrivalMatch?.row, "arrivalDelaySeconds", arrivalMatch);
        const depOrder = Number(departureMatch?.row?.userStopOrderNumber);
        const arrOrder = Number(arrivalMatch?.row?.userStopOrderNumber);
        if (departure && arrival && Number.isFinite(depOrder) && Number.isFinite(arrOrder) && depOrder >= arrOrder) {
          // The candidate stop order contradicts this leg; discard both estimates.
          departure = null;
          arrival = null;
        }
        if (!departureMatch && !arrivalMatch) continue;
        kv78MatchedLegCount += 1;
        if (!departure && !arrival) continue;
        kv78DataLegCount += 1;
        const selectedStopMatches = [departure ? departureMatch : null, arrival ? arrivalMatch : null].filter(Boolean);
        const vehicleFallback = selectedStopMatches.some((match) => !sameKv78TripIdentity(match.row, item));
        const psaPlatformConfirmed = selectedStopMatches.length > 0 && selectedStopMatches.every((match) => match.stopAssignmentStatus === "confirmed_quay_platform");
        const psaStopPlaceConfirmed = selectedStopMatches.length > 0 && selectedStopMatches.every((match) => String(match.stopAssignmentStatus ?? "").startsWith("confirmed_"));
        if (psaStopPlaceConfirmed) kv78ConfirmedStopLegCount += 1;
        if (vehicleFallback) kv78VehicleFallbackLegCount += 1;
        const vehicleLabel = vehicleLookup
          ? `${vehicleLookup.owner}:${vehicleLookup.vehicleNumber}`
          : "het waargenomen voertuig";
        const identityBasis = vehicleFallback
          ? `exact-vehicle ${vehicleLabel} + unieke halte-/dienstregelingstijd`
          : "exact-trip-identity + dienstregelingstijd";
        const matchMethod = psaPlatformConfirmed
          ? `${identityBasis} + official PSA/CHB StopPlace + Quay/haltezijde`
          : psaStopPlaceConfirmed
            ? `${identityBasis} + official PSA/CHB StopPlace; haltezijde niet volledig bevestigd`
            : `${identityBasis}; PSA/CHB-haltebevestiging ontbreekt`;
        const freshnessNote = vehicleFallback
          ? psaPlatformConfirmed
            ? `KV78-halterij gekoppeld aan de exact waargenomen OpenOV-voertuiginstantie (${vehicleLabel}), bedieningsdag, lijn, geplande halte/tijd en officiële PSA/CHB StopPlace + Quay. De NDOV-ritidentiteit zelf kon niet exact aan de GTFS-rit worden gekoppeld.`
            : psaStopPlaceConfirmed
              ? `KV78-halterij gekoppeld aan voertuig ${vehicleLabel}, lijn, bedieningsdag en geplande halte/tijd; de officiële PSA/CHB StopPlace komt overeen, maar de haltezijde en exacte NDOV-ritidentiteit zijn niet volledig bevestigd.`
              : `KV78-halterij gevonden via waargenomen voertuig ${vehicleLabel}, lijn, bedieningsdag en unieke geplande tijd. De exacte NDOV-ritidentiteit en PSA/CHB-haltebevestiging ontbreken; behandel dit als een diagnose met lagere zekerheid.`
          : psaPlatformConfirmed
            ? "Haltezijde bevestigd via de officiële NDOV Passenger Stop Assignment en CHB-koppeling; de match gebruikt vervoerder, UserStopCode, geldigheid, station en haltezijde."
            : psaStopPlaceConfirmed
              ? "Station bevestigd via de officiële NDOV PSA/CHB-koppeling; de haltezijde kon niet afzonderlijk worden bevestigd."
              : "De ritidentiteit en tijd zijn gematcht, maar voor deze halte ontbreekt een bevestigde PSA/CHB-match; behandel de halte als tijdmatch met lagere zekerheid.";
        const kv78Observation = {
          status: "kv78_delay",
          source: "NDOV KV78Turbo",
          identity: item.identityKey ?? null,
          matchMethod,
          matchBasis: vehicleFallback ? "exact_vehicle_stop_time" : "exact_trip_identity",
          observedVehicleId: vehicleFallback ? vehicleLabel : null,
          feedAgeSeconds: kv78FeedAgeSeconds,
          stopCrosswalkGeneratedAt: stopAssignmentIndex?.generatedAt ?? null,
          freshnessNote,
          departure,
          arrival,
        };
        item.leg.ndovRealtime = {
          ...(item.leg.ndovRealtime ?? {}),
          kv78: kv78Observation,
          ...kv78Observation,
        };
        if (Number(departure?.delaySeconds) > 0 || Number(arrival?.delaySeconds) > 0) {
          kv78DelayLegCount += 1;
        }
      }
    } else {
      kv78FeedState = "stale";
    }
  } catch (error) {
    kv78Error = error instanceof Error ? error.message : "KV78-gegevens niet beschikbaar.";
  }

  const kv6PredictionItems = candidates.filter((item) => item.routePattern && item.kv6PredictionContext);
  if (kv6PredictionItems.length && (!stopAssignmentIndex || !openovStopPlaceIndex)) {
    const stopIds = kv6PredictionItems.flatMap((item) => getNdovPredictionStopIds(
      item.leg, item.routePattern, item.kv6PredictionContext.event, item.kv6PredictionContext.delaySeconds,
    ));
    try {
      if (!openovStopPlaceIndex) openovStopPlaceIndex = await getOpenovStopPlaceIndex(env, stopIds);
    } catch (error) {
      kv78Error = [kv78Error, "OpenOV/CHB-stopcrosswalk voor KV6-voorspelling niet beschikbaar: " +
        (error instanceof Error ? error.message : "onbekende fout")].filter(Boolean).join("; ");
    }
    const assignmentKeys = kv6PredictionItems.map((item) => {
      const event = item.kv6PredictionContext?.event;
      const owner = String(event?.dataOwnerCode ?? "").trim().toUpperCase();
      const stopCode = String(event?.userStopCode ?? "").trim();
      return owner && stopCode ? owner + "|" + stopCode : null;
    }).filter(Boolean);
    try {
      if (!stopAssignmentIndex) stopAssignmentIndex = await getStopAssignmentIndex(env, assignmentKeys);
    } catch (error) {
      kv78Error = [kv78Error, "PSA/CHB-haltecrosswalk voor KV6-voorspelling niet beschikbaar: " +
        (error instanceof Error ? error.message : "onbekende fout")].filter(Boolean).join("; ");
    }
  }

  let ndovPredictionLegCount = 0;
  let combinedPredictionLegCount = 0;
  for (const item of candidates) {
    const context = item.kv6PredictionContext;
    if (context && item.routePattern && stopAssignmentIndex && openovStopPlaceIndex) {
      const prediction = deriveNdovKv6Prediction({
        leg: item.leg,
        pattern: item.routePattern,
        event: context.event,
        assignmentIndex: stopAssignmentIndex,
        stopPlaceIndex: openovStopPlaceIndex,
        operationDate: item.identity?.serviceDate ?? null,
      });
      if (prediction) {
        item.leg.ndovRealtime = { ...(item.leg.ndovRealtime ?? {}), prediction };
        ndovPredictionLegCount += 1;
      }
    }
    const combined = buildUnifiedRealtimePrediction(item.leg);
    if (combined) {
      item.leg.realtimePrediction = combined;
      combinedPredictionLegCount += 1;
    }
  }

  plan.ndovRealtimeMeta = {
    ...baseMeta,
    ndovPredictionLegCount,
    combinedPredictionLegCount,
    status: "ok",
    feedState: snapshot.state ?? "unknown",
    feedAgeSeconds: Math.round(feedAgeMs / 1000),
    crosswalkGeneratedAt: (await getManifest(env).catch(() => null))?.generatedAt ?? null,
    openovRouteCrosswalkGeneratedAt: routeCrosswalkGeneratedAt,
    routeCrosswalkMatchedLegCount,
    routeCrosswalkError,
    nsTrainIdentities: buildNsTrainIdentities(routeCrosswalkOutcomes),
    routeCrosswalkOutcomes: routeCrosswalkOutcomes.slice(0, 12),
    matchedLegCount: matched,
    kv17MatchedLegCount: matched,
    cancelledLegCount: cancelled,
    recoveredLegCount: recovered,
    kv6MatchedLegCount,
    kv6DelayLegCount,
    kv6ObservedLegCount,
    kv6Error,
    kv78FeedState,
    kv78FeedAgeSeconds,
    kv78StopCrosswalkGeneratedAt: stopAssignmentIndex?.generatedAt ?? null,
    kv78MatchedLegCount,
    kv78DataLegCount,
    kv78ConfirmedStopLegCount,
    kv78VehicleFallbackLegCount,
    kv78DelayLegCount,
    kv78Error,
    message: cancelled
      ? `${cancelled} exacte KV17-annulering(en) aan een reisdeel gekoppeld.`
      : kv78DataLegCount
        ? `KV78 leverde actuele haltegegevens voor ${kv78DataLegCount} reisdelen, waarvan ${kv78DelayLegCount} met positieve haltevertraging; KV6 leverde ${kv6MatchedLegCount} exacte ritmatches (${kv6DelayLegCount} met vertraging en ${kv6ObservedLegCount} verse voertuigwaarnemingen zonder actuele punctuality).`
        : kv6MatchedLegCount
          ? `KV6 leverde ${kv6MatchedLegCount} actuele exacte ritmatches (${kv6DelayLegCount} met vertraging en ${kv6ObservedLegCount} verse voertuigwaarnemingen zonder actuele punctuality). ${kv6Error ? `KV6-waarschuwing: ${kv6Error}` : ""}`.trim()
          : "Geen verse exacte KV6-ritmatch of bruikbare KV78-haltegegevens ontvangen; er wordt geen vertraging verzonnen.",
  };
  return plan;
}
