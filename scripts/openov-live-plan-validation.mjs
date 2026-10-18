import process from "node:process";

const baseUrl = (process.env.OVLIVE_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const fromPlace = process.env.OVLIVE_FROM_PLACE ?? "nl-OpenOV_3924329";
const toPlace = process.env.OVLIVE_TO_PLACE ?? "nl-OpenOV_3924355";

function normalizeId(value) {
  return String(value ?? "").trim().replace(/^nl-OpenOV_/i, "").replace(/^OpenOV_/i, "");
}

function toSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value / 1000;
    if (value > 1e9) return value;
  }
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return milliseconds / 1000;
  }
  return Number.NaN;
}

async function getJson(url, timeoutMs = 65000) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(url.pathname + " gaf geen geldige JSON terug (HTTP " + response.status + ").");
  }
  if (!response.ok) {
    throw new Error(url.pathname + " gaf HTTP " + response.status + ": " +
      String(data?.error ?? body).slice(0, 500));
  }
  return data;
}

function collectLegs(root) {
  const legs = [];
  const seenObjects = new Set();
  const seenLegs = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value.legs)) {
      for (const leg of value.legs) {
        if (leg && typeof leg === "object" && !seenLegs.has(leg)) {
          seenLegs.add(leg);
          legs.push(leg);
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "legs") continue;
      if (child && typeof child === "object") visit(child);
    }
  }

  visit(root);
  return legs;
}

function buildRealtimeRefreshPayload(plan) {
  const payload = JSON.parse(JSON.stringify(plan));
  delete payload.openovRealtimeMeta;
  delete payload.openovAlerts;
  delete payload.nsRealtimeMeta;
  delete payload.ndovRealtimeMeta;
  for (const leg of collectLegs(payload)) {
    const wasNdovCancelled = leg.ndovRealtime?.status === "cancelled";
    delete leg.openovRealtime;
    delete leg.nsRealtime;
    delete leg.ndovRealtime;
    delete leg.ndovRealtimeMatch;
    delete leg.realtimePrediction;
    if (wasNdovCancelled) delete leg.cancelled;
  }
  return payload;
}

function openovLegKeys(root) {
  return collectLegs(root)
    .filter(leg => /^nl-OpenOV_/i.test(String(leg.routeId ?? leg.route?.id ?? "")))
    .map(leg => [
      String(leg.routeId ?? leg.route?.id ?? ""),
      String(leg.tripId ?? leg.trip?.id ?? ""),
      String(leg.from?.stopId ?? leg.from?.id ?? leg.from?.name ?? ""),
      String(leg.to?.stopId ?? leg.to?.id ?? leg.to?.name ?? "")
    ].join("|"))
    .sort();
}

function scheduledValue(leg, kind) {
  return kind === "departure"
    ? leg.from?.scheduledDeparture ?? leg.scheduledStartTime ?? leg.startTime
    : leg.to?.scheduledArrival ?? leg.scheduledEndTime ?? leg.endTime;
}

function predictionOf(leg, kind) {
  return kind === "departure" ? leg.openovRealtime?.departure : leg.openovRealtime?.arrival;
}

function findTargetStopId(leg, kind) {
  const stop = kind === "departure" ? leg.from : leg.to;
  return stop?.stopId ?? stop?.id ?? stop?.stop?.id ?? stop?.stop?.stopId ?? null;
}

