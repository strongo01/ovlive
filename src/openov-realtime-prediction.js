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
  const unconfirmedScheduleEcho =
    options?.hasPerTripTimestamp !== true &&
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
