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

export declare function findRealtimeStopByScheduledEvent(
  record: any,
  kind: OpenovRealtimeEventKind,
  scheduledValue?: unknown,
): {
  stop: any;
  method: "scheduled_time_correlated";
  deltaSeconds: number;
} | null;


export interface OpenovVehiclePositionObservation {
  tripId: string;
  routeId: string;
  vehicleId: string | null;
  startDate: string | null;
  startTime: string | null;
  latitude: number;
  longitude: number;
  stopId: string | null;
  observedAt: string;
  ageSeconds: number;
  matchMethod: "exact_trip_id_vehicle_position";
}

export declare function findExactVehiclePositionForLeg(
  leg: any,
  positions: any[],
  nowSeconds?: number,
): OpenovVehiclePositionObservation | null;

export function findPropagatedRealtimeEvent(
  record: any,
  kind: "arrival" | "departure",
  scheduledValue: unknown,
  options?: {
    nowSeconds?: number;
    targetStopId?: string | number;
    maxLookaheadSeconds?: number;
    maxSourceEventAgeSeconds?: number;
  }
): any;
