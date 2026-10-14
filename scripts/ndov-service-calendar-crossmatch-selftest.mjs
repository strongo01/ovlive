import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { matchOpenovRoutePattern } from "../src/ndov-plan-cancellation.js";

const root = process.env.OVLIVE_CROSSWALK_DIR;
if (!root) throw new Error("OVLIVE_CROSSWALK_DIR ontbreekt.");

const readJson = async (file) =>
  JSON.parse(await readFile(join(root, file), "utf8"));

const manifest = await readJson("manifest.json");
const calendar = await readJson("service-calendar.json");
const serviceDate = "20261013";
const activeRows = calendar[serviceDate];

assert.ok(Array.isArray(activeRows) && activeRows.length > 0);
const active = new Set(activeRows.map((id) => String(id)));

async function loadPatterns(routeId, tripId) {
  const routeBuckets = manifest.routesByStartBucket?.[routeId];
  let files = manifest.routes?.[routeId];
  let selectedBucket = null;

  if (routeBuckets && typeof routeBuckets === "object" && !Array.isArray(routeBuckets)) {
    const tripMatch = String(tripId ?? "").match(/^\d{8}_(\d{2}:\d{2})_/);
    assert.ok(tripMatch, `Geen vertrektijd gevonden in rit-ID: ${tripId}`);

    const hour = Number(tripMatch[1].slice(0, 2));
    const bucketHours = Number(manifest.timeBucketHours ?? 3);
    assert.ok(Number.isInteger(hour) && hour >= 0 && hour <= 99, `Ongeldig vertrekuur: ${hour}`);
    assert.ok(Number.isInteger(bucketHours) && bucketHours >= 1, `Ongeldige tijdblokgrootte: ${bucketHours}`);

    selectedBucket = String(Math.floor(hour / bucketHours) * bucketHours).padStart(2, "0");
    files = routeBuckets[selectedBucket];

    assert.ok(
      Array.isArray(files) && files.length > 0,
      `Route ${routeId} heeft geen bestanden voor tijdblok ${selectedBucket}.`
    );

    const allRouteFiles = manifest.routes?.[routeId];
    assert.ok(Array.isArray(allRouteFiles), `Route ${routeId} ontbreekt in manifest.routes.`);
    for (const filename of files) {
      assert.ok(
        allRouteFiles.includes(filename),
        `Tijdblokbestand ${filename} ontbreekt in de gewone routelijst.`
      );
    }

    console.log(
      `INDEX: route ${routeId}, vertrektijd ${tripMatch[1]}, tijdblok ${selectedBucket}, ${files.length} bestand(en)`
    );
  }

  assert.ok(Array.isArray(files) && files.length, `Route ${routeId} ontbreekt.`);

  const patterns = [];
  for (const filename of files) {
    const rows = await readJson(`routes/${filename}`);
    assert.ok(Array.isArray(rows), `${filename} is geen JSON-array.`);

    if (manifest.serviceIdsEmbedded === true) {
      assert.ok(
        rows.every((row) => row && Array.isArray(row.serviceIds)),
        `${filename} mist ingebedde serviceIds.`
      );
      patterns.push(...rows);
      continue;
    }

    if (Number(manifest.serviceCalendarDateCount ?? 0) > 0) {
      const sidecar = filename.replace(/\.json$/i, "-services.json");
      const services = await readJson(`routes/${sidecar}`);
      assert.ok(Array.isArray(services), `${sidecar} ontbreekt of is geen array.`);
      assert.equal(services.length, rows.length, `${sidecar} is niet uitgelijnd met ${filename}.`);

      for (let i = 0; i < rows.length; i++) {
        patterns.push({
          ...rows[i],
          serviceIds: Array.isArray(services[i]) ? services[i].map(String) : []
        });
      }
    } else {
      patterns.push(...rows);
    }
  }

  return patterns;
}

const cases = [
  {
    name: "Bus 73",
    route: "146903",
    expected: "CXX:U073:64",
    leg: {
      routeId: "nl-OpenOV_146903",
      tripId: "20261013_13:17_nl-OpenOV_391225466",
      headsign: "Maarssenbroek",
      directionId: "1",
      tripFrom: { stopId: "3924174", scheduledDeparture: "13:17:00" },
      tripTo: { stopId: "3925041", scheduledArrival: "14:21:00" },
      from: { stopId: "3924354", scheduledDeparture: "13:59:00" },
      to: { stopId: "3924361", scheduledArrival: "14:04:00" }
    }
  },
  {
    name: "Bus 48",
    route: "146897",
    expected: "CXX:U048:31",
    leg: {
      routeId: "nl-OpenOV_146897",
      tripId: "20261013_13:19_nl-OpenOV_391222110",
      headsign: "Maarssen",
      directionId: "0",
      tripFrom: { stopId: "3924637", scheduledDeparture: "13:19:00" },
      tripTo: { stopId: "3925042", scheduledArrival: "14:21:00" },
      from: { stopId: "3924352", scheduledDeparture: "14:03:00" },
      to: { stopId: "3924361", scheduledArrival: "14:08:00" }
    }
  },
  {
    name: "Bus 11",
    route: "146878",
    expected: "CXX:U011:30",
    leg: {
      routeId: "nl-OpenOV_146878",
      tripId: "20261013_13:31_nl-OpenOV_391209615",
      headsign: "Vleuten",
      directionId: "1",
      tripFrom: { stopId: "3924918", scheduledDeparture: "13:31:00" },
      tripTo: { stopId: "3924412", scheduledArrival: "14:07:00" },
      from: { stopId: "3924352", scheduledDeparture: "13:49:00" },
      to: { stopId: "3924329", scheduledArrival: "13:54:00" }
    }
  }
];

console.log(`Actieve services op ${serviceDate}: ${active.size}`);

for (const test of cases) {
  const patterns = await loadPatterns(test.route, test.leg.tripId);
  const before = matchOpenovRoutePattern(test.leg, patterns);
  const after = matchOpenovRoutePattern(test.leg, patterns, active);

  console.log(test.name, {
    zonderFilter: before.realtimeTripId ?? before.reason ?? null,
    metFilter: after.realtimeTripId ?? after.reason ?? null,
    actieveKandidaten: after.candidateCount ?? 1
  });

  assert.equal(after.realtimeTripId, test.expected, `${test.name}: geen unieke actieve match.`);
  console.log(`PASS: ${test.name} -> ${test.expected}`);
}

console.log("PASS: alle servicekalender-tests.");
