export function openovTripShapeIdCandidates(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 256) return [];

  // Transitous/MOTIS expects the service-instance wrapper
  // YYYYMMDD_HH:mm[_:ss]_nl-OpenOV_<GTFS trip ID>.
  // An unwrapped "nl-OpenOV_<id>" is not a valid /trip identifier and can
  // mask the more useful response from the canonical request.
  const withoutOuterNamespace = raw.replace(/^nl-OpenOV_/i, "");
  const wrappedTrip = withoutOuterNamespace.match(
    /^(\d{8})_(\d{1,2}:\d{2}(?::\d{2})?)_(?:nl-OpenOV_)?(.+)$/i
  );
  if (!wrappedTrip) return [];

  const [, serviceDate, rawTime, rawBaseTripId] = wrappedTrip;
  const baseTripId = String(rawBaseTripId ?? "").replace(/^nl-OpenOV_/i, "").trim();
  if (!baseTripId) return [];

  const hourMinuteSecond = rawTime.split(":");
  const hour = String(Number(hourMinuteSecond[0])).padStart(2, "0");
  const minute = hourMinuteSecond[1];
  const second = hourMinuteSecond[2];
  const canonicalTime = hour + ":" + minute +
    (second === undefined ? "" : ":" + second);
  const serviceTimes = [canonicalTime];

  // OpenOV and Transitous sometimes differ only by a zero-seconds suffix.
  // Keep the service date and the exact base GTFS trip ID; never try a line ID,
  // a bare numeric ID, or an unwrapped trip ID.
  if (second === "00") {
    serviceTimes.push(hour + ":" + minute);
  } else if (second === undefined) {
    serviceTimes.push(hour + ":" + minute + ":00");
  }

  return [...new Set(serviceTimes)]
    .map(serviceTime => serviceDate + "_" + serviceTime + "_nl-OpenOV_" + baseTripId)
    .slice(0, 2);
}
