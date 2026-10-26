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
assert.ok(script.includes('const POLL_MS = 30_000;'),
  "the country-wide vehicle map must poll at roughly 30 seconds");
assert.ok(script.includes('const MAX_POSITION_AGE_SECONDS = 300;'),
  "positions up to five minutes old remain visible instead of vanishing after two minutes");
assert.ok(worker.includes('vehiclePositions: "https://gtfs.ovapi.nl/nl/vehiclePositions.pb"'),
  "the live map must use the current NDOV/OVapi position feed rather than the stale 2018 OpenOV endpoint");
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
assert.ok(script.includes("const backoff = [30_000, 45_000, 60_000, 90_000]"),
  "repeated full failures must apply progressive retry backoff");
assert.ok(script.includes('marker.setOpacity(vehicle.ageSeconds > 120 ? 0.45 : (state.sourceStatus[vehicle.sourceKey]?.ok ? 1 : 0.35))'),
  "older positions must remain visible but fade after two minutes; unavailable sources also fade");
assert.ok(script.includes("function markerZIndexOffset(mode)") &&
  script.includes('if (mode === "tram") return 2400;') &&
  script.includes("zIndexOffset: markerZIndexOffset(vehicle.mode)") &&
  script.includes("marker.setZIndexOffset(markerZIndexOffset(vehicle.mode))"),
  "tram markers must render above overlapping bus markers, both on creation and refresh");
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
assert.ok(script.includes("function renderVehicleStopTimeline") &&
  script.includes("state.routeStopDetails") &&
  script.includes("function stopProgressForVehicle") &&
  script.includes("GPS-inschatting") &&
  script.includes("function loadRealtimeStopUpdates") &&
  script.includes('kind: "tripUpdates"') &&
  script.includes('fetch("/api/realtime?"') &&
  script.includes('const stopTimelineElement = $("liveFleetStopTimeline")') &&
  script.includes("function renderSelectedStopTimeline()") &&
  script.includes("renderSelectedStopTimeline();"),
  "selecting a live vehicle must render its ordered stops in the separate panel beneath the map and load exact-trip realtime stop predictions");
assert.ok(html.includes('id="liveFleetStopTimeline"') &&
  html.indexOf('id="liveFleetStopTimeline"') > html.indexOf('id="liveFleetMap"') &&
  html.includes(".live-fleet-stop-panel[hidden]") &&
  html.includes("grid-template-columns:repeat(auto-fit"),
  "the stop timeline must live below the map in a responsive, hidden-until-selected panel rather than in marker popups");
const vehiclePopupStart = script.indexOf("function vehiclePopup(vehicle)");
const vehiclePopupEnd = script.indexOf("function markerIcon", vehiclePopupStart);
const vehiclePopupSource = script.slice(vehiclePopupStart, vehiclePopupEnd);
assert.ok(vehiclePopupStart >= 0 && vehiclePopupEnd > vehiclePopupStart &&
  !vehiclePopupSource.includes("renderVehicleStopTimeline(vehicle)"),
  "stop details must not make the map marker popup tall or cluttered");
assert.ok(worker.includes("latitude: stopLatitude") &&
  worker.includes("longitude: stopLongitude") &&
  worker.includes("place.lat") &&
  worker.includes("place.lon"),
  "exact trip stop data must preserve stop coordinates so the live map can estimate progress without inventing stop order");
assert.ok(worker.includes("const tripUpdateFilters") &&
  worker.includes("vehiclePositionFilters ?? tripUpdateFilters"),
  "selected vehicle stop predictions must use targeted trip-update decoding instead of decoding the whole realtime feed");
assert.ok(html.includes(".live-fleet-stop-timeline") &&
  html.includes(".live-fleet-stop-list") &&
  html.includes(".live-fleet-stop.is-passed") &&
  html.includes(".live-fleet-stop.is-estimated") &&
  script.includes("Dienstregeling (niet bevestigd)"),
  "live-map stop timeline must distinguish GPS-estimated progress from unconfirmed timetable-only progress");

