import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

assert.match(html, /<html lang="nl">/, "the public site must declare Dutch as its language");
assert.match(html, /<meta name="description"/, "the public site must provide a search description");
assert.match(html, /class="skip-link" href="#plannerPanel"/, "keyboard users must be able to skip to the planner");

const navTargets = [...html.matchAll(/<a class="primary-nav-link" href="#([^"]+)"/g)]
  .map(match => match[1]);
assert.deepEqual(navTargets, [
  "plannerPanel",
  "liveFleetMapPanel",
  "stopTimesPanel",
  "lineSearchPanel"
], "the main navigation must expose the four public product areas");

const sectionIds = new Set(
  [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map(match => match[1])
);
for (const target of navTargets) {
  assert.ok(sectionIds.has(target), "navigation target must exist: " + target);
}

for (const id of ["from", "to", "planBtn", "liveFleetMap", "boardSearch", "lineSearch"]) {
  assert.ok(html.includes('id="' + id + '"'), "existing public feature must remain available: " + id);
}

assert.equal(
  (html.match(/class="panel diagnostic-panel/g) || []).length,
  4,
  "technical diagnostic panels must be hidden from the normal public view"
);
assert.match(html, /\.diagnostic-panel\s*\{\s*display:\s*none\s*!important;/,
  "diagnostic panels must be hidden by default");
assert.match(html, /body\.debug-enabled \.diagnostic-panel\s*\{\s*display:\s*block\s*!important;/,
  "diagnostic panels must remain available in debug mode");
assert.match(html, /params\.get\("debug"\) === "1"/,
  "the debug query parameter must enable technical panels");
assert.match(html, /new IntersectionObserver/,
  "the navigation must track the section currently in view");
assert.match(html, /prefers-reduced-motion:\s*reduce/,
  "reduced-motion preferences must be respected");

const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
  .map((match, index) => ({ index: index + 1, source: match[1].trim() }))
  .filter(block => block.source.length > 0);
assert.ok(inlineScripts.length > 0, "the page must contain application scripts");

for (const block of inlineScripts) {
  assert.doesNotThrow(
    () => new vm.Script(block.source, { filename: "public/index.html#inline-script-" + block.index }),
    "inline JavaScript block " + block.index + " must parse"
  );
}

console.log("PASS: OVLive production UI structure, navigation, diagnostics, accessibility and inline scripts");
