/**
 * Incremental GTFS-Realtime decoding for the OVLive Worker.
 *
 * WHY: `FeedMessage.decode(bytes)` materialises the *entire* feed as protobufjs
 * objects (≈ 250 B per StopTimeUpdate, including Long objects) and only then is
 * it normalised into a second structure. Both copies were alive at the same
 * time, which is what pushed the isolate over the 128 MB limit on large
 * tripUpdates feeds.
 *
 * WHAT: this module walks the outer FeedMessage framing itself and decodes ONE
 * FeedEntity at a time with the unchanged, generated protobuf decoders
 * (`FeedEntity.decode`, `FeedHeader.decode`). Each entity is normalised right
 * away and becomes garbage immediately afterwards. Every entity is processed in
 * the original order and no entity is skipped, so the normalised output is
 * identical to the old implementation (verified by scripts/gtfs-rt-stream-equivalence.mjs).
 *
 * Anything unexpected in the outer framing (unknown wire type, truncated data)
 * falls back to the original one-shot `FeedMessage.decode`, so behaviour on odd
 * input is unchanged as well.
 */
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

export type OpenovFeedKind = "tripUpdates" | "alerts" | "trainUpdates" | "vehiclePositions";

const rt = (GtfsRealtimeBindings as any).transit_realtime;

export function toNumber(value: any): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function translatedText(value: any): string | undefined {
  const translations = value?.translation;
  if (!Array.isArray(translations) || translations.length === 0) return undefined;
  const dutch = translations.find((t: any) => t.language === "nl");
  return (dutch ?? translations[0])?.text;
}

export function enumName(enumObject: any, value: any): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : enumObject?.[value];
}

/**
 * Per-feed string pool. Stop ids, route ids and similar identifiers repeat
 * across hundreds of thousands of stop updates; every protobuf decode creates a
 * fresh string for each occurrence. Sharing one instance per distinct value
 * leaves every value byte-for-byte identical but stores it once.
 */
export class StringPool {
  private readonly map = new Map<string, string>();
  get(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const known = this.map.get(value);
    if (known !== undefined) return known;
    this.map.set(value, value);
    return value;
  }
}

/** Same logic as the original normalizeTripUpdates body, for one entity. */
export function normalizeTripUpdateEntity(entity: any, pool?: StringPool): any | null {
  const tu = entity.tripUpdate;
  if (!tu) return null;
  const p = (v: string | undefined) => (pool ? pool.get(v) : v);
  const trip = tu.trip ?? {};
  const stopTimeUpdates: any[] = tu.stopTimeUpdate ?? [];

  // GTFS-RT: een trip-level delay geldt ook voor volgende stops,
  // totdat een stop-update een eigen vertraging opgeeft.
  let propagatedDelaySeconds: number | undefined =
    typeof tu.delay === "number" && Number.isFinite(tu.delay) ? tu.delay : undefined;

  const stopUpdates = new Array(stopTimeUpdates.length);
  for (let i = 0; i < stopTimeUpdates.length; i++) {
    const s = stopTimeUpdates[i];
    // Original: rawStopUpdates (7 fields) then `{...stop, effective*}`; the
    // intermediate array is no longer allocated, the resulting object has the
    // same keys in the same order.
    const arrivalDelaySeconds = s.arrival?.delay;
    const departureDelaySeconds = s.departure?.delay;
    const scheduleRelationship = enumName(rt.StopTimeUpdate?.ScheduleRelationship, s.scheduleRelationship);

    const ownArrivalDelay =
      typeof arrivalDelaySeconds === "number" && Number.isFinite(arrivalDelaySeconds) ? arrivalDelaySeconds : undefined;
    const ownDepartureDelay =
      typeof departureDelaySeconds === "number" && Number.isFinite(departureDelaySeconds) ? departureDelaySeconds : undefined;

    // Als één event op deze halte een expliciete delay heeft, wordt die
    // de geërfde delay voor volgende halte-updates.
    const explicitDelay = ownDepartureDelay ?? ownArrivalDelay;
    if (explicitDelay !== undefined) propagatedDelaySeconds = explicitDelay;

    const noData = String(scheduleRelationship ?? "").toUpperCase() === "NO_DATA";
    const inheritedDelay = noData ? undefined : propagatedDelaySeconds;

    stopUpdates[i] = {
      stopId: p(s.stopId),
      stopSequence: s.stopSequence,
      arrivalTime: toNumber(s.arrival?.time),
      arrivalDelaySeconds,
      departureTime: toNumber(s.departure?.time),
      departureDelaySeconds,
      scheduleRelationship,
      effectiveArrivalDelaySeconds: ownArrivalDelay ?? inheritedDelay,
      effectiveDepartureDelaySeconds: ownDepartureDelay ?? inheritedDelay,
    };
  }

  return {
    entityId: entity.id,
    tripId: p(trip.tripId),
    routeId: p(trip.routeId),
    startDate: p(trip.startDate),
    startTime: p(trip.startTime),
    directionId: trip.directionId,
    scheduleRelationship: enumName(rt.TripDescriptor?.ScheduleRelationship, trip.scheduleRelationship),
    delaySeconds: tu.delay,
    vehicleId: tu.vehicle?.id,
    // Een ontbrekende protobuf-timestamp mag niet als tijdstip 0 gelden.
    timestamp: (() => {
      const value = toNumber(tu.timestamp);
      return value != null && value > 0 ? value : undefined;
    })(),
    stopUpdates,
  };
}