assert.ok(script.includes("Geen exacte ritkoppeling beschikbaar") &&
  script.includes("function tripIdMatchesForShape") &&
  script.includes("payload.requestedTripId") &&
  script.includes("payload.resolvedTripId") &&
  script.includes("tripIdMatchesForShape(resolvedTripId, identity.tripId)"),
  "the map must validate the exact trip request/resolution before drawing route geometry");
assert.ok(worker.includes("selectOpenovPositionsWithTramPriority") &&
  worker.includes("getLiveMapTramRouteIds(env)") &&
  worker.includes("ndov-openov-route-crosswalk/route-metadata.json") &&
  worker.includes("validTramPositionCount") &&
  worker.includes("returnedTramPositionCount") &&
  worker.includes("validPositions.length,\n        tramRouteIds") &&
  !worker.includes(".slice(0, LIVE_MAP_OPENOV_MAX_POSITIONS)"),
  "the current NDOV feed must return all valid positions and retain tram metrics");

assert.ok(script.includes('return mode !== "WALK" && mode !== "FOOT";') &&
  !script.includes("candidate.modeMatches && candidate.points.length > 1"),
  "verified exact-trip geometry must not be discarded by inconsistent per-leg mode labels");
assert.ok(!script.includes("candidate.candidateRouteId === identity.routeId"),
  "the map must not discard exact-trip geometry merely because route metadata IDs differ");

assert.ok(worker.includes("Array.isArray(leg.legGeometry?.coordinates)") &&
  worker.includes("leg.legGeometry.coordinates.length > 1"),
  "the trip-shape endpoint must preserve GeoJSON LineString geometry for native map clients");

assert.ok(worker.includes("sawSuccessfulReplyWithoutGeometry = true") &&
  worker.includes("if (shapes.length > 0)") &&
  worker.includes("if (candidateResponse?.ok)") &&
  worker.includes("openovTripShapeIdCandidates(tripId)"),
  "trip-shape lookup must try other exact ID spellings when Transitous returns HTTP 200 without geometry");

assert.ok(worker.includes("Transitous beperkt tijdelijk het aantal routevragen (HTTP 429)") &&
  worker.includes("Transitous weigert de aangeleverde rit-ID (HTTP 400)") &&
  worker.includes("Transitous reageerde niet op de routevraag (netwerkfout of time-out)") &&
  worker.includes("candidateCount: boundedCandidates.length"),
  "trip-shape failures must expose actionable upstream status instead of hiding every failure behind one generic message");

assert.ok(worker.includes("if (candidateResponse?.status === 429)") &&
  !worker.includes("candidateResponse.status >= 500 || candidateResponse.status === 429"),
  "an upstream HTTP 429 must stop route-ID retries instead of amplifying rate limits");

assert.ok(worker.includes("async function findOpenovStaticTripShape(") &&
  worker.includes("findOpenovStaticTripShape(env, tripId, routeId)") &&
  worker.includes('routeSource: "OpenOV GTFS-static (exact trip-ID + route-ID)"') &&
  worker.includes("shard.trips[tripId]") &&
  worker.includes("shard.shapes[shapeId]"),
  "when Transitous has a stale trip index, route geometry may only fall back to an exact local GTFS trip_id + route_id match");

assert.ok(worker.includes("const extractTransitStops") &&
  worker.includes("normalizeTransitousLineSearchStops(leg)") &&
  worker.includes('source: "Transitous timetable"') &&
  worker.includes('stopTimesSource: "Transitous timetable; realtime stop predictions are not implied"'),
  "the exact trip-shape API must expose clearly labelled timetable stops as a fallback when realtime stop updates are missing");
assert.ok(worker.includes("let timetableStops: Array<Record<string, any>> = []") &&
  worker.includes("stops: timetableStops") &&
  worker.includes("candidateStops.length > timetableStops.length"),
  "the exact-trip timetable fallback must survive even if route geometry cannot be returned");

assert.ok(script.includes("routeId: identity.routeId") &&
  script.includes("state.routeSourceCache") &&
  script.includes("state.routeSource = String(payload.routeSource ?? \"\")"),
  "the website must send the exact route ID and retain geometry source metadata with its route cache");

