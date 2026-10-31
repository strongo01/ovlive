/**
 * CPU-bewuste GTFS-Realtime-decoder voor alleen VehiclePosition-velden.
 *
 * FeedMessage.decode bouwt voor de hele feed een groot generiek objectmodel op.
 * Deze decoder loopt door dezelfde protobuf-bytes maar slaat onbekende/niet
 * benodigde velden over en maakt objecten alleen voor voertuigposities. Dit
 * behoudt dezelfde velden die OVLive nodig heeft voor exacte ritidentiteit,
 * coördinaten en actualiteitscontrole.
 */

export interface DecodedOpenovVehiclePosition {
  entityId?: string;
  vehicleId?: string;
  tripId?: string;
  routeId?: string;
  startDate?: string;
  startTime?: string;
  directionId?: number;
  stopId?: string;
  latitude?: number;
  longitude?: number;
  timestamp?: number;
}

export interface DecodedOpenovVehicleFeed {
  feedTimestamp?: number;
  /** Number of VehiclePosition messages seen, before optional trip filtering. */
  sourceEntityCount: number;
  entities: DecodedOpenovVehiclePosition[];
  /** Present for bounded scans; true means later feed entities were intentionally skipped. */
  truncated?: boolean;
  /** Present for bounded scans; counts FeedMessage.entity records inspected. */
  scannedEntityCount?: number;
}

export interface OpenovVehiclePositionFilters {
  /** Normalized GTFS trip IDs; "nl-OpenOV_" prefixes are not required. */
  tripIds?: ReadonlySet<string>;
  /** Normalized GTFS route IDs; "nl-OpenOV_" prefixes are not required. */
  routeIds?: ReadonlySet<string>;
  /** Stop once this many matching vehicles have been materialized. */
  maxResults?: number;
  /** Hard CPU guard: stop after inspecting this many FeedMessage.entity records. */
  maxScannedEntities?: number;
  /** Optional geographic window; out-of-window positions are skipped before trip/vehicle details are decoded. */
  bounds?: {
    minLatitude: number;
    maxLatitude: number;
    minLongitude: number;
    maxLongitude: number;
  };
}

function normalizedFilterId(value: unknown): string {
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").trim();
}

function matchesVehiclePositionFilters(
  trip: { tripId?: string; routeId?: string } | undefined,
  filters?: OpenovVehiclePositionFilters
): boolean {
  if (!filters) return true;
  const tripIds = filters.tripIds;
  const routeIds = filters.routeIds;
  const tripId = normalizedFilterId(trip?.tripId);
  const routeId = normalizedFilterId(trip?.routeId);

  if (tripIds && tripIds.size > 0 && !tripIds.has(tripId)) return false;
  if (routeIds && routeIds.size > 0 && !routeIds.has(routeId)) return false;
  return true;
}

// Fast reject using only fields needed by the filter. OpenOV usually serializes
// tripId first in TripDescriptor; when it is not the requested trip, we can skip
// the rest of this descriptor without decoding route/date/start-time strings.
function matchesVehiclePositionDescriptor(
  bytes: Uint8Array,
  start: number,
  end: number,
  filters?: OpenovVehiclePositionFilters
): boolean {
  const tripIds = filters?.tripIds;
  const routeIds = filters?.routeIds;
  const hasTripFilter = Boolean(tripIds?.size);
  const hasRouteFilter = Boolean(routeIds?.size);
  if (!hasTripFilter && !hasRouteFilter) return true;

  let tripMatched = !hasTripFilter;
  let routeMatched = !hasRouteFilter;
  for (let offset = start; offset < end;) {
    const field = readField(bytes, offset, end);
    if (field.number === 1 && field.wireType === 2 && hasTripFilter) {
      tripMatched = tripIds!.has(normalizedFilterId(readString(bytes, field)));
      if (!tripMatched) return false;
      if (routeMatched) return true;
    } else if (field.number === 5 && field.wireType === 2 && hasRouteFilter) {
      routeMatched = routeIds!.has(normalizedFilterId(readString(bytes, field)));
      if (!routeMatched) return false;
      if (tripMatched) return true;
    }
    offset = field.nextOffset;
  }

  return tripMatched && routeMatched;
}

interface VarintResult {
  value: number;
  nextOffset: number;
}

