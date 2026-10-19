/**
 * CPU-bewuste GTFS-Realtime-decoder voor ritupdates.
 *
 * Bij een planner-refresh hoeven alleen TripUpdates voor de geselecteerde
 * OpenOV-route/dienstdata te worden gematerialiseerd. De decoder loopt door de
 * protobuf-stream, maar bouwt geen volledige objectgrafiek van alle 7k+ ritten.
 * Bij een route/datumfilter worden stopdetails pas na de ritfilter gedecodeerd.
 */

export interface DecodedOpenovTripUpdateStop {
  stopId?: string;
  stopSequence?: number;
  arrivalTime?: number;
  arrivalDelaySeconds?: number;
  departureTime?: number;
  departureDelaySeconds?: number;
  scheduleRelationship?: string;
  effectiveArrivalDelaySeconds?: number;
  effectiveDepartureDelaySeconds?: number;
}

export interface DecodedOpenovTripUpdate {
  entityId?: string;
  tripId?: string;
  routeId?: string;
  startDate?: string;
  startTime?: string;
  directionId?: number;
  scheduleRelationship?: string;
  delaySeconds?: number;
  vehicleId?: string;
  timestamp?: number;
  stopUpdates: DecodedOpenovTripUpdateStop[];
}

export interface OpenovTripUpdateFilters {
  tripIds?: ReadonlySet<string>;
  routeIds?: ReadonlySet<string>;
  /** Normalized routeId|YYYYMMDD keys for route/time fallback matching. */
  routeDateKeys?: ReadonlySet<string>;
}

export interface DecodedOpenovTripUpdateFeed {
  feedTimestamp?: number;
  sourceEntityCount: number;
  entities: DecodedOpenovTripUpdate[];
}

interface Field {
  number: number;
  wireType: number;
  value?: number | bigint;
  contentStart: number;
  contentEnd: number;
  nextOffset: number;
}

interface VarintResult {
  value: number | bigint;
  nextOffset: number;
}

function readVarintBigInt(bytes: Uint8Array, startOffset: number, limit: number): VarintResult {
  let value = 0n;
  let offset = startOffset;
  for (let index = 0; index < 10; index += 1) {
    if (offset >= limit) throw new Error("GTFS-Realtime protobuf bevat een afgebroken varint.");
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, nextOffset: offset };
  }
  throw new Error("GTFS-Realtime protobuf bevat een varint die langer is dan 10 bytes.");
}

function readVarint(bytes: Uint8Array, startOffset: number, limit: number): VarintResult {
  // Most protobuf tags, lengths and ordinary timestamps fit in at most seven
  // bytes. Use Number arithmetic on that hot path; reserve BigInt for 64-bit
  // values, including the ten-byte encoding of negative int32 delays.
  let value = 0;
  let offset = startOffset;
  for (let index = 0; index < 7; index += 1) {
    if (offset >= limit) throw new Error("GTFS-Realtime protobuf bevat een afgebroken varint.");
    const byte = bytes[offset++];
    value += (byte & 0x7f) * (2 ** (index * 7));
    if ((byte & 0x80) === 0) return { value, nextOffset: offset };
  }
  return readVarintBigInt(bytes, startOffset, limit);
}

function asSafeNumber(value: number | bigint, description: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error("GTFS-Realtime protobuf bevat een " + description + " buiten het veilige bereik.");
  }
  return result;
}

