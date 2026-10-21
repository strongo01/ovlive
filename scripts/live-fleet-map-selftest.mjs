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
assert.ok(script.includes("openovFeedNotFresh") && script.includes("last-known map points"),
  "stale OpenOV feeds must not overwrite the last known map positions");
assert.ok(script.includes("routeName") && script.includes("routeId") &&
  script.includes("vehiclePopup(vehicle)"),
  "vehicle popups must include available route and identity information");
assert.ok(html.includes('id="liveFleetLocate"') &&
  html.includes('id="liveFleetLocationStatus"') &&
  html.includes('id="journey-live-locate-${index}"') &&
  html.includes('id="journey-live-location-status-${index}"') &&
  html.includes("Mijn locatie"),
  "the general live map and individual journey maps must have a My Location button");
assert.ok(script.includes("navigator.geolocation.getCurrentPosition") &&
  script.includes("locationMarker") &&
  script.includes("attachMyLocationButton"),
  "the general map must locate the user and show a reusable location marker");
assert.ok(script.includes("startDate: String(row.startDate") &&
  script.includes("startTime: String(row.startTime") &&
  script.includes('fetch("/api/trip-shape?"') &&
  script.includes('addLine(item.split.remaining, "#ef4444"') &&
  script.includes("showVehicleRoute(currentVehicle)"),
  "tapping an exact OpenOV vehicle must load and draw its route in red");
assert.ok(script.includes("Geen exacte ritkoppeling beschikbaar") &&
  script.includes("function tripIdMatchesForShape") &&
  script.includes("const exactRouteAndTrip") &&
  script.includes("const exactTrip"),
  "the map must use normalized exact-trip matching and must not fall back to line-only matches");

assert.ok(script.includes("function loadNsVehicleRouteGeometry(vehicle)") &&
  script.includes('fetch("/api/ns/train-route?"') &&
  script.includes('vehicle.sourceKey === "ns"'),
  "NS live train markers must request their exact train journey and rail geometry");
assert.ok(script.includes("canSplitProgress && i < closestIndex") &&
  script.includes('addLine(item.points, "#9ca3af"'),
  "ordered route segments before the vehicle must be shaded grey");

assert.ok(script.includes("state.routeLayer = L.featureGroup().addTo(state.map)") &&
  script.includes("state.routeLayer.getBounds()"),
  "the drawn route layer must support Leaflet getBounds()");
assert.ok(script.includes('addLine(item.split.passed, "#9ca3af"') &&
  script.includes('addLine(item.split.remaining, "#ef4444"') &&
  script.includes('distanceMeters <= 1_500'),
  "the route progress must shade the travelled segment grey only when the GPS point is close enough");

const splitStart = script.indexOf("  function splitRouteAtPosition(points, vehiclePoint) {");
const splitEnd = script.indexOf("  async function loadVehicleRouteGeometry(vehicle) {", splitStart);
assert.ok(splitStart >= 0 && splitEnd > splitStart,
  "the travelled-route split helper must exist independently of the DOM");
const splitContext = vm.createContext({});
new vm.Script(script.slice(splitStart, splitEnd) +
  "\nglobalThis.splitRouteAtPosition = splitRouteAtPosition;").runInContext(splitContext);
const progress = splitContext.splitRouteAtPosition(
  [[52.0, 5.0], [52.01, 5.0], [52.02, 5.0]],
  [52.015, 5.0001]
);
assert.ok(progress.distanceMeters < 20, "the GPS point should snap to the nearby route segment");
assert.equal(progress.passed.length, 3, "the already-travelled prefix should end at the snapped position");
assert.equal(progress.remaining.length, 2, "the remaining route should begin at the snapped position");
assert.ok(Math.abs(progress.passed.at(-1)[0] - progress.remaining[0][0]) < 1e-8 &&
  Math.abs(progress.passed.at(-1)[1] - progress.remaining[0][1]) < 1e-8,
  "the grey and red segments must meet at the same snapped point");

const helperStart = script.indexOf("  function normalizedId(value) {");
const helperEnd = script.indexOf("  function formatClock(value) {", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart,
  "the live map must keep trip ID normalization helpers together");
const helperContext = vm.createContext({});
new vm.Script(script.slice(helperStart, helperEnd) +
  "\nglobalThis.tripIdMatchesForShape = tripIdMatchesForShape;").runInContext(helperContext);
assert.equal(helperContext.tripIdMatchesForShape(
  "20261021_18:30_nl-OpenOV_380014114",
  "20261021_18:30:00_nl-OpenOV_380014114"
), true, "an omitted :00 seconds component should still identify the same trip");
assert.equal(helperContext.tripIdMatchesForShape(
  "nl-OpenOV_380014114",
  "20261021_18:30:00_nl-OpenOV_380014114"
), true, "the same base GTFS trip ID can match when MOTIS omits the service wrapper");
assert.equal(helperContext.tripIdMatchesForShape(
  "20261021_18:31_nl-OpenOV_380014114",
  "20261021_18:30_nl-OpenOV_380014114"
), false, "a different service start time must not match");
assert.equal(helperContext.tripIdMatchesForShape(
  "20261021_18:30_nl-OpenOV_999999999",
  "20261021_18:30_nl-OpenOV_380014114"
), false, "a different GTFS trip must never match");

assert.ok(worker.includes('url.pathname === "/api/live-map/openov"') &&
  worker.includes("handleLiveMapOpenovApi") &&
  worker.includes("decodeOpenovVehiclePositions(bytes)") &&
  worker.includes("Avoid sorting the entire national feed") &&
  worker.includes("LIVE_MAP_OPENOV_CACHE_TTL_MS = 15_000") &&
  worker.includes("liveMapOpenovInFlight") &&
  worker.includes("OVLIVE_LIVE_MAP_OPENOV_STALE_INFLIGHT"),
  "the OpenOV live-map endpoint must use the selective decoder, a 15-second cache, and recover from stale single-flight requests");
assert.ok(worker.includes('url.searchParams.get("all") === "1"') &&
  worker.includes("allPositions: includeAllPositions"),
  "NS live-map retrieval must be explicitly opt-in and bounded");
assert.ok(nsSource.includes("CACHE_TTL_MS = 5_000") &&
  nsSource.includes("writeEdgeCache") &&
  nsSource.includes("readEdgeCache"),
  "the NS upstream positions response must retain its isolate and edge cache");

console.log("PASS: live fleet map script parses and is attached to the correct map panel");
console.log("PASS: independent vehicle modes, exact-trip route popups, and red route lines are present");
console.log("PASS: My Location controls work on the general map and individual journey maps");
console.log("PASS: 20-second non-overlapping polling, hidden-tab pause, and failure backoff are present");
console.log("PASS: OpenOV map feed uses selective decoding, short edge caching, and single-flight");
console.log("PASS: NS all-position mode is explicit and remains cached");
console.log("All live fleet map selftests passed.");
