import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../public/live-fleet-map.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const nsSource = await readFile(new URL("../src/ns-live-vehicle-positions.ts", import.meta.url), "utf8");

assert.doesNotThrow(() => new vm.Script(script, { filename: "public/live-fleet-map.js" }),
  "live fleet map JavaScript must parse");
assert.ok(html.includes('id="liveFleetMapPanel"') && html.includes('id="liveFleetMap"'),
  "the live fleet map panel and map element must exist");
assert.ok(html.includes('/live-fleet-map.js'),
  "the live fleet map script must be loaded by the page");
assert.ok(html.includes('data-live-fleet-mode="train"') &&
  html.includes('data-live-fleet-mode="bus"') &&
  html.includes('data-live-fleet-mode="tram"') &&
  html.includes('data-live-fleet-mode="metro"') &&
  html.includes('data-live-fleet-mode="ferry"'),
  "the map must provide filters for train, bus, tram, metro, and ferry");
assert.ok(script.includes('const POLL_MS = 20_000;'),
  "the country-wide vehicle map must use a conservative 20-second poll");
assert.ok(script.includes("if (state.refreshing || state.destroyed) return;"),
  "manual and automatic refreshes must not overlap");
assert.ok(script.includes("Promise.allSettled([") &&
  script.includes('requestJson(OPENOV_ENDPOINT)') &&
  script.includes('requestJson(NS_ENDPOINT)'),
  "OpenOV and NS position requests must fail independently");
assert.ok(script.includes('"/api/live-map/openov"') &&
  script.includes('"/api/ns/vehicle-positions?all=1"'),
  "the map must use its dedicated OpenOV endpoint and capped NS all-position endpoint");
assert.ok(script.includes("if (document.hidden && !manual) return;") &&
  script.includes('document.addEventListener("visibilitychange"'),
  "automatic refresh must pause while the browser tab is hidden");
assert.ok(script.includes("const backoff = [20_000, 30_000, 45_000, 60_000]"),
  "repeated full failures must apply progressive retry backoff");
assert.ok(script.includes('setOpacity(state.sourceStatus[vehicle.sourceKey]?.ok ? 1 : 0.35)'),
  "last-known markers must visibly fade when their source is unavailable");
assert.ok(script.includes("marker.setLatLng([vehicle.latitude, vehicle.longitude])"),
  "existing markers must be moved instead of rebuilding the entire Leaflet map");
assert.ok(script.includes("routeName") && script.includes("routeId") &&
  script.includes("vehiclePopup(vehicle)"),
  "vehicle popups must include available route and identity information");

assert.ok(worker.includes('url.pathname === "/api/live-map/openov"') &&
  worker.includes("handleLiveMapOpenovApi") &&
  worker.includes("decodeOpenovVehiclePositions(bytes)") &&
  worker.includes("LIVE_MAP_OPENOV_CACHE_TTL_MS = 15_000") &&
  worker.includes("liveMapOpenovInFlight"),
  "the OpenOV live-map endpoint must use the selective decoder, a 15-second cache, and single-flight");
assert.ok(worker.includes('url.searchParams.get("all") === "1"') &&
  worker.includes("allPositions: includeAllPositions"),
  "NS live-map retrieval must be explicitly opt-in and bounded");
assert.ok(nsSource.includes("CACHE_TTL_MS = 5_000") &&
  nsSource.includes("writeEdgeCache") &&
  nsSource.includes("readEdgeCache"),
  "the NS upstream positions response must retain its isolate and edge cache");

console.log("PASS: live fleet map script parses and is attached to the correct map panel");
console.log("PASS: independent vehicle modes and line/vehicle popups are present");
console.log("PASS: 20-second non-overlapping polling, hidden-tab pause, and failure backoff are present");
console.log("PASS: OpenOV map feed uses selective decoding, short edge caching, and single-flight");
console.log("PASS: NS all-position mode is explicit and remains cached");
console.log("All live fleet map selftests passed.");
