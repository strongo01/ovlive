import assert from "node:assert/strict";

const baseUrl = (process.env.OVLIVE_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("nl-NL")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function verifyStopSearch(query, expectedStopName) {
  const url = new URL(baseUrl + "/api/geocode");
  url.searchParams.set("q", query);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.ok, true,
    "OVLive /api/geocode must succeed for " + query + " (HTTP " + response.status + ")");
  const body = await response.json();
  assert.ok(Array.isArray(body.features), "/api/geocode must return a FeatureCollection");

  const matchingStops = body.features.filter(feature =>
    feature.properties?.isTransitousStop === true &&
    normalize(feature.properties?.name) === normalize(expectedStopName)
  );
  assert.ok(matchingStops.length > 0,
    "Native Transitous stop search must find " + expectedStopName +
    "; returned results: " +
    body.features.map(feature =>
      (feature.properties?.name || "?") + " [" + (feature.properties?.source || "unknown") + "]"
    ).join("; "));

  const stop = matchingStops[0];
  assert.ok(typeof stop.properties.transitousId === "string" &&
    stop.properties.transitousId.length > 0,
    "The stop suggestion must include a real Transitous stop ID");
  assert.ok(Array.isArray(stop.geometry?.coordinates) && stop.geometry.coordinates.length === 2,
    "The stop suggestion must also include valid map coordinates");
  assert.equal(body.features[0]?.properties?.isTransitousStop, true,
    "Native Transitous stop suggestions must be ranked before ordinary map locations");
  console.log("PASS: " + expectedStopName + " is returned first as a native Transitous stop ID " +
    stop.properties.transitousId);
}

await verifyStopSearch("Klifrakplantsoen", "Klifrakplantsoen");
await verifyStopSearch("Taagdreef", "Taagdreef");
console.log("All live Transitous stop geocoding checks passed.");
