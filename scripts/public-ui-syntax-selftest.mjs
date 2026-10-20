import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
  .map((match, index) => ({ index: index + 1, source: match[1].trim() }))
  .filter((block) => block.source.length > 0);

assert.ok(blocks.length > 0, "public/index.html must contain at least one inline JavaScript block");

for (const block of blocks) {
  try {
    new vm.Script(block.source, { filename: "public/index.html#inline-script-" + block.index });
    console.log("PASS: inline JavaScript block " + block.index + " parses");
  } catch (error) {
    console.error("FAIL: inline JavaScript block " + block.index + " has a syntax error");
    throw error;
  }
}

// Realtime timings and vehicle positions must both use a ten-second poll.
assert.ok(html.includes("const LIVE_PLAN_REALTIME_POLL_MS = 10000;"),
  "itinerary realtime polling must use a 10-second interval");
assert.ok(html.includes("const LIVE_VEHICLE_POLL_MS = 10000;"),
  "vehicle positions must use a 10-second interval");
assert.ok(html.includes("fetch('/api/realtime-refresh'"),
  "the UI must request fresh timetable realtime enrichments");
assert.ok(html.includes("cache: 'no-store'"),
  "realtime refresh requests must bypass browser HTTP cache");
assert.ok(html.includes("}, LIVE_PLAN_REALTIME_POLL_MS);"),
  "the 10-second realtime poll must be scheduled");
assert.ok(html.includes('<div class="journey-leg-details">') &&
  html.includes('data-leg-index="${index}"'),
  "realtime refresh must target the journey-leg details without rebuilding the map");
assert.ok(html.includes("startLivePlanRealtimeRefresh(data);"),
  "automatic realtime refresh must start after a successful plan search");
assert.ok(html.includes("q.set('deferRealtime', '1');"),
  "the initial search must request the fast route-only response");
assert.ok(html.includes("void refreshLivePlanRealtime(generation);"),
  "the realtime pass must start immediately instead of waiting for the first timer tick");
assert.ok(html.includes("signal: AbortSignal.timeout(30000)"),
  "a realtime refresh must time out so one slow source cannot lock the UI indefinitely");
// Realtime providers must fail independently so one outage does not discard other fresh feeds.
const refreshHandlerStart = workerSource.indexOf('if (isRealtimeRefresh && request.method === "POST")');
const refreshHandlerEnd = workerSource.indexOf('if (url.pathname === "/api/health")', refreshHandlerStart);
const refreshHandlerSource = workerSource.slice(refreshHandlerStart, refreshHandlerEnd);
assert.ok(refreshHandlerSource.includes("[OVLIVE_REALTIME_REFRESH_NS_ERROR]") &&
  refreshHandlerSource.includes("[OVLIVE_REALTIME_REFRESH_OPENOV_ERROR]") &&
  refreshHandlerSource.includes("[OVLIVE_REALTIME_REFRESH_NDOV_ERROR]"),
  "NS, OpenOV and NDOV failures must be isolated and logged separately");
assert.ok(refreshHandlerSource.includes('status: sourceErrors.length === 0 ? "complete" : "partial"') &&
  refreshHandlerSource.includes("successfulSources === 0"),
  "the realtime endpoint must return partial successes and fail only when every provider fails");
assert.ok(html.includes("const refreshErrorSummary = refreshErrors") &&
  html.includes("Realtime-update mislukt: ${reason}"),
  "the UI must show which source failed instead of hiding the actual error");

const openovMatcherStart = workerSource.indexOf("function matchOpenovRealtime(");
const openovMatcherEnd = workerSource.indexOf("\nfunction findRealtimeStop(", openovMatcherStart);
assert.ok(openovMatcherStart >= 0 && openovMatcherEnd > openovMatcherStart,
  "the OpenOV realtime matcher must remain inspectable");
const openovMatcherSource = workerSource.slice(openovMatcherStart, openovMatcherEnd);
assert.ok(openovMatcherSource.includes("indexes.byTripId.get(identity.tripId)") &&
  openovMatcherSource.includes("indexes.byRouteDate.get"),
  "the matcher must use trip and route/date indexes instead of scanning every feed record");

assert.ok(workerSource.includes("function openovRealtimeLegFeedFamily(") &&
  workerSource.includes('OPENOV_TRAIN_LEG_MODES.has(mode)') &&
  workerSource.includes('OPENOV_TRIP_LEG_MODES.has(mode)'),
  "OpenOV realtime feed selection must distinguish rail from bus/tram modes");
assert.ok(workerSource.includes('needsTripUpdates\n      ? safeOpenovFeed(OPENOV.tripUpdates, "tripUpdates", tripUpdateFilters)') &&
  workerSource.includes('needsTrainUpdates\n      ? safeOpenovFeed(OPENOV.trainUpdates, "trainUpdates", trainUpdateFilters)') &&
  workerSource.includes('needsTripUpdates && includeVehiclePositions\n      ? safeOpenovFeed(OPENOV.vehiclePositions, "vehiclePositions")'),
  "refresh must skip irrelevant feeds and target trip updates to itinerary route/service-date identities");
assert.ok(workerSource.includes('status: "not_requested"') &&
  workerSource.includes('return "unknown"'),
  "unknown route modes must preserve the safe fallback and skipped feeds must be explicit");
assert.doesNotMatch(openovMatcherSource,
  /diagnostic(Route|Date|Direction|FromStop|OrderedStop|Time)Records|diagnosticSamples/,
  "temporary matcher diagnostics must not rescan the full realtime feed on each itinerary leg");
assert.ok(workerSource.includes("buildOpenovRealtimeMatcherIndexes(records)") &&
  workerSource.includes("buildVehiclePositionIndex(vehiclePositions)") &&
  workerSource.includes("vehiclePositionCandidatesForLeg(leg, vehiclePositionsByTripRoute)"),
  "large trip updates and vehicle-position feeds must be indexed once per refresh");
console.log("PASS: OpenOV realtime matching indexes large feeds and skips unused per-leg diagnostic scans");
assert.ok(workerSource.includes('if (url.searchParams.get("deferRealtime") === "1")'),
  "the Worker must have an explicit route-only response mode");
const deferredStart = workerSource.indexOf('if (url.searchParams.get("deferRealtime") === "1")');
const deferredReturn = workerSource.indexOf("return json(planData, response.status", deferredStart);
const enrichmentAfterDeferred = workerSource.indexOf("await prepareNsTrainIdentities(planData, env);", deferredStart);
assert.ok(deferredStart >= 0 && deferredReturn > deferredStart &&
  enrichmentAfterDeferred > deferredReturn,
  "route-only mode must return before the blocking realtime enrichment sequence");
const refreshStart = html.indexOf("async function refreshLivePlanRealtime(");
const refreshEnd = html.indexOf("function startLivePlanRealtimeRefresh(", refreshStart);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart,
  "the realtime refresh loop must exist");
const refreshFunction = html.slice(refreshStart, refreshEnd);
assert.ok(refreshFunction.includes("!baseline || livePlanRealtimeInFlight"),
  "a refresh must be skipped while another refresh is already running");
assert.ok(refreshFunction.includes("const retryableStatus = [429, 502, 503, 504].includes(statusCode);"),
  "transient HTTP 503 and related server responses must use automatic recovery");
assert.ok(refreshFunction.includes("livePlanRealtimeRetryAfterMs = Date.now() + backoffMs"),
  "repeated transient failures must back off instead of hammering the API");
assert.ok(refreshFunction.includes("Realtimegegevens zijn tijdelijk niet beschikbaar. De bestaande tijden blijven staan; OVLive controleert automatisch opnieuw."),
  "transient failures must keep existing times and show a calm automatic-retry message");
assert.ok(refreshFunction.includes("Realtime-update mislukt: ${reason}"),
  "non-transient errors must retain actionable diagnostic details");
const retryableBranchStart = refreshFunction.indexOf("if (retryable) {");
const nonRetryableBranchStart = refreshFunction.indexOf("} else if (statusElement)", retryableBranchStart);
assert.ok(retryableBranchStart >= 0 && nonRetryableBranchStart > retryableBranchStart,
  "retryable and non-retryable errors must have separate UI handling");
assert.equal(
  refreshFunction.slice(retryableBranchStart, nonRetryableBranchStart).includes("Realtime-update mislukt: ${reason}"),
  false,
  "transient HTTP 503 must not show the repeated raw failure message"
);
const stopStart = html.indexOf("function stopLivePlanRealtimeRefresh() {");
const stopEnd = html.indexOf("async function refreshLivePlanRealtime(", stopStart);
assert.ok(stopStart >= 0 && stopEnd > stopStart,
  "the refresh timer stop helper must exist");
