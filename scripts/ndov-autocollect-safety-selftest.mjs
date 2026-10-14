import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [worker, config, hub] = await Promise.all([
  readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
  readFile(new URL("../src/ndov-stream-hub.js", import.meta.url), "utf8")
]);

assert.match(config, /NDOV_AUTOCOLLECT\s*=\s*"false"/);
console.log("PASS: productieconfiguratie heeft automatische NDOV-verzameling uitgeschakeld");

const scheduledStart = worker.indexOf("async scheduled(");
const scheduledEnd = worker.indexOf("\n  async fetch(", scheduledStart);
assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart);
const scheduled = worker.slice(scheduledStart, scheduledEnd);
assert.match(scheduled, /NDOV_AUTOCOLLECT !== "true"/);
assert.match(scheduled, /callNdovHub\(env, "kv78", "continuous\/disable"\)/);
assert.match(scheduled, /callNdovHub\(env, "bison", "continuous\/disable"\)/);
assert.ok(
  scheduled.indexOf('"continuous/disable"') < scheduled.indexOf('"continuous/enable"'),
  "de disable-tak moet eerder staan dan het enable-pad"
);
console.log("PASS: scheduled handler schakelt bestaande KV78- en BISON-collectors daadwerkelijk uit");

const disableStart = hub.indexOf("if (url.pathname === '/continuous/disable')");
const enableStart = hub.indexOf("if (url.pathname === '/continuous/enable')");
assert.ok(disableStart >= 0 && enableStart > disableStart);
const disableBlock = hub.slice(disableStart, enableStart);
assert.match(disableBlock, /alreadyDisabled/);
assert.match(disableBlock, /Collector stond al uit/);
console.log("PASS: herhaalde collectorpauzes vermijden onnodige opslagwrites");

console.log("Alle NDOV-autocollect-safety-tests geslaagd.");
