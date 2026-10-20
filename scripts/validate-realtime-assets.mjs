#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(repoRoot, "public");
const MAX_ASSETS_FREE = 20_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

async function walkFiles(directory, prefix = "") {
  const output = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(absolute, relative));
    else if (entry.isFile()) {
      const info = await stat(absolute);
      output.push({ relative, absolute, size: info.size });
    }
  }
  return output;
}

async function readJson(relative) {
  const text = await readFile(path.join(publicRoot, relative), "utf8");
  return JSON.parse(text);
}

function addRequired(required, file) {
  const normalized = String(file ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Ongeldig assetpad in manifest: " + String(file));
  }
  required.add(normalized);
}

async function main() {
  const allFiles = await walkFiles(publicRoot);
  const byPath = new Map(allFiles.map((file) => [file.relative, file]));
  const required = new Set();
  const optional = new Set();
  const notes = [];

  if (!byPath.has("index.html")) throw new Error("public/index.html ontbreekt.");

  const routeManifestPath = "ndov-openov-route-crosswalk/manifest.json";
  const tripManifestPath = "ndov-trip-crosswalk/manifest.json";
  if (!byPath.has(routeManifestPath)) {
    throw new Error("Verplichte NDOV-route-index ontbreekt: public/" + routeManifestPath);
  }
  if (!byPath.has(tripManifestPath)) {
    throw new Error("Verplichte GTFS-NL-trip-crosswalk ontbreekt: public/" + tripManifestPath);
  }

  const routeManifest = await readJson(routeManifestPath);
  const routes = routeManifest?.routes;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
    throw new Error("NDOV-route-index heeft geen geldig routes-object.");
  }
  addRequired(required, routeManifestPath);

  const routeMetadataPath = "ndov-openov-route-crosswalk/route-metadata.json";
  if (!byPath.has(routeMetadataPath)) {
    throw new Error(
      "OpenOV openbare lijnnamen ontbreken: public/" + routeMetadataPath +
      ". Run npm run ndov:build-openov-route-metadata en voer de controle opnieuw uit."
    );
  }
  const routeMetadata = await readJson(routeMetadataPath);
  const publicRoutes = routeMetadata?.routes;
  if (routeMetadata?.format !== 1 || !publicRoutes ||
      typeof publicRoutes !== "object" || Array.isArray(publicRoutes)) {
    throw new Error("OpenOV route-metadata heeft geen geldig routes-object of ondersteund formaat.");
  }
  const routeMetadataMissing = Object.keys(routes).filter((routeId) =>
    !publicRoutes[String(routeId)] || typeof publicRoutes[String(routeId)] !== "object"
  );
  if (routeMetadataMissing.length) {
    throw new Error(
      "OpenOV route-metadata mist " + routeMetadataMissing.length +
      " route-ID('s), bijvoorbeeld: " + routeMetadataMissing.slice(0, 8).join(", ") +
      ". Run npm run ndov:build-openov-route-metadata en voer de controle opnieuw uit."
    );
  }
  addRequired(required, routeMetadataPath);

  const routeShardNames = new Set();
  for (const [routeId, filenames] of Object.entries(routes)) {
    if (!Array.isArray(filenames) || filenames.length === 0) {
      throw new Error("Route " + routeId + " heeft geen route-shards in de manifest.");
    }
    for (const rawFilename of filenames) {
      const filename = String(rawFilename ?? "").trim();
      if (!filename || filename.includes("/") || filename.includes("..")) {
        throw new Error("Ongeldige route-shardnaam voor route " + routeId + ": " + filename);
      }
      routeShardNames.add(filename);
      addRequired(required, "ndov-openov-route-crosswalk/routes/" + filename);
      if (Number(routeManifest.serviceCalendarDateCount ?? 0) > 0 &&
          routeManifest.serviceIdsEmbedded !== true) {
        addRequired(required, "ndov-openov-route-crosswalk/routes/" +
          filename.replace(/\.json$/i, "-services.json"));
      }
    }
  }
  if (Number(routeManifest.serviceCalendarDateCount ?? 0) > 0) {
    addRequired(required, "ndov-openov-route-crosswalk/service-calendar.json");
  }

  const tripManifest = await readJson(tripManifestPath);
  const tripShards = Array.isArray(tripManifest?.shards) ? tripManifest.shards : [];
  if (!tripShards.length) throw new Error("GTFS-NL-trip-crosswalk heeft geen shardlijst in de manifest.");
  addRequired(required, tripManifestPath);
  for (const prefix of tripShards) {
    const clean = String(prefix ?? "").trim();
    if (!/^\d+$/.test(clean)) throw new Error("Ongeldig GTFS-NL-shardprefix: " + clean);
    addRequired(required, "ndov-trip-crosswalk/trips-" + clean + ".json");
  }

  // These stop maps improve KV78 platform validation. KV6 exact-trip observations
  // can still be displayed without them, so they warn instead of blocking deploy.
  const stopManifestPath = "ndov-stop-crosswalk/manifest.json";
  if (byPath.has(stopManifestPath)) {
    try {
      const manifest = await readJson(stopManifestPath);
      const shardPaths = Array.isArray(manifest?.shards) ? manifest.shards : [];
      for (const file of shardPaths) addRequired(optional, "ndov-stop-crosswalk/" + String(file).replace(/^\/+/, ""));
      if (!shardPaths.length) notes.push("PSA/CHB-haltecrosswalk heeft geen shardlijst.");
    } catch (error) {
      notes.push("PSA/CHB-haltecrosswalk kon niet worden gelezen: " + (error instanceof Error ? error.message : String(error)));
    }
  } else notes.push("PSA/CHB-haltecrosswalk ontbreekt; KV78-haltezijde kan niet volledig worden bevestigd.");

  const stopPlaceManifestPath = "ndov-openov-stopplace-crosswalk/manifest.json";
  if (byPath.has(stopPlaceManifestPath)) {
    try {
      const manifest = await readJson(stopPlaceManifestPath);
      const count = Number(manifest?.shardCount);
      if (!Number.isInteger(count) || count < 1 || count > 256) {
        notes.push("OpenOV/CHB-stopplaatscrosswalk heeft een ongeldige shardCount.");
      } else {
        addRequired(optional, stopPlaceManifestPath);
        for (let index = 0; index < count; index += 1) {
          addRequired(optional, "ndov-openov-stopplace-crosswalk/shards/openov-stop-places-" + index + ".json");
        }
      }
    } catch (error) {
      notes.push("OpenOV/CHB-stopplaatscrosswalk kon niet worden gelezen: " + (error instanceof Error ? error.message : String(error)));
    }
  } else notes.push("OpenOV/CHB-stopplaatscrosswalk ontbreekt; haltevergelijking heeft minder haltecontext.");

  const missingRequired = [...required].filter((file) => !byPath.has(file));
  const missingOptional = [...optional].filter((file) => !byPath.has(file));
  const tooLarge = allFiles.filter((file) => file.size > MAX_ASSET_BYTES);
  const totalBytes = allFiles.reduce((sum, file) => sum + file.size, 0);

  console.log(JSON.stringify({
    check: "realtime-static-asset-preflight",
    generatedAt: routeManifest.generatedAt ?? null,
    routeCount: Object.keys(routes).length,
    routeShardCount: routeShardNames.size,
    requiredRouteFiles: [...required].filter((file) => file.startsWith("ndov-openov-route-crosswalk/routes/")).length,
    tripCrosswalkShardCount: tripShards.length,
    staticAssetCount: allFiles.length,
    staticAssetMiB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
    freePlanFileLimit: MAX_ASSETS_FREE,
    missingRequiredCount: missingRequired.length,
    missingRequiredSamples: missingRequired.slice(0, 20),
    missingOptionalCount: missingOptional.length,
    missingOptionalSamples: missingOptional.slice(0, 10),
    oversizedCount: tooLarge.length,
    oversizedSamples: tooLarge.slice(0, 10).map((file) => ({
      path: file.relative,
      MiB: Math.round(file.size / 1024 / 1024 * 100) / 100,
    })),
    notes,
  }, null, 2));

  if (allFiles.length > MAX_ASSETS_FREE) {
    throw new Error("public/ bevat " + allFiles.length + " bestanden; Workers Free staat maximaal " + MAX_ASSETS_FREE + " assets per Worker-versie toe.");
  }
  if (tooLarge.length) throw new Error(tooLarge.length + " asset(s) zijn groter dan 25 MiB.");
  if (missingRequired.length) {
    const missingRouteFile = missingRequired.some((file) => file.startsWith("ndov-openov-route-crosswalk/routes/"));
    const missingRouteMetadata = missingRequired.includes("ndov-openov-route-crosswalk/route-metadata.json");
    const advice = missingRouteMetadata
      ? "Run npm run ndov:build-openov-route-metadata met gtfs-openov-nl.zip in ~/Library/Caches/ovlive-ndov/ en voer de controle opnieuw uit."
      : missingRouteFile
        ? "Run npm run ndov:build-openov-route-crosswalk met gtfs-openov-nl.zip in ~/Library/Caches/ovlive-ndov/ en voer de controle opnieuw uit."
        : "Run npm run ndov:build-crosswalk met gtfs-nl.zip in ~/Library/Caches/ovlive-ndov/ en voer de controle opnieuw uit.";
    throw new Error(missingRequired.length + " verplichte realtime-asset(s) ontbreken. Deployment afgebroken om een Worker zonder NDOV-koppelingen te voorkomen. " + advice);
  }

  for (const note of notes) console.warn("WAARSCHUWING: " + note);
  if (missingOptional.length) {
    console.warn("WAARSCHUWING: " + missingOptional.length + " optionele haltecrosswalk-asset(s) ontbreken; KV6/live ritmatching kan nog werken, maar halte-/platformverificatie is beperkt.");
  }
  console.log("PASS: verplichte NDOV realtime-assets zijn compleet; deployment mag doorgaan.");
}

main().catch((error) => {
  console.error("REALTIME ASSET-PREFLIGHT MISLUKT: " + (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