const stopFunction = html.slice(stopStart, stopEnd);
assert.equal(stopFunction.includes("livePlanRealtimeInFlight = false;"), false,
  "stopping/restarting the timer must not release the lock for an unfinished request");
console.log("PASS: timetable and vehicle updates poll every 10 seconds with an in-flight overlap guard");

assert.ok(workerSource.includes("const OPENOV_FEED_CACHE_TTL_MS = 30_000;") &&
  workerSource.includes("const OPENOV_VEHICLE_POSITION_CACHE_TTL_MS = 12_000;"),
  "large trip/train feeds must be cached long enough to avoid repeated full-feed CPU work while vehicle positions stay short-lived");
assert.ok(workerSource.includes("cf: { cacheTtl: 5, cacheEverything: true }"),
  "the upstream OpenOV feed cache must be shorter than the ten-second poll");
console.log("PASS: large OpenOV trip/train feeds are cached longer while vehicle positions stay short-lived");

// Regression guard: the itinerary summary must not read block-scoped values
// before their declarations, which would abort the planner at runtime.
const invalidChronologyDeclaration = html.indexOf("const invalidChronologyCount = itineraryCandidates");
const validItineraryDeclaration = html.indexOf("const validItineraryCandidates = itineraryCandidates");
const itinerarySummaryReference = html.indexOf("`${Math.min(validItineraryCandidates.length, 10)} reisopties getoond`");
assert.ok(invalidChronologyDeclaration >= 0 && validItineraryDeclaration > invalidChronologyDeclaration,
  "itinerary candidate counts must be initialized before rendering the summary");
assert.ok(itinerarySummaryReference > invalidChronologyDeclaration &&
  itinerarySummaryReference > validItineraryDeclaration,
  "the itinerary summary must only access candidate counts after they are initialized");

// Regression guard: OpenOV status formatting must only use its own
// parameter, never a free-standing "leg" from another renderer's scope.
const summaryStart = html.indexOf("function openovStatusSummary(rt) {");
const summaryEnd = html.indexOf("function renderRealtimeLegend()", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart,
  "openovStatusSummary and renderRealtimeLegend must both exist");
const summaryFunction = html.slice(summaryStart, summaryEnd);
assert.equal(summaryFunction.includes("leg."), false,
  "openovStatusSummary must not reference the out-of-scope variable leg");

// Vehicle-only KV6 observations should be rendered in realtimeHtml(leg), not
// inside the string-only OpenOV status helper.
const realtimeRendererStart = html.indexOf("function realtimeHtml(leg) {");
const realtimeRendererEnd = html.indexOf("function timelineRealtimePrediction(", realtimeRendererStart);
assert.ok(realtimeRendererStart >= 0 && realtimeRendererEnd > realtimeRendererStart,
  "realtimeHtml renderer must exist");
const realtimeRenderer = html.slice(realtimeRendererStart, realtimeRendererEnd);
assert.equal(realtimeRenderer.includes("leg.ndovRealtime?.status === 'kv6_observed'"), true,
  "realtimeHtml must explicitly render fresh KV6 observations without punctuality");
assert.ok(realtimeRenderer.includes("const rawDelay = ndov.punctualitySeconds;") &&
  realtimeRenderer.includes("rawDelay == null || rawDelay === '' ? Number.NaN"),
  "missing KV6 punctuality must remain unknown rather than becoming zero");
assert.ok(realtimeRenderer.includes("'Voertuigupdate meldt 0 sec afwijking'"),
  "zero KV6 punctuality must be described as the vehicle update's measurement, not stop-level on-time status");
assert.ok(realtimeRenderer.includes("!Number.isFinite(delay) || delay === 0"),
  "zero-deviation KV6 status must use neutral/unknown styling, not the on-time green styling");
assert.ok(realtimeRenderer.includes("geen bevestigde verwachte vertrek- of aankomsttijd op deze halte"),
  "KV6 vehicle punctuality must be distinguished from a stop-specific arrival/departure prediction");
assert.equal(realtimeRenderer.includes("Op tijd volgens de actuele voertuigupdate"), false,
  "a vehicle-only KV6 observation must not be labelled as simply on time");
assert.ok(realtimeRenderer.includes("Voertuigupdate meldt 0 sec afwijking") &&
  realtimeRenderer.includes("kv6Seconds === 0"),
  "the nested KV6 vehicle status must also use neutral wording/styling for zero deviation");
const compareHelperStart = html.indexOf("function canCompareOpenovWithKv78(");
const compareHelperEnd = html.indexOf("\n}", compareHelperStart) + 2;
assert.ok(compareHelperStart >= 0 && compareHelperEnd > compareHelperStart,
  "OpenOV-versus-KV78 confidence helper must exist");
const compareHelperSource = html.slice(compareHelperStart, compareHelperEnd);
const canCompareOpenovWithKv78 = new vm.Script("(" + compareHelperSource + ")").runInNewContext();
assert.equal(canCompareOpenovWithKv78(true, {
  stopAssignmentStatus: "confirmed_quay_platform", stopSideCode: "C9"
}), false, "OpenOV without a per-trip timestamp must not be compared against KV78");
assert.equal(canCompareOpenovWithKv78(false, {
  stopAssignmentStatus: "confirmed_psa_chb", stopSideCode: "C9"
}), false, "a StopPlace-only match must not be treated as a confirmed platform match");
assert.equal(canCompareOpenovWithKv78(false, {
  stopAssignmentStatus: "confirmed_quay_platform"
}), false, "a platform match without a concrete side code must not be compared");
assert.equal(canCompareOpenovWithKv78(false, {
  stopAssignmentStatus: "confirmed_quay_platform", stopSideCode: "C9"
}), true, "source comparison requires a trip timestamp and a confirmed KV78 platform/side");
assert.ok(realtimeRenderer.includes("if (!canCompareOpenovWithKv78(openovTripTimestampMissing, kv78Event)) continue;"),
  "OpenOV-versus-KV78 discrepancy warnings must require reliable per-trip and platform identity");
assert.ok(realtimeRenderer.includes("OpenOV meldt 0 sec zonder timestamp per rit"),
  "the UI must explain that zero seconds without a trip timestamp does not prove punctual running");
assert.ok(realtimeRenderer.includes("exacte haltezijde is niet bevestigd"),
  "the UI must expose StopPlace-only confidence without claiming a confirmed platform");

const delayLabelStart = html.indexOf("function delayLabel(value) {");
const stopEventStart = html.indexOf("function stopEventHtml(label, event, scheduledValue, options = {}) {");
const stopEventEnd = html.indexOf("function openovStatusSummary(rt) {", stopEventStart);
assert.ok(delayLabelStart >= 0 && stopEventStart > delayLabelStart && stopEventEnd > stopEventStart,
  "KV78 delay and stop-event renderers must exist");
const delayLabelSource = html.slice(delayLabelStart, stopEventStart).trim();
const stopEventSource = html.slice(stopEventStart, stopEventEnd).trim();
const delayLabel = new vm.Script("(" + delayLabelSource + ")").runInNewContext();
const stopEventHtml = new vm.Script("(" + stopEventSource + ")").runInNewContext({
  delayLabel,
  esc: value => String(value ?? ""),
  clock: value => new Date(value).toLocaleTimeString("nl-NL", {
    timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit"
  })
});
const unconfirmedKv78Html = stopEventHtml("Vertrek (KV78-halte 50000128)", {
  targetTime: "21:54:00",
  delaySeconds: 31,
  stopAssignmentStatus: "time_only_unverified"
}, "2026-10-16T19:54:00Z", { requireConfirmedStopAssignment: true });
assert.ok(unconfirmedKv78Html.includes("tijdindicatie uit KV78-doeltijd + afwijking; halte niet bevestigd"),
  "time-only KV78 matching must be described as a diagnostic time indication, not an expected departure");
assert.ok(unconfirmedKv78Html.includes('class="rt-unknown"'),
  "delay values from unconfirmed KV78 stop matches must use neutral styling");
assert.ok(unconfirmedKv78Html.includes("gemeld: 31 sec vertraging"),
  "an unconfirmed KV78 deviation may be shown only as a reported value");
assert.equal(unconfirmedKv78Html.includes('class="rt-delay"'), false,
  "an unconfirmed KV78 stop match must not colour a reported delay as confirmed");
