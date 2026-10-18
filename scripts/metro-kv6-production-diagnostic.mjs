import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("OVLIVE_BASE_URL is required.");

async function getJson(url, timeoutMs = 65000) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    json,
    textStart: text.slice(0, 180),
  };
}

function transitLegs(plan) {
  const itineraries = Array.isArray(plan?.itineraries) ? plan.itineraries
    : Array.isArray(plan?.journeys) ? plan.journeys : [];
  return itineraries.flatMap((itinerary, itineraryIndex) =>
    (Array.isArray(itinerary?.legs) ? itinerary.legs : [])
      .filter((leg) => !["WALK", "TRANSFER"].includes(String(leg?.mode ?? "").toUpperCase()))
      .map((leg, legIndex) => ({
        itineraryIndex: itineraryIndex + 1,
        legIndex: legIndex + 1,
        mode: leg.mode ?? null,
        routeId: leg.routeId ?? leg.route?.id ?? null,
        route: leg.routeShortName ?? leg.route?.shortName ?? leg.routeLongName ?? leg.route?.longName ?? null,
        tripId: leg.tripId ?? leg.trip?.id ?? null,
        from: {
          name: leg.from?.name ?? null,
          stopId: leg.from?.stopId ?? leg.from?.id ?? leg.from?.stop?.id ?? null,
          departure: leg.from?.departure ?? null,
        },
        to: {
          name: leg.to?.name ?? null,
          stopId: leg.to?.stopId ?? leg.to?.id ?? leg.to?.stop?.id ?? null,
          arrival: leg.to?.arrival ?? null,
        },
        openovRealtime: leg.openovRealtime ? {
          status: leg.openovRealtime.status ?? null,
          tripId: leg.openovRealtime.tripId ?? null,
          updateTimestamp: leg.openovRealtime.updateTimestamp ?? null,
          reason: leg.openovRealtime.reason ?? null,
          departureStopMatchMethod: leg.openovRealtime.departureStopMatchMethod ?? null,
          arrivalStopMatchMethod: leg.openovRealtime.arrivalStopMatchMethod ?? null,
        } : null,
        ndovRealtime: leg.ndovRealtime ? {
          status: leg.ndovRealtime.status ?? null,
          identity: leg.ndovRealtime.identity ?? leg.ndovRealtime.kv6?.identity ?? null,
          eventType: leg.ndovRealtime.eventType ?? leg.ndovRealtime.kv6?.eventType ?? null,
          punctualitySeconds: leg.ndovRealtime.punctualitySeconds ?? leg.ndovRealtime.kv6?.punctualitySeconds ?? null,
          kv78: leg.ndovRealtime.kv78 ? {
            departureStopCode: leg.ndovRealtime.kv78.departure?.userStopCode ?? null,
            arrivalStopCode: leg.ndovRealtime.kv78.arrival?.userStopCode ?? null,
            departureAssignment: leg.ndovRealtime.kv78.departure?.stopAssignmentStatus ?? null,
            arrivalAssignment: leg.ndovRealtime.kv78.arrival?.stopAssignmentStatus ?? null,
          } : null,
        } : null,
      }))
  );
}

function compactComparisons(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  return {
    available: diagnostics.available ?? null,
    currentDate: diagnostics.currentDate ?? null,
    storedRecordCount: diagnostics.storedRecordCount ?? null,
    currentDateRecordCount: diagnostics.currentDateRecordCount ?? null,
    byOwnerLine: diagnostics.byOwnerLine ?? [],
    byLine: diagnostics.byLine ?? [],
    requestedIdentities: diagnostics.requestedIdentities ?? [],
    comparisons: (Array.isArray(diagnostics.comparisons) ? diagnostics.comparisons : []).map((item) => ({
      requestedIdentity: item.requestedIdentity ?? null,
      exactIdentityInReturnedSample: item.exactIdentityInReturnedSample ?? null,
      sameOwnerDateSampleCount: item.sameOwnerDateSampleCount ?? null,
      sameOwnerDateLineSamples: item.sameOwnerDateLineSamples ?? [],
      sameOwnerDateJourneySamples: item.sameOwnerDateJourneySamples ?? [],
      sameOwnerDateOtherSamples: item.sameOwnerDateOtherSamples ?? [],
    })),
  };
}

