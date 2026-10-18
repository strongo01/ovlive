function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("nl-NL")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueParts(values) {
  const seen = new Set();
  return values
    .map(value => String(value ?? "").trim())
    .filter(value => {
      if (!value) return false;
      const key = normalizeName(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Convert official MOTIS/Transitous geocoding STOP matches to the same
 * FeatureCollection format that the existing map geocoder uses. Crucially,
 * transitousId preserves the provider's stop identifier for /api/v6/plan.
 */
export function transitousMatchesToFeatureCollection(matches) {
  const features = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    if (String(match?.type ?? "").toUpperCase() !== "STOP") continue;
    const id = String(match?.id ?? "").trim();
    const name = String(match?.name ?? "").trim();
    const lat = Number(match?.lat);
    const lon = Number(match?.lon);
    if (!id || !name ||
        !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const areas = Array.isArray(match?.areas)
      ? match.areas.map(area => area?.name).filter(Boolean)
      : [];
    const displayName = uniqueParts([
      name,
      match?.street,
      match?.houseNumber,
      match?.zip,
      ...areas
    ]).join(", ");
    const modes = Array.isArray(match?.modes)
      ? [...new Set(match.modes.map(mode => String(mode ?? "").trim().toUpperCase()).filter(Boolean))]
      : [];

    features.push({
      type: "Feature",
      properties: {
        source: "Transitous",
        transitousId: id,
        isTransitousStop: true,
        type: "STOP",
        osm_value: "transit_stop",
        category: match?.category ?? null,
        name,
        street: match?.street ?? null,
        housenumber: match?.houseNumber ?? null,
        postcode: match?.zip ?? null,
        city: areas[0] ?? null,
        display_name: displayName || name,
        modes
      },
      geometry: {
        type: "Point",
        coordinates: [lon, lat]
      }
    });
  }
  return { type: "FeatureCollection", features };
}

function isMapTransportStop(feature) {
  const p = feature?.properties ?? {};
  const description = [
    p.osm_key, p.osm_value, p.type, p.category
  ].filter(Boolean).join(" ").toLocaleLowerCase("nl-NL");
  return /(bus_stop|tram_stop|stop_position|platform|station|public_transport|transit_stop)/.test(description);
}

/**
 * Put real Transitous stops first. Keep address/POI coordinate search working,
 * but remove duplicate OpenStreetMap stop pins by exact normalized stop name
 * when Transitous has a real stop ID for that same named stop.
 */
export function mergeTransitousAndMapFeatureCollections(transitousData, mapData) {
  const transitousFeatures = Array.isArray(transitousData?.features)
    ? transitousData.features.filter(feature =>
        feature?.properties?.isTransitousStop === true &&
        typeof feature?.properties?.transitousId === "string" &&
        Array.isArray(feature?.geometry?.coordinates)
      )
    : [];
  const mapFeatures = Array.isArray(mapData?.features)
    ? mapData.features.filter(feature =>
        feature?.properties && Array.isArray(feature?.geometry?.coordinates)
      )
    : [];
  const transitousStopNames = new Set(
    transitousFeatures.map(feature => normalizeName(feature.properties.name)).filter(Boolean)
  );
  const remainingMapFeatures = mapFeatures.filter(feature => {
    if (!isMapTransportStop(feature)) return true;
    const name = normalizeName(feature.properties?.name);
    return !name || !transitousStopNames.has(name);
  });
  return {
    type: "FeatureCollection",
    features: [...transitousFeatures, ...remainingMapFeatures]
  };
}