interface Field {
  number: number;
  wireType: number;
  value?: number;
  contentStart: number;
  contentEnd: number;
  nextOffset: number;
}

const textDecoder = new TextDecoder();

function readVarint(bytes: Uint8Array, startOffset: number, limit: number): VarintResult {
  let value = 0;
  let offset = startOffset;

  for (let index = 0; index < 10; index += 1) {
    if (offset >= limit) throw new Error("GTFS-Realtime protobuf bevat een afgebroken varint.");
    const byte = bytes[offset];
    offset += 1;
    const payload = byte & 0x7f;

    // GTFS timestamps and protobuf tags are within JavaScript's exact integer
    // range. Reject malformed uint64 values rather than silently rounding them.
    if (index === 9 && payload > 1) {
      throw new Error("GTFS-Realtime protobuf bevat een varint buiten het veilige bereik.");
    }
    value += payload * (2 ** (index * 7));

    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("GTFS-Realtime protobuf bevat een niet-exact geheel getal.");
      }
      return { value, nextOffset: offset };
    }
  }

  throw new Error("GTFS-Realtime protobuf bevat een varint die langer is dan 10 bytes.");
}

function readField(bytes: Uint8Array, offset: number, limit: number): Field {
  const tag = readVarint(bytes, offset, limit);
  const number = Math.floor(tag.value / 8);
  const wireType = tag.value & 7;

  if (number <= 0) throw new Error("GTFS-Realtime protobuf bevat veldnummer 0.");

  let contentStart = tag.nextOffset;
  let contentEnd: number;
  let nextOffset: number;
  let value: number | undefined;

  switch (wireType) {
    case 0: {
      const parsed = readVarint(bytes, tag.nextOffset, limit);
      value = parsed.value;
      contentEnd = parsed.nextOffset;
      nextOffset = parsed.nextOffset;
      break;
    }
    case 1:
      contentEnd = tag.nextOffset + 8;
      nextOffset = contentEnd;
      break;
    case 2: {
      const length = readVarint(bytes, tag.nextOffset, limit);
      if (!Number.isSafeInteger(length.value) || length.value < 0 ||
          length.value > limit - length.nextOffset) {
        throw new Error("GTFS-Realtime protobuf bevat een ongeldige veldlengte.");
      }
      contentStart = length.nextOffset;
      contentEnd = contentStart + length.value;
      nextOffset = contentEnd;
      break;
    }
    case 5:
      contentEnd = tag.nextOffset + 4;
      nextOffset = contentEnd;
      break;
    default:
      // Protocol Buffers groups are not used by the GTFS-Realtime schema.
      // The generated decoder fallback in index.ts handles future extensions.
      throw new Error("Niet-ondersteund protobuf wire-type " + wireType + ".");
  }

  if (contentEnd > limit || nextOffset > limit) {
    throw new Error("GTFS-Realtime protobuf loopt voorbij het einde van een bericht.");
  }

  return { number, wireType, value, contentStart, contentEnd, nextOffset };
}

function readString(bytes: Uint8Array, field: Field): string {
  return textDecoder.decode(bytes.subarray(field.contentStart, field.contentEnd));
}

function readFloat32(bytes: Uint8Array, field: Field): number {
  if (field.wireType !== 5 || field.contentEnd - field.contentStart !== 4) {
    throw new Error("GTFS-Realtime protobuf bevat een ongeldige float32-positie.");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + field.contentStart,
    4
  ).getFloat32(0, true);
}

function decodeHeaderTimestamp(
  bytes: Uint8Array,
  start: number,
  end: number
): number {
  // protobufjs exposes proto3 scalar defaults when the submessage exists.
  let timestamp = 0;
  let offset = start;
  while (offset < end) {
    const field = readField(bytes, offset, end);
    // FeedHeader.timestamp = field 3, uint64 / wire type 0.
    // Field 2 is incrementality, not the feed timestamp.
    if (field.number === 3 && field.wireType === 0) timestamp = field.value ?? 0;
    offset = field.nextOffset;
  }
  return timestamp;
}

