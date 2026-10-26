import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/openov-live-map-sampling.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = "data:text/javascript;base64," +
  Buffer.from(compiled).toString("base64");
const { selectDiverseOpenovLiveMapPositions } = await import(moduleUrl);

// The feed is grouped by operator/route: thousands of buses can precede the
// Utrecht tram records. Sampling route groups must still retain the tram routes.
const buses = Array.from({ length: 2500 }, (_, index) => ({
  entityId: `bus-entity-${index}`,
  vehicleId: `bus-${index}`,
  routeId: `nl-OpenOV_bus-route-${Math.floor(index / 20)}`,
  mode: "bus"
}));
const trams = Array.from({ length: 12 }, (_, index) => ({
  entityId: `tram-entity-${index}`,
  vehicleId: `tram-${index}`,
  routeId: [ "uov-tram-20", "nl-OpenOV_uov-tram-21", "uov-tram-22" ][Math.floor(index / 4)],
  mode: "tram"
}));
const allPositions = [...buses, ...trams];
const sampled = selectDiverseOpenovLiveMapPositions(allPositions, 2000);

assert.equal(sampled.length, 2000);
assert.ok(sampled.some((position) => position.mode === "tram" && position.routeId === "uov-tram-22"),
  "tram route 22 near Utrecht Science Park must not disappear behind earlier bus entries");
assert.ok(sampled.some((position) => position.mode === "tram" && position.routeId === "uov-tram-20"));
assert.ok(sampled.some((position) => position.mode === "tram" && position.routeId === "nl-OpenOV_uov-tram-21"));
assert.equal(new Set(sampled).size, sampled.length, "sampling must not duplicate vehicle entries");

// If there are more unique routes than available slots, select evenly across
// the full feed instead of dropping every route after the first 2,000.
const manyRoutes = Array.from({ length: 2200 }, (_, index) => ({
  entityId: `entity-${index}`,
  routeId: `route-${index}`
}));
const routeSample = selectDiverseOpenovLiveMapPositions(manyRoutes, 2000);
assert.equal(routeSample.length, 2000);
assert.equal(routeSample[0].routeId, "route-0");
assert.equal(routeSample.at(-1).routeId, "route-2199",
  "the tail of the source feed must be represented when route groups exceed the cap");

// Small feeds remain complete and retain their original order.
assert.deepEqual(
  selectDiverseOpenovLiveMapPositions(allPositions.slice(0, 8), 2000),
  allPositions.slice(0, 8)
);
assert.deepEqual(selectDiverseOpenovLiveMapPositions(allPositions, 0), []);

console.log("PASS: national live-map sampling preserves U-OV tram routes after bus-heavy feed sections");
console.log("PASS: sampling covers both the beginning and end of feeds with over 2,000 distinct route groups");
console.log("PASS: small feeds remain complete and entries are never duplicated");
