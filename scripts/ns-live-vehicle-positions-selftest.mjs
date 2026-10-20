import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/ns-live-vehicle-positions.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
const { normalizeNsLiveVehiclePositions } = await import(moduleUrl);

const fetchedAt = Date.parse("2026-10-20T07:20:00.000Z");
const positions = normalizeNsLiveVehiclePositions({
  payload: {
    treinen: [
      {
        treinNummer: 6919,
        ritId: "6919",
        lat: 52.0177,
        lng: 5.1051,
        snelheid: 78.5,
        richting: 110,
        type: "SPR",
        bron: "OBIS"
      },
      {
        treinNummer: "6919",
        ritId: "duplicate-without-timestamp",
        lat: 52.02,
        lng: 5.11,
        snelheid: 75,
        richting: 111
      },
      {
        treinNummer: 6920,
        ritId: "6920",
        lat: 52.1,
        lng: 5.2,
        timestamp: "2026-10-20T07:19:50.000Z"
      },
      {
        treinNummer: 1,
        lat: 0,
        lng: 0
      },
      {
        treinNummer: 2,
        lat: 56.1,
        lng: 5.2
      },
      {
        treinNummer: "not-a-number",
        lat: 52.1,
        lng: 5.2
      },
      null
    ]
  }
}, fetchedAt);

assert.equal(positions.length, 2, "only unique train numbers with valid Dutch-region coordinates should be kept");
assert.equal(positions[0].trainNumber, "6919");
assert.equal(positions[0].latitude, 52.0177);
assert.equal(positions[0].sourceTimestampKnown, false,
  "when NS does not provide a position timestamp, the result must say so explicitly");
assert.equal(positions[0].observedAt, new Date(fetchedAt).toISOString(),
  "without a source timestamp, observedAt must be the feed-fetch time");
assert.equal(positions[0].speedKmh, 78.5);
assert.equal(positions[0].headingDeg, 110);
assert.equal(positions[1].trainNumber, "6920");
assert.equal(positions[1].sourceTimestampKnown, true);
assert.equal(positions[1].observedAt, "2026-10-20T07:19:50.000Z");
assert.equal(positions[1].ritId, "6920");

assert.deepEqual(
  normalizeNsLiveVehiclePositions({ payload: { unexpected: [] } }, fetchedAt),
  [],
  "normalizer returns no positions when it is given an unknown shape"
);
console.log("PASS: NS live train response normalization, duplicate handling, source timestamps and coordinate validation");
