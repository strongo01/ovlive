import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
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

// Realtime timings must refresh separately from the map's live vehicle-position poll.
assert.ok(html.includes("const LIVE_PLAN_REALTIME_POLL_MS = 30000;"),
  "itinerary realtime polling must use a 30-second interval");
assert.ok(html.includes("fetch('/api/realtime-refresh'"),
  "the UI must request fresh timetable realtime enrichments");
assert.ok(html.includes("cache: 'no-store'"),
  "realtime refresh requests must bypass browser HTTP cache");
assert.ok(html.includes("}, LIVE_PLAN_REALTIME_POLL_MS);"),
  "the 30-second realtime poll must be scheduled");
assert.ok(html.includes('<div class="journey-leg-details">') &&
  html.includes('data-leg-index="${index}"'),
  "realtime refresh must target the journey-leg details without rebuilding the map");
assert.ok(html.includes("startLivePlanRealtimeRefresh(data);"),
  "automatic realtime refresh must start after a successful plan search");
console.log("PASS: itinerary times and realtime badges are refreshed automatically every 30 seconds");

// Regression guard: the itinerary summary must not read block-scoped values
// before their declarations, which would abort the planner at runtime.
const invalidChronologyDeclaration = html.indexOf("const invalidChronologyCount = itineraryCandidates");
const validItineraryDeclaration = html.indexOf("const validItineraryCandidates = itineraryCandidates");
const itinerarySummaryReference = html.indexOf("`${validItineraryCandidates.length} bruikbare reisopties gevonden`");
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
const renderLegStartForHelpers = html.indexOf("function renderLeg(leg, index = 0) {", chronologyStart);
assert.ok(plannedStart >= 0 && chronologyStart > plannedStart && renderLegStartForHelpers > chronologyStart,
  "planned-time and itinerary chronology helpers must exist");
const plannedTimeSource = html.slice(plannedStart, chronologyStart).trim();
const chronologySource = html.slice(chronologyStart, renderLegStartForHelpers).trim();
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
console.log("All public UI JavaScript checks passed.");
