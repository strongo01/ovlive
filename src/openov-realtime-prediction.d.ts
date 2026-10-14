export type OpenovRealtimeEventKind = "arrival" | "departure";

export interface OpenovRealtimeEventSummary {
  time: string | null;
  delaySeconds: number | null;
  delayBasis:
    | "absolute_prediction_minus_scheduled_time"
    | "source_or_gtfs_propagated_delay"
    | "unknown";
}

export declare function summarizeRealtimeEvent(
  stop: any,
  kind: OpenovRealtimeEventKind,
  scheduledValue?: unknown,
): OpenovRealtimeEventSummary | null;