function decodeTripDescriptor(
  bytes: Uint8Array,
  start: number,
  end: number
): { tripId?: string; startTime?: string; startDate?: string; routeId?: string; directionId?: number } {
  // Preserve protobufjs defaults for fields omitted from an existing TripDescriptor.
  const trip: { tripId?: string; startTime?: string; startDate?: string; routeId?: string; directionId?: number } = {
    tripId: "",
    startTime: "",
    startDate: "",
    routeId: "",
    directionId: 0
  };
  let offset = start;

  while (offset < end) {
    const field = readField(bytes, offset, end);
    if (field.wireType === 2) {
      if (field.number === 1) trip.tripId = readString(bytes, field);
      else if (field.number === 2) trip.startTime = readString(bytes, field);
      else if (field.number === 3) trip.startDate = readString(bytes, field);
      else if (field.number === 5) trip.routeId = readString(bytes, field);
    } else if (field.number === 6 && field.wireType === 0) {
      trip.directionId = field.value;
    }
    offset = field.nextOffset;
  }

  return trip;
}

function decodePosition(
  bytes: Uint8Array,
  start: number,
  end: number
): { latitude?: number; longitude?: number } {
  // Position.latitude and Position.longitude default to 0 when omitted.
  const position: { latitude?: number; longitude?: number } = { latitude: 0, longitude: 0 };
  let offset = start;

  while (offset < end) {
    const field = readField(bytes, offset, end);
    if (field.number === 1 && field.wireType === 5) position.latitude = readFloat32(bytes, field);
    else if (field.number === 2 && field.wireType === 5) position.longitude = readFloat32(bytes, field);
    offset = field.nextOffset;
  }

  return position;
}

function decodeVehicleDescriptor(
  bytes: Uint8Array,
  start: number,
  end: number
): { vehicleId?: string } {
  // VehicleDescriptor.id defaults to the empty string when omitted.
  let vehicleId = "";
  let offset = start;

  while (offset < end) {
    const field = readField(bytes, offset, end);
    // VehicleDescriptor.id = field 1, string.
    if (field.number === 1 && field.wireType === 2) vehicleId = readString(bytes, field);
    offset = field.nextOffset;
  }

  return { vehicleId };
}

function decodeVehiclePosition(
  bytes: Uint8Array,
  start: number,
  end: number,
  filters?: OpenovVehiclePositionFilters
): Omit<DecodedOpenovVehiclePosition, "entityId"> | null {
  let tripField: Field | undefined;
  let positionField: Field | undefined;
  let position: { latitude?: number; longitude?: number } | undefined;
  let stopIdField: Field | undefined;
  let vehicleField: Field | undefined;
  // VehiclePosition scalar/string defaults are 0 and "" in protobufjs.
  let timestamp = 0;
  let offset = start;

  // Keep descriptor boundaries rather than decoding strings immediately. On a
  // map request, reject out-of-area coordinates before doing the more expensive
  // trip/vehicle string decoding, and stop a bounded scan without reading the
  // rest of a large national feed.
  while (offset < end) {
    const field = readField(bytes, offset, end);
    if (field.wireType === 2) {
      if (field.number === 1) {
        if (!matchesVehiclePositionDescriptor(
          bytes,
          field.contentStart,
          field.contentEnd,
          filters
        )) return null;
        tripField = field;
      } else if (field.number === 2) {
        positionField = field;
        const bounds = filters?.bounds;
        // Decode only four coordinate bytes before rejecting an out-of-window
        // vehicle. In ordinary exact-trip lookups defer position decoding until
        // after the trip descriptor has passed its filters.
        if (bounds) {
          position = decodePosition(bytes, field.contentStart, field.contentEnd);
          if (
            !Number.isFinite(position.latitude) ||
            !Number.isFinite(position.longitude) ||
            Number(position.latitude) < bounds.minLatitude ||
            Number(position.latitude) > bounds.maxLatitude ||
            Number(position.longitude) < bounds.minLongitude ||
            Number(position.longitude) > bounds.maxLongitude
          ) return null;
        }
      } else if (field.number === 7) stopIdField = field;
      else if (field.number === 8) vehicleField = field;
    } else if (field.number === 5 && field.wireType === 0) {
      // VehiclePosition.timestamp = field 5, uint64 epoch seconds.
      timestamp = field.value ?? 0;
    }
    offset = field.nextOffset;
  }

  if (filters?.bounds && !position) return null;
  const trip = tripField
    ? decodeTripDescriptor(bytes, tripField.contentStart, tripField.contentEnd)
    : undefined;
  if (!matchesVehiclePositionFilters(trip, filters)) return null;

  if (!position && positionField) {
    position = decodePosition(bytes, positionField.contentStart, positionField.contentEnd);
  }
  const vehicle = vehicleField
    ? decodeVehicleDescriptor(bytes, vehicleField.contentStart, vehicleField.contentEnd)
    : undefined;
  const stopId = stopIdField ? readString(bytes, stopIdField) : "";

  return {
    vehicleId: vehicle?.vehicleId,
    tripId: trip?.tripId,
    routeId: trip?.routeId,
    startDate: trip?.startDate,
    startTime: trip?.startTime,
    directionId: trip?.directionId,
    stopId,
    latitude: position?.latitude,
    longitude: position?.longitude,
    timestamp
  };
}

