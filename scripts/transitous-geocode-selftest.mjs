import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  transitousMatchesToFeatureCollection,
  mergeTransitousAndMapFeatureCollections
} from "../src/transitous-geocode.js";

const stopMatches = [
  {
    type: "STOP",
    id: "nl-OpenOV_3924329",
    name: "Klifrakplantsoen",
    lat: 52.07321,
    lon: 5.04567,
    zip: "3544 RR",
    street: "Langerakbaan",
    areas: [{ name: "Utrecht", adminLevel: 8 }],
    modes: ["BUS"]
  },
  {
    type: "ADDRESS",
    id: "not-a-stop-id",
    name: "Klifrakplantsoen 1",
    lat: 52.0732,
    lon: 5.0456
  },
  {
    type: "STOP",
    id: "invalid-coordinates",
    name: "Invalid stop",
    lat: 999,
    lon: 5
  }
];

const transitous = transitousMatchesToFeatureCollection(stopMatches);
assert.equal(transitous.features.length, 1, "only usable STOP records should become official transit stops");
const stop = transitous.features[0];
assert.equal(stop.properties.transitousId, "nl-OpenOV_3924329",
  "the actual Transitous stop ID must be preserved");
assert.equal(stop.properties.isTransitousStop, true);
assert.equal(stop.properties.name, "Klifrakplantsoen");
assert.deepEqual(stop.geometry.coordinates, [5.04567, 52.07321]);
assert.deepEqual(stop.properties.modes, ["BUS"]);
assert.ok(stop.properties.display_name.includes("Utrecht"));
console.log("PASS: native Transitous stop IDs and coordinates are retained");

const mapData = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Klifrakplantsoen", osm_key: "highway", osm_value: "bus_stop" },
      geometry: { type: "Point", coordinates: [5.04568, 52.07322] }
    },
    {
      type: "Feature",
      properties: { name: "Taagdreef", osm_key: "highway", osm_value: "bus_stop" },
      geometry: { type: "Point", coordinates: [5.081, 52.102] }
    },
    {
      type: "Feature",
      properties: { name: "Taagdreef", osm_key: "place", osm_value: "house" },
      geometry: { type: "Point", coordinates: [5.082, 52.103] }
    }
  ]
};

const merged = mergeTransitousAndMapFeatureCollections(transitous, mapData);
assert.equal(merged.features.length, 3,
  "the duplicate map stop should be removed while the unmatched map stop and address remain");
assert.equal(merged.features[0].properties.transitousId, "nl-OpenOV_3924329",
  "official Transitous stops must appear first");
assert.deepEqual(
  merged.features.slice(1).map(feature => feature.properties.name),
  ["Taagdreef", "Taagdreef"]
);
assert.equal(merged.features.some(feature =>
  feature.properties.osm_value === "bus_stop" &&
  feature.properties.name === "Klifrakplantsoen"
), false, "a duplicate OSM bus-stop option should not compete with the real Transitous stop");
console.log("PASS: official stop suggestions are first and duplicate map-stop suggestions are suppressed");

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
assert.ok(html.includes("const transitousId = String(p.transitousId || '').trim();"),
  "the UI must read the official stop ID");
assert.ok(html.includes("const optionValue = transitousId || ("),
  "a Transitous stop must submit its native ID rather than lat/lon");
assert.ok(html.includes("data-provider=\"${transitousId ? 'transitous' : 'coordinates'}\""),
  "the location result must identify whether it uses a stop ID or map coordinates");
assert.ok(html.includes("validItineraryCandidates.slice(0, 8)"),
  "the UI must not hide a sixth valid journey when six results were returned");
console.log("PASS: place selection uses exact stop IDs and the planner can show up to eight returned options");
console.log("All Transitous stop geocoding selftests passed.");
