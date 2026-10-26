import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/ns-live-train-route.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
const { fetchNsLiveTrainRoute } = await import(moduleUrl);

const requests = [];
const stationCodes = new Map([
  ["8400001", "UT"],
  ["8400002", "ASD"],
  ["8400003", "AH"]
]);
const stationNames = new Map([
  ["8400001", "Utrecht Centraal"],
  ["8400002", "Amsterdam Centraal"],
  ["8400003", "Amsterdam Amstel"]
]);
const routeGeoJson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { from: "ASD", to: "UT" },
      geometry: {
        type: "LineString",
        coordinates: [[4.9, 52.3], [5.1, 52.1]]
      }
    },
    {
      type: "Feature",
      properties: { from: "AH", to: "ASD" },
      geometry: {
        type: "LineString",
        coordinates: [[5.0, 52.0], [4.9, 52.3]]
      }
    },
    {
      type: "Feature",
      properties: { from: "UT", to: "AH" },
      geometry: {
        type: "LineString",
        coordinates: [[5.1, 52.1], [5.3, 52.2], [5.0, 52.0]]
      }
    }
  ]
};

const fetchMock = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, init });
  assert.equal(
    new Headers(init.headers).get("Ocp-Apim-Subscription-Key"),
    "test-ns-key",
    "all NS requests must use the existing server-side subscription key"
  );

  if (url.pathname.endsWith("/api/v2/journey")) {
    assert.equal(url.searchParams.get("train"), "1733");
    assert.equal(url.searchParams.get("dateTime"), "2026-10-20T07:20:00.000Z");
    return new Response(JSON.stringify({
      payload: {
        stops: [
          {
            stop: { uicCode: "8400001" },
            plannedDepartureDateTime: "2026-10-20T07:21:00+02:00",
            actualDepartureDateTime: "2026-10-20T07:22:00+02:00",
            plannedTrack: "5"
          },
          {
            stop: { uicCode: "8400002" },
            plannedArrivalDateTime: "2026-10-20T07:42:00+02:00",
            plannedDepartureDateTime: "2026-10-20T07:43:00+02:00",
            actualArrivalDateTime: "2026-10-20T07:44:00+02:00",
            plannedTrack: "8"
          },
          {
            stop: { uicCode: "8400003" },
            arrivals: [{
              plannedTime: "2026-10-20T07:50:00+02:00",
              actualTime: "2026-10-20T07:52:30+02:00"
            }],
            departures: [{
              plannedTime: "2026-10-20T07:51:00+02:00",
              actualTime: "2026-10-20T07:53:30+02:00"
            }],
            plannedTrack: "2",
            passing: false
          }
        ]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/nsapp-stations/v1/station")) {
    const uicCode = url.searchParams.get("uicCode");
    const code = stationCodes.get(uicCode);
    assert.ok(code, "station lookup should request only known UIC codes");
    return new Response(JSON.stringify({
      payload: {
        id: { uicCode, code },
        name: stationNames.get(uicCode)
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/api/v1/traject.geojson")) {
    assert.equal(url.searchParams.get("stations"), "UT,ASD,AH",
      "track geometry must be requested using the exact ordered station sequence");
    return new Response(JSON.stringify(routeGeoJson), {
      status: 200,
      headers: { "content-type": "application/geo+json" }
    });
  }

  throw new Error("Unexpected mocked NS request: " + url.toString());
};

const route = await fetchNsLiveTrainRoute(
  "1733",
  "2026-10-20T07:20:47.000Z",
  {
    NS_API_SUBSCRIPTION_KEY: "test-ns-key",
    APP_NAME: "OVLive",
    APP_VERSION: "test",
    APP_CONTACT: "https://example.test"
  },
  fetchMock
);

assert.equal(route.ok, true);
assert.equal(route.source, "NS Reisinformatie + SpoorKaart API");
assert.equal(route.trainNumber, "1733");
assert.equal(route.dateTime, "2026-10-20T07:20:00.000Z");
assert.equal(route.legs.length, 2,
  "the selected train's connected track segments should be preserved");
assert.equal(route.legs[0].sequence, 0);
assert.equal(route.stops.length, 3, "ordered stations must be returned with the route");
assert.deepEqual(route.stops.map(stop => stop.name), [
  "Utrecht Centraal",
  "Amsterdam Centraal",
  "Amsterdam Amstel"
], "the API must resolve Dutch station names by exact UIC code");
assert.equal(route.stops[0].plannedDepartureDateTime, "2026-10-20T05:21:00.000Z",
  "planned departure times must be normalized to ISO UTC");
assert.equal(route.stops[0].actualDepartureDateTime, "2026-10-20T05:22:00.000Z",
  "actual departure time must be kept separately from the timetable");
assert.equal(route.stops[0].departureDelaySeconds, 60,
  "departure delay should be calculated from planned and actual times");
assert.equal(route.stops[1].plannedArrivalDateTime, "2026-10-20T05:42:00.000Z");
assert.equal(route.stops[1].platform, "8");
assert.equal(route.stops[2].plannedArrivalDateTime, "2026-10-20T05:50:00.000Z",
  "the NS arrivals[].plannedTime array must supply the planned station time");
assert.equal(route.stops[2].actualArrivalDateTime, "2026-10-20T05:52:30.000Z",
  "the NS arrivals[].actualTime array must be exposed as the live time");
assert.equal(route.stops[2].arrivalDelaySeconds, 150,
  "NS arrivals[].actualTime and plannedTime must produce the station delay in seconds");
assert.equal(route.stops[2].plannedDepartureDateTime, "2026-10-20T05:51:00.000Z",
  "the NS departures[].plannedTime array must be supported");
assert.equal(route.stops[2].actualDepartureDateTime, "2026-10-20T05:53:30.000Z",
  "the NS departures[].actualTime array must be supported");
assert.deepEqual(route.legs[0].legGeometry.coordinates[0], [5.1, 52.1],
  "a reversed track segment must be oriented in the journey direction");
assert.deepEqual(route.legs[1].legGeometry.coordinates[0], [4.9, 52.3],
  "the next connected segment must follow in station order");
assert.equal(requests.filter(r => r.url.pathname.endsWith("/api/v2/journey")).length, 1);
assert.equal(requests.filter(r => r.url.pathname.endsWith("/nsapp-stations/v1/station")).length, 3);
assert.equal(requests.filter(r => r.url.pathname.endsWith("/api/v1/traject.geojson")).length, 1);

// Prefer a specific NS journey ID when it is available for the live vehicle.
// The number + timestamp path above remains covered as a fallback.
const exactJourneyRequests = [];
const exactJourneyFetchMock = async (input, init = {}) => {
  const url = new URL(String(input));
  exactJourneyRequests.push(url);
  assert.equal(
    new Headers(init.headers).get("Ocp-Apim-Subscription-Key"),
    "test-ns-key"
  );

  if (url.pathname.endsWith("/api/v2/journey")) {
    assert.equal(url.searchParams.get("id"), "rit-1735-exact");
    assert.equal(url.searchParams.get("train"), null,
      "exact journey lookup should use id rather than ambiguously searching by train number");
    assert.equal(url.searchParams.get("dateTime"), null);
    return new Response(JSON.stringify({
      payload: {
        stops: [
          { stop: { uicCode: "8400001" }, plannedDepartureDateTime: "2026-10-20T07:21:00+02:00" },
          { stop: { uicCode: "8400002" }, plannedArrivalDateTime: "2026-10-20T07:42:00+02:00" },
          { stop: { uicCode: "8400003" }, plannedArrivalDateTime: "2026-10-20T07:50:00+02:00" }
        ]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/api/v1/traject.geojson")) {
    assert.equal(url.searchParams.get("stations"), "UT,ASD,AH");
    return new Response(JSON.stringify(routeGeoJson), {
      status: 200,
      headers: { "content-type": "application/geo+json" }
    });
  }

  if (url.pathname.endsWith("/nsapp-stations/v1/station")) {
    const uicCode = url.searchParams.get("uicCode");
    const code = stationCodes.get(uicCode);
    assert.ok(code, "station lookup should request only known UIC codes");
    return new Response(JSON.stringify({
      payload: { id: { uicCode, code }, name: stationNames.get(uicCode) }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  throw new Error("Unexpected exact-journey mocked request: " + url.toString());
};

const exactJourneyRoute = await fetchNsLiveTrainRoute(
  "1735",
  "2026-10-20T07:20:47.000Z",
  {
    NS_API_SUBSCRIPTION_KEY: "test-ns-key",
    APP_NAME: "OVLive",
    APP_VERSION: "test",
    APP_CONTACT: "https://example.test"
  },
  exactJourneyFetchMock,
  "rit-1735-exact"
);
assert.equal(exactJourneyRoute.ok, true);
assert.equal(exactJourneyRoute.legs.length, 2,
  "the route must be built from the journey selected by the exact NS ID");
assert.equal(
  exactJourneyRequests.find(url => url.pathname.endsWith("/api/v2/journey"))?.searchParams.get("id"),
  "rit-1735-exact"
);

// The station timetable must remain useful even when Spoorkaart has no
// matching line geometry for a particular train.
const noGeometryFetchMock = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(
    new Headers(init.headers).get("Ocp-Apim-Subscription-Key"),
    "test-ns-key"
  );

  if (url.pathname.endsWith("/api/v2/journey")) {
    assert.equal(url.searchParams.get("train"), "1734");
    return new Response(JSON.stringify({
      payload: {
        stops: [
          {
            stop: { uicCode: "8400001" },
            plannedDepartureDateTime: "2026-10-20T07:31:00+02:00"
          },
          {
            stop: { uicCode: "8400002" },
            plannedArrivalDateTime: "2026-10-20T07:52:00+02:00"
          }
        ]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/api/v1/traject.geojson")) {
    // Spoorkaart returned a real line, but it connects the first and final
    // stations directly instead of matching the journey's adjacent pair.
    // The endpoint must not draw that unrelated geometry as this train's route.
    return new Response(JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { from: "UT", to: "AH" },
        geometry: {
          type: "LineString",
          coordinates: [[5.1, 52.1], [5.3, 52.2], [5.0, 52.0]]
        }
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/geo+json" }
    });
  }

  throw new Error("Unexpected no-geometry mocked request: " + url.toString());
};

const stationOnlyRoute = await fetchNsLiveTrainRoute(
  "1734",
  "2026-10-20T07:30:00.000Z",
  {
    NS_API_SUBSCRIPTION_KEY: "test-ns-key",
    APP_NAME: "OVLive",
    APP_VERSION: "test",
    APP_CONTACT: "https://example.test"
  },
  noGeometryFetchMock
);
assert.equal(stationOnlyRoute.ok, true);
assert.equal(stationOnlyRoute.legs.length, 0,
  "a route with no matching track geometry should not invent a line");
assert.equal(stationOnlyRoute.stops.length, 2,
  "planned stations and times must still be returned without track geometry");
assert.match(stationOnlyRoute.routeWarning ?? "", /spoorgeometrie/i);

await assert.rejects(
  fetchNsLiveTrainRoute("train-1733", "2026-10-20T07:20:00.000Z",
    { NS_API_SUBSCRIPTION_KEY: "test-ns-key" }, fetchMock),
  /NS_LIVE_TRAIN_ROUTE_INVALID_TRAIN_NUMBER/,
  "an invalid train identifier must be rejected before making upstream requests"
);

// Long rail journeys keep every timetable stop. SpoorKaart calls are
// chunked to bounded station lists with an overlapping endpoint between chunks.
const longStationCodes = Array.from({ length: 40 }, (_, index) =>
  "S" + String(index).padStart(3, "0")
);
const longGeometryRequests = [];
const longJourneyFetchMock = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(
    new Headers(init.headers).get("Ocp-Apim-Subscription-Key"),
    "test-ns-key"
  );

  if (url.pathname.endsWith("/api/v2/journey")) {
    return new Response(JSON.stringify({
      payload: {
        stops: longStationCodes.map((code, index) => ({
          stop: {
            uicCode: String(8401000 + index),
            code,
            name: "Station " + index
          },
          ...(index === 0
            ? { plannedDepartureDateTime: "2026-10-20T05:00:00Z" }
            : { plannedArrivalDateTime: new Date(Date.UTC(2026, 9, 20, 5, index)).toISOString() })
        }))
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.pathname.endsWith("/api/v1/traject.geojson")) {
    const codes = (url.searchParams.get("stations") ?? "").split(",");
    longGeometryRequests.push(codes);
    assert.ok(codes.length <= 36,
      "each SpoorKaart geometry request must stay within the bounded station limit");
    const features = codes.slice(0, -1).map((from, index) => ({
      type: "Feature",
      properties: { from, to: codes[index + 1] },
      geometry: {
        type: "LineString",
        coordinates: [[4.0 + index / 100, 52.0], [4.01 + index / 100, 52.01]]
      }
    }));
    return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
      status: 200,
      headers: { "content-type": "application/geo+json" }
    });
  }

  throw new Error("Unexpected long-journey mocked NS request: " + url.toString());
};

const longJourneyRoute = await fetchNsLiveTrainRoute(
  "1736",
  "2026-10-20T07:00:00.000Z",
  {
    NS_API_SUBSCRIPTION_KEY: "test-ns-key",
    APP_NAME: "OVLive",
    APP_VERSION: "test",
    APP_CONTACT: "https://example.test"
  },
  longJourneyFetchMock
);
assert.equal(longJourneyRoute.ok, true);
assert.equal(longJourneyRoute.stops.length, 40,
  "long journeys must retain the complete station timetable instead of being rejected");
assert.equal(longJourneyRoute.stops[0].plannedDepartureDateTime, "2026-10-20T05:00:00.000Z");
assert.equal(longJourneyRoute.stops[39].plannedArrivalDateTime,
  new Date(Date.UTC(2026, 9, 20, 5, 39)).toISOString(),
  "the final station's planned time must remain available");
assert.equal(longGeometryRequests.length, 2,
  "a 40-station journey should use two bounded geometry requests");
assert.deepEqual(longGeometryRequests.map(codes => codes.length), [36, 5]);
assert.equal(longGeometryRequests[0].at(-1), longGeometryRequests[1][0],
  "adjacent geometry chunks must share their endpoint station");
assert.equal(longJourneyRoute.legs.length, 39,
  "all sequential track segments should be returned for the long journey");

console.log("PASS: long train journeys retain all stops and use bounded geometry chunks");

console.log("PASS: NS train route lookup uses exact train/time, ordered station codes and cached track geometry");
