/* Pure, source-aware transfer assessment for the OVLive browser UI. */
(function attachRealtimeTransferAssistant(root) {
  "use strict";

  const NON_TRANSIT_MODES = new Set(["WALK", "WAIT", "TRANSFER"]);

  function text(value) {
    return String(value ?? "").trim();
  }

  function timestamp(value) {
    if (value == null || value === "") return Number.NaN;
    return Date.parse(value);
  }

  function normalizedName(value) {
    return text(value).toLocaleLowerCase("nl-NL")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }

  function stopId(place) {
    const value = place && typeof place === "object"
      ? (place.stopId ?? place.stop_id ?? place.gtfsId ?? place.gtfs_id ?? place.id)
      : null;
    const result = text(value);
    return result ? result.replace(/^nl-OpenOV_/i, "").toLocaleLowerCase("nl-NL") : "";
  }

  function stopName(place) {
    if (!place || typeof place !== "object") return "";
    return text(place.name ?? place.displayName ?? place.stopName ?? place.stop_name);
  }

  function placeKey(place) {
    const id = stopId(place);
    if (id) return "id:" + id;
    const name = normalizedName(stopName(place));
    return name ? "name:" + name : "";
  }

  function samePlace(left, right) {
    const leftId = stopId(left);
    const rightId = stopId(right);
    if (leftId && rightId) return leftId === rightId;
    const leftName = normalizedName(stopName(left));
    const rightName = normalizedName(stopName(right));
    return Boolean(leftName && rightName && leftName === rightName);
  }

  function isCancelled(leg) {
    return Boolean(leg && (
      leg.cancelled === true ||
      leg.ndovRealtime?.status === "cancelled" ||
      leg.openovRealtime?.status === "cancelled" ||
      leg.nsRealtime?.status === "cancelled"
    ));
  }

  function safeTime(getTime, leg, kind) {
    try {
      return typeof getTime === "function" ? getTime(leg, kind) : null;
    } catch {
      return null;
    }
  }

  function safePrediction(getPrediction, leg, kind, scheduled) {
    try {
      const value = typeof getPrediction === "function"
        ? getPrediction(leg, kind, scheduled)
        : null;
      return value && Number.isFinite(timestamp(value.time)) ? value : null;
    } catch {
      return null;
    }
  }

  function durationFromLeg(leg, getTime, getWalkingDuration, speedKmh) {
    const distance = Number(leg?.distance);
    if (Number.isFinite(distance) && distance > 0 &&
        typeof getWalkingDuration === "function") {
      const duration = Number(getWalkingDuration(distance, speedKmh));
      if (Number.isFinite(duration) && duration >= 0) return duration;
    }

    const startMs = timestamp(safeTime(getTime, leg, "departure"));
    const endMs = timestamp(safeTime(getTime, leg, "arrival"));
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      return (endMs - startMs) / 1000;
    }

    const explicitDuration = Number(leg?.duration);
    if (leg?.mode && Number.isFinite(explicitDuration) && explicitDuration > 0) {
      return explicitDuration;
    }
    return null;
  }

  function analyze(legs, options = {}) {
    const items = Array.isArray(legs) ? legs : [];
    const getTime = options.plannedEndpointTime;
    const getPrediction = options.timelineRealtimePrediction;
    const getWalkingDuration = options.walkingDurationSeconds;
    const speedKmh = Number(options.walkingSpeedKmh);
    const nowValue = Number(options.nowMs);
    const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
    const transit = [];

    items.forEach((leg, index) => {
      if (!NON_TRANSIT_MODES.has(String(leg?.mode ?? "").toUpperCase())) {
        transit.push({ leg, index });
      }
    });

    const results = [];
    for (let transferIndex = 1; transferIndex < transit.length; transferIndex += 1) {
      const previous = transit[transferIndex - 1];
      const next = transit[transferIndex];

      const scheduledArrivalTime = safeTime(getTime, previous.leg, "arrival");
      const scheduledDepartureTime = safeTime(getTime, next.leg, "departure");
      const arrivalPrediction = safePrediction(
        getPrediction, previous.leg, "arrival", scheduledArrivalTime
      );
      const departurePrediction = safePrediction(
        getPrediction, next.leg, "departure", scheduledDepartureTime
      );
      const arrivalTime = arrivalPrediction?.time || scheduledArrivalTime || null;
      const departureTime = departurePrediction?.time || scheduledDepartureTime || null;
      const arrivalMs = timestamp(arrivalTime);
      const departureMs = timestamp(departureTime);
      let walkingSeconds = 0;
      let walkingDistanceMeters = 0;
      let hasWalkingLeg = false;
      let walkingUnknown = false;

      for (let index = previous.index + 1; index < next.index; index += 1) {
        const leg = items[index];
        const mode = String(leg?.mode ?? "").toUpperCase();
        if (mode !== "WALK" && mode !== "TRANSFER") continue;
        hasWalkingLeg = true;
        const duration = durationFromLeg(
          leg, getTime, getWalkingDuration, speedKmh
        );
        if (!Number.isFinite(duration) || duration < 0) {
          walkingUnknown = true;
        } else {
          walkingSeconds += duration;
        }
        const distance = Number(leg?.distance);
        if (Number.isFinite(distance) && distance > 0) {
          walkingDistanceMeters += distance;
        }
      }

      // If the planner omitted a walk/transfer leg, treat it as zero only
      // when both trip endpoints identify the same stop or platform.
      if (!hasWalkingLeg) {
        if (samePlace(previous.leg?.to, next.leg?.from)) {
          walkingSeconds = 0;
        } else {
          walkingUnknown = true;
        }
      }

      const plannedArrivalMs = timestamp(scheduledArrivalTime);
      const plannedDepartureMs = timestamp(scheduledDepartureTime);
      const scheduledSlackSeconds = !walkingUnknown &&
        Number.isFinite(plannedArrivalMs) && Number.isFinite(plannedDepartureMs)
        ? (plannedDepartureMs - plannedArrivalMs) / 1000 - walkingSeconds
        : null;
      const readyAtMs = !walkingUnknown && Number.isFinite(arrivalMs)
        ? Math.max(arrivalMs, nowMs) + walkingSeconds * 1000
        : Number.NaN;
      const slackSeconds = !walkingUnknown && Number.isFinite(readyAtMs) &&
        Number.isFinite(departureMs)
        ? (departureMs - readyAtMs) / 1000
        : null;

      const previousCancelled = isCancelled(previous.leg);
      const nextCancelled = isCancelled(next.leg);
      const realtimePredictionCount = Number(Boolean(arrivalPrediction)) +
        Number(Boolean(departurePrediction));
      let status = "unknown";
      if (previousCancelled || nextCancelled) {
        status = "cancelled";
      } else if (!walkingUnknown && Number.isFinite(arrivalMs) &&
          Number.isFinite(departureMs) && Number.isFinite(slackSeconds)) {
        status = slackSeconds < 0 ? "unreachable" :
          slackSeconds <= 120 ? "tight" : "feasible";
      }

      const timeBasis = realtimePredictionCount === 2 ? "realtime" :
        realtimePredictionCount === 1 ? "partial-realtime" : "schedule";
      results.push({
        transferIndex,
        previousLegIndex: previous.index,
        nextLegIndex: next.index,
        previousLeg: previous.leg,
        nextLeg: next.leg,
        stop: next.leg?.from ?? previous.leg?.to ?? null,
        stopKey: placeKey(next.leg?.from) || placeKey(previous.leg?.to),
        scheduledArrivalTime: scheduledArrivalTime || null,
        scheduledDepartureTime: scheduledDepartureTime || null,
        arrivalTime,
        departureTime,
        arrivalPrediction,
        departurePrediction,
        arrivalMs,
        departureMs,
        readyAtMs,
        walkingKnown: !walkingUnknown,
        walkingSeconds: walkingUnknown ? null : Math.round(walkingSeconds),
        walkingDistanceMeters: walkingDistanceMeters || null,
        hasWalkingLeg,
        scheduledSlackSeconds: Number.isFinite(scheduledSlackSeconds)
          ? Math.round(scheduledSlackSeconds) : null,
        slackSeconds: Number.isFinite(slackSeconds) ? Math.round(slackSeconds) : null,
        realtimePredictionCount,
        timeBasis,
        previousCancelled,
        nextCancelled,
        status
      });
    }

    return results;
  }

  root.OVLiveRealtimeTransferAssistant = Object.freeze({
    analyze,
    placeKey,
    samePlace
  });
})(globalThis);