const confirmedKv78Html = stopEventHtml("Vertrek (KV78-halte 51112304)", {
  targetTime: "21:54:00",
  delaySeconds: 31,
  stopAssignmentStatus: "confirmed_quay_platform",
  stopSideCode: "C9"
}, "2026-10-16T19:54:00Z", { requireConfirmedStopAssignment: true });
assert.ok(confirmedKv78Html.includes("verwacht, berekend uit KV78-doeltijd + halteafwijking"),
  "a confirmed KV78 stop assignment may retain its expected-time wording");
assert.ok(confirmedKv78Html.includes('class="rt-delay"'),
  "a confirmed KV78 stop assignment may retain its delay styling");
const stopPlaceOnlyKv78Html = stopEventHtml("Vertrek (KV78-halte 09575)", {
  targetTime: "12:28:00",
  delaySeconds: 0,
  stopAssignmentStatus: "confirmed_stopplace"
}, "2026-10-18T10:28:00Z", { requireConfirmedStopAssignment: true });
assert.ok(stopPlaceOnlyKv78Html.includes('class="rt-unknown"'),
  "a StopPlace-only zero deviation must use neutral styling");
assert.equal(stopPlaceOnlyKv78Html.includes('class="rt-ok"'), false,
  "a StopPlace-only zero deviation must not be shown as confirmed on time");
assert.ok(stopPlaceOnlyKv78Html.includes("gemeld: 0 sec afwijking; op tijd niet bevestigd"),
  "a StopPlace-only zero deviation must explicitly remain unconfirmed");

const unconfirmedOpenovHtml = stopEventHtml("Vertrek", {
  time: "2026-10-16T19:54:00Z",
  delaySeconds: 0
}, "2026-10-16T19:54:00Z", {
  sourceLabel: "OpenOV",
  unconfirmed: true
});
assert.ok(unconfirmedOpenovHtml.includes("tijd uit OpenOV-ritupdate; rit-timestamp ontbreekt"),
  "OpenOV predictions without a per-trip timestamp must be labelled as OpenOV, never as KV78");
assert.equal(unconfirmedOpenovHtml.includes("KV78-rij"), false,
  "OpenOV rendering must not accidentally identify its event as a KV78 row");
assert.ok(unconfirmedOpenovHtml.includes("gemeld: 0 sec afwijking; op tijd niet bevestigd"),
  "zero deviation from an unconfirmed OpenOV trip update must not claim on-time running");
assert.ok(unconfirmedOpenovHtml.includes('class="rt-unknown"') &&
  !unconfirmedOpenovHtml.includes('class="rt-ok"'),
  "unconfirmed OpenOV timing must use neutral styling");

assert.ok(realtimeRenderer.includes("{ sourceLabel: 'OpenOV', unconfirmed: openovPredictionUnconfirmed }"),
  "OpenOV renderer must pass its own source and timestamp confidence to the shared event renderer");
assert.ok(realtimeRenderer.includes("{ requireConfirmedStopAssignment: true }"),
  "only KV78 events must require PSA/CHB stop confirmation for authoritative stop labels");
console.log("PASS: unconfirmed KV78 stop matches remain diagnostic and neutral");
console.log("PASS: confirmed KV78 stop matches retain stop-specific prediction display");
console.log("PASS: OpenOV events keep OpenOV identity and remain unconfirmed without trip timestamps");

// MOTIS can expose a realtime-adjusted startTime alongside the original timetable.
 // Always select explicit scheduled times first; never silently substitute a realtime time.
const plannedStart = html.indexOf("function plannedEndpointTime(leg, kind) {");
const chronologyStart = html.indexOf("function journeyChronologyIssue(legs, toleranceSeconds = 60) {", plannedStart);
const renderLegStartForHelpers = html.indexOf("function renderLeg(leg, index = 0, journeyLegs = null) {", chronologyStart);
assert.ok(plannedStart >= 0 && chronologyStart > plannedStart && renderLegStartForHelpers > chronologyStart,
  "planned-time and itinerary chronology helpers must exist");
const plannedTimeSource = html.slice(plannedStart, chronologyStart).trim();
const walkingHelpersStartForChronology = html.indexOf("function normalizeWalkingSpeedKmh(value) {", chronologyStart);
assert.ok(walkingHelpersStartForChronology > chronologyStart &&
  renderLegStartForHelpers > walkingHelpersStartForChronology,
  "walking helper functions must remain outside the chronology checker function");
const chronologySource = html.slice(chronologyStart, walkingHelpersStartForChronology).trim();
const plannedEndpointTime = new vm.Script("(" + plannedTimeSource + ")").runInNewContext();
const journeyChronologyIssue = new vm.Script("(" + chronologySource + ")").runInNewContext({ plannedEndpointTime });

const realtimeDeparture = "2026-10-16T19:22:00.000Z";
const scheduledDeparture = "2026-10-16T19:47:00.000Z";
assert.equal(plannedEndpointTime({
  mode: "BUS",
  realTime: true,
  startTime: realtimeDeparture,
  scheduledStartTime: scheduledDeparture,
  from: { departure: realtimeDeparture, scheduledDeparture: realtimeDeparture }
}, "departure"), scheduledDeparture,
"leg-level scheduled time must win over a conflicting realtime-adjusted stop time");
assert.equal(plannedEndpointTime({
  mode: "BUS",
  realTime: true,
  startTime: realtimeDeparture,
  from: { departure: realtimeDeparture }
}, "departure"), null,
"an unlabelled realtime departure must never masquerade as a timetable time");
assert.equal(plannedEndpointTime({
  mode: "WALK",
  startTime: "2026-10-16T19:43:00.000Z",
  endTime: "2026-10-16T19:47:00.000Z"
}, "departure"), "2026-10-16T19:43:00.000Z",
"walking legs may use their route-calculated start time");

assert.equal(journeyChronologyIssue([
  { mode: "WALK", startTime: "2026-10-16T19:43:00.000Z", endTime: "2026-10-16T19:47:00.000Z" },
  {
    mode: "BUS", realTime: true,
    startTime: "2026-10-16T19:47:00.000Z",
    endTime: "2026-10-16T20:05:00.000Z",
    scheduledStartTime: "2026-10-16T19:22:00.000Z",
    scheduledEndTime: "2026-10-16T19:40:00.000Z"
  }
])?.legIndex, 1,
"an itinerary must be rejected when a displayed scheduled departure is before arrival, even if startTime looks chronological");
assert.equal(journeyChronologyIssue([
  { mode: "WALK", startTime: "2026-10-16T19:43:00.000Z", endTime: "2026-10-16T19:47:00.000Z" },
  { mode: "BUS", realTime: true, startTime: realtimeDeparture, endTime: "2026-10-16T20:05:00.000Z", scheduledStartTime: scheduledDeparture, scheduledEndTime: "2026-10-16T20:05:00.000Z" }
]), null,
"a chronological walk-to-bus connection remains valid when judged using the same scheduled times as the UI");
console.log("PASS: planned times prefer timetable fields over realtime-adjusted time");
console.log("PASS: impossible itinerary chronology is rejected");

 // Unconfirmed OpenOV predictions must not replace planned stop times in the main timeline.
const predictionStart = html.indexOf("function timelineRealtimePrediction(leg, kind, scheduledTime) {");
const predictionEnd = html.indexOf("function timelineTimeHtml(", predictionStart);
assert.ok(predictionStart >= 0 && predictionEnd > predictionStart,
  "timeline prediction selector must exist");
const predictionFunction = html.slice(predictionStart, predictionEnd);
assert.ok(predictionFunction.includes("!unifiedTimestampMissing"),
  "unified predictions without a per-trip timestamp must not drive the timeline");
assert.ok(predictionFunction.includes("unifiedEvent?.confidence !== 'low'"),
  "low-confidence unified predictions must not drive the timeline");
assert.ok(predictionFunction.includes("String(rt.timestampBasis ?? '').toLowerCase() === 'trip_update'"),
  "raw OpenOV predictions must have an explicit per-trip timestamp");
assert.ok(predictionFunction.includes("if (!hasPerTripTimestamp) {\n    return null;"),
  "raw OpenOV fallback must fail closed when the per-trip timestamp is missing");
const timelineRealtimePrediction = new vm.Script("(" + predictionFunction + ")").runInNewContext();
const reproducedStopPlaceOnlyLeg = {
  mode: "SUBWAY",
  scheduledStartTime: "2026-10-18T10:28:00.000Z",
  ndovRealtime: { status: "kv78_delay", kv78: { departure: {
    time: "2026-10-18T10:28:00.000Z", delaySeconds: 0,
    targetTime: "12:28:00", stopAssignmentStatus: "confirmed_stopplace"
  } } },
  realtimePrediction: { status: "available", departure: {
    time: "2026-10-18T10:28:00.000Z", source: "NDOV KV78Turbo", confidence: "medium"
  } }
};
assert.equal(timelineRealtimePrediction(reproducedStopPlaceOnlyLeg, "departure", reproducedStopPlaceOnlyLeg.scheduledStartTime), null,
  "a StopPlace-only KV78 event must not replace the timetable in the main timeline");
