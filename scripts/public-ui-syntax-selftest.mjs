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

console.log("PASS: OpenOV status helper has no out-of-scope leg reference");
console.log("PASS: KV6 observed-only status is rendered in the leg UI");
console.log("All public UI JavaScript checks passed.");
