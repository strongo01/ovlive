import assert from "node:assert/strict";
import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("OVLIVE_BASE_URL is required.");

async function get(path, timeoutMs = 30000) {
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.byteLength(text),
      json,
      textStart: text.slice(0, 160),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectLegs(plan) {
  const itineraries = Array.isArray(plan?.itineraries) ? plan.itineraries
    : Array.isArray(plan?.journeys) ? plan.journeys : [];
  return itineraries.flatMap((itinerary) =>
    (Array.isArray(itinerary?.legs) ? itinerary.legs : []).map((leg, index) => ({
      ...leg,
      _diagnosticItineraryIndex: itineraries.indexOf(itinerary) + 1,
      _diagnosticLegIndex: index + 1,
    }))
  );
}

function routeId(leg) {
  const raw = String(leg?.routeId ?? leg?.route?.id ?? "");
  return raw.match(/(\d+)$/)?.[1] ?? null;
}

function normalizeOpenovId(value) {
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").replace(/^OpenOV_/i, "").trim();
}

function openovTripId(value) {
  const raw = String(value ?? "");
  return raw.match(/_nl-OpenOV_(.+)$/i)?.[1] ?? normalizeOpenovId(raw);
}

function plannedEndpoint(leg, kind) {
  return kind === "departure"
    ? leg?.from?.scheduledDeparture ?? leg?.scheduledStartTime ?? leg?.startTime ?? leg?.from?.departure ?? null
    : leg?.to?.scheduledArrival ?? leg?.scheduledEndTime ?? leg?.endTime ?? leg?.to?.arrival ?? null;
}

function epochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value / 1000;
    if (value > 1e9) return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

function openovTripStartBucket(tripId) {
  const match = String(tripId ?? "").trim().match(/^\d{8}_(\d{1,3}):\d{2}(?::\d{2})?_/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 0) return null;
  return hour >= 24 ? "24" : hour >= 12 ? "12" : "00";
}

function gtfsClockSeconds(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function plannedServiceSeconds(value, serviceDate) {
  const epoch = epochSeconds(value);
  const dateMatch = String(serviceDate ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
  if (epoch == null || !dateMatch) return null;

  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch * 1000)).map((part) => [part.type, part.value]));

  const targetDateMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const serviceDateMs = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  const dayOffset = Math.round((targetDateMs - serviceDateMs) / 86400000);
  return dayOffset * 86400 + Number(parts.hour) * 3600 +
    Number(parts.minute) * 60 + Number(parts.second);
}

function summarizeSourceRecord(record) {
  return {
    routeId: record?.routeId ?? null,
    tripId: record?.tripId ?? null,
    startDate: record?.startDate ?? null,
    startTime: record?.startTime ?? null,
    timestamp: record?.timestamp ?? null,
    delaySeconds: record?.delaySeconds ?? null,
    scheduleRelationship: record?.scheduleRelationship ?? null,
    stopUpdateCount: Array.isArray(record?.stopUpdates) ? record.stopUpdates.length : null,
    endpointStopUpdates: record?.endpointStopUpdates ?? null,
  };
}


function fnv1aShardNumber(value, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) return null;
  const bytes = new TextEncoder().encode(String(value));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

function openovStopPlaceKey(value) {
  const match = String(value ?? "").trim().match(/^(?:nl-openov_)?(\d+)$/i);
  return match ? match[1] : null;
}

function compactKv78StopEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    stopCode: event.stopCode ?? null,
    targetTime: event.targetTime ?? null,
    stopSideCode: event.stopSideCode ?? null,
    quayName: event.quayName ?? null,
    quayCode: event.quayCode ?? null,
    stopPlaceCode: event.stopPlaceCode ?? null,
    stopPlaceRef: event.stopPlaceRef ?? null,
    stopAssignmentStatus: event.stopAssignmentStatus ?? null,
    matchMethod: event.matchMethod ?? null,
  };
}