const confirmedPlatformLeg = {
  ...reproducedStopPlaceOnlyLeg,
  ndovRealtime: { status: "kv78_delay", kv78: { departure: {
    time: "2026-10-18T10:28:00.000Z", delaySeconds: 0, targetTime: "12:28:00",
    stopAssignmentStatus: "confirmed_quay_platform", stopSideCode: "C9"
  } } },
  realtimePrediction: { status: "available", departure: {
    time: "2026-10-18T10:28:00.000Z", source: "NDOV KV78Turbo", confidence: "medium"
  } }
};
assert.equal(timelineRealtimePrediction(confirmedPlatformLeg, "departure", confirmedPlatformLeg.scheduledStartTime)?.source, "NDOV KV78Turbo",
  "a fully confirmed KV78 platform/side prediction may replace the timetable");
assert.ok(predictionFunction.includes("event?.stopAssignmentStatus === 'confirmed_quay_platform'") &&
  predictionFunction.includes("Boolean(event?.stopSideCode)"),
  "KV78 times must not replace planned timeline times without a confirmed platform and side");

assert.ok(realtimeRenderer.includes("De haltezijde is niet bevestigd; deze nulafwijking bewijst daarom niet"),
  "StopPlace-only KV78 zero-deviation must explain that the exact stop side remains unconfirmed");
assert.ok(realtimeRenderer.includes("const vehicleTypeLabel = String(modeName(leg.mode) || 'OV').toLocaleLowerCase('nl-NL');"),
  "realtime UI must derive transport wording from the actual leg mode");
assert.ok(realtimeRenderer.includes("de ${vehicleTypeLabel} op tijd rijdt"),
  "OpenOV's zero-deviation warning must name the actual transport mode");
assert.ok(realtimeRenderer.includes("Dit betekent niet dat de ${esc(vehicleTypeLabel)} op tijd rijdt"),
  "missing prediction warning must name the actual transport mode");
assert.equal(realtimeRenderer.includes("de bus op tijd rijdt"), false,
  "metro realtime notices must not incorrectly mention a bus");
assert.ok(html.includes("invalidChronologyCount") &&
  html.includes("Deze opties worden niet getoond"),
  "time-inconsistent itineraries must be excluded and explained to the user");

assert.ok(summaryFunction.includes("${label}: gemeld ${value}"),
  "feed-header-only deviations must be described as reported, not confirmed");
assert.ok(summaryFunction.includes("niet gebruikt als verwachte tijd in de tijdlijn"),
  "OpenOV status must explain why an unconfirmed time does not replace the schedule");

console.log("PASS: OpenOV status helper has no out-of-scope leg reference");
console.log("PASS: KV6 observed-only status is rendered in the leg UI");
console.log("PASS: unconfirmed OpenOV times cannot replace planned timeline times");

const ovapiPanelStart = html.indexOf("$('ovapiTransitousMatchButton').onclick = async () => {");
const ovapiPanelEnd = html.indexOf("function normalizeTransitousStopId", ovapiPanelStart);
assert.ok(ovapiPanelStart >= 0 && ovapiPanelEnd > ovapiPanelStart, "OVAPI comparison panel must exist");
const ovapiPanelSource = html.slice(ovapiPanelStart, ovapiPanelEnd);
assert.ok(ovapiPanelSource.includes("['BUS', 'TRAM', 'METRO', 'SUBWAY'].includes(mode)"),
  "OVAPI panel must accept bus, tram, metro and subway legs");
assert.ok(ovapiPanelSource.includes("normalizeComparableLine"),
  "OVAPI panel must normalize T/M-prefixed route labels before comparison");
assert.ok(ovapiPanelSource.includes("TRAM: 'tram'") && ovapiPanelSource.includes("METRO: 'metro'"),
  "OVAPI comparison results must display the correct transport mode");
assert.equal(ovapiPanelSource.includes("!== 'BUS'"), false,
  "OVAPI comparison panel must not retain the old bus-only filter");
console.log("PASS: OVAPI comparison panel accepts tram/metro and labels them correctly");

assert.ok(html.includes("kv6LookupDiagnostics") &&
  html.includes("returnedExactEventCount") &&
  html.includes("unmatchedIdentitySamples") &&
  html.includes("KV6-lookup") &&
  html.includes("verse exacte matches"),
  "planner summary must expose bounded KV6 lookup diagnostics needed to investigate zero exact metro matches");
assert.ok(html.includes("met bevestigde PSA/CHB-station (StopPlace)") &&
  html.includes("zonder bevestigde PSA/CHB-stationmatch"),
  "planner summary must distinguish station-level StopPlace confirmation from an exact quay/platform match");

console.log("PASS: planner summary exposes bounded KV6 lookup diagnostics");
console.log("PASS: KV78 summary labels StopPlace confirmation accurately");

// Full-line geometry is loaded separately from the selected journey segment.
// Keep the upstream fixed to Transitous, cached, and limited to a known trip ID.
assert.ok(workerSource.includes('if (url.pathname === "/api/trip-shape")') &&
  workerSource.includes('${TRANSITOUS}/trip') &&
  workerSource.includes('cf: { cacheTtl: 1800, cacheEverything: true }'),
  "full trip shapes must use the fixed, cached Transitous trip endpoint");
assert.ok(workerSource.includes("String(url.searchParams.get(\"tripId\") ?? \"\").trim()") &&
  workerSource.includes("tripId.length > 256"),
  "the full-trip-shape endpoint must validate the requested trip identity");
assert.ok(html.includes("function fetchLiveFullTripGeometry(leg)") &&
  html.includes("function loadLiveFullTripRouteOverlays(index)") &&
  html.includes('fetch("/api/trip-shape?"'),
  "the live map must fetch full-trip geometry separately from live vehicle locations");
assert.ok(html.includes('color: "#f59e0b"') &&
  html.includes('color: "#22c55e"') &&
  html.includes("Volledige lijnroute") &&
  html.includes("Jouw traject"),
  "the map must draw the complete vehicle trip in orange and the selected segment in green");
assert.ok(html.includes("candidateRouteId === expectedRouteId") &&
  html.includes("candidateTripId === expectedTripId"),
  "full-trip overlays must match the selected leg's exact route and trip identity");
console.log("PASS: map overlays use exact full-trip geometry, with orange route and green selected segment");
// Journey sorting must compare absolute timestamps so today's late departure precedes tomorrow morning.
assert.ok(html.includes('id="journeySort"') &&
  html.includes('value="departure" selected') &&
  html.includes('value="arrival"') &&
  html.includes('value="duration"') &&
  html.includes('value="transfers"') &&
  html.includes('value="transferWait"'),
  "journey results must expose all five sorting choices");
assert.ok(html.includes('data-sort-departure-ms=') &&
  html.includes('data-sort-transfer-wait-seconds=') &&
  html.includes("sortJourneyCards(journeySort.value)") &&
  html.includes('data-tracking-index="${index}"'),
  "journey cards must expose calculated sorting metrics and a live sort control");
const sortPlannedStart = html.indexOf("function plannedEndpointTime(leg, kind) {");
const sortChronologyStart = html.indexOf("function journeyChronologyIssue(legs, toleranceSeconds = 60) {", sortPlannedStart);
const sortPrepareStart = html.indexOf("function prepareJourneyLegsForDisplay(");
const sortItineraryKeyStart = html.indexOf("\nfunction itineraryRealtimeKey(", sortPrepareStart);
const sortMetricsStart = html.indexOf("function journeySortMetrics(");
const sortComparatorStart = html.indexOf("\nfunction compareJourneySortMetrics(", sortMetricsStart);
const sortCardMetricsStart = html.indexOf("\nfunction journeyCardSortMetrics(", sortComparatorStart);
assert.ok(sortPlannedStart >= 0 && sortChronologyStart > sortPlannedStart &&
  sortPrepareStart >= 0 && sortItineraryKeyStart > sortPrepareStart &&
  sortMetricsStart >= 0 && sortComparatorStart > sortMetricsStart &&
  sortCardMetricsStart > sortComparatorStart,
  "journey sort metric helpers must be inspectable for deterministic tests");