async function main() {
  const planUrl = new URL(baseUrl + "/api/plan");
  planUrl.searchParams.set("fromPlace", fromPlace);
  planUrl.searchParams.set("toPlace", toPlace);
  planUrl.searchParams.set("time", new Date(Date.now() + 120_000).toISOString());
  planUrl.searchParams.set("numItineraries", "5");
  planUrl.searchParams.set("maxItineraries", "5");

  console.log("=== LIVE OVLive /api/plan ===");
  console.log("Van: " + fromPlace);
  console.log("Naar: " + toPlace);
  const plan = await getJson(planUrl);
  const legs = collectLegs(plan);
  if (!legs.length) {
    throw new Error("/api/plan gaf geen legs terug. Responsevelden: " + Object.keys(plan ?? {}).join(", "));
  }

  const openovLegs = legs.filter(leg =>
    /^nl-OpenOV_/i.test(String(leg.routeId ?? leg.route?.id ?? ""))
  );
  if (!openovLegs.length) {
    throw new Error("/api/plan gaf " + legs.length +
      " leg(s), maar geen OpenOV-OV-leg. Controleer de stops of Transitous.");
  }

  console.log("=== LIVE realtime-only refresh ===");
  const refreshPayload = buildRealtimeRefreshPayload(plan);
  const refreshBody = JSON.stringify(refreshPayload);
  const refreshResponse = await fetch(baseUrl + "/api/realtime-refresh", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    cache: "no-store",
    body: refreshBody,
    signal: AbortSignal.timeout(65000)
  });
  const refreshText = await refreshResponse.text();
  let refreshedPlan;
  try {
    refreshedPlan = JSON.parse(refreshText);
  } catch {
    throw new Error("/api/realtime-refresh gaf geen geldige JSON terug (HTTP " +
      refreshResponse.status + ").");
  }
  if (!refreshResponse.ok) {
    throw new Error("/api/realtime-refresh gaf HTTP " + refreshResponse.status +
      ": " + String(refreshedPlan?.error ?? refreshText).slice(0, 500));
  }
  const refreshedOpenovKeys = openovLegKeys(refreshedPlan);
  const originalOpenovKeys = openovLegKeys(plan);
  if (JSON.stringify(refreshedOpenovKeys) !== JSON.stringify(originalOpenovKeys)) {
    throw new Error("/api/realtime-refresh veranderde de vaste route-/ritidentiteiten.");
  }
  const refreshItineraryCount = Array.isArray(refreshedPlan.itineraries)
    ? refreshedPlan.itineraries.length
    : Array.isArray(refreshedPlan.journeys)
      ? refreshedPlan.journeys.length
      : 0;
  const originalItineraryCount = Array.isArray(plan.itineraries)
    ? plan.itineraries.length
    : Array.isArray(plan.journeys)
      ? plan.journeys.length
      : 0;
  if (refreshItineraryCount !== originalItineraryCount) {
    throw new Error("/api/realtime-refresh veranderde het aantal bestaande reisopties.");
  }
  if (!refreshedPlan.openovRealtimeMeta?.checkedAt) {
    throw new Error("/api/realtime-refresh gaf geen verse OpenOV-controlemetadata terug.");
  }
  console.log("PASS: realtime-only refresh hercontroleert tijden en behoudt route-/ritidentiteiten.");
  console.log(JSON.stringify({
    payloadBytes: Buffer.byteLength(refreshBody),
    itinerariesPreserved: refreshItineraryCount,
    openovLegIdentitiesPreserved: refreshedOpenovKeys.length,
    openovCheckedAt: refreshedPlan.openovRealtimeMeta.checkedAt
  }, null, 2));

  const statusCounts = {};
  for (const leg of openovLegs) {
    const status = String(leg.openovRealtime?.status ?? "missing");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  const ndovStatusCounts = {};
  for (const leg of legs) {
    const status = String(leg.ndovRealtime?.status ?? "no_ndov_match");
    ndovStatusCounts[status] = (ndovStatusCounts[status] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    itineraries: Array.isArray(plan.itineraries) ? plan.itineraries.length : null,
    totalLegs: legs.length,
    openovLegs: openovLegs.length,
    openovStatusCounts: statusCounts,
    ndovStatusCounts,
    ndovRealtimeMeta: plan.ndovRealtimeMeta ?? null
  }, null, 2));

  for (const [index, leg] of openovLegs.entries()) {
    const realtime = leg.openovRealtime ?? {};
    console.log(JSON.stringify({
      leg: index + 1,
      routeId: leg.routeId ?? leg.route?.id ?? null,
      routeName: leg.route?.longName ?? leg.route?.name ?? leg.route?.shortName ?? null,
      tripId: realtime.tripId ?? leg.tripId ?? null,
      status: realtime.status ?? "missing",
      reason: realtime.reason ?? null,
      updateTimestamp: realtime.updateTimestamp ?? null,
      updateAgeSeconds: realtime.updateAgeSeconds ?? null,
      departureStopMatchMethod: realtime.departureStopMatchMethod ?? null,
      arrivalStopMatchMethod: realtime.arrivalStopMatchMethod ?? null,
      departure: realtime.departure ?? null,
      arrival: realtime.arrival ?? null,
      freshnessNote: realtime.freshnessNote ?? null,
      ndovStatus: leg.ndovRealtime?.status ?? null,
      ndovSource: leg.ndovRealtime?.source ?? null,
      ndovIdentity: leg.ndovRealtime?.identity ?? null,
      ndovEventType: leg.ndovRealtime?.eventType ?? leg.ndovRealtime?.kv6?.eventType ?? null,
      ndovPunctualitySeconds: leg.ndovRealtime?.punctualitySeconds ?? leg.ndovRealtime?.kv6?.punctualitySeconds ?? null,
      ndovFeedAgeSeconds: leg.ndovRealtime?.feedAgeSeconds ?? leg.ndovRealtime?.kv6?.feedAgeSeconds ?? null,
      ndovMatchReason: leg.ndovRealtimeMatch?.reason ?? null
    }, null, 2));
  }

  const derived = [];
  for (const leg of openovLegs) {
    for (const kind of ["departure", "arrival"]) {
      const prediction = predictionOf(leg, kind);
      if (prediction?.predictionMethod === "gtfsrt_delay_propagation") {
        derived.push({ leg, kind, prediction });
      }
    }
  }

  console.log("Afgeleide voorspellingen in deze echte planrespons: " + derived.length);
  if (!derived.length) {
    console.warn("INCONCLUSIVE: deze route/feedcombinatie leverde geen doorgetrokken voorspelling op; live bronvergelijking voor deze aanvraag is niet mogelijk.");
    console.log("PASS: /api/plan leverde echte OpenOV-OV-legs terug; niets gedeployed.");
    return;
  }

  let verified = 0;
  let inconclusive = 0;
  for (const { leg, kind, prediction } of derived.slice(0, 5)) {
    const scheduled = toSeconds(scheduledValue(leg, kind));
    const delay = Number(prediction.delaySeconds);
    const predicted = toSeconds(prediction.time);

    if (!Number.isFinite(scheduled) || !Number.isFinite(delay) || !Number.isFinite(predicted)) {
      console.error("FAIL: afgeleide " + kind + "-voorspelling mist een geldige tijd of vertraging.");
      process.exitCode = 1;
      continue;
    }

    const difference = Math.abs(predicted - (scheduled + delay));
    if (difference > 1) {
      console.error("FAIL: afgeleide " + kind +
        "-tijd wijkt " + difference.toFixed(2) + " s af van dienstregeling + vertraging.");
      process.exitCode = 1;
      continue;
    }

    const updateAge = leg.openovRealtime?.updateAgeSeconds;
    if (typeof updateAge === "number" && (updateAge < -60 || updateAge > 180)) {
      console.error("FAIL: realtime-update is niet vers genoeg (" + updateAge + " s oud).");
      process.exitCode = 1;
      continue;
    }

    const routeId = leg.routeId ?? leg.route?.id;
    const tripId = leg.openovRealtime?.tripId ?? leg.tripId;
    if (!routeId || !tripId) {
      console.error("FAIL: afgeleide voorspelling mist routeId of tripId.");
      process.exitCode = 1;
      continue;
    }

    const sourceKinds = ["tripUpdates", "trainUpdates"];
    const feedResults = await Promise.all(sourceKinds.map(async feedKind => {
      const feedUrl = new URL(baseUrl + "/api/realtime");
      feedUrl.searchParams.set("kind", feedKind);
      feedUrl.searchParams.set("routeId", String(routeId));
      feedUrl.searchParams.set("tripId", String(tripId));
      feedUrl.searchParams.set("limit", "2000");
      try {
        return { feedKind, data: await getJson(feedUrl, 45000) };
      } catch (error) {
        return { feedKind, error: String(error) };
      }
    }));

    const freshFeeds = feedResults.filter(result =>
      result.data?.ok === true &&
      result.data?.freshness === "fresh" &&
      Number.isFinite(Number(result.data?.ageSeconds)) &&
      Number(result.data.ageSeconds) >= -60 &&
      Number(result.data.ageSeconds) <= 180
    );

    const records = freshFeeds.flatMap(result =>
      (result.data.entities ?? []).filter(record =>
        (!record.routeId || normalizeId(record.routeId) === normalizeId(routeId)) &&
        (!record.tripId || String(record.tripId) === String(tripId) ||
          normalizeId(record.tripId) === normalizeId(tripId))
      ).map(record => ({ record, feed: result.data, feedKind: result.feedKind }))
    );

    if (!records.length) {
      inconclusive++;
      console.warn("INCONCLUSIVE: verse bronopvraag leverde geen exact record op voor " +
        routeId + " / " + tripId + "; de feed kan intussen zijn gewijzigd.");
      continue;
    }

    const sourceId = normalizeId(prediction.sourceStopId);
    const sourceTime = toSeconds(prediction.sourceEventTime);
    const sourceScheduled = toSeconds(prediction.sourceScheduledTime);
    const rawEvidence = [];

    for (const item of records) {
      for (const stop of item.record.stopUpdates ?? []) {
        if (normalizeId(stop.stopId) !== sourceId) continue;
        for (const eventKind of ["arrival", "departure"]) {
          const eventTime = toSeconds(stop[eventKind + "Time"]);
          const sourceDelay = stop[eventKind + "DelaySeconds"];
          if (Number.isFinite(eventTime) &&
              typeof sourceDelay === "number" &&
              Number.isFinite(sourceDelay) &&
              Math.abs(eventTime - sourceTime) <= 1 &&
              Math.abs((eventTime - sourceDelay) - sourceScheduled) <= 1 &&
              Math.abs(sourceDelay - delay) <= 1) {
            rawEvidence.push({ item, stop, eventKind, eventTime, sourceDelay });
          }
        }
      }
    }

    if (!rawEvidence.length) {
      inconclusive++;
      console.warn("INCONCLUSIVE: de oorspronkelijke brongebeurtenis voor halte " +
        prediction.sourceStopId + " ontbreekt inmiddels of is veranderd.");
      continue;
    }

    const targetId = normalizeId(findTargetStopId(leg, kind));
    const targetStillHasUpdate = targetId && records.some(({ record }) =>
      (record.stopUpdates ?? []).some(stop => normalizeId(stop.stopId) === targetId)
    );
    if (targetStillHasUpdate) {
      console.error("FAIL: er staat toch een update voor doelhalte " + targetId +
        " in de feed terwijl een afgeleide voorspelling is toegepast.");
      process.exitCode = 1;
      continue;
    }

    verified++;
    const evidence = rawEvidence[0];
    console.log("PASS: voorspelling bevestigd tegenover expliciete brongebeurtenis.");
    console.log(JSON.stringify({
      routeId,
      tripId,
      feedKind: evidence.item.feedKind,
      feedTimestamp: evidence.item.feed.feedTimestamp ?? null,
      feedAgeSeconds: evidence.item.feed.ageSeconds ?? null,
      sourceStopId: prediction.sourceStopId,
      sourceEventKind: evidence.eventKind,
      sourceEventTime: prediction.sourceEventTime,
      sourceScheduledTime: prediction.sourceScheduledTime,
      sourceDelaySeconds: evidence.sourceDelay,
      targetScheduledTime: new Date(scheduled * 1000).toISOString(),
      derivedPrediction: prediction.time,
      targetDelaySeconds: delay,
      existingTargetStopUpdate: false
    }, null, 2));
  }

  console.log(JSON.stringify({
    derivedPredictionsChecked: Math.min(derived.length, 5),
    verifiedAgainstFreshFeed: verified,
    inconclusiveBecauseFeedChanged: inconclusive
  }, null, 2));

  if (verified === 0) {
    console.warn("INCONCLUSIVE: geen afgeleide voorspelling kon tegen dezelfde gebeurtenis in de verse feed worden bevestigd.");
  } else {
    console.log("GESLAAGD: " + verified + " afgeleide voorspelling(en) gecontroleerd tegenover OpenOV-brondata.");
  }
}

main().catch(error => {
  console.error("LIVE-VALIDATIE MISLUKT:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
