
// Alleen gebruiken als de exacte halte-ID ontbreekt.
// De trip moet al exact gekoppeld zijn; deze helper zoekt uitsluitend
// een unieke haltegebeurtenis met een expliciete bronvertraging waarvan
// de gereconstrueerde geplande tijd zeer dicht bij de geplande reistijd ligt.
export function findRealtimeStopByScheduledEvent(record, kind, scheduledValue) {
  let plannedMs = Number.NaN;

  if (typeof scheduledValue === "string") {
    plannedMs = Date.parse(scheduledValue);
  } else if (typeof scheduledValue === "number") {
    plannedMs = scheduledValue > 1e12
      ? scheduledValue
      : scheduledValue > 1e9
        ? scheduledValue * 1000
        : Number.NaN;
  }

  if (!Number.isFinite(plannedMs)) return null;

  const plannedSeconds = plannedMs / 1000;
  const timeKey = `${kind}Time`;
  const delayKey = `${kind}DelaySeconds`;
  const candidates = [];

  for (const stop of record?.stopUpdates ?? []) {
    if (String(stop.scheduleRelationship ?? "").toUpperCase() === "NO_DATA") {
      continue;
    }

    const eventTime = stop[timeKey];
    const explicitDelay = stop[delayKey];

    // Geen fallback op basis van alleen een tijd of een geërfde vertraging.
    if (
      typeof eventTime !== "number" ||
      !Number.isFinite(eventTime) ||
      typeof explicitDelay !== "number" ||
      !Number.isFinite(explicitDelay)
    ) {
      continue;
    }

    const reconstructedSchedule = eventTime - explicitDelay;
    const deltaSeconds = Math.abs(reconstructedSchedule - plannedSeconds);

    // Strenge grens: de brongebeurtenis moet binnen 45 seconden passen.
    if (deltaSeconds <= 45) {
      candidates.push({ stop, deltaSeconds });
    }
  }

  candidates.sort((a, b) => a.deltaSeconds - b.deltaSeconds);

  if (candidates.length === 0) return null;

  // Als twee haltegebeurtenissen vrijwel even goed passen, niets gokken.
  if (
    candidates.length > 1 &&
    candidates[1].deltaSeconds - candidates[0].deltaSeconds < 15
  ) {
    return null;
  }

  return {
    stop: candidates[0].stop,
    method: "scheduled_time_correlated",
    deltaSeconds: Math.round(candidates[0].deltaSeconds)
  };
}

export function summarizeRealtimeEvent(
  stop,
  kind,
  scheduledValue,
  options = {}
) {
  if (!stop) return null;

  const timestamp = stop[`${kind}Time`];
  const capitalizedKind = kind[0].toUpperCase() + kind.slice(1);
  const reportedDelay =
    stop[`effective${capitalizedKind}DelaySeconds`] ??
    stop[`${kind}DelaySeconds`];

  let scheduledMs = Number.NaN;
  if (typeof scheduledValue === "string") {
    scheduledMs = Date.parse(scheduledValue);
  } else if (typeof scheduledValue === "number") {
    scheduledMs = scheduledValue > 1e12
      ? scheduledValue
      : scheduledValue > 1e9
        ? scheduledValue * 1000
        : Number.NaN;
  }

  const scheduledSeconds = Number.isFinite(scheduledMs)
    ? scheduledMs / 1000
    : undefined;

  const validTimestamp =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? timestamp
      : undefined;

  const hasReportedDelay =
    typeof reportedDelay === "number" && Number.isFinite(reportedDelay);

  const hasAbsolutePrediction =
    validTimestamp !== undefined && scheduledSeconds !== undefined;

  // GTFS-Realtime: absolute event time normally takes precedence over delay.
  const candidateDelaySeconds = hasAbsolutePrediction
    ? Math.round(validTimestamp - scheduledSeconds)
    : hasReportedDelay
      ? reportedDelay
      : null;

  // Zonder timestamp van de rit kan een absolute tijd op een volgende
  // service-dag ten onrechte als precies 24 uur vertraging verschijnen.
  // Herken verschuivingen van hele dagen met maximaal 3 minuten afwijking.
  const isWholeDayOffset = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;

    const absolute = Math.abs(value);
    if (absolute < 43200) return false;

    const remainder = absolute % 86400;
    return Math.min(remainder, 86400 - remainder) <= 180;
  };

  const unconfirmedWholeDayOffset =
    options?.hasPerTripTimestamp !== true &&
    isWholeDayOffset(candidateDelaySeconds);

  // Zonder rit-timestamp is een tijd die exact de dienstregeling herhaalt
  // geen bewijs van een actuele voorspelling. Behandel deze als onbekend.
  // Een expliciete bronvertraging die overeenkomt met de absolute
  // voorspelling is ook zonder timestamp per rit bruikbaar.
  // Alleen een niet-onderbouwde dienstregeling-echo wordt verborgen.
  const explicitReportedDelay = stop[`${kind}DelaySeconds`];
  const hasConsistentExplicitDelay =
    typeof explicitReportedDelay === "number" &&
    Number.isFinite(explicitReportedDelay) &&
    typeof candidateDelaySeconds === "number" &&
    Math.abs(explicitReportedDelay - candidateDelaySeconds) <= 1;

  const unconfirmedScheduleEcho =
    options?.hasPerTripTimestamp !== true &&
    !hasConsistentExplicitDelay &&
    hasAbsolutePrediction &&
    candidateDelaySeconds === 0 &&
    Math.abs(validTimestamp - scheduledSeconds) <= 1;

  const unconfirmedPrediction =
    unconfirmedWholeDayOffset || unconfirmedScheduleEcho;

  // Een onbetrouwbare tijd mag niet als realtime worden getoond.
  const delaySeconds = unconfirmedPrediction
    ? null
    : candidateDelaySeconds;

  return {
    time: validTimestamp !== undefined && !unconfirmedPrediction
      ? new Date(validTimestamp * 1000).toISOString()
      : null,
    delaySeconds,
    delayBasis: unconfirmedWholeDayOffset
      ? "unconfirmed_whole_day_offset"
      : unconfirmedScheduleEcho
        ? "unconfirmed_schedule_echo"
        : hasAbsolutePrediction
          ? "absolute_prediction_minus_scheduled_time"
          : hasReportedDelay
            ? "source_or_gtfs_propagated_delay"
            : "unknown"
  };
}