const sortMetricContext = {};
new vm.Script(
  html.slice(sortPlannedStart, sortChronologyStart).trim() + "\n" +
  html.slice(sortPrepareStart, sortItineraryKeyStart).trim() + "\n" +
  html.slice(sortMetricsStart, sortComparatorStart).trim() + "\n" +
  html.slice(sortComparatorStart, sortCardMetricsStart).trim() + "\n" +
  "this.journeySortMetrics = journeySortMetrics; this.compareJourneySortMetrics = compareJourneySortMetrics;"
).runInNewContext(sortMetricContext);

const tonightBus = {
  startTime: "2026-10-19T21:00:00.000Z",
  endTime: "2026-10-19T21:25:00.000Z",
  legs: [{
    mode: "BUS",
    scheduledStartTime: "2026-10-19T21:00:00.000Z",
    scheduledEndTime: "2026-10-19T21:25:00.000Z"
  }]
};
const tomorrowTrain = {
  startTime: "2026-10-20T07:06:00.000Z",
  endTime: "2026-10-20T08:11:00.000Z",
  legs: [
    { mode: "TRAIN", scheduledStartTime: "2026-10-20T07:06:00.000Z", scheduledEndTime: "2026-10-20T07:35:00.000Z" },
    { mode: "BUS", scheduledStartTime: "2026-10-20T07:45:00.000Z", scheduledEndTime: "2026-10-20T08:11:00.000Z" }
  ]
};
const tonightMetrics = sortMetricContext.journeySortMetrics(tonightBus, tonightBus.legs);
const tomorrowMetrics = sortMetricContext.journeySortMetrics(tomorrowTrain, tomorrowTrain.legs);
assert.ok(sortMetricContext.compareJourneySortMetrics(tonightMetrics, tomorrowMetrics, "departure") < 0,
  "a bus departing tonight must sort before an itinerary departing tomorrow morning");
assert.ok(sortMetricContext.compareJourneySortMetrics(tonightMetrics, tomorrowMetrics, "arrival") < 0,
  "earliest-arrival sorting must compare full date-times");
assert.ok(sortMetricContext.compareJourneySortMetrics(tonightMetrics, tomorrowMetrics, "duration") < 0,
  "shortest-trip sorting must compare total itinerary duration");

const directLongJourney = {
  startTime: "2026-10-19T21:02:00.000Z",
  endTime: "2026-10-19T23:02:00.000Z",
  legs: [{ mode: "BUS", scheduledStartTime: "2026-10-19T21:02:00.000Z", scheduledEndTime: "2026-10-19T23:02:00.000Z" }]
};
const fasterTransferJourney = {
  startTime: "2026-10-19T21:03:00.000Z",
  endTime: "2026-10-19T21:48:00.000Z",
  legs: [
    { mode: "BUS", scheduledStartTime: "2026-10-19T21:03:00.000Z", scheduledEndTime: "2026-10-19T21:15:00.000Z" },
    { mode: "BUS", scheduledStartTime: "2026-10-19T21:20:00.000Z", scheduledEndTime: "2026-10-19T21:48:00.000Z" }
  ]
};
const directMetrics = sortMetricContext.journeySortMetrics(directLongJourney, directLongJourney.legs);
const transferMetrics = sortMetricContext.journeySortMetrics(fasterTransferJourney, fasterTransferJourney.legs);
assert.ok(sortMetricContext.compareJourneySortMetrics(directMetrics, transferMetrics, "transfers") < 0,
  "fewest-transfers sorting must prefer a direct itinerary even when it takes longer");

const shortConnection = {
  startTime: "2026-10-19T20:00:00.000Z",
  endTime: "2026-10-19T20:40:00.000Z",
  legs: [
    { mode: "BUS", scheduledStartTime: "2026-10-19T20:00:00.000Z", scheduledEndTime: "2026-10-19T20:10:00.000Z" },
    { mode: "WALK", startTime: "2026-10-19T20:10:00.000Z", endTime: "2026-10-19T20:12:00.000Z", distance: 180 },
    { mode: "BUS", scheduledStartTime: "2026-10-19T20:14:00.000Z", scheduledEndTime: "2026-10-19T20:40:00.000Z" }
  ]
};
const longConnection = {
  startTime: "2026-10-19T20:00:00.000Z",
  endTime: "2026-10-19T20:44:00.000Z",
  legs: [
    { mode: "BUS", scheduledStartTime: "2026-10-19T20:00:00.000Z", scheduledEndTime: "2026-10-19T20:10:00.000Z" },
    { mode: "WALK", startTime: "2026-10-19T20:10:00.000Z", endTime: "2026-10-19T20:12:00.000Z", distance: 180 },
    { mode: "BUS", scheduledStartTime: "2026-10-19T20:18:00.000Z", scheduledEndTime: "2026-10-19T20:44:00.000Z" }
  ]
};
const shortConnectionMetrics = sortMetricContext.journeySortMetrics(shortConnection, shortConnection.legs);
const longConnectionMetrics = sortMetricContext.journeySortMetrics(longConnection, longConnection.legs);
assert.equal(shortConnectionMetrics.transferWaitSeconds, 120,
  "transfer waiting must subtract the scheduled walk duration from the connection gap");
assert.ok(sortMetricContext.compareJourneySortMetrics(shortConnectionMetrics, longConnectionMetrics, "transferWait") < 0,
  "least-transfer-wait sorting must prefer the shorter actual wait, not just the shortest total journey");
console.log("PASS: journey sorting compares absolute dates, duration, transfer count and transfer waiting accurately");
// The first-vehicle buffer and walking speed must determine when to leave the origin.
assert.ok(html.includes('id="firstVehicleBuffer"') &&
  html.includes('type="number" min="0" max="30" step="1" value="5"') &&
  html.includes('<input id="walkingSpeed" type="range" min="2" max="15" step="0.5" value="5"') &&
  html.includes('id="walkingSpeedValue"') &&
  html.includes('addEventListener(\'input\', updateWalkingSpeedReadout)') &&
  html.includes("speed.toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + ' km/u'") &&
  !html.includes('id="initialWaitLimit"') &&
  !html.includes('<select id="walkingSpeed">'),
  "the planner must expose a 2–15 km/h slider, visible live value and five-minute arrival buffer");
assert.ok(html.includes("firstArrivalBufferSeconds: selectedFirstVehicleBufferSeconds()") &&
  html.includes("walkingSpeedKmh: selectedWalkingSpeedKmh()") &&
  html.includes("activeWalkSettings.firstArrivalBufferSeconds") &&
  html.includes("activeWalkSettings.walkingSpeedKmh") &&
  html.includes("const minutes = Number.isFinite(parsed) ? Math.min(30, Math.max(0, parsed)) : 5;"),
  "initial planning and realtime refresh must both apply the current buffer and walking speed");
assert.ok(html.includes("distance / (normalizeWalkingSpeedKmh(speedKmh) / 3.6)") &&
  html.includes("walkingDurationSeconds(leg.distance, activeWalkingSpeedKmh)") &&
  html.includes("walkingLegTimingAtSpeed(leg, startTime, walkingSpeedKmh)") &&
  html.includes("walkingConnectionStatus(timing.endTime, nextDeparture)"),
  "all walking durations and transfer feasibility must use the configured speed");

const walkingHelpersStart = html.indexOf("function normalizeWalkingSpeedKmh(value) {");
const renderLegAfterWalkingHelpers = html.indexOf("function renderLeg(leg, index = 0, journeyLegs = null) {", walkingHelpersStart);
const prepareForBufferStart = html.indexOf("function prepareJourneyLegsForDisplay(");
const journeySortAfterPrepare = html.indexOf("function journeySortMetrics(", prepareForBufferStart);
assert.ok(walkingHelpersStart >= 0 && renderLegAfterWalkingHelpers > walkingHelpersStart &&
  prepareForBufferStart >= 0 && journeySortAfterPrepare > prepareForBufferStart,
  "walking duration and first-departure helpers must exist for deterministic tests");
const walkingHelperContext = { plannedEndpointTime };
new vm.Script(
  html.slice(walkingHelpersStart, renderLegAfterWalkingHelpers).trim() +
  "\nthis.walkingDurationSeconds = walkingDurationSeconds;" +
  "\nthis.walkingLegTimingAtSpeed = walkingLegTimingAtSpeed;" +
  "\nthis.walkingConnectionStatus = walkingConnectionStatus;" +
  "\nthis.journeyWalkingTransferIssue = journeyWalkingTransferIssue;"
).runInNewContext(walkingHelperContext);

assert.equal(walkingHelperContext.normalizeWalkingSpeedKmh(2), 2,
  "the walking speed normalizer must allow the slider's minimum of 2 km/h");