function decodeFeedEntity(
  bytes: Uint8Array,
  start: number,
  end: number,
  filters?: OpenovVehiclePositionFilters
): { isVehiclePosition: boolean; entity: DecodedOpenovVehiclePosition | null } {
  let entityIdField: Field | undefined;
  let vehiclePosition: Omit<DecodedOpenovVehiclePosition, "entityId"> | null | undefined;
  let isVehiclePosition = false;
  let offset = start;

  while (offset < end) {
    const field = readField(bytes, offset, end);
    if (field.number === 1 && field.wireType === 2) {
      entityIdField = field;
    } else if (field.number === 4 && field.wireType === 2) {
      // FeedEntity.vehicle = field 4. Trip updates, alerts and other entity
      // variants are skipped without constructing their object graphs.
      isVehiclePosition = true;
      vehiclePosition = decodeVehiclePosition(bytes, field.contentStart, field.contentEnd, filters);
    }
    offset = field.nextOffset;
  }

  if (!isVehiclePosition || !vehiclePosition) {
    return { isVehiclePosition, entity: null };
  }
  const entityId = entityIdField ? readString(bytes, entityIdField) : undefined;
  return { isVehiclePosition: true, entity: { entityId, ...vehiclePosition } };
}

export function decodeOpenovVehiclePositions(
  bytes: Uint8Array,
  filters?: OpenovVehiclePositionFilters
): DecodedOpenovVehicleFeed {
  let feedTimestamp: number | undefined;
  let sourceEntityCount = 0;
  let scannedEntityCount = 0;
  let truncated = false;
  const entities: DecodedOpenovVehiclePosition[] = [];
  const maxResults = Number.isInteger(filters?.maxResults) && Number(filters?.maxResults) > 0
    ? Number(filters?.maxResults)
    : undefined;
  const maxScannedEntities = Number.isInteger(filters?.maxScannedEntities) &&
      Number(filters?.maxScannedEntities) > 0
    ? Number(filters?.maxScannedEntities)
    : undefined;
  let offset = 0;

  while (offset < bytes.byteLength) {
    const field = readField(bytes, offset, bytes.byteLength);

    if (field.number === 1 && field.wireType === 2) {
      feedTimestamp = decodeHeaderTimestamp(bytes, field.contentStart, field.contentEnd);
    } else if (field.number === 2 && field.wireType === 2) {
      // Never scan the full national feed when the caller requests a bounded
      // preview. maxScannedEntities is an explicit CPU guard, not a feed count.
      if (maxScannedEntities !== undefined && scannedEntityCount >= maxScannedEntities) {
        truncated = true;
        break;
      }
      scannedEntityCount += 1;
      const decoded = decodeFeedEntity(bytes, field.contentStart, field.contentEnd, filters);
      if (decoded.isVehiclePosition) sourceEntityCount += 1;
      const entity = decoded.entity;
      if (entity && (entity.vehicleId || entity.tripId || entity.latitude != null)) {
        entities.push(entity);
        if (maxResults !== undefined && entities.length >= maxResults) {
          truncated = field.nextOffset < bytes.byteLength;
          offset = field.nextOffset;
          break;
        }
      }
    }

    offset = field.nextOffset;
  }

  if (maxResults !== undefined || maxScannedEntities !== undefined) {
    return {
      feedTimestamp,
      sourceEntityCount,
      entities,
      truncated,
      scannedEntityCount
    };
  }
  return { feedTimestamp, sourceEntityCount, entities };
}
