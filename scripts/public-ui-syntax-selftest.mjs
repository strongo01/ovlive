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

assert.ok(summaryFunction.includes("${label}: gemeld ${value}"),
  "feed-header-only deviations must be described as reported, not confirmed");
assert.ok(summaryFunction.includes("niet gebruikt als verwachte tijd in de tijdlijn"),
  "OpenOV status must explain why an unconfirmed time does not replace the schedule");

console.log("PASS: OpenOV status helper has no out-of-scope leg reference");
console.log("PASS: KV6 observed-only status is rendered in the leg UI");
console.log("PASS: unconfirmed OpenOV times cannot replace planned timeline times");
console.log("All public UI JavaScript checks passed.");