assert.equal(walkingHelperContext.normalizeWalkingSpeedKmh(15), 15,
  "the walking speed normalizer must allow the slider's maximum of 15 km/h");
assert.equal(walkingHelperContext.normalizeWalkingSpeedKmh(1.5), 5,
  "values below the slider minimum must safely fall back to 5 km/h");
assert.equal(walkingHelperContext.normalizeWalkingSpeedKmh(15.5), 5,
  "values above the slider maximum must safely fall back to 5 km/h");

const speedBindingStart = html.indexOf("const walkingSpeedInput = document.getElementById('walkingSpeed');");
const speedBindingEnd = html.indexOf("$('planBtn').onclick = async () => {", speedBindingStart);
assert.ok(speedBindingStart >= 0 && speedBindingEnd > speedBindingStart,
  "the slider readout must be bound separately from the travel search handler");
const slider = {
  value: "5",
  listeners: {},
  addEventListener(type, callback) { this.listeners[type] = callback; }
};
const speedOutput = { textContent: "" };
const fakeSpeedDocument = {
  getElementById(id) {
    if (id === "walkingSpeed") return slider;
    if (id === "walkingSpeedValue") return speedOutput;
    return null;
  }
};
new vm.Script(html.slice(speedBindingStart, speedBindingEnd).trim())
  .runInNewContext({
    document: fakeSpeedDocument,
    normalizeWalkingSpeedKmh: walkingHelperContext.normalizeWalkingSpeedKmh
  });
assert.equal(speedOutput.textContent, "5 km/u",
  "the slider value must be displayed when the planner loads");
slider.value = "12.5";
slider.listeners.input();
assert.equal(speedOutput.textContent, "12,5 km/u",
  "the displayed speed must update immediately when the slider moves");
slider.value = "15";
slider.listeners.input();
assert.equal(speedOutput.textContent, "15 km/u",
  "the readout must display the slider maximum accurately");
console.log("PASS: walking speed slider displays its live value and enforces the 2–15 km/h range");
const prepareBufferContext = {
  plannedEndpointTime,
  walkingDurationSeconds: walkingHelperContext.walkingDurationSeconds,
  walkingLegTimingAtSpeed: walkingHelperContext.walkingLegTimingAtSpeed,
  walkingConnectionStatus: walkingHelperContext.walkingConnectionStatus,
  normalizeWalkingSpeedKmh: walkingHelperContext.normalizeWalkingSpeedKmh
};
prepareBufferContext.prepareJourneyLegsForDisplay = new vm.Script(
  "(" + html.slice(prepareForBufferStart, journeySortAfterPrepare).trim() + ")"
).runInNewContext(prepareBufferContext);
const stationDeparture = "2026-10-20T06:09:00.000Z";
const sampleWalk = {
  mode: "WALK",
  startTime: "2026-10-20T05:55:00.000Z",
  endTime: stationDeparture,
  distance: 899,
  from: { name: "START", departure: "2026-10-20T05:55:00.000Z" },
  to: { name: "Utrecht Terwijde", arrival: stationDeparture }
};
const sampleTrain = {
  mode: "TRAIN",
  scheduledStartTime: stationDeparture,
  scheduledEndTime: "2026-10-20T06:22:00.000Z",
  from: { scheduledDeparture: stationDeparture },
  to: { scheduledArrival: "2026-10-20T06:22:00.000Z" }
};
const sampleJourney = {
  startTime: sampleWalk.startTime,
  endTime: sampleTrain.scheduledEndTime,
  legs: [sampleWalk, sampleTrain]
};
const fiveMinuteBuffer = prepareBufferContext.prepareJourneyLegsForDisplay(
  sampleJourney, [sampleWalk, sampleTrain], 300, 5
);
assert.equal(fiveMinuteBuffer.adjustedJourneyStart, "2026-10-20T05:53:13.000Z",
  "899 m at 5 km/h and a five-minute buffer must calculate a 05:53:13 departure for a 06:09 train");
const calculatedWalkSeconds = walkingHelperContext.walkingDurationSeconds(899, 5);
const calculatedArrivalMs = Date.parse(fiveMinuteBuffer.legs[0].startTime) + calculatedWalkSeconds * 1000;
assert.equal((Date.parse(stationDeparture) - calculatedArrivalMs) / 1000, 300,
  "the estimated arrival at the first vehicle must be exactly the configured buffer before departure");
const threeMinuteBuffer = prepareBufferContext.prepareJourneyLegsForDisplay(
  sampleJourney, [sampleWalk, sampleTrain], 180, 5
);
assert.equal(threeMinuteBuffer.adjustedJourneyStart, "2026-10-20T05:55:13.000Z",
  "reducing the buffer from five minutes to three must move the origin departure two minutes later");
const slowWalk = prepareBufferContext.prepareJourneyLegsForDisplay(
  sampleJourney, [sampleWalk, sampleTrain], 300, 3
);
const fastWalk = prepareBufferContext.prepareJourneyLegsForDisplay(
  sampleJourney, [sampleWalk, sampleTrain], 300, 6
);
assert.ok(Date.parse(slowWalk.adjustedJourneyStart) < Date.parse(fastWalk.adjustedJourneyStart),
  "a slower selected walking speed must calculate an earlier origin departure");
assert.equal(slowWalk.legs[0].initialDepartureCalculated, true,
  "the computed walking departure must take precedence over original walking timetable fields");
console.log("PASS: first-vehicle buffer and walking speed calculate consistent origin departure and station arrival times");

// Later walks must use the selected speed and check whether the next transit is reachable.
const transferWalk = {
  mode: "WALK",
  startTime: "2026-10-20T06:22:00.000Z",
  endTime: "2026-10-20T06:24:00.000Z",
  distance: 392,
  from: { name: "Utrecht Vaartsche Rijn", departure: "2026-10-20T06:22:00.000Z" },
  to: { name: "Utrecht, Station Vaartsche Rijn", arrival: "2026-10-20T06:24:00.000Z" }
};
const sampleTram = {
  mode: "TRAM",
  scheduledStartTime: "2026-10-20T06:30:00.000Z",
  scheduledEndTime: "2026-10-20T06:40:00.000Z",
  from: { name: "Utrecht, Station Vaartsche Rijn", scheduledDeparture: "2026-10-20T06:30:00.000Z" },
  to: { name: "Utrecht, Heidelberglaan", scheduledArrival: "2026-10-20T06:40:00.000Z" }
};
const finalWalk = {
  mode: "WALK",
  startTime: "2026-10-20T06:40:00.000Z",
  endTime: "2026-10-20T06:45:00.000Z",
  distance: 367,
  from: { name: "Utrecht, Heidelberglaan", departure: "2026-10-20T06:40:00.000Z" },
  to: { name: "Bestemming", arrival: "2026-10-20T06:45:00.000Z" }
};
const multiWalkJourney = {
  startTime: sampleWalk.startTime,
  endTime: "2026-10-20T06:45:00.000Z",
  legs: [sampleWalk, sampleTrain, transferWalk, sampleTram, finalWalk]
};
const normalSpeedJourney = prepareBufferContext.prepareJourneyLegsForDisplay(
  multiWalkJourney, multiWalkJourney.legs, 300, 5
);
assert.equal(normalSpeedJourney.legs[2].duration, 282,
  "392 m at 5 km/h must take four minutes and 42 seconds");
assert.equal(normalSpeedJourney.legs[2].endTime, "2026-10-20T06:26:42.000Z",
  "the transfer walking arrival must use the selected speed");
assert.equal(normalSpeedJourney.legs[2].connectionFeasibility, "available",
  "arriving before the next tram must leave a feasible connection");
assert.equal(normalSpeedJourney.legs[4].endTime, "2026-10-20T06:44:24.000Z",
  "the final walking leg must update journey arrival too");
const twoKmhJourney = prepareBufferContext.prepareJourneyLegsForDisplay(
  multiWalkJourney, multiWalkJourney.legs, 300, 2
);
assert.equal(twoKmhJourney.legs[2].endTime, "2026-10-20T06:33:46.000Z",
  "392 m at 2 km/h must take 11 minutes and 46 seconds");
assert.equal(twoKmhJourney.legs[2].connectionFeasibility, "missed",
  "walking slowly must flag the 06:30 tram as an infeasible connection");
assert.equal(
  walkingHelperContext.walkingConnectionStatus("2026-10-20T06:29:30.000Z", "2026-10-20T06:30:00.000Z").status,
  "tight",
  "a connection with under one minute remaining must be marked tight"
);

