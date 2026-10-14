export function summarizeRealtimeEvent(stop, kind, scheduledValue) {
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

  // GTFS-Realtime: absolute event time takes precedence over delay.
  const delaySeconds = hasAbsolutePrediction
    ? Math.round(validTimestamp - scheduledSeconds)
    : hasReportedDelay
      ? reportedDelay
      : null;

  return {
    time: validTimestamp !== undefined
      ? new Date(validTimestamp * 1000).toISOString()
      : null,
    delaySeconds,
    delayBasis: hasAbsolutePrediction
      ? "absolute_prediction_minus_scheduled_time"
      : hasReportedDelay
        ? "source_or_gtfs_propagated_delay"
        : "unknown"
  };
}
