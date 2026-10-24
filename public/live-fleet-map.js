(() => {
  "use strict";

  const POLL_MS = 20_000;
  const MAX_POSITION_AGE_SECONDS = 120;
  const OPENOV_ENDPOINT = "/api/live-map/openov";
  const NS_ENDPOINT = "/api/ns/vehicle-positions?all=1";
  const ROUTE_METADATA_ENDPOINT = "/ndov-openov-route-crosswalk/route-metadata.json";

  const MODES = {
    train:  { label: "trein", emoji: "🚆", color: "#2563eb" },
    bus:    { label: "bus", emoji: "🚌", color: "#15803d" },
    tram:   { label: "tram", emoji: "🚊", color: "#ea580c" },
    metro:  { label: "metro", emoji: "🚇", color: "#7c3aed" },
    ferry:  { label: "veerboot", emoji: "⛴️", color: "#0891b2" },
    other:  { label: "overig/onbekend", emoji: "❔", color: "#64748b" }
  };

  const $ = (id) => document.getElementById(id);
  const panel = $("liveFleetMapPanel");
  const mapElement = $("liveFleetMap");
  const statusElement = $("liveFleetStatus");
  const refreshButton = $("liveFleetRefresh");
  if (!panel || !mapElement || !statusElement || !refreshButton) return;

  const state = {
    map: null,
    layer: null,
    markers: new Map(),
    sourceVehicles: {
      openov: new Map(),
      ns: new Map()
    },
    sourceStatus: {
      openov: { ok: false, checkedAt: null, ageSeconds: null, freshness: "unknown", error: null, cache: null },
      ns: { ok: false, checkedAt: null, error: null }
    },
    routeMetadata: null,
    routeMetadataFailed: false,
    routeMetadataPromise: null,
    routeLayer: null,
    selectedRouteKey: null,
    routeStatus: "",
    routeSource: "",
    routeSourceCache: new Map(),
    routeRequestToken: 0,
    routeGeometryCache: new Map(),
    locationMarker: null,
    refreshing: false,
    timer: null,
    failureStreak: 0,
    lastSuccessfulRefreshAt: null,
    destroyed: false
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizedId(value) {
    return String(value ?? "").replace(/^nl-OpenOV_/i, "").trim();
  }

  // MOTIS can return the same GTFS trip ID either with or without its
  // service-date/start-time wrapper. Normalize only that wrapper; keep the
  // underlying trip ID and, when present on both sides, its service instance.
  function tripIdPartsForShape(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const match = raw.match(/^(\d{8})_(\d{1,2}:\d{2}(?::\d{2})?)_(.+)$/i);
    if (!match) return { tripId: normalizedId(raw), serviceKey: null };

    const [, serviceDate, rawTime, rawTripId] = match;
    const [rawHour, minute, rawSecond] = rawTime.split(":");
    const hour = rawHour.padStart(2, "0");
    const second = String(rawSecond ?? "00").padStart(2, "0");
    return {
      tripId: normalizedId(rawTripId),
      serviceKey: serviceDate + "_" + hour + ":" + minute + ":" + second
    };
  }

  function tripIdMatchesForShape(candidateValue, requestedValue) {
    const candidate = tripIdPartsForShape(candidateValue);
    const requested = tripIdPartsForShape(requestedValue);
    if (!candidate || !requested || !candidate.tripId ||
        candidate.tripId !== requested.tripId) return false;

    // A composite ID on either side is still useful when the other side only
    // exposes the base GTFS trip ID. If both expose service-instance details,
    // however, the date and start time must match exactly.
    return !candidate.serviceKey || !requested.serviceKey ||
      candidate.serviceKey === requested.serviceKey;
  }

  function formatClock(value) {
    const milliseconds = typeof value === "number"
      ? (value > 1e12 ? value : value * 1000)
      : Date.parse(String(value ?? ""));
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "onbekend";
    return new Date(milliseconds).toLocaleTimeString("nl-NL", {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  function ageFromIso(value) {
    const timestamp = Date.parse(String(value ?? ""));
    return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
  }

  function isPositionFresh(ageSeconds) {
    return ageSeconds !== null && ageSeconds >= -60 && ageSeconds <= MAX_POSITION_AGE_SECONDS;
  }

  async function requestJson(path, timeoutMs = 12_000) {
    const response = await fetch(path, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      const upstream = payload?.upstreamStatus ? " (bron HTTP " + payload.upstreamStatus + ")" : "";
      throw new Error((payload?.error || ("HTTP " + response.status)) + upstream);
    }
    return { payload, response };
  }

  async function loadRouteMetadata() {
    if (state.routeMetadata) return state.routeMetadata;
    if (state.routeMetadataFailed) return null;
    if (!state.routeMetadataPromise) {
      state.routeMetadataPromise = (async () => {
        try {
          const response = await fetch(ROUTE_METADATA_ENDPOINT, {
            cache: "force-cache",
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(8_000)
          });
          if (!response.ok) throw new Error("route-metadata HTTP " + response.status);
          const payload = await response.json();
          if (!payload || typeof payload.routes !== "object" || Array.isArray(payload.routes)) {
            throw new Error("route-metadata heeft geen bruikbare routes-index.");
          }
          state.routeMetadata = payload.routes;
          return state.routeMetadata;
        } catch (error) {
          state.routeMetadataFailed = true;
          console.warn("[OVLIVE_LIVE_FLEET_ROUTE_METADATA]", error);
          return null;
        }
      })();
    }
    return state.routeMetadataPromise;
  }

  function modeFromRouteType(rawValue) {
    const routeType = Number(rawValue);
    if (!Number.isFinite(routeType)) return "other";
    if (routeType === 0 || (routeType >= 900 && routeType <= 999)) return "tram";
    if (routeType === 1 || (routeType >= 400 && routeType <= 499)) return "metro";
    if (routeType === 2 || (routeType >= 100 && routeType <= 199)) return "train";
    if (routeType === 3 ||
        (routeType >= 200 && routeType <= 299) ||
        (routeType >= 700 && routeType <= 899)) return "bus";
    if (routeType === 4 ||
        (routeType >= 1000 && routeType <= 1299)) return "ferry";
    return "other";
  }

  function convertOpenov(payload, metadata) {
    const vehicles = new Map();
    const rows = Array.isArray(payload.entities) ? payload.entities : [];
    const feedAge = finiteNumber(payload.ageSeconds);

    for (const row of rows) {
      const latitude = finiteNumber(row.latitude);
      const longitude = finiteNumber(row.longitude);
      if (latitude === null || longitude === null ||
          latitude < 49 || latitude > 56 || longitude < 2 || longitude > 9.5) continue;

      const rawTimestamp = finiteNumber(row.timestamp);
      const ageSeconds = rawTimestamp !== null && rawTimestamp > 0
        ? Math.max(0, Math.round(Date.now() / 1000 - rawTimestamp))
        : feedAge;
      if (ageSeconds !== null && (ageSeconds < -60 || ageSeconds > MAX_POSITION_AGE_SECONDS)) continue;
      if (ageSeconds === null || payload.freshness !== "fresh") continue;

      const routeId = normalizedId(row.routeId);
      const routeInfo = metadata && routeId ? metadata[routeId] : null;
      const mode = modeFromRouteType(routeInfo?.routeType);
      // Rail vehicles come from the dedicated NS source below, which carries
      // train number and GPS metadata more directly than OpenOV.
      if (mode === "train") continue;

      const vehicleId = String(row.vehicleId ?? "").trim();
      const tripId = normalizedId(row.tripId);
      const keyPart = vehicleId || (tripId ? tripId + ":" + routeId : String(row.entityId ?? ""));
      if (!keyPart) continue;

      const vehicle = {
        key: "openov:" + keyPart,
        source: "OpenOV GTFS-Realtime",
        sourceKey: "openov",
        mode,
        latitude,
        longitude,
        ageSeconds,
        observedAt: rawTimestamp !== null && rawTimestamp > 0 ? new Date(rawTimestamp * 1000).toISOString() : null,
        vehicleId,
        tripId,
        routeId,
        startDate: String(row.startDate ?? "").trim(),
        startTime: String(row.startTime ?? "").trim(),
        directionId: row.directionId ?? null,
        routeName: String(routeInfo?.routeShortName || routeInfo?.routeLongName || "").trim(),
        agencyName: String(routeInfo?.agencyName || "").trim(),
        routeType: routeInfo?.routeType == null ? null : String(routeInfo.routeType),
        sourceFreshness: payload.freshness
      };
      vehicles.set(vehicle.key, vehicle);
    }
    return vehicles;
  }

  function convertNs(payload) {
    const vehicles = new Map();
    const rows = Array.isArray(payload.positions) ? payload.positions : [];
    for (const row of rows) {
      const latitude = finiteNumber(row.latitude);
      const longitude = finiteNumber(row.longitude);
      const trainNumber = String(row.trainNumber ?? "").trim();
      if (!trainNumber || latitude === null || longitude === null ||
          latitude < 49 || latitude > 56 || longitude < 2 || longitude > 9.5) continue;

      const ageSeconds = ageFromIso(row.observedAt) ?? ageFromIso(payload.checkedAt);
      if (ageSeconds === null || ageSeconds < -60 || ageSeconds > MAX_POSITION_AGE_SECONDS) continue;

      const key = "ns:" + trainNumber;
      vehicles.set(key, {
        key,
        source: "NS Virtual Train API",
        sourceKey: "ns",
        mode: "train",
        latitude,
        longitude,
        ageSeconds,
        observedAt: row.observedAt || payload.checkedAt || null,
        vehicleId: trainNumber,
        trainNumber,
        tripId: row.ritId || "",
        routeId: row.routeId || "",
        startDate: row.startDate || "",
        startTime: row.startTime || "",
        routeName: "Trein " + trainNumber,
        agencyName: "NS",
        trainType: row.trainType || "",
        speedKmh: finiteNumber(row.speedKmh),
        headingDeg: finiteNumber(row.headingDeg),
        sourceTimestampKnown: row.sourceTimestampKnown !== false
      });
    }
    return vehicles;
  }

  function modeFilters() {
    const selected = new Set();
    panel.querySelectorAll("[data-live-fleet-mode]").forEach((input) => {
      if (input.checked) selected.add(input.getAttribute("data-live-fleet-mode"));
    });
    return selected;
  }

  function visibleVehicles() {
    const selected = modeFilters();
    const merged = new Map();
    for (const source of ["openov", "ns"]) {
      for (const [key, vehicle] of state.sourceVehicles[source]) {
        if (selected.has(vehicle.mode)) merged.set(key, vehicle);
      }
    }
    return merged;
  }

  function vehicleRouteIdentity(vehicle) {
    const routeId = normalizedId(vehicle?.routeId);
    const rawTripId = String(vehicle?.tripId ?? "").trim();
    if (!rawTripId || !routeId) return null;

    // Transitous uses an exact service-date/start-time trip ID. Never fall back
    // to line-only matching: that could draw a different vehicle's route.
    if (/^\d{8}_\d{2}:\d{2}(?::\d{2})?_nl-OpenOV_.+$/i.test(rawTripId)) {
      return { tripId: rawTripId, routeId };
    }
    if (vehicle.sourceKey !== "openov") return null;

    const startDate = String(vehicle.startDate ?? "").replace(/\D/g, "");
    const rawStartTime = String(vehicle.startTime ?? "").trim();
    if (!/^\d{8}$/.test(startDate) ||
        !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(rawStartTime)) return null;

    const timeParts = rawStartTime.split(":");
    timeParts[0] = timeParts[0].padStart(2, "0");
    const tripId = normalizedId(rawTripId);
    if (!tripId) return null;
    return { tripId: startDate + "_" + timeParts.join(":") + "_nl-OpenOV_" + tripId, routeId };
  }

  function routeModeMatches(vehicleMode, candidateMode) {
    const mode = String(candidateMode ?? "").trim().toUpperCase();
    const accepted = {
      bus: ["BUS", "COACH"],
      tram: ["TRAM"],
      metro: ["METRO", "SUBWAY"],
      ferry: ["FERRY"],
      train: ["RAIL", "TRAIN", "REGIONAL_RAIL", "LONG_DISTANCE", "HIGH_SPEED_RAIL",
        "HIGHSPEED_RAIL", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "SUBURBAN"]
    };
    return (accepted[vehicleMode] || []).includes(mode);
  }

  function routeCoordinates(geometry) {
    const validPoint = point => Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
      Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180;

    if (Array.isArray(geometry)) {
      return geometry.map(point => {
        if (Array.isArray(point) && point.length >= 2) return [Number(point[1]), Number(point[0])];
        if (point && typeof point === "object") {
          return [
            Number(point.latitude ?? point.lat),
            Number(point.longitude ?? point.lon ?? point.lng)
          ];
        }
        return null;
      }).filter(validPoint);
    }
    if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
      return geometry.coordinates.map(point => [Number(point[1]), Number(point[0])]).filter(validPoint);
    }

    const encoded = typeof geometry === "string" ? geometry : geometry?.points;
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 250_000) return [];
    const rawPrecision = typeof geometry === "object" && geometry?.precision != null
      ? Number(geometry.precision) : 6;
    const precision = Number.isInteger(rawPrecision) && rawPrecision >= 0 && rawPrecision <= 7
      ? rawPrecision : 6;
    const factor = 10 ** precision;
    const result = [];
    let index = 0;
    let latitude = 0;
    let longitude = 0;

    function readDelta() {
      let value = 0;
      let shift = 0;
      let byte;
      do {
        if (index >= encoded.length || shift > 30) return null;
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63) return null;
        value |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      return (value & 1) ? ~(value >> 1) : (value >> 1);
    }

    while (index < encoded.length && result.length < 30_000) {
      const latDelta = readDelta();
      const lonDelta = latDelta === null ? null : readDelta();
      if (latDelta === null || lonDelta === null) return [];
      latitude += latDelta;
      longitude += lonDelta;
      const point = [latitude / factor, longitude / factor];
      if (!validPoint(point)) return [];
      result.push(point);
    }
    return result;
  }

  function splitRouteAtPosition(points, vehiclePoint) {
    if (!Array.isArray(points) || points.length < 2 ||
        !Array.isArray(vehiclePoint) || vehiclePoint.length < 2 ||
        !vehiclePoint.every(Number.isFinite)) {
      return { distanceMeters: Infinity, passed: [], remaining: points || [] };
    }

    // For these short distances, an equirectangular projection is accurate
    // enough to find the closest route segment without a geometry dependency.
    const latitudeScale = 111_132;
    const longitudeScale = 111_320 * Math.cos(vehiclePoint[0] * Math.PI / 180);
    const project = point => [point[1] * longitudeScale, point[0] * latitudeScale];
    const target = project(vehiclePoint);
    let best = { distanceSquared: Infinity, segmentIndex: 0, t: 0, point: points[0] };

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = project(points[i]);
      const b = project(points[i + 1]);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((target[0] - a[0]) * dx +
          (target[1] - a[1]) * dy) / lengthSquared))
        : 0;
      const projected = [a[0] + dx * t, a[1] + dy * t];
      const distanceSquared = (target[0] - projected[0]) ** 2 +
        (target[1] - projected[1]) ** 2;
      if (distanceSquared < best.distanceSquared) {
        best = {
          distanceSquared,
          segmentIndex: i,
          t,
          point: [
            points[i][0] + (points[i + 1][0] - points[i][0]) * t,
            points[i][1] + (points[i + 1][1] - points[i][1]) * t
          ]
        };
      }
    }

    const samePoint = (left, right) =>
      Math.abs(left[0] - right[0]) < 1e-8 &&
      Math.abs(left[1] - right[1]) < 1e-8;
    const passed = points.slice(0, best.segmentIndex + 1);
    if (!samePoint(passed[passed.length - 1], best.point)) passed.push(best.point);

    const remaining = [best.point];
    for (const point of points.slice(best.segmentIndex + 1)) {
      if (!samePoint(remaining[remaining.length - 1], point)) remaining.push(point);
    }

    return {
      distanceMeters: Math.sqrt(best.distanceSquared),
      passed,
      remaining
    };
  }

  async function loadNsVehicleRouteGeometry(vehicle) {
    const trainNumber = String(vehicle?.trainNumber ?? vehicle?.tripId ?? vehicle?.vehicleId ?? "").trim();
    if (!/^\d{1,6}$/.test(trainNumber)) {
      throw new Error("Voor deze NS-trein ontbreekt een geldig treinnummer.");
    }

    const sourceTime = Date.parse(String(vehicle?.observedAt ?? ""));
    const dateTime = Number.isFinite(sourceTime)
      ? new Date(sourceTime).toISOString()
      : new Date().toISOString();
    const cacheKey = "ns-route|" + trainNumber + "|" + dateTime.slice(0, 16);
    if (state.routeGeometryCache.has(cacheKey)) {
      state.routeSource = state.routeSourceCache.get(cacheKey) || "";
      return state.routeGeometryCache.get(cacheKey);
    }

    const task = (async () => {
      const params = new URLSearchParams({ trainNumber, dateTime });
      const response = await fetch("/api/ns/train-route?" + params.toString(), {
        cache: "default",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.legs)) {
        throw new Error(payload?.error ||
          ("De NS-treinroute kon niet worden opgehaald (HTTP " + response.status + ")."));
      }

      const geometries = payload.legs
        .map((candidate, index) => ({
          sequence: Number.isFinite(Number(candidate?.sequence)) ? Number(candidate.sequence) : index,
          points: routeCoordinates(candidate?.legGeometry)
        }))
        .filter(candidate => candidate.points.length > 1)
        .sort((left, right) => left.sequence - right.sequence)
        .map(candidate => candidate.points);
      if (!geometries.length) {
        throw new Error("NS gaf geen bruikbare spoorgeometrie voor deze treinrit terug.");
      }
      return geometries;
    })();

    state.routeGeometryCache.set(cacheKey, task);
    try {
      return await task;
    } catch (error) {
      if (state.routeGeometryCache.get(cacheKey) === task) state.routeGeometryCache.delete(cacheKey);
      state.routeSourceCache.delete(cacheKey);
      throw error;
    }
  }

  async function loadVehicleRouteGeometry(vehicle) {
    if (vehicle?.sourceKey === "ns") return loadNsVehicleRouteGeometry(vehicle);
    const identity = vehicleRouteIdentity(vehicle);
    if (!identity) {
      throw new Error(vehicle.sourceKey === "ns"
        ? "Voor deze trein ontbreekt een exacte rit- en routekoppeling; ik teken geen vermoedelijke route."
        : "Deze voertuigpositie bevat geen volledige rit-ID met startdatum en starttijd.");
    }

    const cacheKey = identity.tripId + "|" + identity.routeId;
    if (state.routeGeometryCache.has(cacheKey)) {
      return state.routeGeometryCache.get(cacheKey);
    }

    const task = (async () => {
      const params = new URLSearchParams({
        tripId: identity.tripId,
        routeId: identity.routeId
      });
      const response = await fetch("/api/trip-shape?" + params.toString(), {
        cache: "default",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.legs)) {
        throw new Error(payload?.error || ("De ritroute kon niet worden opgehaald (HTTP " + response.status + ")."));
      }

      // The Worker requests Transitous /trip with this exact service-instance ID
      // (or a spelling-only alias with the same date/time and base trip ID).
      // Verify that request/resolution identity first; per-leg routeId/tripId and
      // mode metadata may be absent or spelled differently by Transitous.
      state.routeSource = String(payload.routeSource ?? "");
      state.routeSourceCache.set(cacheKey, state.routeSource);
      const requestedTripId = String(payload.requestedTripId ?? identity.tripId).trim();
      const resolvedTripId = String(payload.resolvedTripId ?? requestedTripId).trim();
      if (!tripIdMatchesForShape(requestedTripId, identity.tripId) ||
          !tripIdMatchesForShape(resolvedTripId, identity.tripId)) {
        throw new Error("Transitous heeft geen geometrie bevestigd voor de exact geselecteerde rit.");
      }

      // Once the /trip response is tied to this exact service instance, retain
      // every drawable transit leg it returned. Do not discard correct geometry
      // just because route IDs or mode labels (BUS/COACH/TROLLEYBUS etc.) differ.
      // Walking legs stay excluded, and we never fall back to a line-number query.
      const geometries = payload.legs
        .filter(candidate => {
          const mode = String(candidate?.mode ?? "").trim().toUpperCase();
          return mode !== "WALK" && mode !== "FOOT";
        })
        .map(candidate => routeCoordinates(candidate?.legGeometry))
        .filter(points => points.length > 1);
      if (!geometries.length) {
        throw new Error(payload.legs.length
          ? "Transitous leverde voor deze exacte rit geen tekenbare OV-routegeometrie terug."
          : "Transitous heeft voor deze exacte rit geen routevorm teruggegeven.");
      }
      return geometries;
    })();

    state.routeGeometryCache.set(cacheKey, task);
    try {
      return await task;
    } catch (error) {
      if (state.routeGeometryCache.get(cacheKey) === task) state.routeGeometryCache.delete(cacheKey);
      throw error;
    }
  }

  function refreshVehiclePopup(key) {
    const marker = state.markers.get(key);
    const vehicle = marker?.__ovliveVehicle;
    if (marker && vehicle) marker.setPopupContent(vehiclePopup(vehicle));
  }

  async function showVehicleRoute(vehicle) {
    if (!state.map || !state.routeLayer || !vehicle?.key) return;
    const token = ++state.routeRequestToken;
    state.selectedRouteKey = vehicle.key;
    state.routeStatus = "Route wordt opgehaald…";
    state.routeSource = "";
    state.routeLayer.clearLayers();
    refreshVehiclePopup(vehicle.key);

    try {
      const geometries = await loadVehicleRouteGeometry(vehicle);
      if (token !== state.routeRequestToken || state.selectedRouteKey !== vehicle.key) return;
      const vehiclePoint = [finiteNumber(vehicle.latitude), finiteNumber(vehicle.longitude)];
      const splits = geometries.map(points => ({
        points,
        split: splitRouteAtPosition(points, vehiclePoint)
      }));
      let closestIndex = -1;
      for (let i = 0; i < splits.length; i += 1) {
        if (closestIndex < 0 ||
            splits[i].split.distanceMeters < splits[closestIndex].split.distanceMeters) {
          closestIndex = i;
        }
      }

      const addLine = (points, color, opacity, weight) => {
        if (!Array.isArray(points) || points.length < 2) return;
        window.L.polyline(points, {
          color,
          weight,
          opacity,
          lineCap: "round",
          lineJoin: "round",
          interactive: false
        }).addTo(state.routeLayer);
      };

      const closest = closestIndex >= 0 ? splits[closestIndex] : null;
      const canSplitProgress = Boolean(closest &&
        closest.split.distanceMeters <= 1_500 &&
        closest.split.passed.length > 1);

      for (let i = 0; i < splits.length; i += 1) {
        const item = splits[i];
        if (canSplitProgress && i < closestIndex) {
          // Earlier ordered route segments are already behind the vehicle.
          addLine(item.points, "#9ca3af", 0.82, 5);
        } else if (i === closestIndex && canSplitProgress) {
          addLine(item.split.passed, "#9ca3af", 0.82, 5);
          addLine(item.split.remaining, "#ef4444", 0.97, 5);
        } else {
          addLine(item.points, "#ef4444", 0.97, 5);
        }
      }

      // Keep the user's current map center and zoom when a vehicle is selected.
      // A full vehicle route can span a large area; fitBounds() would zoom the
      // map out to show the entire route and make the clicked vehicle hard to inspect.
      // The route overlay is still drawn, including the part around the vehicle.

      const sourceLabel = state.routeSource ? " Bron: " + state.routeSource + "." : "";
      state.routeStatus = (canSplitProgress
        ? (closest.split.remaining.length > 1
          ? "⚪ Grijs = afgelegd deel (geschat vanaf GPS); 🔴 rood = resterende route."
          : "⚪ Grijs = afgelegd deel; de trein/bus bevindt zich bij het einde van de route.")
        : "🔴 Rood = route van deze rit. De GPS-positie ligt te ver van de route of dicht bij het begin om het afgelegde deel betrouwbaar grijs te markeren.") + sourceLabel;
    } catch (error) {
      if (token !== state.routeRequestToken || state.selectedRouteKey !== vehicle.key) return;
      state.routeStatus = error instanceof Error ? error.message : "De ritroute kon niet worden getoond.";
    }
    refreshVehiclePopup(vehicle.key);
  }

  function attachMyLocationButton(map, mapState, button, statusElement) {
    if (!map || !button || !statusElement) return;
    button.addEventListener("click", () => {
      if (!navigator.geolocation) {
        statusElement.textContent = "Je browser biedt geen locatietoegang.";
        return;
      }
      if (button.disabled) return;
      button.disabled = true;
      const originalText = button.textContent || "📍 Mijn locatie";
      button.textContent = "📍 Locatie zoeken…";
      statusElement.textContent = "Je locatie wordt opgevraagd. Je browser kan om toestemming vragen.";

      navigator.geolocation.getCurrentPosition(position => {
        const point = [Number(position.coords.latitude), Number(position.coords.longitude)];
        if (!point.every(Number.isFinite) || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) {
          statusElement.textContent = "De browser gaf geen geldige locatie terug.";
        } else {
          if (mapState.locationMarker) {
            mapState.locationMarker.setLatLng(point);
          } else {
            mapState.locationMarker = window.L.circleMarker(point, {
              radius: 8,
              color: "#ffffff",
              weight: 3,
              fillColor: "#2563eb",
              fillOpacity: 1
            }).addTo(map);
            mapState.locationMarker.bindPopup("📍 Mijn locatie");
          }
          map.setView(point, 15, { animate: true });
          statusElement.textContent = "📍 Locatie gevonden; de kaart is naar jouw locatie verplaatst.";
        }
        button.disabled = false;
        button.textContent = originalText;
      }, error => {
        statusElement.textContent = error?.code === 1
          ? "Locatietoegang geweigerd. Geef OVLive toestemming in je browserinstellingen."
          : error?.code === 2
            ? "Je locatie kon niet worden bepaald. Controleer je locatievoorzieningen."
            : "Locatie ophalen duurde te lang. Probeer het opnieuw.";
        button.disabled = false;
        button.textContent = originalText;
      }, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000 });
    });
  }

  function vehiclePopup(vehicle) {
    const routeIdentity = vehicleRouteIdentity(vehicle);
    const routeStatus = state.selectedRouteKey === vehicle.key
      ? (state.routeStatus || "Ritroute geselecteerd.")
      : vehicle.sourceKey === "ns" && vehicle.trainNumber
        ? "Tik op deze trein om de exacte NS-route op te vragen."
        : routeIdentity
          ? "Tik op dit voertuig om de route als rode lijn te tonen."
          : "Geen exacte ritkoppeling beschikbaar; er wordt geen vermoedelijke lijn getekend.";
    const meta = [
      vehicle.agencyName ? "<div>Vervoerder: " + escapeHtml(vehicle.agencyName) + "</div>" : "",
      vehicle.vehicleId ? "<div>Voertuig: " + escapeHtml(vehicle.vehicleId) + "</div>" : "",
      vehicle.tripId ? "<div>Rit-ID: " + escapeHtml(vehicle.tripId) + "</div>" : "",
      vehicle.routeId ? "<div>Route-ID: " + escapeHtml(vehicle.routeId) + "</div>" : "",
      vehicle.trainType ? "<div>Treintype: " + escapeHtml(vehicle.trainType) + "</div>" : "",
      vehicle.speedKmh !== null && vehicle.speedKmh !== undefined
        ? "<div>Snelheid: " + escapeHtml(Math.round(vehicle.speedKmh)) + " km/u</div>" : "",
      vehicle.headingDeg !== null && vehicle.headingDeg !== undefined
        ? "<div>Richting: " + escapeHtml(Math.round(vehicle.headingDeg)) + "°</div>" : "",
      "<div>Bron: " + escapeHtml(vehicle.source) + "</div>",
      "<div>Positietijd: " + escapeHtml(vehicle.observedAt ? formatClock(vehicle.observedAt) : "niet afzonderlijk gemeld") + "</div>",
      "<div>Leeftijd: " + escapeHtml(vehicle.ageSeconds) + " sec</div>",
      "<div class=\"live-fleet-route-status\" role=\"status\">" + escapeHtml(routeStatus) + "</div>"
    ].join("");
    const heading = vehicle.routeName || vehicle.routeId || vehicle.routeName === "" && vehicle.mode === "train"
      ? (vehicle.routeName || "Lijn onbekend")
      : MODES[vehicle.mode]?.label || "OV-voertuig";
    return "<strong>" + escapeHtml(heading) + "</strong>" + meta;
  }

  function markerIcon(L, mode) {
    const spec = MODES[mode] || MODES.other;
    return L.divIcon({
      className: "ovlive-vehicle-marker",
      html: "<span style=\"background:" + spec.color + "\">" + spec.emoji + "</span>",
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
  }

  function renderMarkers() {
    if (!state.map || !state.layer || !window.L) return;
    const vehicles = visibleVehicles();
    const visibleIds = new Set(vehicles.keys());

    if (state.selectedRouteKey && !visibleIds.has(state.selectedRouteKey)) {
      state.selectedRouteKey = null;
      state.routeStatus = "";
      state.routeRequestToken += 1;
      state.routeLayer?.clearLayers();
    }

    for (const [key, marker] of state.markers.entries()) {
      if (!visibleIds.has(key)) {
        state.layer.removeLayer(marker);
        state.markers.delete(key);
      }
    }

    for (const vehicle of vehicles.values()) {
      let marker = state.markers.get(vehicle.key);
      if (!marker) {
        marker = window.L.marker([vehicle.latitude, vehicle.longitude], {
          icon: markerIcon(window.L, vehicle.mode),
          title: (vehicle.routeName || MODES[vehicle.mode]?.label || "OV-voertuig") +
            (vehicle.vehicleId ? " · " + vehicle.vehicleId : "")
        });
        marker.__ovliveVehicle = vehicle;
        marker.bindPopup(vehiclePopup(vehicle));
        marker.on("click", () => {
          const currentVehicle = marker.__ovliveVehicle;
          if (currentVehicle) void showVehicleRoute(currentVehicle);
        });
        marker.setOpacity(state.sourceStatus[vehicle.sourceKey]?.ok ? 1 : 0.35);
        marker.addTo(state.layer);
        state.markers.set(vehicle.key, marker);
      } else {
        marker.__ovliveVehicle = vehicle;
        marker.setLatLng([vehicle.latitude, vehicle.longitude]);
        marker.setIcon(markerIcon(window.L, vehicle.mode));
        marker.setPopupContent(vehiclePopup(vehicle));
        marker.setOpacity(state.sourceStatus[vehicle.sourceKey]?.ok ? 1 : 0.35);
      }
    }
  }

  function modeCountText(vehicles) {
    const counts = Object.fromEntries(Object.keys(MODES).map((mode) => [mode, 0]));
    for (const vehicle of vehicles.values()) counts[vehicle.mode] = (counts[vehicle.mode] || 0) + 1;
    return Object.keys(MODES)
      .filter((mode) => counts[mode] > 0)
      .map((mode) => MODES[mode].emoji + " " + counts[mode])
      .join(" · ") || "geen actuele voertuigposities";
  }

  function sourceStatusText(source) {
    if (!source.ok) return source.error ? "niet beschikbaar" : "nog niet geladen";
    if (source.sourceKey === "ns") return "beschikbaar";
    return (source.freshness || "actualiteit onbekend") +
      (source.ageSeconds === null ? "" : " · feed " + source.ageSeconds + " sec oud") +
      (source.cache ? " · cache " + source.cache : "");
  }

  function setStatus(message, kind = "") {
    statusElement.textContent = message;
    statusElement.classList.toggle("is-live", kind === "live");
    statusElement.classList.toggle("is-warning", kind === "warning");
    statusElement.classList.toggle("is-error", kind === "error");
  }

  function scheduleNextRefresh(delay = POLL_MS) {
    if (state.timer) window.clearTimeout(state.timer);
    if (state.destroyed) return;
    state.timer = window.setTimeout(() => {
      state.timer = null;
      if (document.hidden) {
        scheduleNextRefresh(POLL_MS);
        return;
      }
      void refresh(false);
    }, delay);
  }

  async function refresh(manual = false) {
    if (state.refreshing || state.destroyed) return;
    if (document.hidden && !manual) return;

    state.refreshing = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "↻ Bezig…";
    const hasOldData = state.sourceVehicles.openov.size > 0 || state.sourceVehicles.ns.size > 0;
    if (!hasOldData) setStatus("Live voertuigposities ophalen…");

    const tasks = await Promise.allSettled([
      (async () => {
        const { payload, response } = await requestJson(OPENOV_ENDPOINT);
        const metadata = await loadRouteMetadata();
        return {
          name: "openov",
          vehicles: convertOpenov(payload, metadata),
          status: {
            ok: true,
            checkedAt: payload.checkedAt || new Date().toISOString(),
            ageSeconds: finiteNumber(payload.ageSeconds),
            freshness: payload.freshness || "unknown",
            error: null,
            cache: response.headers.get("x-ovlive-live-map-cache") || "onbekend",
            count: payload.returnedCount ?? payload.entities?.length ?? 0
          },
          metadataMissing: !metadata
        };
      })(),
      (async () => {
        const { payload } = await requestJson(NS_ENDPOINT);
        return {
          name: "ns",
          vehicles: convertNs(payload),
          status: {
            ok: true,
            checkedAt: payload.checkedAt || new Date().toISOString(),
            error: null,
            count: Array.isArray(payload.positions) ? payload.positions.length : 0
          },
          metadataMissing: false
        };
      })()
    ]);

    let successful = 0;
    const problems = [];
    let metadataMissing = false;
    for (let index = 0; index < tasks.length; index += 1) {
      const result = tasks[index];
      const sourceName = index === 0 ? "openov" : "ns";
      if (result.status === "fulfilled") {
        successful += 1;
        const sourceResult = result.value;
        const openovFeedNotFresh = sourceName === "openov" &&
          sourceResult.status.freshness !== "fresh";
        if (openovFeedNotFresh) {
          // A successful HTTP response is not enough: never replace good
          // last-known map points with an explicitly stale/unknown feed.
          state.sourceStatus[sourceName] = {
            ...sourceResult.status,
            ok: false,
            sourceKey: sourceName,
            error: "De feed-timestamp bevestigt geen verse voertuigposities."
          };
          problems.push("OpenOV-feed niet vers; laatst bekende punten blijven zichtbaar");
        } else {
          state.sourceVehicles[sourceName] = sourceResult.vehicles;
          state.sourceStatus[sourceName] = {
            ...sourceResult.status,
            sourceKey: sourceName
          };
        }
        metadataMissing ||= sourceResult.metadataMissing;
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        state.sourceStatus[sourceName] = {
          ...state.sourceStatus[sourceName],
          ok: false,
          error: message
        };
        problems.push((sourceName === "openov" ? "OpenOV" : "NS") + ": " + message);
      }
    }

    renderMarkers();
    const allVisible = visibleVehicles();
    const currentCheckedAt = new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const openovStatus = state.sourceStatus.openov.ok
      ? "OpenOV " + (state.sourceStatus.openov.freshness || "onbekend") +
        (state.sourceStatus.openov.ageSeconds === null ? "" : " (" + state.sourceStatus.openov.ageSeconds + " s oud)") +
        " · cache " + (state.sourceStatus.openov.cache || "onbekend")
      : "OpenOV niet actueel/bevestigd";
    const nsStatus = state.sourceStatus.ns.ok ? "NS beschikbaar" : "NS niet actueel/beschikbaar";
    const openovIsStale = state.sourceStatus.openov.ok &&
      state.sourceStatus.openov.freshness !== "fresh";
    const message = allVisible.size + " zichtbare voertuigen · " + modeCountText(allVisible) +
      " · gecontroleerd " + currentCheckedAt +
      " · " + openovStatus + " · " + nsStatus +
      (metadataMissing ? " · route-metadata niet beschikbaar; sommige bus/tram/metro-types kunnen als onbekend staan." : "") +
      (problems.length ? " · Fout: " + problems.join(" | ") + (hasOldData ? " · laatst bekende voertuigen blijven zichtbaar." : "") : "") +
      " · automatische controle circa elke " + Math.round(POLL_MS / 1000) + " sec.";

    if (successful === 0) {
      state.failureStreak += 1;
      setStatus(hasOldData ? message : "Beide voertuigbronnen zijn mislukt: " + problems.join(" | "), hasOldData ? "warning" : "error");
    } else {
      state.failureStreak = 0;
      setStatus(message, problems.length || metadataMissing || openovIsStale ? "warning" : "live");
      state.lastSuccessfulRefreshAt = Date.now();
    }

    state.refreshing = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "↻ Ververs nu";

    const backoff = [20_000, 30_000, 45_000, 60_000][Math.min(state.failureStreak, 4) - 1];
    scheduleNextRefresh(state.failureStreak > 0 ? backoff : POLL_MS);
  }

  async function initialize() {
    try {
      if (typeof loadLiveLeaflet !== "function") {
        throw new Error("De kaartbibliotheek is niet beschikbaar.");
      }
      const L = await loadLiveLeaflet();
      if (!L || !mapElement.isConnected) throw new Error("De kaart kon niet worden gestart.");

      state.map = L.map(mapElement, { scrollWheelZoom: false }).setView([52.1, 5.3], 7);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(state.map);
      state.layer = L.layerGroup().addTo(state.map);
      state.routeLayer = L.featureGroup().addTo(state.map);
      attachMyLocationButton(
        state.map,
        state,
        $("liveFleetLocate"),
        $("liveFleetLocationStatus")
      );

      panel.querySelectorAll("[data-live-fleet-mode]").forEach((input) => {
        input.addEventListener("change", renderMarkers);
      });
      refreshButton.addEventListener("click", () => {
        if (state.timer) window.clearTimeout(state.timer);
        state.timer = null;
        void refresh(true);
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          if (state.timer) window.clearTimeout(state.timer);
          state.timer = null;
        } else {
          void refresh(false);
        }
      });

      window.setTimeout(() => state.map?.invalidateSize(), 150);
      void refresh(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("Live kaart kon niet worden gestart: " + message, "error");
      refreshButton.disabled = true;
    }
  }

  void initialize();
})();