// 392 m lopen aan 5 km/u duurt 282 seconden: vanaf 12:12 aankomst is de
// tram om 12:15 dus onmogelijk. De tram om 12:21 is wél haalbaar.
const transferTrainAtStation = {
  mode: "TRAIN",
  scheduledEndTime: "2026-10-20T10:12:00.000Z",
  to: { scheduledArrival: "2026-10-20T10:12:00.000Z" }
};
const stationWalk = {
  mode: "WALK",
  distance: 392,
  startTime: "2026-10-20T10:12:00.000Z",
  endTime: "2026-10-20T10:15:00.000Z",
  from: { departure: "2026-10-20T10:12:00.000Z" },
  to: { arrival: "2026-10-20T10:15:00.000Z" }
};
const tooSoonTram = {
  mode: "TRAM",
  scheduledStartTime: "2026-10-20T10:15:00.000Z",
  from: { scheduledDeparture: "2026-10-20T10:15:00.000Z" }
};
const nextTram = {
  mode: "TRAM",
  scheduledStartTime: "2026-10-20T10:21:00.000Z",
  from: { scheduledDeparture: "2026-10-20T10:21:00.000Z" }
};
const impossibleWalkTransfer = walkingHelperContext.journeyWalkingTransferIssue(
  [transferTrainAtStation, stationWalk, tooSoonTram], 5
);
assert.equal(impossibleWalkTransfer?.nextLegIndex, 2,
  "a train-to-tram transfer requiring more walking time than scheduled must be rejected");
assert.equal(impossibleWalkTransfer?.requiredWalkingSeconds, 282);
assert.equal(impossibleWalkTransfer?.availableSeconds, 180);
assert.equal(walkingHelperContext.journeyWalkingTransferIssue(
  [transferTrainAtStation, stationWalk, nextTram], 5
), null, "the next tram with enough walking time must remain a valid option");
assert.ok(html.includes("journeyWalkingTransferIssue(sourceLegs, walkSettings.walkingSpeedKmh)"),
  "unreachable walking transfers must be filtered before journey cards are rendered");
assert.ok(html.includes("q.set('searchWindow', '7200')") &&
  html.includes("q.set('numItineraries', '10')") &&
  html.includes("q.set('maxItineraries', '10')"),
  "the first timetable page must request ten itineraries over a two-hour window");
assert.ok(html.includes("data-page-direction=\"previous\"") &&
  html.includes("Laad 3 eerdere reizen") &&
  html.includes("data-page-direction=\"next\"") &&
  html.includes("Laad 3 latere reizen"),
  "earlier and later buttons must appear above and below the journey list");
assert.ok(html.includes("pageQuery.set('pageCursor', state.cursors[direction])") &&
  workerSource.includes('"maxItineraries", "searchWindow", "pageCursor",'),
  "page cursors must be forwarded to Transitous without changing the original search parameters");
assert.ok(html.includes("function renderJourneyCard(journey, index, walkSettings)") &&
  html.includes("function loadMoreJourneys(direction)"),
  "newly loaded journeys must use the same detailed card renderer and loading handler");

const pageBatchStart = html.indexOf("function takeJourneyPageBatch(state, direction, batchSize = JOURNEY_PAGE_BATCH_SIZE) {");
const pageBatchEnd = html.indexOf("function filterNewPageJourneys(", pageBatchStart);
assert.ok(pageBatchStart >= 0 && pageBatchEnd > pageBatchStart,
  "the three-at-a-time paging helper must remain available for tests");
const pageBatchContext = {};
new vm.Script(
  html.slice(pageBatchStart, pageBatchEnd).trim() +
  "\nthis.takeJourneyPageBatch = takeJourneyPageBatch;"
).runInNewContext(pageBatchContext);
const laterQueue = { pendingNext: [1, 2, 3, 4, 5, 6, 7], pendingPrevious: [] };
assert.deepEqual(Array.from(pageBatchContext.takeJourneyPageBatch(laterQueue, "next", 3)), [1, 2, 3],
  "loading later journeys must return the next three items from the queue");
assert.deepEqual(laterQueue.pendingNext, [4, 5, 6, 7],
  "loading later journeys must leave remaining options queued");
const earlierQueue = { pendingNext: [], pendingPrevious: [1, 2, 3, 4, 5, 6, 7] };
assert.deepEqual(Array.from(pageBatchContext.takeJourneyPageBatch(earlierQueue, "previous", 3)), [5, 6, 7],
  "loading earlier journeys must choose the closest three items before the current page");
assert.deepEqual(earlierQueue.pendingPrevious, [1, 2, 3, 4],
  "loading earlier journeys must keep more distant journeys queued");

assert.ok(!html.includes("validItineraryCandidates.slice(0, 8)"),
  "the UI must no longer use the old eight-card truncation");

const batchingStart = html.indexOf("function chunkLivePlanRealtimeEntries(entries, maxPerBatch = 8) {");
const batchingEnd = html.indexOf("function setLivePlanRealtimeRefreshBatch(", batchingStart);
assert.ok(batchingStart >= 0 && batchingEnd > batchingStart,
  "the realtime refresh batch helper must remain available for deterministic tests");
const batchingContext = {};
new vm.Script(
  html.slice(batchingStart, batchingEnd).trim() +
  "\nthis.chunkLivePlanRealtimeEntries = chunkLivePlanRealtimeEntries;"
).runInNewContext(batchingContext);
const batchSample = Array.from({ length: 17 }, (_, index) => index);
const batches = batchingContext.chunkLivePlanRealtimeEntries(batchSample, 8);
assert.deepEqual(Array.from(batches, batch => batch.length), [8, 8, 1],
  "all displayed journeys must be split into small realtime refresh batches");
assert.deepEqual(Array.from(batches).flat(), batchSample,
  "realtime batching must retain every journey without omissions or duplicates");
console.log("PASS: impossible walking transfers are filtered and later tram alternatives remain eligible");
console.log("PASS: more timetable options are requested and all feasible cards can be displayed");
console.log("PASS: realtime refresh batches cover every displayed journey");
console.log("PASS: all walking legs use the selected speed and check transfer feasibility");

// A scheduled-only supplementary search must retain only explicitly confirmed
// cancellations and show them separately, never as usable trip options.
const cancelledHelperStart = html.indexOf("function journeySourceLegs(journey) {");
const cancelledHelperEnd = html.indexOf("function prepareJourneyLegsForDisplay(", cancelledHelperStart);
assert.ok(cancelledHelperStart >= 0 && cancelledHelperEnd > cancelledHelperStart,
  "cancelled-trip identity helpers must remain available for deterministic tests");
const cancelledHelperContext = {};
new vm.Script(
  html.slice(cancelledHelperStart, cancelledHelperEnd).trim() +
  "\nthis.confirmedCancelledLegs = confirmedCancelledLegs;" +
  "\nthis.journeyHasConfirmedCancellation = journeyHasConfirmedCancellation;" +
  "\nthis.confirmedCancelledSource = confirmedCancelledSource;" +
  "\nthis.confirmedTripIdentityKey = confirmedTripIdentityKey;"
).runInNewContext(cancelledHelperContext);
assert.equal(cancelledHelperContext.journeyHasConfirmedCancellation({
  legs: [{ mode: "TRAM", ndovRealtime: { status: "cancelled", source: "NDOV BISON KV17" } }]
}), true, "an exact NDOV cancellation must be recognized");
assert.equal(cancelledHelperContext.confirmedCancelledSource({
  mode: "TRAM", ndovRealtime: { status: "cancelled", source: "NDOV BISON KV17" }
}), "NDOV BISON KV17");
assert.equal(cancelledHelperContext.journeyHasConfirmedCancellation({
  legs: [{ mode: "TRAM", ndovRealtime: { status: "unknown" } }]
}), false, "missing/unconfirmed realtime must not be described as a cancellation");
assert.equal(cancelledHelperContext.confirmedTripIdentityKey({
  mode: "TRAM", tripId: "20261020_12:55_nl-OpenOV_123456"
}), "TRAM|20261020_12:55_nl-OpenOV_123456");
assert.ok(html.includes("cancellationQuery.delete('deferRealtime')") &&
  html.includes("cancellationQuery.set('realtimeMode', 'OFF')") &&
  html.includes("cancellationQuery.set('numItineraries', '16')") &&
  html.includes("cancellationQuery.set('maxItineraries', '16')"),
  "the supplementary search must request more scheduled journeys and allow cancellation enrichment to run");
assert.ok(html.includes('id="cancelled-trips-container"') &&
  html.includes("Rijdt niet — reis niet mogelijk met deze rit") &&
  html.includes("Vervallen ritten"),
  "confirmed cancelled trips must be displayed in a separate, clearly unavailable section");