async function main() {
  const baseDiagnostics = {
    check: "production-metro-kv6-diagnostic",
    baseUrl,
    purpose: "Read-only production check. Exact trip matching is not relaxed and no collector setting or feed state is changed.",
  };

  // These coordinates are the station areas. Restrict transit modes to metro/subway
  // so the diagnostic identities represent GVB metro trips, not nearby buses/trams.
  const fromPlace = process.env.OVLIVE_FROM_PLACE ?? "52.3780,4.9003";
  const toPlace = process.env.OVLIVE_TO_PLACE ?? "52.3382,4.8729";
  const planUrl = new URL("/api/plan", baseUrl);
  planUrl.searchParams.set("fromPlace", fromPlace);
  planUrl.searchParams.set("toPlace", toPlace);
  planUrl.searchParams.set("time", new Date(Date.now() + 120_000).toISOString());
  planUrl.searchParams.set("transitModes", "METRO,SUBWAY");
  planUrl.searchParams.set("maxPreTransitTime", "900");
  planUrl.searchParams.set("maxPostTransitTime", "900");
  planUrl.searchParams.set("pedestrianSpeed", "1.5");
  planUrl.searchParams.set("numItineraries", "5");
  planUrl.searchParams.set("maxItineraries", "5");
  planUrl.searchParams.set("ndovIdentityDiagnostics", "1");

  const result = await getJson(planUrl);
  if (!result.ok || !result.json || !Array.isArray(result.json.itineraries)) {
    console.log(JSON.stringify({
      ...baseDiagnostics,
      httpStatus: result.status,
      contentType: result.contentType,
      responseStart: result.textStart,
      error: "Production metro /api/plan call did not return a valid itinerary response.",
    }, null, 2));
    throw new Error("Production metro API diagnostic failed.");
  }

  const plan = result.json;
  const legs = transitLegs(plan);
  const meta = plan.ndovRealtimeMeta ?? {};
  const kv6Lookup = meta.kv6LookupDiagnostics ?? null;
  const kv6IdentityDiagnostics = compactComparisons(meta.kv6IdentityDiagnostics);
  const kv78IdentityDiagnostics = compactComparisons(meta.kv78IdentityDiagnostics);
  const gvbLineTrips = (kv6IdentityDiagnostics?.byOwnerLine ?? [])
    .filter((item) => String(item.owner ?? "").toUpperCase() === "GVB" ||
      String(item.line ?? "").toUpperCase().includes("52"));

  console.log(JSON.stringify({
    ...baseDiagnostics,
    httpStatus: result.status,
    requestedFrom: fromPlace,
    requestedTo: toPlace,
    itineraryCount: plan.itineraries.length,
    transitLegCount: legs.length,
    transitLegs: legs,
    kv6Lookup: kv6Lookup ? {
      lookupCompleted: kv6Lookup.lookupCompleted ?? null,
      requestedIdentityCount: kv6Lookup.requestedIdentityCount ?? null,
      returnedExactEventCount: kv6Lookup.returnedExactEventCount ?? null,
      freshExactMatchCount: kv6Lookup.freshExactMatchCount ?? null,
      unmatchedIdentityCount: kv6Lookup.unmatchedIdentityCount ?? null,
      unmatchedIdentitySamples: kv6Lookup.unmatchedIdentitySamples ?? [],
      error: kv6Lookup.error ?? null,
    } : null,
    kv6IdentityDiagnostics,
    kv78IdentityDiagnostics,
    gvbOrLine52StoredTripsToday: gvbLineTrips,
    routeCrosswalkOutcomes: Array.isArray(meta.routeCrosswalkOutcomes)
      ? meta.routeCrosswalkOutcomes.slice(0, 12)
      : [],
    interpretation: {
      requestedExactEventsReturned: kv6Lookup?.returnedExactEventCount ?? null,
      gvbTodayTripSamplesPresent: gvbLineTrips.some((item) =>
        String(item.owner ?? "").toUpperCase() === "GVB" &&
        String(item.line ?? "") === "52" &&
        Number(item.tripCount ?? 0) > 0
      ),
      nextHint: "If GVB|52 trips are absent from the BISON identity diagnostic, investigate BISON source/subscription/collector coverage. If they exist under alternate date/line/journey/reinforcement, inspect the GTFS-NL crosswalk. Do not infer a match from nearby identities.",
    },
  }, null, 2));

  if (!legs.length) {
    throw new Error("Production plan returned no transit legs; diagnostic route did not produce any OV leg.");
  }
  console.log("PASS: read-only production metro/KV6 identity diagnostic completed.");
}

await main();
