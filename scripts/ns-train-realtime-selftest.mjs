import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/ns-train-realtime.ts", import.meta.url),
  "utf8"
);

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(compiled).toString("base64");

const { eventFrom } = await import(moduleUrl);

const planned = "2026-10-14T11:10:00.000Z";
const actual = "2026-10-14T11:10:00.000Z";

// UNKNOWN + gelijke tijden mogen geen bevestigde voorspelling worden.
const unknownEcho = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  departureStatus: "UNKNOWN",
  cancelled: false
}, "departure");

assert.equal(unknownEcho.time, null);
assert.equal(unknownEcho.actualTime, null);
assert.equal(unknownEcho.delaySeconds, null);
assert.equal(unknownEcho.plannedTime, planned);
console.log("PASS: UNKNOWN met gelijke tijden blijft onbevestigd");

// Een ontbrekende status mag evenmin vanzelf als op tijd gelden.
const missingStatus = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  cancelled: false
}, "arrival");

assert.equal(missingStatus.time, null);
assert.equal(missingStatus.delaySeconds, null);
console.log("PASS: ontbrekende NS-status blijft onbekend");

// INCOMING beschrijft de treinstatus, niet automatisch de punctualiteit.
const incomingWithoutDelay = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  arrivalStatus: "INCOMING",
  cancelled: false
}, "arrival");

assert.equal(incomingWithoutDelay.time, planned);
assert.equal(incomingWithoutDelay.delaySeconds, null);
console.log("PASS: INCOMING zonder expliciete vertraging blijft punctualiteit onbekend");

// Nulvertraging is wel geldig als NS die expliciet als 0 doorgeeft.
const confirmedZero = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  departureStatus: "UNKNOWN",
  delayInSeconds: 0,
  cancelled: false
}, "departure");

assert.equal(confirmedZero.time, planned);
assert.equal(confirmedZero.delaySeconds, 0);
console.log("PASS: expliciete nulvertraging van NS blijft geldig");

// Een werkelijke afwijking mag niet worden weggefilterd.
const delayed = eventFrom({
  plannedDateTime: planned,
  actualDateTime: "2026-10-14T11:12:00.000Z",
  departureStatus: "UNKNOWN",
  cancelled: false
}, "departure");

assert.equal(delayed.time, "2026-10-14T11:12:00.000Z");
assert.equal(delayed.delaySeconds, 120);
console.log("PASS: echte afwijking van 120 seconden blijft zichtbaar");

// Een expliciet door NS gemelde vertraging blijft behouden.
const reportedDelay = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  departureStatus: "UNKNOWN",
  delayInSeconds: 150,
  cancelled: false
}, "departure");

assert.equal(reportedDelay.delaySeconds, 150);
console.log("PASS: expliciet gemelde NS-vertraging blijft behouden");

console.log("Alle NS-regressietests geslaagd.");