assert.ok(html.includes("data-transit-trip-ids=") &&
  html.includes("cancelledTripIds.has(String(id))"),
  "a confirmed cancelled trip must not remain in the normal list as a usable option");
console.log("PASS: confirmed cancelled trips are retrieved from the timetable and shown separately as unavailable");

// The cancellation supplement must not overwrite maxItineraries with a lower value.
assert.ok(!html.includes("cancellationQuery.set('maxItineraries', '12')"),
  "the cancellation lookup must not overwrite maxItineraries=16 with 12");

// The stop board and standalone line/vehicle search must be separate tools.
// The stop board uses an actual Transitous stop ID; line search must not require a stop.
assert.ok(html.includes('id="stopTimesPanel"') &&
  html.includes('id="boardStopFind"') &&
  html.includes('id="boardDirection"') &&
  html.includes('id="boardSearch"') &&
  html.includes('id="boardStopMeta"') &&
  html.includes('id="lineSearchPanel"') &&
  html.includes('id="lineNumber"') &&
  html.includes('id="lineSearch"'),
  "the UI must expose a stop board and a separate standalone line/vehicle search");
assert.ok(html.indexOf('id="lineSearchPanel"') > html.indexOf('</section>', html.indexOf('id="stopTimesPanel"')) &&
  html.includes("api('/api/line-search?' + query.toString()"),
  "line search must be outside the stop panel and call its own API");
assert.ok(html.includes("fetchStop: 'true'") &&
  html.includes("arriveBy: String(direction === 'arrivals')") &&
  !html.includes("direction: 'true'") &&
  html.includes("row?.nextStops") &&
  html.includes("row?.previousStops"),
  "stop-time queries must set arriveBy separately and must not send an invalid boolean direction");
assert.ok(workerSource.includes('const booleanParams = ["arriveBy", "fetchStop", "withScheduledSkippedStops"]') &&
  workerSource.includes('const requestedDirection = String(url.searchParams.get("direction") ?? "").trim().toUpperCase()') &&
  workerSource.includes('Ongeldige waarde voor direction; gebruik EARLIER of LATER.') &&
  workerSource.includes('upstream.searchParams.set("pageCursor", pageCursor)') &&
  workerSource.includes('upstream.searchParams.set("time", requestedTime)'),
  "the Worker must validate direction as EARLIER/LATER and safely forward time and paging parameters");
assert.ok(workerSource.includes('url.pathname === "/api/line-search"') &&
  workerSource.includes('http://v0.ovapi.nl/line/') &&
  workerSource.includes('getOpenovFeed(OPENOV.vehiclePositions, "vehiclePositions")') &&
  workerSource.includes('TRANSITOUS + "/trip"'),
  "the standalone line-search API must combine public line metadata with current vehicle/trip identities");
assert.ok(workerSource.includes('const routeId = String(entity?.routeId ?? "").trim();') &&
  workerSource.includes("routeId: routeId || null") &&
  workerSource.includes('"Lijn onbekend"') &&
  workerSource.includes('Rit-ID " + (tripNumber || tripId)'),
  "OpenOV results must retain exact route/trip identifiers when schedule enrichment is unavailable");
assert.ok(html.includes("function renderStopBoardMetadata(data)") &&
  html.includes("Halte-ID: ") &&
  html.includes("<th>Lijn</th><th>Richting</th><th>") &&
  html.includes("Verwachte aankomsttijd"),
  "the stop board must display available stop metadata and a timetable-style arrivals/departures table");

const boardTimeFormatterStart = html.indexOf("function stopTimeEvent(row, direction) {");
const boardTimeFormatterEnd = html.indexOf("\nfunction stopTimeDestination(", boardTimeFormatterStart);
assert.ok(boardTimeFormatterStart >= 0 && boardTimeFormatterEnd > boardTimeFormatterStart,
  "the stop-time event formatter must remain independently testable");
const stopEventContext = {};
new vm.Script(
  html.slice(boardTimeFormatterStart, boardTimeFormatterEnd).trim() +
  "\nthis.stopTimeEvent = stopTimeEvent;"
).runInNewContext(stopEventContext);
assert.deepEqual(
  JSON.parse(JSON.stringify(stopEventContext.stopTimeEvent({
    realTime: true,
    place: { departure: "2026-10-20T12:03:00Z", scheduledDeparture: "2026-10-20T12:00:00Z" }
  }, "departures"))),
  { time: "2026-10-20T12:03:00Z", scheduled: "2026-10-20T12:00:00Z", reported: "2026-10-20T12:03:00Z", live: true },
  "a real-time stop event must show the reported time while retaining its scheduled time"
);
assert.deepEqual(
  JSON.parse(JSON.stringify(stopEventContext.stopTimeEvent({
    realTime: false,
    place: { departure: null, scheduledDeparture: "2026-10-20T12:00:00Z" }
  }, "departures"))),
  { time: "2026-10-20T12:00:00Z", scheduled: "2026-10-20T12:00:00Z", reported: null, live: false },
  "a scheduled-only stop event must not be presented as live"
);

const lineMatchStart = html.indexOf("function stopTimeMatchesLine(row, query) {");
const lineMatchEnd = html.indexOf("\nfunction renderStopSequence(", lineMatchStart);
assert.ok(lineMatchStart >= 0 && lineMatchEnd > lineMatchStart,
  "stop-time line matching must remain independently testable");
const lineMatchContext = {};
new vm.Script(
  html.slice(lineMatchStart, lineMatchEnd).trim() +
  "\nthis.stopTimeMatchesLine = stopTimeMatchesLine;"
).runInNewContext(lineMatchContext);
assert.equal(lineMatchContext.stopTimeMatchesLine({ routeShortName: "5", displayName: "Bus 5" }, "5"), true);
assert.equal(lineMatchContext.stopTimeMatchesLine({ routeShortName: "11", displayName: "Bus 11" }, "5"), false);

const lineSearchMatcherStart = html.indexOf("function lineSearchMatchesRecord(row, query) {");
const lineSearchMatcherEnd = html.indexOf("\nfunction renderLineSearchCard(", lineSearchMatcherStart);
assert.ok(lineSearchMatcherStart >= 0 && lineSearchMatcherEnd > lineSearchMatcherStart,
  "the standalone vehicle search matcher must remain independently testable");
const lineSearchMatcherContext = {};
new vm.Script(
  html.slice(lineSearchMatcherStart, lineSearchMatcherEnd).trim() +
  "\nthis.lineSearchMatchesRecord = lineSearchMatchesRecord;"
).runInNewContext(lineSearchMatcherContext);
assert.equal(lineSearchMatcherContext.lineSearchMatchesRecord({ line: "73", destination: "Maarssenbroek" }, "73"), true);
assert.equal(lineSearchMatcherContext.lineSearchMatchesRecord({ line: "500", vehicleNumber: "7305" }, "73"), true);
assert.equal(lineSearchMatcherContext.lineSearchMatchesRecord({ line: "3", tripNumber: "73" }, "73"), true);
assert.equal(lineSearchMatcherContext.lineSearchMatchesRecord({ line: "77", destination: "Bilthoven" }, "73"), false);

const lineCardStart = html.indexOf("function renderLineSearchCard(row) {");
const lineCardEnd = html.indexOf("\\nfunction displayLineSearchResults(", lineCardStart);
assert.ok(lineCardStart >= 0 && lineCardEnd > lineCardStart,
  "the line-search card renderer must remain independently testable");
const lineCardContext = { esc: value => String(value ?? "") };
new vm.Script(
  html.slice(lineCardStart, lineCardEnd).trim() +
  "\\nthis.renderLineSearchCard = renderLineSearchCard;"
).runInNewContext(lineCardContext);
const fallbackCard = lineCardContext.renderLineSearchCard({
  line: "Lijn onbekend", destination: "Bestemming onbekend",
  vehicleNumber: "7305", tripId: "rt-trip-73", routeId: "rt-route-7",
  vehicleLabel: "Voertuig met nummer 7305", source: "OpenOV GTFS-Realtime"
});
assert.ok(fallbackCard.includes("Voertuig-ID: 7305") &&
  fallbackCard.includes("Rit-ID: rt-trip-73") &&
  fallbackCard.includes("Route-ID: rt-route-7"),
  "fallback line-search cards must show exact vehicle, trip and route IDs");
console.log("PASS: line-search fallback cards preserve exact vehicle, trip and route identifiers");
console.log("PASS: stop board separates live observations from scheduled times and displays a timetable table");
console.log("PASS: standalone line search matches public line numbers, vehicle numbers and trip numbers without a selected stop");
console.log("All public UI JavaScript checks passed.");