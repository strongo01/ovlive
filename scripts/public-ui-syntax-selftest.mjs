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
const journeyChronologyIssue = new vm.Script("(" + chronologySource + ")").runInNewContext();

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
  { mode: "BUS", startTime: realtimeDeparture, endTime: "2026-10-16T19:35:00.000Z", scheduledStartTime: scheduledDeparture }
])?.legIndex, 1,
"an itinerary must be rejected when the vehicle departs before the previous leg reaches the stop");
assert.equal(journeyChronologyIssue([
  { mode: "WALK", startTime: "2026-10-16T19:43:00.000Z", endTime: "2026-10-16T19:47:00.000Z" },
  { mode: "BUS", startTime: scheduledDeparture, endTime: "2026-10-16T20:05:00.000Z", scheduledStartTime: scheduledDeparture }
]), null,
"a chronological walk-to-bus connection remains valid");
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
assert.ok(predictionFunction.includes("String(event?.stopAssignmentStatus ?? '').startsWith('confirmed_')"),
  "KV78 times must not replace planned timeline times without a confirmed stop assignment");

assert.ok(realtimeRenderer.includes("nulafwijking hoort bij een tijdmatch zonder bevestigde PSA/CHB-halte"),
  "unconfirmed KV78 zero-deviation must not be labelled as on-time at that stop");
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
console.log("All public UI JavaScript checks passed.");