async function main() {
  const auditStartedMs = Date.now();
  const requestedPlanTime = new Date(auditStartedMs + 120_000).toISOString();
  const planUrl = new URL("/api/plan", baseUrl);
  planUrl.searchParams.set("fromPlace", process.env.OVLIVE_FROM_PLACE ?? "nl-OpenOV_3924329");
  planUrl.searchParams.set("toPlace", process.env.OVLIVE_TO_PLACE ?? "nl-OpenOV_3924355");
  planUrl.searchParams.set("time", requestedPlanTime);
  const parsedItineraryCount = Number.parseInt(process.env.OVLIVE_NUM_ITINERARIES ?? "3", 10);
  const itineraryCount = Number.isFinite(parsedItineraryCount)
    ? Math.min(5, Math.max(1, parsedItineraryCount))
    : 3;
  planUrl.searchParams.set("numItineraries", String(itineraryCount));
  planUrl.searchParams.set("maxItineraries", String(itineraryCount));
  planUrl.searchParams.set("ndovIdentityDiagnostics", "1");

  const planResult = await get(planUrl.pathname + planUrl.search, 65000);
  if (!planResult.ok || !planResult.json) {
    console.log(JSON.stringify({ check: "production-plan", ...planResult }, null, 2));
    throw new Error("Production /api/plan could not be queried.");
  }

  const legs = collectLegs(planResult.json);
  const openovLegs = legs.filter((leg) => /^nl-OpenOV_/i.test(String(leg.routeId ?? leg.route?.id ?? "")));

  // Inspect raw OpenOV feed records for the exact trips selected by production
  // /api/plan. This separates a missing source record from a failure to enrich
  // a record that actually exists. Only two bounded, read-only API requests.
  const openovTripIds = [...new Set(openovLegs
    .map((leg) => openovTripId(leg.tripId ?? leg.trip?.id))
    .filter(Boolean))];
  const sourceFeedResults = await Promise.all(["tripUpdates", "vehiclePositions"].map(async (kind) => {
    if (!openovTripIds.length) return { kind, result: null };
    const query = new URLSearchParams({
      kind,
      tripId: openovTripIds.join(","),
      limit: "2000",
    });
    const result = await get("/api/realtime?" + query.toString(), 45000);
    return { kind, result };
  }));
  const sourceFeeds = Object.fromEntries(sourceFeedResults.map(({ kind, result }) => {
    const data = result?.json;
    return [kind, {
      httpStatus: result?.status ?? null,
      ok: data?.ok === true,
      freshness: data?.freshness ?? null,
      ageSeconds: data?.ageSeconds ?? null,
      feedTimestamp: data?.feedTimestamp ?? null,
      matchingCount: data?.matchingCount ?? null,
      returnedCount: data?.returnedCount ?? null,
      error: data?.error ?? result?.error ?? null,
    }];
  }));
  // Also sample records for the routes themselves. Exact-trip queries alone cannot
  // distinguish "this future trip has not been published yet" from "the feed has
  // no usable records for the selected routes". These are bounded read-only calls.
  const openovRouteIds = [...new Set(openovLegs
    .map((leg) => normalizeOpenovId(leg.routeId ?? leg.route?.id))
    .filter(Boolean))];
  const routeLevelFeedResults = await Promise.all(["tripUpdates", "vehiclePositions"].map(async (kind) => {
    if (!openovRouteIds.length) return { kind, result: null };
    const query = new URLSearchParams({
      kind,
      routeId: openovRouteIds.join(","),
      limit: "30",
    });
    const result = await get("/api/realtime?" + query.toString(), 45000);
    return { kind, result };
  }));
  const routeTripTimeStopCrossCheck = openovLegs.map((leg) => {
    const expectedRouteId = normalizeOpenovId(leg.routeId ?? leg.route?.id);
    const expectedTripId = openovTripId(leg.tripId ?? leg.trip?.id);
    const expectedServiceDate = String(leg.tripId ?? leg.trip?.id ?? "").match(/^(\d{8})_/)?.[1] ?? null;
    const expectedDirection = leg.directionId ?? leg.trip?.directionId ?? null;
    const fromStopId = normalizeOpenovId(leg.from?.stopId ?? leg.from?.id);
    const toStopId = normalizeOpenovId(leg.to?.stopId ?? leg.to?.id);
    const plannedDeparture = plannedEndpoint(leg, "departure");
    const plannedDepartureSeconds = epochSeconds(plannedDeparture);
    const tripFeedResult = routeLevelFeedResults.find(({ kind }) => kind === "tripUpdates")?.result;
    const tripFeedData = tripFeedResult?.json;
    const allRecords = Array.isArray(tripFeedData?.entities) ? tripFeedData.entities : [];
    const routeRecords = allRecords.filter((record) =>
      normalizeOpenovId(record?.routeId) === expectedRouteId
    );
    const dateRecords = routeRecords.filter((record) =>
      String(record?.startDate ?? "") === expectedServiceDate
    );
    const directionRecords = dateRecords.filter((record) =>
      expectedDirection == null ||
      record?.directionId == null ||
      String(record.directionId) === String(expectedDirection)
    );
    const normalizedClock = (value) => {
      const match = String(value ?? "").match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
      return match ? match[1].padStart(2, "0") + ":" + match[2] + ":" + (match[3] ?? "00") : null;
    };
    const candidates = directionRecords.map((record) => {
      const stopUpdates = Array.isArray(record?.stopUpdates) ? record.stopUpdates : [];
      const stopIds = stopUpdates.map((stop) => normalizeOpenovId(stop?.stopId)).filter(Boolean);
      const fromIndex = fromStopId ? stopIds.indexOf(fromStopId) : -1;
      const toIndex = toStopId ? stopIds.indexOf(toStopId) : -1;
      const fromUpdate = fromIndex >= 0 ? stopUpdates[fromIndex] : null;
      const events = [];
      for (const kind of ["departure", "arrival"]) {
        const time = fromUpdate?.[kind + "Time"];
        if (typeof time !== "number" || !Number.isFinite(time)) continue;
        const cap = kind[0].toUpperCase() + kind.slice(1);
        const delay = fromUpdate?.["effective" + cap + "DelaySeconds"] ?? fromUpdate?.[kind + "DelaySeconds"];
        const reconstructed = typeof delay === "number" && Number.isFinite(delay);
        events.push({
          kind,
          seconds: reconstructed ? time - delay : time,
          delaySeconds: reconstructed ? delay : null,
          reconstructed,
        });
      }
      const event = events.find((candidate) => candidate.reconstructed) ?? events[0] ?? null;
      const differenceSeconds = event && plannedDepartureSeconds != null
        ? Math.round(event.seconds - plannedDepartureSeconds)
        : null;
      const toleranceSeconds = event?.reconstructed ? 180 : 300;
      const orderedStops = fromIndex >= 0 && (toIndex < 0 || toIndex > fromIndex);
      return {
        tripId: record?.tripId ?? null,
        startDate: record?.startDate ?? null,
        startTime: record?.startTime ?? null,
        normalizedStartTime: normalizedClock(record?.startTime),
        directionId: record?.directionId ?? null,
        scheduleRelationship: record?.scheduleRelationship ?? null,
        stopUpdateCount: stopUpdates.length,
        fromStopPresent: fromIndex >= 0,
        toStopPresent: toIndex >= 0,
        fromStopIndex: fromIndex,
        toStopIndex: toIndex,
        orderedStops,
        fromStopEventKind: event?.kind ?? null,
        sourceDelaySeconds: event?.delaySeconds ?? null,
        reconstructedOrReportedEventTime: event ? new Date(event.seconds * 1000).toISOString() : null,
        differenceFromPlannedDepartureSeconds: differenceSeconds,
        candidateToleranceSeconds: event ? toleranceSeconds : null,
        withinTimeTolerance: differenceSeconds != null && Math.abs(differenceSeconds) <= toleranceSeconds,
        explicitCancellation: /CANCEL|DELETE/i.test(String(record?.scheduleRelationship ?? "")),
      };
    });
    const rankedCandidates = [...candidates].sort((a, b) => {
      const aDistance = a.differenceFromPlannedDepartureSeconds == null ? Number.POSITIVE_INFINITY : Math.abs(a.differenceFromPlannedDepartureSeconds);
      const bDistance = b.differenceFromPlannedDepartureSeconds == null ? Number.POSITIVE_INFINITY : Math.abs(b.differenceFromPlannedDepartureSeconds);
      return aDistance - bDistance;
    });
    const boardingStopCandidates = rankedCandidates.filter((candidate) =>
      candidate.fromStopPresent && candidate.orderedStops && candidate.differenceFromPlannedDepartureSeconds != null
    );
    return {
      routeId: leg.routeId ?? leg.route?.id ?? null,
      openovRouteId: expectedRouteId || null,
      transitousTripId: leg.tripId ?? leg.trip?.id ?? null,
      openovFeedTripId: expectedTripId || null,
      serviceDate: expectedServiceDate,
      directionId: expectedDirection,
      fromStopId: fromStopId || null,
      toStopId: toStopId || null,
      plannedDeparture,
      fullRouteRecordsReturned: routeRecords.length,
      sameServiceDateRecordCount: dateRecords.length,
      compatibleDirectionRecordCount: directionRecords.length,
      recordsContainingBoardingStop: candidates.filter((candidate) => candidate.fromStopPresent).length,
      recordsWithOrderedBoardingAndAlightingStops: candidates.filter((candidate) => candidate.fromStopPresent && candidate.orderedStops).length,
      recordsWithBoardingEventWithinMatcherTolerance: candidates.filter((candidate) =>
        candidate.fromStopPresent && candidate.orderedStops && candidate.withinTimeTolerance
      ).length,
      closestBoardingStopCandidates: boardingStopCandidates.slice(0, 6),
    };
  });

  const routeLevelSourceEvidence = {
    checkedRouteIds: openovRouteIds,
    feeds: Object.fromEntries(routeLevelFeedResults.map(({ kind, result }) => {
      const data = result?.json;
      const records = Array.isArray(data?.entities) ? data.entities : [];
      const matchingCount = Number(data?.matchingCount ?? records.length);
      const returnedCount = Number(data?.returnedCount ?? records.length);
      return [kind, {
        httpStatus: result?.status ?? null,
        ok: data?.ok === true,
        freshness: data?.freshness ?? null,
        ageSeconds: data?.ageSeconds ?? null,
        feedTimestamp: data?.feedTimestamp ?? null,
        matchingCount: data?.matchingCount ?? null,
        returnedCount,
        completeRouteSample: Number.isFinite(matchingCount) && returnedCount >= matchingCount,
        sampleRecords: records.slice(0, 10).map(summarizeSourceRecord),
        error: data?.error ?? result?.error ?? null,
      }];
    })),
    // Compare planned IDs against records returned by the route-filtered
    // requests themselves. This rules out misleading conclusions from two
    // separate feed requests whose contents may differ between fetches.
    tripCrossCheck: openovLegs.map((leg) => {
      const expectedRouteId = normalizeOpenovId(leg.routeId ?? leg.route?.id);
      const expectedTripId = openovTripId(leg.tripId ?? leg.trip?.id);
      const feedMatches = Object.fromEntries(routeLevelFeedResults.map(({ kind, result }) => {
        const data = result?.json;
        const records = Array.isArray(data?.entities) ? data.entities : [];
        const sameTrip = records.filter((record) =>
          normalizeOpenovId(record?.tripId) === expectedTripId
        );
        const exactRouteAndTrip = sameTrip.filter((record) =>
          normalizeOpenovId(record?.routeId) === expectedRouteId
        );
        return [kind, {
          httpStatus: result?.status ?? null,
          freshness: data?.freshness ?? null,
          matchingRouteRecords: data?.matchingCount ?? null,
          returnedRouteRecords: data?.returnedCount ?? records.length,
          completeRouteSample: Number(data?.returnedCount ?? records.length) >=
            Number(data?.matchingCount ?? records.length),
          sameTripIdCount: sameTrip.length,
          exactRouteAndTripCount: exactRouteAndTrip.length,
          exactRecords: exactRouteAndTrip.slice(0, 2).map(summarizeSourceRecord),
        }];
      }));
      return {
        routeId: leg.routeId ?? leg.route?.id ?? null,
        openovRouteId: expectedRouteId || null,
        transitousTripId: leg.tripId ?? leg.trip?.id ?? null,
        openovFeedTripId: expectedTripId || null,
        feedMatches,
      };
    }),
    routeTripTimeStopCrossCheck,
  };

  const exactOpenovSourceEvidence = {
    requestedPlanTime,
    auditStartedAt: new Date(auditStartedMs).toISOString(),
    feedChecks: sourceFeeds,
    trips: openovLegs.map((leg) => {
      const expectedRouteId = normalizeOpenovId(leg.routeId ?? leg.route?.id);
      const expectedTripId = openovTripId(leg.tripId ?? leg.trip?.id);
      const departure = plannedEndpoint(leg, "departure");
      const arrival = plannedEndpoint(leg, "arrival");
      const departureSeconds = epochSeconds(departure);
      const tripEvidence = Object.fromEntries(sourceFeedResults.map(({ kind, result }) => {
        const records = Array.isArray(result?.json?.entities) ? result.json.entities : [];
        const sameTrip = records.filter((record) =>
          normalizeOpenovId(record?.tripId) === expectedTripId
        );
        const exactRouteAndTrip = sameTrip.filter((record) =>
          normalizeOpenovId(record?.routeId) === expectedRouteId
        );
        return [kind, {
          sameTripIdCount: sameTrip.length,
          exactRouteAndTripCount: exactRouteAndTrip.length,
          sameTripIdRecords: sameTrip.slice(0, 3).map(summarizeSourceRecord),
          exactRecords: exactRouteAndTrip.slice(0, 3).map(summarizeSourceRecord),
        }];
      }));
      const hasExactSourceRecord = Object.values(tripEvidence)
        .some((evidence) => evidence.exactRouteAndTripCount > 0);
      const exactRecordInFreshFeed = Object.entries(tripEvidence).some(([kind, evidence]) => {
        const feed = sourceFeeds[kind];
        return evidence.exactRouteAndTripCount > 0 &&
          feed?.ok === true &&
          feed?.freshness === "fresh" &&
          Number.isFinite(Number(feed?.ageSeconds)) &&
          Number(feed.ageSeconds) >= -60 &&
          Number(feed.ageSeconds) <= 180;
      });
      const atLeastOneFreshSourceFeed = Object.values(sourceFeeds).some((feed) =>
        feed?.ok === true &&
        feed?.freshness === "fresh" &&
        Number.isFinite(Number(feed?.ageSeconds)) &&
        Number(feed.ageSeconds) >= -60 &&
        Number(feed.ageSeconds) <= 180
      );
      const secondsUntilDeparture = departureSeconds == null
        ? null
        : Math.round(departureSeconds - auditStartedMs / 1000);
      const sourceStatus = exactRecordInFreshFeed
        ? "exact_fresh_openov_source_record_found"
        : hasExactSourceRecord
          ? "exact_openov_record_found_but_feed_not_fresh"
          : !atLeastOneFreshSourceFeed
            ? "source_feeds_not_fresh_enough_to_judge"
            : secondsUntilDeparture != null && secondsUntilDeparture > 300
              ? "trip_may_not_be_published_to_realtime_yet"
              : "no_exact_openov_source_record_for_near_departure";
      return {
        mode: leg.mode ?? leg.transitMode ?? null,
        routeId: leg.routeId ?? leg.route?.id ?? null,
        openovRouteId: expectedRouteId || null,
        transitousTripId: leg.tripId ?? leg.trip?.id ?? null,
        openovFeedTripId: expectedTripId || null,
        scheduledDeparture: departure,
        scheduledArrival: arrival,
        secondsUntilDeparture,
        openovStatusFromPlan: leg.openovRealtime?.status ?? null,
        openovReasonFromPlan: leg.openovRealtime?.reason ?? null,
        sourceStatus,
        feeds: tripEvidence,
      };
    }),
  };

  const transitLegs = legs.filter((leg) => {
    const mode = String(leg?.mode ?? leg?.transitMode ?? "").trim().toUpperCase();
    const tripId = String(leg?.tripId ?? leg?.trip?.id ?? "").trim();
    const route = String(leg?.routeId ?? leg?.route?.id ?? "").trim();
    return mode !== "WALK" && mode !== "TRANSFER" && Boolean(tripId || route);
  });
  const ndovStatusCounts = {};
  for (const leg of transitLegs) {
    const status = String(leg.ndovRealtime?.status ?? "no_ndov_match");
    ndovStatusCounts[status] = (ndovStatusCounts[status] ?? 0) + 1;
  }
  const openovStatusCounts = {};
  const openovReasonCounts = {};
  for (const leg of openovLegs) {
    const status = String(leg.openovRealtime?.status ?? "no_openov_match");
    openovStatusCounts[status] = (openovStatusCounts[status] ?? 0) + 1;
    if (leg.openovRealtime?.reason) {
      const reason = String(leg.openovRealtime.reason);
      openovReasonCounts[reason] = (openovReasonCounts[reason] ?? 0) + 1;
    }
  }

  console.log(JSON.stringify({
    check: "production-plan",
    baseUrl,
    requestedItineraries: itineraryCount,
    httpStatus: planResult.status,
    itineraries: Array.isArray(planResult.json.itineraries) ? planResult.json.itineraries.length : null,
    totalLegs: legs.length,
    transitLegs: transitLegs.length,
    openovLegs: openovLegs.length,
    ndovStatusScope: "transit legs only; walking and transfer legs are excluded",
    ndovStatusCounts,
    openovStatusCounts,
    openovReasonCounts,
    ndovRealtimeMeta: planResult.json.ndovRealtimeMeta ?? null,
    exactOpenovSourceEvidence,
    legs: legs.map((leg) => ({
      routeId: leg.routeId ?? leg.route?.id ?? null,
      tripId: leg.tripId ?? leg.trip?.id ?? null,
      mode: leg.mode ?? null,
      openovStatus: leg.openovRealtime?.status ?? null,
      openovReason: leg.openovRealtime?.reason ?? null,
      departure: leg.openovRealtime?.departure ?? null,
      arrival: leg.openovRealtime?.arrival ?? null,
      ndovStatus: leg.ndovRealtime?.status ?? null,
      ndovSource: leg.ndovRealtime?.source ?? null,
      ndovIdentity: leg.ndovRealtime?.identity ?? null,
      ndovEventType: leg.ndovRealtime?.eventType ?? leg.ndovRealtime?.kv6?.eventType ?? null,
      ndovPunctualitySeconds: leg.ndovRealtime?.punctualitySeconds ?? leg.ndovRealtime?.kv6?.punctualitySeconds ?? null,
      ndovMatchReason: leg.ndovRealtimeMatch?.reason ?? null,
      ndovPrediction: leg.ndovRealtime?.prediction ?? null,
      realtimePrediction: leg.realtimePrediction ?? null,
    })),
  }, null, 2));

  const ndovMeta = planResult.json.ndovRealtimeMeta ?? {};
  const routeCrosswalkOutcomes = Array.isArray(ndovMeta.routeCrosswalkOutcomes)
    ? ndovMeta.routeCrosswalkOutcomes
    : [];
  const openovNdovIdentityBridge = openovLegs.map((leg) => {
    const tripId = String(leg.tripId ?? leg.trip?.id ?? "");
    const outcome = routeCrosswalkOutcomes.find((item) =>
      String(item?.tripId ?? "") === tripId
    ) ?? null;
    const realtimeTripId = String(outcome?.realtimeTripId ?? "");
    const parts = realtimeTripId.split(":").map((part) => part.trim());
    const serviceDate = String(outcome?.serviceDate ?? tripId.match(/^(\d{8})_/)?.[1] ?? "");
    const expectedBisonIdentity = parts.length === 3 && parts.every(Boolean) && /^\d{8}$/.test(serviceDate)
      ? parts[0] + "|" + serviceDate + "|" + parts[1] + "|" + parts[2] + "|0"
      : null;
    return {
      mode: leg.mode ?? leg.transitMode ?? null,
      routeId: leg.routeId ?? leg.route?.id ?? null,
      tripId,
      scheduledDeparture: plannedEndpoint(leg, "departure"),
      scheduledArrival: plannedEndpoint(leg, "arrival"),
      openovRealtime: leg.openovRealtime ? {
        status: leg.openovRealtime.status ?? null,
        reason: leg.openovRealtime.reason ?? null,
        matchMethod: leg.openovRealtime.matchMethod ?? null,
        updateAgeSeconds: leg.openovRealtime.updateAgeSeconds ?? null,
      } : null,
      ndovRealtimeMatch: leg.ndovRealtimeMatch ? {
        status: leg.ndovRealtimeMatch.status ?? null,
        reason: leg.ndovRealtimeMatch.reason ?? null,
        candidateCount: leg.ndovRealtimeMatch.candidateCount ?? null,
        candidateRealtimeTripIds: leg.ndovRealtimeMatch.candidateRealtimeTripIds ?? [],
      } : null,
      routeCrosswalk: outcome ? {
        source: outcome.source ?? null,
        reason: outcome.reason ?? null,
        realtimeTripId: outcome.realtimeTripId ?? null,
        parsedIdentity: outcome.parsedIdentity ?? null,
        expectedBisonIdentity,
        candidateCount: outcome.candidateCount ?? null,
        candidateRealtimeTripIds: outcome.candidateRealtimeTripIds ?? [],
        candidatePatternDetails: Array.isArray(outcome.candidatePatternDetails)
          ? outcome.candidatePatternDetails.slice(0, 3)
          : [],
      } : null,
      ndovRealtime: leg.ndovRealtime ? {
        status: leg.ndovRealtime.status ?? null,
        source: leg.ndovRealtime.source ?? null,
        identity: leg.ndovRealtime.identity ?? null,
        eventType: leg.ndovRealtime.eventType ?? leg.ndovRealtime.kv6?.eventType ?? null,
        punctualitySeconds: leg.ndovRealtime.punctualitySeconds ?? leg.ndovRealtime.kv6?.punctualitySeconds ?? null,
        kv6Status: leg.ndovRealtime.kv6?.status ?? null,
        kv78Status: leg.ndovRealtime.kv78?.status ?? null,
        kv78: leg.ndovRealtime.kv78 ? {
          matchMethod: leg.ndovRealtime.kv78.matchMethod ?? null,
          matchedKv78TripIdentity: leg.ndovRealtime.kv78.matchedKv78TripIdentity ?? null,
          feedAgeSeconds: leg.ndovRealtime.kv78.feedAgeSeconds ?? null,
          stopCrosswalkGeneratedAt: leg.ndovRealtime.kv78.stopCrosswalkGeneratedAt ?? null,
          departure: compactKv78StopEvent(leg.ndovRealtime.kv78.departure),
          arrival: compactKv78StopEvent(leg.ndovRealtime.kv78.arrival),
        } : null,
      } : null,
    };
  });
  console.log("=== OPENOV TO NDOV IDENTITY BRIDGE (SEARCH THIS HEADING) ===");
  console.log(JSON.stringify({
    planCheckedAt: ndovMeta.checkedAt ?? null,
    routeCrosswalkGeneratedAt: ndovMeta.openovRouteCrosswalkGeneratedAt ?? null,
    routeCrosswalkMatchedLegCount: ndovMeta.routeCrosswalkMatchedLegCount ?? null,
    tripIdCrosswalkFallbackMatchedLegCount: ndovMeta.tripIdCrosswalkFallbackMatchedLegCount ?? null,
    routeCrosswalkError: ndovMeta.routeCrosswalkError ?? null,
    kv6LookupDiagnostics: ndovMeta.kv6LookupDiagnostics ?? null,
    kv6IdentityDiagnostics: ndovMeta.kv6IdentityDiagnostics ?? null,
    kv78FeedState: ndovMeta.kv78FeedState ?? null,
    kv78FeedAgeSeconds: ndovMeta.kv78FeedAgeSeconds ?? null,
    kv78Error: ndovMeta.kv78Error ?? null,
    kv78CollectorDiagnostics: ndovMeta.kv78CollectorDiagnostics ?? null,
    kv78IdentityDiagnostics: ndovMeta.kv78IdentityDiagnostics ?? null,
    legs: openovNdovIdentityBridge,
  }, null, 2));

  // Print this section separately so it is easy to find in long Actions logs.
  console.log("=== EXACT OPENOV SOURCE EVIDENCE (SEARCH THIS HEADING) ===");
  console.log(JSON.stringify(exactOpenovSourceEvidence, null, 2));
  console.log("=== OPENOV ROUTE-LEVEL SOURCE EVIDENCE (SEARCH THIS HEADING) ===");
  console.log(JSON.stringify(routeLevelSourceEvidence, null, 2));

  const manifests = [
    "/ndov-openov-route-crosswalk/manifest.json",
    "/ndov-trip-crosswalk/manifest.json",
    "/ndov-stop-crosswalk/manifest.json",
    "/ndov-openov-stopplace-crosswalk/manifest.json",
  ];
  const results = [];
  let routeManifest = null;
  let stopAssignmentManifest = null;
  let openovStopPlaceManifest = null;
  for (const path of manifests) {
    const result = await get(path);
    const data = result.json;
    const summary = {
      path,
      status: result.status,
      contentType: result.contentType ?? null,
      bytes: result.bytes ?? null,
      validJson: Boolean(data && typeof data === "object" && !Array.isArray(data)),
      generatedAt: data?.generatedAt ?? null,
      source: data?.source ?? null,
      routeCount: data?.routeCount ?? (data?.routes ? Object.keys(data.routes).length : null),
      serviceCalendarDateCount: data?.serviceCalendarDateCount ?? null,
      shardCount: data?.shardCount ?? (Array.isArray(data?.shards) ? data.shards.length : null),
      error: result.error ?? null,
    };
    results.push(summary);
    if (path === "/ndov-openov-route-crosswalk/manifest.json" && result.ok && data?.routes) {
      routeManifest = data;
    }
    if (path === "/ndov-stop-crosswalk/manifest.json" && result.ok && Number.isInteger(Number(data?.shardCount))) {
      stopAssignmentManifest = data;
    }
    if (path === "/ndov-openov-stopplace-crosswalk/manifest.json" && result.ok && data?.schemaVersion === 1) {
      openovStopPlaceManifest = data;
    }
  }

  // Match the same time-bucketed route shard selected by production,
  // then compare its static stop order/times to the planned leg. Checking
  // routes[id][0] alone can inspect the wrong half-day shard for an evening trip.
  const serviceCalendarResult = await get("/ndov-openov-route-crosswalk/service-calendar.json");
  const serviceCalendar = serviceCalendarResult.json;
  const routeBucketTargets = new Map();
  for (const leg of openovLegs) {
    const id = routeId(leg);
    const bucket = openovTripStartBucket(leg.tripId ?? leg.trip?.id);
    if (!id) continue;
    const key = id + "|" + String(bucket ?? "unknown");
    if (!routeBucketTargets.has(key)) {
      routeBucketTargets.set(key, { routeId: id, bucket, legs: [] });
    }
    routeBucketTargets.get(key).legs.push(leg);
  }

  const routePatternChecks = [];
  for (const target of [...routeBucketTargets.values()].slice(0, 8)) {
    const bucketFiles = routeManifest?.routesByStartBucket?.[target.routeId]?.[target.bucket];
    const correctBucketAvailable = Array.isArray(bucketFiles) && bucketFiles.length > 0;
    const allRouteFiles = routeManifest?.routes?.[target.routeId];
    const files = correctBucketAvailable
      ? bucketFiles
      : Array.isArray(allRouteFiles) ? allRouteFiles.slice(0, 1) : [];

    if (!files.length) {
      routePatternChecks.push({
        routeId: target.routeId,
        tripStartBucket: target.bucket,
        manifestHasRoute: Array.isArray(allRouteFiles) && allRouteFiles.length > 0,
        correctBucketAvailable,
        error: "Geen route-shard gevonden voor route/tijdvak.",
      });
      continue;
    }

    const patterns = [];
    const shardSummaries = [];
    for (const filenameValue of files) {
      const filename = String(filenameValue);
      if (!filename || filename.includes("..") || filename.includes("/")) continue;
      const shardPath = "/ndov-openov-route-crosswalk/routes/" + filename;
      const shard = await get(shardPath);
      const sidecarPath = shardPath.replace(/\.json$/, "-services.json");
      const sidecar = correctBucketAvailable ? await get(sidecarPath) : null;
      const rows = Array.isArray(shard.json) ? shard.json : [];
      const serviceRows = Array.isArray(sidecar?.json) ? sidecar.json : [];
      shardSummaries.push({
        filename,
        status: shard.status,
        bytes: shard.bytes ?? null,
        validJsonArray: Array.isArray(shard.json),
        patternCount: rows.length,
        serviceSidecarStatus: sidecar?.status ?? null,
        serviceSidecarAligned: serviceRows.length === rows.length,
        error: shard.error ?? null,
      });
      rows.forEach((pattern, index) => {
        patterns.push({
          pattern,
          serviceIds: Array.isArray(serviceRows[index]) ? serviceRows[index].map(String) : [],
        });
      });
    }

    const targetChecks = target.legs.map((leg) => {
      const serviceDate = String(leg.tripId ?? leg.trip?.id ?? "").match(/^(\d{8})_/)?.[1] ?? null;
      const targetDirection = leg.directionId ?? leg.trip?.directionId ?? null;
      const fromStopId = normalizeOpenovId(leg.from?.stopId ?? leg.from?.id);
      const toStopId = normalizeOpenovId(leg.to?.stopId ?? leg.to?.id);
      const plannedDeparture = plannedEndpoint(leg, "departure");
      const targetSeconds = plannedServiceSeconds(plannedDeparture, serviceDate);
      const activeServices = Array.isArray(serviceCalendar?.[serviceDate])
        ? new Set(serviceCalendar[serviceDate].map(String))
        : null;
      const candidates = patterns.map(({ pattern, serviceIds }) => {
        const stops = Array.isArray(pattern?.stops) ? pattern.stops : [];
        const normalizedStops = stops.map((stop) => normalizeOpenovId(stop?.stopId));
        const fromIndex = fromStopId ? normalizedStops.indexOf(fromStopId) : -1;
        const toIndex = toStopId ? normalizedStops.indexOf(toStopId) : -1;
        const fromStop = fromIndex >= 0 ? stops[fromIndex] : null;
        const clockValue = fromStop?.departureTime || fromStop?.arrivalTime || null;
        const stopSeconds = gtfsClockSeconds(clockValue);
        const differenceSeconds = targetSeconds == null || stopSeconds == null
          ? null
          : Math.round(stopSeconds - targetSeconds);
        const directionCompatible = targetDirection == null ||
          pattern?.directionId == null ||
          String(pattern.directionId) === String(targetDirection);
        const orderedStops = fromIndex >= 0 && (toIndex < 0 || toIndex > fromIndex);
        const serviceActive = activeServices == null
          ? null
          : serviceIds.some((serviceId) => activeServices.has(serviceId));
        return {
          realtimeTripId: pattern?.realtimeTripId ?? null,
          headsign: pattern?.headsign ?? null,
          directionId: pattern?.directionId ?? null,
          serviceIdsForDate: serviceIds,
          serviceActiveOnDate: serviceActive,
          fromStopPresent: fromIndex >= 0,
          toStopPresent: toIndex >= 0,
          fromStopIndex: fromIndex,
          toStopIndex: toIndex,
          orderedStops,
          staticDepartureTimeAtFromStop: clockValue,
          secondsFromPlannedDeparture: differenceSeconds,
          withinThreeMinutes: differenceSeconds != null && Math.abs(differenceSeconds) <= 180,
          directionCompatible,
        };
      });
      const orderedCandidates = candidates
        .filter((candidate) => candidate.fromStopPresent && candidate.orderedStops && candidate.directionCompatible)
        .sort((a, b) => {
          const aDistance = a.secondsFromPlannedDeparture == null ? Number.POSITIVE_INFINITY : Math.abs(a.secondsFromPlannedDeparture);
          const bDistance = b.secondsFromPlannedDeparture == null ? Number.POSITIVE_INFINITY : Math.abs(b.secondsFromPlannedDeparture);
          return aDistance - bDistance;
        });
      return {
        routeId: leg.routeId ?? leg.route?.id ?? null,
        transitousTripId: leg.tripId ?? leg.trip?.id ?? null,
        serviceDate,
        tripStartBucket: target.bucket,
        directionId: targetDirection,
        fromStopId: fromStopId || null,
        toStopId: toStopId || null,
        plannedDeparture,
        plannedServiceSeconds: targetSeconds,
        staticServiceCalendarAvailable: activeServices != null,
        activeServiceCountForDate: activeServices?.size ?? null,
        patternsScanned: patterns.length,
        patternsWithOrderedEndpointStops: candidates.filter((candidate) => candidate.fromStopPresent && candidate.orderedStops).length,
        orderedEndpointPatternsWithinThreeMinutes: orderedCandidates.filter((candidate) => candidate.withinThreeMinutes).length,
        activeOrderedEndpointPatternsWithinThreeMinutes: orderedCandidates.filter((candidate) =>
          candidate.withinThreeMinutes && candidate.serviceActiveOnDate === true
        ).length,
        closestStaticPatterns: orderedCandidates.slice(0, 5),
      };
    });

    routePatternChecks.push({
      routeId: target.routeId,
      tripStartBucket: target.bucket,
      correctBucketAvailable,
      selectedShardCount: files.length,
      shardSummaries,
      targetChecks,
    });
  }


  // Independently probe the production stop-crosswalk assets for the exact
  // OpenOV endpoint IDs selected by /api/plan. This distinguishes a missing
  // mapping in the published assets from a mapping that exists but was not
  // applied by the bounded per-request shard loader.
  const openovEndpointTargets = openovLegs.flatMap((leg) => [
    { leg, endpoint: "from", stop: leg?.from },
    { leg, endpoint: "to", stop: leg?.to },
  ]).map(({ leg, endpoint, stop }) => ({
    routeId: leg.routeId ?? leg.route?.id ?? null,
    tripId: leg.tripId ?? leg.trip?.id ?? null,
    endpoint,
    rawStopId: stop?.stopId ?? stop?.id ?? null,
    key: openovStopPlaceKey(stop?.stopId ?? stop?.id),
    existingStopPlace: stop?.stopPlaceCode ?? stop?.stopPlaceRef ?? stop?.parentId ?? stop?.parentStation ?? null,
  })).filter((item) => item.key);

  const openovStopPlaceShardNumbers = [...new Set(openovEndpointTargets
    .map((target) => fnv1aShardNumber(target.key, Number(openovStopPlaceManifest?.shardCount)))
    .filter((number) => number !== null))];
  const openovStopPlaceShardResults = new Map();
  for (const shardNumber of openovStopPlaceShardNumbers) {
    const path = "/ndov-openov-stopplace-crosswalk/shards/openov-stop-places-" + shardNumber + ".json";
    openovStopPlaceShardResults.set(shardNumber, await get(path));
  }
  const openovStopPlaceTargetChecks = openovEndpointTargets.map((target) => {
    const shardNumber = fnv1aShardNumber(target.key, Number(openovStopPlaceManifest?.shardCount));
    const shardResult = shardNumber === null ? null : openovStopPlaceShardResults.get(shardNumber);
    const mapping = shardResult?.json?.stopPlaces?.[target.key] ?? null;
    const existingPlace = String(target.existingStopPlace ?? "").trim();
    const mappedPlace = String(mapping?.stopPlaceCode ?? "").trim();
    return {
      routeId: target.routeId,
      tripId: target.tripId,
      endpoint: target.endpoint,
      stopId: target.rawStopId,
      shardNumber,
      shardHttpStatus: shardResult?.status ?? null,
      shardValidJson: Boolean(shardResult?.json && typeof shardResult.json === "object" && !Array.isArray(shardResult.json)),
      publishedAssetMappingPresent: Boolean(mapping),
      mappingMethod: mapping?.method ?? null,
      mappedStopPlaceCode: mapping?.stopPlaceCode ?? null,
      mappedQuayCode: mapping?.quayCode ?? null,
      mappedDistanceMeters: mapping?.distanceMeters ?? null,
      preExistingStopPlaceIdentity: target.existingStopPlace,
      possibleConflictingPlanIdentity: Boolean(mapping && existingPlace && mappedPlace && existingPlace !== mappedPlace),
    };
  });

  // For any KV78 stop codes surfaced on the returned legs, probe the exact
  // PSA/CHB assignment shard too. This is bounded by the observed endpoint
  // events; missing events remain explicitly unprobed rather than guessed.
  const observedAssignmentTargets = [];
  for (const leg of openovLegs) {
    const kv78 = leg?.ndovRealtime?.kv78;
    if (!kv78 || typeof kv78 !== "object") continue;
    const identity = String(kv78.identity ?? leg?.ndovRealtime?.identity ?? "");
    const identityParts = identity.split("|");
    const owner = String(identityParts[0] ?? "").trim().toUpperCase();
    const operationDate = String(identityParts[1] ?? "");
    for (const endpoint of ["departure", "arrival"]) {
      const event = kv78[endpoint];
      const stopCode = String(event?.stopCode ?? "").trim();
      if (!owner || !stopCode) continue;
      observedAssignmentTargets.push({
        tripId: leg.tripId ?? leg.trip?.id ?? null,
        identity,
        owner,
        operationDate,
        endpoint,
        stopCode,
        key: owner + "|" + stopCode,
        planEvent: compactKv78StopEvent(event),
      });
    }
  }
  const assignmentShardCount = Number(stopAssignmentManifest?.shardCount);
  const assignmentShardNumbers = [...new Set(observedAssignmentTargets
    .map((target) => fnv1aShardNumber(target.key, assignmentShardCount))
    .filter((number) => number !== null))];
  const assignmentShardResults = new Map();
  for (const shardNumber of assignmentShardNumbers) {
    const path = "/ndov-stop-crosswalk/shards/stop-assignments-" + shardNumber + ".json";
    assignmentShardResults.set(shardNumber, await get(path));
  }
  const observedAssignmentChecks = observedAssignmentTargets.map((target) => {
    const shardNumber = fnv1aShardNumber(target.key, assignmentShardCount);
    const shardResult = shardNumber === null ? null : assignmentShardResults.get(shardNumber);
    const records = shardResult?.json?.assignments?.[target.key] ?? [];
    const activeRecords = records.filter((record) => {
      const day = String(target.operationDate ?? "").replace(/-/g, "");
      const dateKey = (value) => {
        const match = String(value ?? "").match(/(\d{4})-?(\d{2})-?(\d{2})/);
        return match ? match[1] + match[2] + match[3] : null;
      };
      const from = dateKey(record?.validFrom);
      const thru = dateKey(record?.validThru);
      return !day || ((!from || from <= day) && (!thru || day <= thru));
    });
    return {
      tripId: target.tripId,
      identity: target.identity,
      endpoint: target.endpoint,
      owner: target.owner,
      stopCode: target.stopCode,
      shardNumber,
      shardHttpStatus: shardResult?.status ?? null,
      shardValidJson: Boolean(shardResult?.json && typeof shardResult.json === "object" && !Array.isArray(shardResult.json)),
      publishedAssignmentRecordCount: records.length,
      activeAssignmentRecordCountForOperationDate: activeRecords.length,
      assignmentRecords: activeRecords.slice(0, 3).map((record) => ({
        stopPlaceCode: record?.stopPlaceCode ?? null,
        stopSideCode: record?.stopSideCode ?? null,
        quayCode: record?.quayCode ?? null,
        quayName: record?.quayName ?? null,
        validFrom: record?.validFrom ?? null,
        validThru: record?.validThru ?? null,
      })),
      planStopAssignmentStatus: target.planEvent?.stopAssignmentStatus ?? null,
      planMatchMethod: target.planEvent?.matchMethod ?? null,
    };
  });

  console.log("=== OPENOV/CHB STOPPLACE SHARD DIAGNOSTIC ===");
  console.log(JSON.stringify({
    manifest: {
      httpStatus: results.find((item) => item.path === "/ndov-openov-stopplace-crosswalk/manifest.json")?.status ?? null,
      generatedAt: openovStopPlaceManifest?.generatedAt ?? null,
      sourceGtfs: openovStopPlaceManifest?.sourceGtfs ?? null,
      sourceChb: openovStopPlaceManifest?.sourceChb ?? null,
      shardCount: openovStopPlaceManifest?.shardCount ?? null,
      keyCount: openovStopPlaceManifest?.keyCount ?? null,
    },
    targetEndpointCount: openovEndpointTargets.length,
    distinctRequiredShardCount: openovStopPlaceShardNumbers.length,
    shardProbes: openovStopPlaceShardNumbers.map((shardNumber) => {
      const shard = openovStopPlaceShardResults.get(shardNumber);
      return {
        shardNumber,
        httpStatus: shard?.status ?? null,
        bytes: shard?.bytes ?? null,
        validJson: Boolean(shard?.json && typeof shard.json === "object" && !Array.isArray(shard.json)),
        error: shard?.error ?? null,
      };
    }),
    targets: openovStopPlaceTargetChecks,
    limitation: "The public plan response does not expose which shards the runtime selected for a request. A mapping in a published shard therefore does not prove that the specific shard was loaded for that request; absence of a crosswalk annotation on a stop object is not, by itself, evidence of a bug.",
  }, null, 2));
  console.log("=== OBSERVED KV78 PSA/CHB ASSIGNMENT SHARD DIAGNOSTIC ===");
  console.log(JSON.stringify({
    manifest: {
      httpStatus: results.find((item) => item.path === "/ndov-stop-crosswalk/manifest.json")?.status ?? null,
      generatedAt: stopAssignmentManifest?.generatedAt ?? null,
      shardCount: assignmentShardCount || null,
      assignmentCount: stopAssignmentManifest?.assignmentCount ?? null,
    },
    observedStopEventCount: observedAssignmentTargets.length,
    distinctRequiredShardCount: assignmentShardNumbers.length,
    shardProbes: assignmentShardNumbers.map((shardNumber) => {
      const shard = assignmentShardResults.get(shardNumber);
      return {
        shardNumber,
        httpStatus: shard?.status ?? null,
        bytes: shard?.bytes ?? null,
        validJson: Boolean(shard?.json && typeof shard.json === "object" && !Array.isArray(shard.json)),
        error: shard?.error ?? null,
      };
    }),
    targets: observedAssignmentChecks,
    limitation: "PSA/CHB records are probed only for KV78 stop codes returned by /api/plan; no stop code is inferred for unmatched trips.",
  }, null, 2));

  console.log("=== OPENOV STATIC SCHEDULE PATTERN CROSSCHECK (CORRECT TIME BUCKET) ===");
  console.log(JSON.stringify({
    serviceCalendarStatus: serviceCalendarResult.status,
    serviceCalendarValid: Boolean(serviceCalendar && typeof serviceCalendar === "object" && !Array.isArray(serviceCalendar)),
    routePatternChecks,
  }, null, 2));
  console.log(JSON.stringify({
    check: "production-static-crosswalk-assets",
    assets: results,
    routePatternChecks,
  }, null, 2));

  assert.ok(legs.length > 0, "Production /api/plan must return at least one leg.");
  console.log("PASS: production endpoint diagnostics finished; no data was changed.");
}

await main();
