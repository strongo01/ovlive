/**
 * Conservative bridge from a Transitous leg to NDOV KV78 rows.
 * This module is pure: no sockets, polling, Worker side effects, or planner mutation.
 */
import {
  matchKv78Leg,
  type Kv78StopRow,
  type LegMatchInput,
  type MatchedLeg,
} from "./ndov-realtime-adapter";

export type StopCodePair = [stopId: string, stopCode: string];
export type RouteRow = [routeId: string, agencyId: string, routeShortName: string, routeLongName: string];

export interface NdovGtfsCrosswalk {
  schemaVersion?: number;
  stopCodes: StopCodePair[];
  routeRows: RouteRow[];
  agencies?: Record<string, string>;
}

export interface TransitousLegForNdov {
  routeId: string;
  operationDate: string;
  fromStopId: string;
  toStopId: string;
  plannedDeparture: string;
  plannedArrival: string;
  /** Optional explicit filters, only when independently established. */
  allowedDataOwnerCodes?: string[];
  allowedLinePlanningNumbers?: string[];
  maxScheduleDifferenceSeconds?: number;
  maxUpdateAgeSeconds?: number;
  nowMs?: number;
}

export interface ResolvedRoute {
  routeId: string;
  agencyId: string;
  agencyName: string | null;
  routeShortName: string;
  routeLongName: string;
}

export interface TransitousNdovMatch {
  mappingStatus: "resolved" | "not_found" | "ambiguous";
  reason: string;
  route?: ResolvedRoute;
  fromStopCode?: string;
  toStopCode?: string;
  realtimeMatch?: MatchedLeg;
}

function distinct<T>(values: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function transitousRouteKey(routeId: string): string {
  const cleaned = (routeId ?? "").trim();
  if (!cleaned) return "";
  // Transitous IDs commonly look like nl-OpenOV_146872. Only use the suffix
  // when it exactly matches a route_id in the provided GTFS crosswalk.
  return cleaned;
}

function resolveRoute(crosswalk: NdovGtfsCrosswalk, transitousRouteId: string):
  | { status: "resolved"; route: ResolvedRoute }
  | { status: "not_found" | "ambiguous"; reason: string } {
  const wanted = transitousRouteKey(transitousRouteId);
  const possibleKeys = distinct([wanted, wanted.includes("_") ? wanted.slice(wanted.lastIndexOf("_") + 1) : wanted]);
  const allRows = Array.isArray(crosswalk.routeRows) ? crosswalk.routeRows : [];

  for (const key of possibleKeys) {
    const exact = distinct(allRows.filter((row) => String(row[0] ?? "") === key));
    if (exact.length === 1) {
      const [routeId, agencyId, routeShortName, routeLongName] = exact[0];
      return {
        status: "resolved",
        route: {
          routeId: String(routeId),
          agencyId: String(agencyId ?? ""),
          agencyName: crosswalk.agencies?.[String(agencyId ?? "")] ?? null,
          routeShortName: String(routeShortName ?? ""),
          routeLongName: String(routeLongName ?? ""),
        },
      };
    }
    if (exact.length > 1) {
      return { status: "ambiguous", reason: `duplicate_gtfs_route_rows_for_${key}` };
    }
  }
  return { status: "not_found", reason: "transitous_route_id_not_in_gtfs_crosswalk" };
}

function resolveStopCode(crosswalk: NdovGtfsCrosswalk, stopId: string):
  | { status: "resolved"; stopCode: string }
  | { status: "not_found" | "ambiguous"; reason: string } {
  const id = (stopId ?? "").trim();
  if (!id) return { status: "not_found", reason: "missing_transitous_stop_id" };
  const codes = [...new Set((crosswalk.stopCodes ?? [])
    .filter((pair) => String(pair?.[0] ?? "").trim() === id)
    .map((pair) => String(pair?.[1] ?? "").trim())
    .filter(Boolean))];
  if (codes.length === 1) return { status: "resolved", stopCode: codes[0] };
  if (codes.length > 1) return { status: "ambiguous", reason: `multiple_stop_codes_for_${id}` };
  return { status: "not_found", reason: `stop_code_missing_from_crosswalk_${id}` };
}

/**
 * Resolve Transitous route/stop identifiers through the public GTFS crosswalk,
 * then require exact two-stop, order, schedule-time and full KV78 identity matching.
 * route_short_name is reported as metadata but is deliberately NOT converted into
 * LinePlanningNumber; that mapping is not guaranteed by GTFS.
 */
export function matchTransitousLegWithKv78(
  rows: Kv78StopRow[],
  crosswalk: NdovGtfsCrosswalk,
  leg: TransitousLegForNdov,
): TransitousNdovMatch {
  if (!crosswalk || !Array.isArray(crosswalk.stopCodes) || !Array.isArray(crosswalk.routeRows)) {
    return { mappingStatus: "not_found", reason: "invalid_or_missing_gtfs_crosswalk" };
  }

  const routeResult = resolveRoute(crosswalk, leg.routeId);
  if (routeResult.status !== "resolved") {
    return { mappingStatus: routeResult.status, reason: routeResult.reason };
  }
  const fromResult = resolveStopCode(crosswalk, leg.fromStopId);
  if (fromResult.status !== "resolved") {
    return { mappingStatus: fromResult.status, reason: fromResult.reason, route: routeResult.route };
  }
  const toResult = resolveStopCode(crosswalk, leg.toStopId);
  if (toResult.status !== "resolved") {
    return { mappingStatus: toResult.status, reason: toResult.reason, route: routeResult.route, fromStopCode: fromResult.stopCode };
  }
  if (fromResult.stopCode === toResult.stopCode) {
    return { mappingStatus: "ambiguous", reason: "both_transitous_stops_resolve_to_same_userstopcode", route: routeResult.route, fromStopCode: fromResult.stopCode, toStopCode: toResult.stopCode };
  }

  const input: LegMatchInput = {
    operationDate: leg.operationDate,
    plannedDeparture: leg.plannedDeparture,
    plannedArrival: leg.plannedArrival,
    fromUserStopCode: fromResult.stopCode,
    toUserStopCode: toResult.stopCode,
    allowedDataOwnerCodes: leg.allowedDataOwnerCodes,
    allowedLinePlanningNumbers: leg.allowedLinePlanningNumbers,
    maxScheduleDifferenceSeconds: leg.maxScheduleDifferenceSeconds,
    maxUpdateAgeSeconds: leg.maxUpdateAgeSeconds,
    nowMs: leg.nowMs,
  };
  const realtimeMatch = matchKv78Leg(rows, input);
  return {
    mappingStatus: "resolved",
    reason: "gtfs_route_and_both_stop_codes_resolved",
    route: routeResult.route,
    fromStopCode: fromResult.stopCode,
    toStopCode: toResult.stopCode,
    realtimeMatch,
  };
}