function readField(bytes: Uint8Array, offset: number, limit: number): Field {
  const tagResult = readVarint(bytes, offset, limit);
  const tag = asSafeNumber(tagResult.value, "protobuf-tag");
  const number = Math.floor(tag / 8);
  const wireType = tag & 7;
  if (number <= 0) throw new Error("GTFS-Realtime protobuf bevat veldnummer 0.");

  let contentStart = tagResult.nextOffset;
  let contentEnd: number;
  let nextOffset: number;
  let value: number | bigint | undefined;

  switch (wireType) {
    case 0: {
      const parsed = readVarint(bytes, tagResult.nextOffset, limit);
      value = typeof parsed.value === "number"
        ? parsed.value
        : parsed.value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(parsed.value)
          : parsed.value;
      contentEnd = parsed.nextOffset;
      nextOffset = parsed.nextOffset;
      break;
    }
    case 1:
      contentEnd = tagResult.nextOffset + 8;
      nextOffset = contentEnd;
      break;
    case 2: {
      const length = readVarint(bytes, tagResult.nextOffset, limit);
      const lengthNumber = asSafeNumber(length.value, "veld-lengte");
      if (lengthNumber < 0 || lengthNumber > limit - length.nextOffset) {
        throw new Error("GTFS-Realtime protobuf bevat een ongeldige veldlengte.");
      }
      contentStart = length.nextOffset;
      contentEnd = contentStart + lengthNumber;
      nextOffset = contentEnd;
      break;
    }
    case 5:
      contentEnd = tagResult.nextOffset + 4;
      nextOffset = contentEnd;
      break;
    default: {
      const sample = Array.from(bytes.subarray(offset, Math.min(offset + 8, limit)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ");
      throw new Error(
        "Niet-ondersteund protobuf wire-type " + wireType +
        " (tag " + tag + ", offset " + offset + ", limit " + limit +
        ", bytes " + sample + ")."
      );
    }
  }

  if (contentEnd > limit || nextOffset > limit) {
    throw new Error("GTFS-Realtime protobuf loopt voorbij het einde van een bericht.");
  }
  return { number, wireType, value, contentStart, contentEnd, nextOffset };
}

function numeric(value: number | bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const result = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(result) || Number.isFinite(result) ? result : undefined;
}

function readInt32(field: Field): number | undefined {
  if (field.value === undefined) return undefined;
  if (typeof field.value === "number") return field.value | 0;
  return Number(BigInt.asIntN(32, field.value));
}

const textDecoder = new TextDecoder();

function readString(bytes: Uint8Array, field: Field): string {
  return textDecoder.decode(bytes.subarray(field.contentStart, field.contentEnd));
}

function normalizeId(value: unknown): string {
  return String(value ?? "").replace(/^nl-OpenOV_/i, "").trim();
}

function normalizeDate(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "").slice(0, 8);
}

function tripScheduleRelationship(value: number): string | undefined {
  return ({
    0: "SCHEDULED",
    1: "ADDED",
    2: "UNSCHEDULED",
    3: "CANCELED",
    5: "REPLACEMENT",
    6: "DUPLICATED",
    7: "DELETED",
    8: "NEW"
  } as Record<number, string>)[value];
}

function stopScheduleRelationship(value: number): string | undefined {
  return ({
    0: "SCHEDULED",
    1: "SKIPPED",
    2: "NO_DATA",
    3: "UNSCHEDULED"
  } as Record<number, string>)[value];
}

function decodeHeaderTimestamp(bytes: Uint8Array, start: number, end: number): number {
  let timestamp = 0;
  for (let offset = start; offset < end;) {
    const field = readField(bytes, offset, end);
    if (field.number === 3 && field.wireType === 0) {
      timestamp = numeric(field.value) ?? 0;
    }
    offset = field.nextOffset;
  }
  return timestamp;
}

type TripDescriptor = {
  tripId: string;
  startTime: string;
  startDate: string;
  routeId: string;
  directionId: number;
  scheduleRelationship: number;
};

function decodeTripDescriptor(bytes: Uint8Array, start: number, end: number): TripDescriptor {
  const trip: TripDescriptor = {
    tripId: "",
    startTime: "",
    startDate: "",
    routeId: "",
    directionId: 0,
    scheduleRelationship: 0
  };
  for (let offset = start; offset < end;) {
    const field = readField(bytes, offset, end);
    if (field.wireType === 2) {
      if (field.number === 1) trip.tripId = readString(bytes, field);
      else if (field.number === 2) trip.startTime = readString(bytes, field);
      else if (field.number === 3) trip.startDate = readString(bytes, field);
      else if (field.number === 5) trip.routeId = readString(bytes, field);
    } else if (field.wireType === 0 && field.number === 6) {
      trip.directionId = numeric(field.value) ?? 0;
    } else if (field.wireType === 0 && field.number === 4) {
      trip.scheduleRelationship = numeric(field.value) ?? 0;
    }
    offset = field.nextOffset;
  }
  return trip;
}

function decodeVehicleDescriptor(bytes: Uint8Array, start: number, end: number): string {
  let vehicleId = "";
  for (let offset = start; offset < end;) {
    const field = readField(bytes, offset, end);
    if (field.number === 1 && field.wireType === 2) vehicleId = readString(bytes, field);
    offset = field.nextOffset;
  }
  return vehicleId;
}

function decodeStopTimeEvent(bytes: Uint8Array, start: number, end: number): {
  time: number;
  delay: number;
} {
  let time = 0;
  let delay = 0;
  for (let offset = start; offset < end;) {
    const field = readField(bytes, offset, end);
    if (field.number === 1 && field.wireType === 0) delay = readInt32(field) ?? 0;
    else if (field.number === 2 && field.wireType === 0) time = numeric(field.value) ?? 0;
    offset = field.nextOffset;
  }
  return { time, delay };
}

function decodeStopTimeUpdate(bytes: Uint8Array, field: Field): DecodedOpenovTripUpdateStop {
  let stopId = "";
  let stopSequence = 0;
  let scheduleRelationship = 0;
  let arrivalField: Field | undefined;
  let departureField: Field | undefined;
  for (let offset = field.contentStart; offset < field.contentEnd;) {
    const item = readField(bytes, offset, field.contentEnd);
    if (item.number === 1 && item.wireType === 0) stopSequence = numeric(item.value) ?? 0;
    else if (item.number === 2 && item.wireType === 2) stopId = readString(bytes, item);
    else if (item.number === 3 && item.wireType === 2) arrivalField = item;
    else if (item.number === 4 && item.wireType === 2) departureField = item;
    else if (item.number === 5 && item.wireType === 0) scheduleRelationship = numeric(item.value) ?? 0;
    offset = item.nextOffset;
  }
  const arrival = arrivalField
    ? decodeStopTimeEvent(bytes, arrivalField.contentStart, arrivalField.contentEnd)
    : undefined;
  const departure = departureField
    ? decodeStopTimeEvent(bytes, departureField.contentStart, departureField.contentEnd)
    : undefined;
  return {
    stopId,
    stopSequence,
    arrivalTime: arrival?.time,
    arrivalDelaySeconds: arrival?.delay,
    departureTime: departure?.time,
    departureDelaySeconds: departure?.delay,
    scheduleRelationship: stopScheduleRelationship(scheduleRelationship)
  };
}

function matchesFilters(trip: TripDescriptor, filters?: OpenovTripUpdateFilters): boolean {
  if (!filters || (
    !(filters.tripIds?.size) &&
    !(filters.routeIds?.size) &&
    !(filters.routeDateKeys?.size)
  )) return true;

  const tripId = normalizeId(trip.tripId);
  const routeId = normalizeId(trip.routeId);
  const date = normalizeDate(trip.startDate);
  if (filters.tripIds?.has(tripId)) return true;
  if (filters.routeIds?.has(routeId)) return true;
  if (routeId && date && filters.routeDateKeys?.has(routeId + "|" + date)) return true;
  return false;
}

type RawTripUpdate = {
  trip?: TripDescriptor;
  vehicleId?: string;
  timestamp: number;
  delay: number;
  stopFields: Field[];
};

function decodeTripUpdate(
  bytes: Uint8Array,
  start: number,
  end: number,
  filters?: OpenovTripUpdateFilters
): RawTripUpdate | null {
  let trip: TripDescriptor | undefined;
  let vehicleId: string | undefined;
  let timestamp = 0;
  let delay = 0;
  const stopFields: Field[] = [];

  // Store stop-message boundaries first; the trip descriptor may appear after
  // them. Decode stop details only after the route/trip has passed the filter.
  for (let offset = start; offset < end;) {
    const field = readField(bytes, offset, end);
    if (field.number === 1 && field.wireType === 2) {
      trip = decodeTripDescriptor(bytes, field.contentStart, field.contentEnd);
      // TripDescriptor is normally first on the wire. When this route/date is
      // irrelevant, skip all remaining stop-time messages without visiting them.
      if (!matchesFilters(trip, filters)) return null;
    } else if (field.number === 2 && field.wireType === 2) {
      stopFields.push(field);
    } else if (field.number === 3 && field.wireType === 2) {
      vehicleId = decodeVehicleDescriptor(bytes, field.contentStart, field.contentEnd);
    } else if (field.number === 4 && field.wireType === 0) {
      timestamp = numeric(field.value) ?? 0;
    } else if (field.number === 5 && field.wireType === 0) {
      delay = readInt32(field) ?? 0;
    }
    offset = field.nextOffset;
  }

  if (!trip || !matchesFilters(trip, filters)) return null;

  return { trip, vehicleId, timestamp, delay, stopFields };
}

function normalizeStops(stops: DecodedOpenovTripUpdateStop[], tripDelay: number): DecodedOpenovTripUpdateStop[] {
  let propagatedDelaySeconds: number | undefined = tripDelay;
  return stops.map((stop) => {
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
}

export function decodeOpenovTripUpdates(
  bytes: Uint8Array,
  filters?: OpenovTripUpdateFilters
): DecodedOpenovTripUpdateFeed {
  let feedTimestamp: number | undefined;
  let sourceEntityCount = 0;
  const entities: DecodedOpenovTripUpdate[] = [];

  for (let offset = 0; offset < bytes.byteLength;) {
    const field = readField(bytes, offset, bytes.byteLength);
    if (field.number === 1 && field.wireType === 2) {
      feedTimestamp = decodeHeaderTimestamp(bytes, field.contentStart, field.contentEnd);
    } else if (field.number === 2 && field.wireType === 2) {
      let entityIdField: Field | undefined;
      let tripUpdateField: Field | undefined;
      for (let entityOffset = field.contentStart; entityOffset < field.contentEnd;) {
        const entityField = readField(bytes, entityOffset, field.contentEnd);
        if (entityField.number === 1 && entityField.wireType === 2) entityIdField = entityField;
        else if (entityField.number === 3 && entityField.wireType === 2) tripUpdateField = entityField;
        entityOffset = entityField.nextOffset;
      }
      if (tripUpdateField) {
        sourceEntityCount += 1;
        const raw = decodeTripUpdate(bytes, tripUpdateField.contentStart, tripUpdateField.contentEnd, filters);
        if (raw?.trip) {
          const entityId = entityIdField ? readString(bytes, entityIdField) : "";
          const stops = raw.stopFields.map((stopField) =>
            decodeStopTimeUpdate(bytes, stopField)
          );
          entities.push({
            entityId,
            tripId: raw.trip.tripId,
            routeId: raw.trip.routeId,
            startDate: raw.trip.startDate,
            startTime: raw.trip.startTime,
            directionId: raw.trip.directionId,
            scheduleRelationship: tripScheduleRelationship(raw.trip.scheduleRelationship),
            delaySeconds: raw.delay,
            vehicleId: raw.vehicleId,
            timestamp: raw.timestamp > 0 ? raw.timestamp : undefined,
            stopUpdates: normalizeStops(stops, raw.delay)
          });
        }
      }
    }
    offset = field.nextOffset;
  }

  return { feedTimestamp, sourceEntityCount, entities };
}
