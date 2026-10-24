export function openovTripShapeIdCandidates(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 256) return [];

  const candidates = [];
  const appendCandidate = (candidate) => {
    const cleaned = String(candidate ?? "").trim();
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  };
  const withoutLeadingNamespace = raw.replace(/^nl-OpenOV_/i, "");

  appendCandidate(raw);
  appendCandidate(withoutLeadingNamespace);

  // A GTFS-RT vehicle can expose HH:mm:00, but Transitous trip IDs often use
  // HH:mm. Keep the service date and base trip ID exact; only remove seconds
  // when they are explicitly zero. Never infer a trip from a route/line name.
  const wrappedTrip = withoutLeadingNamespace.match(
    /^(\d{8})_(\d{1,2}:\d{2}(?::\d{2})?)_(.+)$/i
  );
  if (wrappedTrip) {
    const [, serviceDate, rawTime, rawBaseTripId] = wrappedTrip;
    const baseTripId = rawBaseTripId.replace(/^nl-OpenOV_/i, "");
    if (baseTripId) {
      const serviceTimes = [rawTime];
      const zeroSeconds = rawTime.match(/^(\d{1,2}:\d{2}):00$/);
      if (zeroSeconds && !serviceTimes.includes(zeroSeconds[1])) {
        serviceTimes.push(zeroSeconds[1]);
      }

      for (const serviceTime of serviceTimes) {
        appendCandidate(serviceDate + "_" + serviceTime + "_nl-OpenOV_" + baseTripId);
        appendCandidate(serviceDate + "_" + serviceTime + "_" + baseTripId);
      }
    }
  } else if (withoutLeadingNamespace === raw) {
    appendCandidate("nl-OpenOV_" + raw);
  }

  return candidates.slice(0, 6);
}
