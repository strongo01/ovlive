/**
 * Select a representative sample for the nationwide live map.
 *
 * The upstream GTFS-Realtime feed can contain more positions than the Worker
 * should return in a single map response. Never take only the first N feed
 * entries: feeds may be ordered by operator/route, which can hide all routes
 * appearing later in the source. Spread the sample across route groups instead.
 */
export interface OpenovMapPositionIdentity {
  routeId?: string;
  tripId?: string;
  vehicleId?: string;
  entityId?: string;
}

function normalizeId(value: unknown): string {
  return String(value ?? "")
    .replace(/^nl-OpenOV_/i, "")
    .trim();
}

function groupKey(position: OpenovMapPositionIdentity, index: number): string {
  const routeId = normalizeId(position.routeId);
  if (routeId) return "route:" + routeId;

  const tripId = normalizeId(position.tripId);
  if (tripId) return "trip:" + tripId;

  const vehicleId = normalizeId(position.vehicleId);
  if (vehicleId) return "vehicle:" + vehicleId;

  const entityId = normalizeId(position.entityId);
  if (entityId) return "entity:" + entityId;

  return "row:" + index;
}

export function selectDiverseOpenovLiveMapPositions<T extends OpenovMapPositionIdentity>(
  positions: readonly T[],
  maxPositions: number
): T[] {
  if (!Number.isSafeInteger(maxPositions) || maxPositions <= 0) return [];
  if (positions.length <= maxPositions) return Array.from(positions);

  const grouped = new Map<string, T[]>();
  positions.forEach((position, index) => {
    const key = groupKey(position, index);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(position);
    } else {
      grouped.set(key, [position]);
    }
  });

  const routes = Array.from(grouped.values());
  const selected: T[] = [];

  // If there are at least as many distinct route groups as slots, choose
  // representatives evenly across the *whole* feed, including its tail.
  if (routes.length >= maxPositions) {
    const lastGroupIndex = routes.length - 1;
    for (let index = 0; index < maxPositions; index += 1) {
      const groupIndex = maxPositions === 1
        ? Math.floor(lastGroupIndex / 2)
        : Math.floor(index * lastGroupIndex / (maxPositions - 1));
      selected.push(routes[groupIndex][0]);
    }
    return selected;
  }

  // Otherwise, take one position per route first, then second positions, etc.
  // This balances popular bus routes against less frequent tram/metro routes.
  for (let round = 0; selected.length < maxPositions; round += 1) {
    let addedThisRound = false;
    for (const route of routes) {
      if (round >= route.length) continue;
      selected.push(route[round]);
      addedThisRound = true;
      if (selected.length >= maxPositions) break;
    }
    if (!addedThisRound) break;
  }

  return selected;
}


/**
 * Keep every known tram position in the national live-map sample before
 * filling the remaining slots with a diverse sample of other vehicles.
 * This prevents low-volume tram routes from losing most of their vehicles
 * when thousands of national bus/rail position records compete for the cap.
 */
export function selectOpenovPositionsWithTramPriority<
  T extends OpenovMapPositionIdentity
>(
  positions: readonly T[],
  maxPositions: number,
  tramRouteIds: ReadonlySet<string>
): T[] {
  if (!Number.isSafeInteger(maxPositions) || maxPositions <= 0) return [];

  const isTramRoute = (position: T) => {
    const routeId = normalizeId(position.routeId);
    return Boolean(routeId && tramRouteIds.has(routeId));
  };

  const tramPositions = positions.filter(isTramRoute);
  if (tramPositions.length >= maxPositions) {
    return selectDiverseOpenovLiveMapPositions(tramPositions, maxPositions);
  }

  const otherPositions = positions.filter(position => !isTramRoute(position));
  const sampledOthers = selectDiverseOpenovLiveMapPositions(
    otherPositions,
    maxPositions - tramPositions.length
  );
  return tramPositions.concat(sampledOthers);
}