export function normalizeAlertEntity(entity: any): any | null {
  const alert = entity.alert;
  if (!alert) return null;
  return {
    entityId: entity.id,
    header: translatedText(alert.headerText),
    description: translatedText(alert.descriptionText),
    url: translatedText(alert.url),
    cause: enumName(rt.Alert?.Cause, alert.cause),
    effect: enumName(rt.Alert?.Effect, alert.effect),
    activePeriods: (alert.activePeriod ?? []).map((p: any) => ({ start: toNumber(p.start), end: toNumber(p.end) })),
    communicationPeriods: (alert.communicationPeriod ?? []).map((p: any) => ({ start: toNumber(p.start), end: toNumber(p.end) })),
    impactPeriods: (alert.impactPeriod ?? []).map((p: any) => ({ start: toNumber(p.start), end: toNumber(p.end) })),
    informedEntities: (alert.informedEntity ?? []).map((e: any) => ({
      agencyId: e.agencyId,
      routeId: e.routeId,
      stopId: e.stopId,
      tripId: e.trip?.tripId,
    })),
  };
}

export function normalizeVehicleEntity(e: any): any | null {
  const row = {
    entityId: e.id,
    vehicleId: e.vehicle?.vehicle?.id,
    tripId: e.vehicle?.trip?.tripId,
    routeId: e.vehicle?.trip?.routeId,
    stopId: e.vehicle?.stopId,
    latitude: e.vehicle?.position?.latitude,
    longitude: e.vehicle?.position?.longitude,
    timestamp: toNumber(e.vehicle?.timestamp),
  };
  return row.vehicleId || row.tripId || row.latitude != null ? row : null;
}

// ---------------------------------------------------------------------------
// Outer FeedMessage framing
// ---------------------------------------------------------------------------

class FramingFallback extends Error {}

/** Reads a protobuf varint (up to 10 bytes) without allocating; returns [value, nextPos]. */
function readVarint(bytes: Uint8Array, pos: number): { value: number; pos: number } {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new FramingFallback("truncated varint");
    const b = bytes[pos++];
    // Lengths and tags in a FeedMessage are far below 2^53; multiplication avoids 32-bit wrap.
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value: result, pos };
    shift += 7;
  }
  throw new FramingFallback("varint too long");
}

export interface StreamedFeed<T> {
  header: any;
  items: T[];
  entityCount: number;
}

/**
 * Decode a FeedMessage one entity at a time. `map` is called with each decoded
 * FeedEntity (in wire order) and returns the normalised row, or null to skip it
 * exactly as the original kind-specific normalisers did.
 */
export function streamFeed<T>(bytes: Uint8Array, map: (entity: any) => T | null): StreamedFeed<T> {
  try {
    let header: any;
    let pos = 0;
    const items: T[] = [];
    let entityCount = 0;
    const end = bytes.length;
    while (pos < end) {
      const tag = readVarint(bytes, pos);
      pos = tag.pos;
      const field = Math.floor(tag.value / 8);
      const wire = tag.value % 8;
      if (wire === 2) {
        const len = readVarint(bytes, pos);
        pos = len.pos;
        const stop = pos + len.value;
        if (stop > end) throw new FramingFallback("length beyond buffer");
        if (field === 1) {
          // Original: header = FeedHeader.decode(reader, len) (last one wins).
          header = rt.FeedHeader.decode(bytes.subarray(pos, stop));
        } else if (field === 2) {
          entityCount++;
          const row = map(rt.FeedEntity.decode(bytes.subarray(pos, stop)));
          if (row !== null) items.push(row);
        }
        pos = stop;
      } else if (wire === 0) {
        pos = readVarint(bytes, pos).pos;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else {
        throw new FramingFallback(`unsupported wire type ${wire}`);
      }
    }
    if (pos !== end) throw new FramingFallback("trailing bytes");
    if (header === undefined) throw new FramingFallback("missing header");
    return { header, items, entityCount };
  } catch (error) {
    if (!(error instanceof FramingFallback)) throw error;
    // Unusual framing: use the original one-shot decoder so behaviour (including
    // its error messages for genuinely corrupt data) is exactly as before.
    const feed = rt.FeedMessage.decode(bytes);
    const items: T[] = [];
    for (const entity of feed.entity ?? []) {
      const row = map(entity);
      if (row !== null) items.push(row);
    }
    return { header: feed.header, items, entityCount: (feed.entity ?? []).length };
  }
}

/** Decode + normalise a feed of the given kind. */
export function decodeOpenovFeed(bytes: Uint8Array, kind: OpenovFeedKind): { header: any; entities: any[] } {
  if (kind === "tripUpdates" || kind === "trainUpdates") {
    const pool = new StringPool();
    const { header, items } = streamFeed(bytes, (entity) => normalizeTripUpdateEntity(entity, pool));
    return { header, entities: items };
  }
  if (kind === "alerts") {
    const { header, items } = streamFeed(bytes, normalizeAlertEntity);
    return { header, entities: items };
  }
  const { header, items } = streamFeed(bytes, normalizeVehicleEntity);
  return { header, entities: items };
}
