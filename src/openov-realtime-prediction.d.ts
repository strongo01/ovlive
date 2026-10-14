export type OpenovRealtimeEventKind = "arrival" | "departure";

export interface OpenovRealtimeEventSummary {
  time: string | null;
  delaySeconds: number | null;
  delayBasis:
    | "absolute_prediction_minus_scheduled_time"
    | "source_or_gtfs_propagated_delay"
    | "unconfirmed_whole_day_offset"
    | "unconfirmed_schedule_echo"
    | "unknown";
}

export interface OpenovRealtimeEventOptions {
  hasPerTripTimestamp?: boolean;
}

export declare function summarizeRealtimeEvent(
  stop: any,
  kind: OpenovRealtimeEventKind,
  scheduledValue?: unknown,
  options?: OpenovRealtimeEventOptions,
): OpenovRealtimeEventSummary | null;