// Koppel een voertuigpositie uitsluitend aan de exacte geplande rit.
// Een positie is géén vertraging: daarvoor blijft halte-informatie nodig.
export function findExactVehiclePositionForLeg(
  leg,
  positions,
  nowSeconds = Date.now() / 1000
) {
  const tripMatch = String(leg?.tripId ?? "").match(
    /^(\d{8})_(\d{2}:\d{2}(?::\d{2})?)_nl-OpenOV_(.+)$/i
  );
  if (!tripMatch) return null;

  const expectedDate = tripMatch[1];
  const expectedStartTime = normalizeVehicleClock(tripMatch[2]);
  const expectedTripId = normalizeVehicleId(tripMatch[3]);
  const expectedRouteId = normalizeVehicleId(
    leg?.routeId ?? leg?.route?.id
  );

  if (!expectedTripId || !expectedRouteId) return null;

  const plannedValue =
    leg?.from?.scheduledDeparture ??
    leg?.scheduledStartTime ??
    leg?.startTime ??
    leg?.from?.departure;

  const plannedMs = typeof plannedValue === "string"
    ? Date.parse(plannedValue)
    : Number.NaN;

  const matches = [];

  for (const position of positions ?? []) {
    if (
      normalizeVehicleId(position?.tripId) !== expectedTripId ||
      normalizeVehicleId(position?.routeId) !== expectedRouteId
    ) {
      continue;
    }

    const timestamp = Number(position?.timestamp);
    const latitude = Number(position?.latitude);
    const longitude = Number(position?.longitude);

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) {
      continue;
    }

    const ageSeconds = Math.round(nowSeconds - timestamp);

    // Een positie mag hooguit 180 seconden oud zijn.
    // Kleine klokafwijkingen tot 30 seconden in de toekomst zijn toegestaan.
    if (ageSeconds < -30 || ageSeconds > 180) continue;

    const positionDate = String(position?.startDate ?? "")
      .replace(/\D/g, "")
      .slice(0, 8);

    const positionStartTime = normalizeVehicleClock(position?.startTime);

    // Dienstinformatie moet de ritinstantie helpen onderscheiden.
    // Alleen een herhaald numeriek GTFS-trip-ID is onvoldoende.
    if (!positionDate && !positionStartTime) continue;

    if (positionDate && positionDate !== expectedDate) continue;

    if (
      positionStartTime &&
      positionStartTime !== expectedStartTime
    ) {
      continue;
    }

    // Een verse positie van een andere ritdag of een heel andere
    // doorkomsttijd mag niet per ongeluk bij dit reistraject terechtkomen.
    if (
      Number.isFinite(plannedMs) &&
      Math.abs(timestamp - plannedMs / 1000) > 4 * 60 * 60
    ) {
      continue;
    }

    matches.push({
      tripId: expectedTripId,
      routeId: expectedRouteId,
      vehicleId: position?.vehicleId || null,
      startDate: positionDate || null,
      startTime: positionStartTime || null,
      latitude,
      longitude,
      stopId: position?.stopId || null,
      observedAt: new Date(timestamp * 1000).toISOString(),
      ageSeconds,
      matchMethod: "exact_trip_id_vehicle_position"
    });
  }

  if (matches.length === 0) return null;

  // Neem bij dubbele records de nieuwste positie.
  matches.sort((a, b) => a.ageSeconds - b.ageSeconds);
  return matches[0];
}

