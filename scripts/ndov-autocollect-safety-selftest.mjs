import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [worker, config, hub] = await Promise.all([
  readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
  readFile(new URL("../src/ndov-stream-hub.js", import.meta.url), "utf8")
]);

const autocollectMatch = config.match(/^\s*NDOV_AUTOCOLLECT\s*=\s*"(true|false)"/m);
const autocollectValue = autocollectMatch?.[1] ?? null;
const controlledSoakTest = /# TEMPORARY CONTROLLED NDOV SOAK TEST/.test(config);
assert.ok(
  autocollectValue === "false" || (autocollectValue === "true" && controlledSoakTest),
  "NDOV_AUTOCOLLECT mag alleen true staan tijdens een expliciet gemarkeerde limiettest."
);
assert.match(hub, /AUTO_ACTIVE_START_UTC_HOUR = 4/);
assert.match(hub, /CONTINUOUS_FULL_CHECKPOINT_MS = 5 \* 60 \* 1000/);
assert.match(hub, /function ndovCollectionWindow\(nowMs = Date\.now\(\)\)/);
assert.match(hub, /this\.ctx\.id\?\.name !== NDOV_SHARED_OBJECT_NAME/);
assert.doesNotMatch(hub, /storage\.put\(durableChanges\)/);
console.log("PASS: dagelijkse collectorpauze, oude-ID-blokkade en gebundelde KV17-checkpoints");
console.log(
  autocollectValue === "true"
    ? "PASS: NDOV tijdelijk ingeschakeld voor gecontroleerde limiettest"
    : "PASS: automatische NDOV-verzameling staat uit"
);

const scheduledStart = worker.indexOf("async scheduled(");
const scheduledEnd = worker.indexOf("\n  async fetch(", scheduledStart);
assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart);
const scheduled = worker.slice(scheduledStart, scheduledEnd);
assert.match(scheduled, /NDOV_AUTOCOLLECT !== "true"/);
assert.match(scheduled, /callNdovHub\(env, "kv78", "continuous\/disable"\)/);
assert.match(scheduled, /callNdovHub\(env, "bison", "continuous\/disable"\)/);
assert.match(scheduled, /disableLegacyCollector\("kv78"\)/);
assert.match(scheduled, /disableLegacyCollector\("bison"\)/);
assert.match(scheduled, /idFromName\(stream\)/);
assert.match(scheduled, /legacyStub\.fetch\(target\.toString\(\)\)/);
console.log("PASS: noodstop schakelt ook oude KV78- en BISON-object-ID's uit");
assert.ok(
  scheduled.indexOf('"continuous/disable"') < scheduled.indexOf('"continuous/enable"'),
  "de disable-tak moet eerder staan dan het enable-pad"
);
console.log("PASS: scheduled handler schakelt bestaande KV78- en BISON-collectors daadwerkelijk uit");

const disableStart = hub.indexOf("if (url.pathname === '/continuous/disable')");
const eventsStart = hub.indexOf("if (url.pathname === '/events')", disableStart);
assert.ok(disableStart >= 0 && eventsStart > disableStart);
const disableBlock = hub.slice(disableStart, eventsStart);
assert.match(disableBlock, /alreadyDisabled/);
assert.match(disableBlock, /Collector stond al uit/);
assert.match(disableBlock, /deleteAlarm\(\)/);
assert.match(disableBlock, /state\.socket\.close\(\)/);
const socketCloseIndex = disableBlock.indexOf("state.socket.close()");
const disableWriteIndex = disableBlock.indexOf(
  "this.ctx.storage.put(stream + ':continuousEnabled', false)"
);
assert.ok(socketCloseIndex >= 0 && disableWriteIndex > socketCloseIndex,
  "De socket moet vóór de opslagwrite worden gesloten.");
console.log("PASS: socket wordt vóór opslag bijgewerkt of gesloten");
console.log("PASS: herhaalde collectorpauzes vermijden onnodige opslagwrites");

assert.match(hub, /async migrateLegacyStorage\(stream\)/);
assert.match(hub, /url\.pathname === '\/migration\/manifest'/);
assert.match(hub, /url\.pathname === '\/migration\/export-batch'/);
assert.match(hub, /legacyStorageMigrationV1/);
assert.match(hub, /isLegacyFeedStorageKey/);
assert.match(hub, /ctx\.id\?\.name === NDOV_SHARED_OBJECT_NAME/);
console.log("PASS: legacy-opslagmigratie is aanwezig en begrensd");

assert.match(hub, /existingRelevantKeys/);
assert.match(hub, /Refusing to migrate/);
console.log("PASS: migratie weigert onverwacht bestaande gegevens te overschrijven");

// Cold-start regressie: een KV78-aanvraag mag niet ook de volledige BISON-cache
// herstellen. Beide streams blijven volledig persistent; alleen herstel is lui.
const constructorStart = hub.indexOf("constructor(ctx, env)");
const constructorEnd = hub.indexOf("\n  async loadStreamState", constructorStart);
assert.ok(constructorStart >= 0 && constructorEnd > constructorStart);
const constructorBody = hub.slice(constructorStart, constructorEnd);
assert.doesNotMatch(constructorBody, /loadStreamState|migrateLegacyStorage/);
assert.match(hub, /async ensureStreamReady\(stream\)/);
assert.doesNotMatch(hub, /await this\.ready/);
assert.match(
  hub,
  /async fetch\(request\) \{\s*const url = new URL\(request\.url\);\s*const stream = url\.searchParams\.get\('stream'\) \|\| 'kv78';[\s\S]*?await this\.ensureStreamReady\(stream\);/
);
assert.match(
  hub,
  /kv78RowScheduleInfo\([\s\S]*?KV78_STOP_TIME_FUTURE_RETENTION_SECONDS\s*\)\.relevant/
);
console.log("PASS: cold-start herstelt alleen de gevraagde stream en behoudt KV78-tijdvensterfilters");
console.log("Alle NDOV-autocollect-safety-tests geslaagd.");
