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

  function vehiclePopup(vehicle) {
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
      "<div class=\"muted\">De volledige gereden route volgt in een volgende stap.</div>"
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
        marker.bindPopup(vehiclePopup(vehicle));
        marker.setOpacity(state.sourceStatus[vehicle.sourceKey]?.ok ? 1 : 0.35);
        marker.addTo(state.layer);
        state.markers.set(vehicle.key, marker);
      } else {
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