function normalizeVehicleId(value) {
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").trim();
}

function normalizeVehicleClock(value) {
  if (value == null || value === "") return null;
  const match = String(value).match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}`;
}

// Leid een vertraging alleen af binnen de reeds exact gematchte rit.
// De caller blijft verantwoordelijk voor de versheid van de feed.
export function findPropagatedRealtimeEvent(record, kind, scheduledValue, options = {}) {
  if (!record || !Array.isArray(record.stopUpdates)) return null;

  const toSeconds = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 1e12) return value / 1000;
      return value > 1e9 ? value : Number.NaN;
    }
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms / 1000 : Number.NaN;
    }
    return Number.NaN;
  };

  const target = toSeconds(scheduledValue);
  const feedTime = toSeconds(record.feedTimestampSeconds);
  const now = Number.isFinite(options.nowSeconds) ? options.nowSeconds : Date.now() / 1000;
  const maxLookahead = Number.isFinite(options.maxLookaheadSeconds) ? options.maxLookaheadSeconds : 2700;
  const maxEventAge = Number.isFinite(options.maxSourceEventAgeSeconds) ? options.maxSourceEventAgeSeconds : 900;

  if (!Number.isFinite(target) || !Number.isFinite(feedTime)) return null;
  const feedAge = now - feedTime;
  if (feedAge < -60 || feedAge > 180) return null;
  if (target - feedTime < -60 || target - feedTime > maxLookahead) return null;

  const normalizeId = value => String(value ?? "").trim()
    .replace(/^nl-OpenOV_/i, "").replace(/^OpenOV_/i, "");
  const targetId = normalizeId(options.targetStopId);
  if (!targetId) return null;

  // Nooit een bestaande doelhalte-update overschrijven.
  if (record.stopUpdates.some(s => normalizeId(s.stopId) === targetId)) return null;

  const candidates = [];

  for (const stop of record.stopUpdates) {
    const relation = String(stop.scheduleRelationship ?? "").toUpperCase();
    if (["NO_DATA", "SKIPPED", "NO_SERVICE", "CANCELLED"].includes(relation)) continue;

    for (const eventKind of ["arrival", "departure"]) {
      const eventTime = toSeconds(stop[`${eventKind}Time`]);
      const delay = stop[`${eventKind}DelaySeconds`];

      // Alleen een vertraging gebruiken die expliciet door de bron is gemeld.
      if (!Number.isFinite(eventTime) ||
          typeof delay !== "number" ||
          !Number.isFinite(delay)) continue;

      const sourceScheduled = eventTime - delay;
      const gap = target - sourceScheduled;
      if (gap <= 0 || gap > maxLookahead) continue;
      if (feedTime - eventTime > maxEventAge) continue;
      if (eventTime > target + 1800) continue;

      candidates.push({
        stop, eventKind, eventTime, sourceScheduled, delay,
        sequence: Number(stop.stopSequence)
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) =>
    b.sourceScheduled - a.sourceScheduled ||
    (Number.isFinite(b.sequence) ? b.sequence : -1) -
      (Number.isFinite(a.sequence) ? a.sequence : -1) ||
    (b.eventKind === "departure" ? 1 : 0) -
      (a.eventKind === "departure" ? 1 : 0)
  );

  const best = candidates[0];

  // Zonder de doelhaltevolgorde kunnen we een latere NO_DATA-barrière
  // niet uitsluiten. In dat geval geven we liever geen afgeleide tijd.
  if (Number.isFinite(best.sequence) && record.stopUpdates.some(stop =>
    String(stop.scheduleRelationship ?? "").toUpperCase() === "NO_DATA" &&
    Number.isFinite(Number(stop.stopSequence)) &&
    Number(stop.stopSequence) > best.sequence
  )) return null;

  return {
    time: new Date((target + best.delay) * 1000).toISOString(),
    delaySeconds: best.delay,
    delayBasis: "gtfsrt_propagated_from_prior_stop_update",
    predictionMethod: "gtfsrt_delay_propagation",
    matchMethod: "gtfsrt_delay_propagation_from_prior_stop_update",
    sourceStopId: best.stop.stopId ?? null,
    sourceStopSequence: Number.isFinite(best.sequence) ? best.sequence : null,
    sourceEventTime: new Date(best.eventTime * 1000).toISOString(),
    sourceScheduledTime: new Date(best.sourceScheduled * 1000).toISOString()
  };
}