assert.ok(worker.includes("const rawDetail = await candidateResponse.clone().text().catch(() => \"\")") &&
  worker.includes("lastUpstreamDetail = String(rawDetail ?? \"\")") &&
  worker.includes(".slice(0, 280)") &&
  worker.includes("upstreamDetail: lastUpstreamDetail || null"),
  "a short, bounded upstream error body must be visible when Transitous rejects a trip request");

assert.ok(worker.includes("if (!boundedCandidates.length)") &&
  worker.includes("De rit-ID moet een volledige dienstdatum, starttijd en OpenOV-trip-ID bevatten.") &&
  worker.includes("candidateDiagnostics.push") &&
  worker.includes("const attemptSummary = candidateDiagnostics"),
  "trip lookup must reject incomplete IDs and preserve the response from canonical ID attempts");


assert.ok(script.includes("function loadNsVehicleRouteGeometry(vehicle)") &&
  script.includes('fetch("/api/ns/train-route?"') &&
  script.includes('vehicle.sourceKey === "ns"'),
  "NS live train markers must request their exact train journey and rail geometry");
assert.ok(script.includes("canSplitProgress && i < closestIndex") &&
  script.includes('addLine(item.points, "#9ca3af"'),
  "ordered route segments before the vehicle must be shaded grey");

assert.ok(script.includes("state.routeLayer = L.featureGroup().addTo(state.map)") &&
  script.includes("state.routeLayer.clearLayers()") &&
  !script.includes("state.map.fitBounds("),
  "selecting a vehicle must draw the route without automatically zooming the map out to fit the full route");
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
  worker.includes("LIVE_MAP_OPENOV_CACHE_TTL_MS = 30_000") &&
  worker.includes("liveMapOpenovInFlight") &&
  worker.includes("OVLIVE_LIVE_MAP_OPENOV_STALE_INFLIGHT"),
  "the NDOV/OVapi live-map endpoint must use the selective decoder, a 30-second cache, and recover from stale single-flight requests");
assert.ok(worker.includes('url.searchParams.get("all") === "1"') &&
  worker.includes("allPositions: includeAllPositions"),
  "NS live-map retrieval must be explicitly opt-in and bounded");
assert.ok(nsSource.includes("CACHE_TTL_MS = 5_000") &&
  nsSource.includes("writeEdgeCache") &&
  nsSource.includes("readEdgeCache"),
  "the NS upstream positions response must retain its isolate and edge cache");

// Native OVLive needs the exact OVAPI journey, not a line-wide top-N result.
assert.ok(worker.includes('url.searchParams.get("tripNumber")') &&
  worker.includes('url.searchParams.get("operatorCode")') &&
  worker.includes("journeyNumber.toLocaleLowerCase") &&
  worker.includes("operatorCode.toLocaleLowerCase"),
  "line search must support exact trip-number and operator-code filters");
assert.ok(worker.includes("ovapiLineResultsFound || requestedTripNumber"),
  "an exact journey lookup must not silently fall back to a different OpenOV journey");
assert.ok(worker.includes("Keep every stop not marked passed/cancelled") &&
  worker.includes('orderedStops.filter((stop) => !["PASSED", "CANCEL", "CANCELLED"]') &&
  !worker.includes("orderedStops.slice(currentIndex)"),
  "the OVAPI trip timeline must keep upcoming stops that are not explicitly passed or cancelled");

console.log("PASS: live fleet map script parses and is attached to the correct map panel");
console.log("PASS: independent vehicle modes, exact-trip route popups, and red route lines are present");
console.log("PASS: My Location controls work on the general map and individual journey maps");
console.log("PASS: 30-second non-overlapping polling, hidden-tab pause, and failure backoff are present");
console.log("PASS: OpenOV map feed uses selective decoding, short edge caching, and single-flight");
console.log("PASS: NS all-position mode is explicit and remains cached");
console.log("All live fleet map selftests passed.");
