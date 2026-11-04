// FROZEN REFERENCE — letterlijke kopie van de implementatie in src/index.ts @ 3517fb0
// (vóór de geheugenoptimalisatie). Alleen bedoeld om nieuwe uitvoer mee te vergelijken.
// NIET aanpassen.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
export { GtfsRealtimeBindings };

export function toNumber(value) {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
export function enumName(enumObject, value) {
  if (value == null) return undefined;
  return typeof value === "string" ? value : enumObject?.[value];
}
export function normalizeTripUpdates(feed) {
  const rt = GtfsRealtimeBindings.transit_realtime;
  const rows = [];
  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const trip = tu.trip ?? {};
    const rawStopUpdates = (tu.stopTimeUpdate ?? []).map((s) => ({
    stopId: s.stopId,
    stopSequence: s.stopSequence,
    arrivalTime: toNumber(s.arrival?.time),
    arrivalDelaySeconds: s.arrival?.delay,
    departureTime: toNumber(s.departure?.time),
    departureDelaySeconds: s.departure?.delay,
    scheduleRelationship: enumName(rt.StopTimeUpdate?.ScheduleRelationship, s.scheduleRelationship)
  }));
  let propagatedDelaySeconds =
    typeof tu.delay === "number" && Number.isFinite(tu.delay)
      ? tu.delay
      : undefined;
  const stopUpdates = rawStopUpdates.map((stop) => {
    const ownArrivalDelay =
      typeof stop.arrivalDelaySeconds === "number" && Number.isFinite(stop.arrivalDelaySeconds)
        ? stop.arrivalDelaySeconds
        : undefined;
    const ownDepartureDelay =
      typeof stop.departureDelaySeconds === "number" && Number.isFinite(stop.departureDelaySeconds)
        ? stop.departureDelaySeconds
        : undefined;
    const explicitDelay = ownDepartureDelay ?? ownArrivalDelay;
    if (explicitDelay !== undefined) propagatedDelaySeconds = explicitDelay;
    const noData = String(stop.scheduleRelationship ?? "").toUpperCase() === "NO_DATA";
    const inheritedDelay = noData ? undefined : propagatedDelaySeconds;
    return {
      ...stop,
      effectiveArrivalDelaySeconds: ownArrivalDelay ?? inheritedDelay,
      effectiveDepartureDelaySeconds: ownDepartureDelay ?? inheritedDelay
    };
  });
    rows.push({
      entityId: entity.id,
      tripId: trip.tripId,
      routeId: trip.routeId,
      startDate: trip.startDate,
      startTime: trip.startTime,
      directionId: trip.directionId,
      scheduleRelationship: enumName(rt.TripDescriptor?.ScheduleRelationship, trip.scheduleRelationship),
      delaySeconds: tu.delay,
      vehicleId: tu.vehicle?.id,
      timestamp: (() => {
        const value = toNumber(tu.timestamp);
        return value != null && value > 0 ? value : undefined;
      })(),
      stopUpdates
    });
  }
  return rows;
}

export function translatedText(value) {
  const translations = value?.translation;
  if (!Array.isArray(translations) || translations.length === 0) return undefined;
  const dutch = translations.find((t) => t.language === "nl");
  return (dutch ?? translations[0])?.text;
}
export function normalizeAlerts(feed) {
  const rt = GtfsRealtimeBindings.transit_realtime;
  const rows = [];
  for (const entity of feed.entity ?? []) {
    const alert = entity.alert;
    if (!alert) continue;
    rows.push({
      entityId: entity.id,
      header: translatedText(alert.headerText),
      description: translatedText(alert.descriptionText),
      url: translatedText(alert.url),
      cause: enumName(rt.Alert?.Cause, alert.cause),
      effect: enumName(rt.Alert?.Effect, alert.effect),
      activePeriods: (alert.activePeriod ?? []).map((p) => ({ start: toNumber(p.start), end: toNumber(p.end) })),
      communicationPeriods: (alert.communicationPeriod ?? []).map((p) => ({ start: toNumber(p.start), end: toNumber(p.end) })),
      impactPeriods: (alert.impactPeriod ?? []).map((p) => ({ start: toNumber(p.start), end: toNumber(p.end) })),
      informedEntities: (alert.informedEntity ?? []).map((e) => ({ agencyId: e.agencyId, routeId: e.routeId, stopId: e.stopId, tripId: e.trip?.tripId }))
    });
  }
  return rows;
}
export function normalizeVehicles(feed) {
  return (feed.entity ?? []).map((e) => ({
    entityId: e.id, vehicleId: e.vehicle?.vehicle?.id, tripId: e.vehicle?.trip?.tripId, routeId: e.vehicle?.trip?.routeId,
    stopId: e.vehicle?.stopId, latitude: e.vehicle?.position?.latitude, longitude: e.vehicle?.position?.longitude,
    timestamp: toNumber(e.vehicle?.timestamp)
  })).filter((e) => e.vehicleId || e.tripId || e.latitude != null);
}
/** Oud pad van fetchOpenovFeedUncached: volledige decode, dan normaliseren. */
export function legacyDecodeAndNormalize(bytes, kind) {
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const entities = kind === "tripUpdates" || kind === "trainUpdates" ? normalizeTripUpdates(feed)
    : kind === "alerts" ? normalizeAlerts(feed) : normalizeVehicles(feed);
  return { header: feed.header, entities, entityCount: (feed.entity ?? []).length };
}
