import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/ns-train-realtime.ts", import.meta.url),
  "utf8"
);

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(compiled).toString("base64");

const { eventFrom, hasKnownPunctualityDeviation, selectJourneyEventFromStops, enrichNsTrainPlan } = await import(moduleUrl);

const planned = "2026-10-14T11:10:00.000Z";
const actual = "2026-10-14T11:10:00.000Z";

// UNKNOWN + gelijke tijden mogen geen bevestigde voorspelling worden.
const unknownEcho = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  departureStatus: "UNKNOWN",
  cancelled: false
}, "departure");

assert.equal(unknownEcho.time, null);
assert.equal(unknownEcho.actualTime, null);
assert.equal(unknownEcho.delaySeconds, null);
assert.equal(unknownEcho.plannedTime, planned);
assert.equal(hasKnownPunctualityDeviation(unknownEcho), false);
console.log("PASS: UNKNOWN met gelijke tijden blijft onbevestigd");

// Een ontbrekende status mag evenmin vanzelf als op tijd gelden.
const missingStatus = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  cancelled: false
}, "arrival");

assert.equal(missingStatus.time, null);
assert.equal(missingStatus.delaySeconds, null);
assert.equal(hasKnownPunctualityDeviation(missingStatus), false);
console.log("PASS: ontbrekende NS-status blijft onbekend");

// INCOMING beschrijft de treinstatus, niet automatisch de punctualiteit.
const incomingWithoutDelay = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  arrivalStatus: "INCOMING",
  cancelled: false
}, "arrival");

assert.equal(incomingWithoutDelay.time, planned);
assert.equal(incomingWithoutDelay.delaySeconds, null);
assert.equal(hasKnownPunctualityDeviation(incomingWithoutDelay), false);
console.log("PASS: INCOMING zonder expliciete vertraging blijft punctualiteit onbekend");

// Nulvertraging is wel geldig als NS die expliciet als 0 doorgeeft.
const confirmedZero = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  departureStatus: "UNKNOWN",
  delayInSeconds: 0,
  cancelled: false
}, "departure");

assert.equal(confirmedZero.time, planned);
assert.equal(confirmedZero.delaySeconds, 0);
assert.equal(hasKnownPunctualityDeviation(confirmedZero), true);
console.log("PASS: expliciete nulvertraging van NS blijft geldig");

// Een werkelijke afwijking mag niet worden weggefilterd.
const delayed = eventFrom({
  plannedDateTime: planned,
  actualDateTime: "2026-10-14T11:12:00.000Z",
  departureStatus: "UNKNOWN",
  cancelled: false
}, "departure");

assert.equal(delayed.time, "2026-10-14T11:12:00.000Z");
assert.equal(delayed.delaySeconds, 120);
assert.equal(hasKnownPunctualityDeviation(delayed), true);
console.log("PASS: echte afwijking van 120 seconden blijft zichtbaar");

// Een expliciet door NS gemelde vertraging blijft behouden.
const reportedDelay = eventFrom({
  plannedDateTime: planned,
  actualDateTime: actual,
  departureStatus: "UNKNOWN",
  delayInSeconds: 150,
  cancelled: false
}, "departure");

assert.equal(reportedDelay.delaySeconds, 150);
assert.equal(hasKnownPunctualityDeviation(reportedDelay), true);
console.log("PASS: expliciet gemelde NS-vertraging blijft behouden");


const stationIndex = {
  uics: new Map([
    ["8400282", "GVC"],
    ["8400621", "UT"]
  ])
};
const journeyStops = [
  {
    stop: { uicCode: "8400282" },
    departures: [{
      product: { number: "661" },
      plannedTime: planned,
      actualTime: actual,
      delayInSeconds: 0,
      cancelled: false
    }]
  },
  {
    stop: { uicCode: "8400621" },
    arrivals: [{
      product: { number: "661" },
      plannedTime: "2026-10-14T11:40:00.000Z",
      actualTime: "2026-10-14T11:42:00.000Z",
      delayInSeconds: 120,
      cancelled: false
    }]
  }
];

const journeyDeparture = selectJourneyEventFromStops(
  journeyStops, "661", "GVC", stationIndex, Date.parse(planned), "departure"
);
assert.ok(journeyDeparture);
assert.equal(journeyDeparture.plannedDateTime, planned);
assert.equal(eventFrom(journeyDeparture, "departure").delaySeconds, 0);
assert.equal(
  hasKnownPunctualityDeviation(eventFrom(journeyDeparture, "departure")),
  true
);
console.log("PASS: reisdetails leveren expliciete nulvertraging bij exact vertrek");

const journeyArrival = selectJourneyEventFromStops(
  journeyStops, "661", "UT", stationIndex,
  Date.parse("2026-10-14T11:40:00.000Z"), "arrival"
);
assert.ok(journeyArrival);
assert.equal(
  eventFrom(journeyArrival, "arrival").delaySeconds,
  120
);
console.log("PASS: reisdetails leveren vertraging bij exacte aankomst");

assert.equal(
  selectJourneyEventFromStops(
    journeyStops, "9999", "GVC", stationIndex,
    Date.parse(planned), "departure"
  ),
  null
);
assert.equal(
  selectJourneyEventFromStops(
    journeyStops, "661", "UT", stationIndex,
    Date.parse(planned), "departure"
  ),
  null
);
assert.equal(
  selectJourneyEventFromStops(
    journeyStops, "661", "GVC", stationIndex,
    Date.parse("2026-10-14T11:20:00.000Z"), "departure"
  ),
  null
);
console.log("PASS: reisdetails vereisen exact treinnummer, station en tijdvenster");

const ambiguousJourneyStops = [
  ...journeyStops,
  {
    stop: { uicCode: "8400282" },
    departures: [{
      product: { number: "661" },
      plannedTime: "2026-10-14T11:09:00.000Z",
      actualTime: "2026-10-14T11:09:00.000Z",
      delayInSeconds: 0,
      cancelled: false
    }]
  }
];
assert.equal(
  selectJourneyEventFromStops(
    ambiguousJourneyStops, "661", "GVC", stationIndex,
    Date.parse("2026-10-14T11:09:30.000Z"), "departure"
  ),
  null
);
console.log("PASS: dubbelzinnige reisdetailmatch wordt geweigerd");

// Als alleen de stationslijst faalt, gebruik dan gecontroleerde lokale
// stationcodes en blijf de actuele vertrektijden/aankomsten bij NS ophalen.
{
  const originalFetch = globalThis.fetch;
  const trainNumber = "6080";
  const tripId = "20261016_23:09_nl-OpenOV_382969680";
  const plannedDeparture = "2026-10-16T21:09:00.000Z";
  const plannedArrival = "2026-10-16T21:15:00.000Z";
  const actualDeparture = "2026-10-16T21:10:03.000Z";
  const actualArrival = "2026-10-16T21:16:03.000Z";
  const boardStations = [];

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/api/v2/stations")) {
      return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname.endsWith("/api/v2/departures")) {
      const station = url.searchParams.get("station");
      boardStations.push(`departures:${station}`);
      assert.equal(station, "UT", "Utrecht Centraal moet via de lokale NS-stationcode worden gevonden");
      return new Response(JSON.stringify({
        payload: { departures: [{
          product: { number: trainNumber },
          plannedDateTime: plannedDeparture,
          actualDateTime: actualDeparture,
          delayInSeconds: 63,
          cancelled: false,
          plannedTrack: "20",
          actualTrack: "20"
        }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/api/v2/arrivals")) {
      const station = url.searchParams.get("station");
      boardStations.push(`arrivals:${station}`);
      assert.equal(station, "UTT", "Utrecht Terwijde moet via de lokale NS-stationcode worden gevonden");
      return new Response(JSON.stringify({
        payload: { arrivals: [{
          product: { number: trainNumber },
          plannedDateTime: plannedArrival,
          actualDateTime: actualArrival,
          delayInSeconds: 63,
          cancelled: false,
          plannedTrack: "4",
          actualTrack: "4"
        }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected NS test request: ${url.pathname}`);
  };

  const plan = {
    itineraries: [{
      legs: [{
        mode: "RAIL",
        tripId,
        from: {
          name: "Utrecht Centraal",
          uicCode: "8400621",
          departure: plannedDeparture
        },
        to: {
          name: "Utrecht Terwijde",
          uicCode: "8400614",
          arrival: plannedArrival
        }
      }]
    }],
    ndovRealtimeMeta: {
      routeCrosswalkOutcomes: [{
        tripId,
        source: "openov-route-crossmatch",
        reason: "exact_openov_trip_id_match",
        parsedIdentity: { owner: "IFF", journey: trainNumber }
      }]
    }
  };

  try {
    await enrichNsTrainPlan(plan, {
      NS_API_SUBSCRIPTION_KEY: "selftest-key",
      APP_NAME: "OVLive",
      APP_VERSION: "selftest",
      APP_CONTACT: "test"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const leg = plan.itineraries[0].legs[0];
  assert.equal(plan.nsRealtimeMeta.stationLookupSource, "builtin_fallback");
  assert.equal(plan.nsRealtimeMeta.stationListError, "HTTP 503");
  assert.equal(plan.nsRealtimeMeta.matchedLegCount, 1);
  assert.equal(leg.nsRealtime.status, "matched");
  assert.equal(leg.nsRealtime.trainNumber, trainNumber);
  assert.equal(leg.nsRealtime.departure.delaySeconds, 63);
  assert.equal(leg.nsRealtime.arrival.delaySeconds, 63);
  assert.deepEqual(boardStations.sort(), ["arrivals:UTT", "departures:UT"]);
  console.log("PASS: HTTP 503 op NS-stationslijst blokkeert treinnummer 6080 niet; UT/UTT-reservecodes halen de expliciete 63 sec vertraging op");
}


// Mixed-mode searches may return several train candidates. They must not
// launch an unbounded burst of NS board requests that makes an otherwise
// valid train realtime result intermittently disappear.
{
  const originalFetch = globalThis.fetch;
  const baseMs = Date.parse("2026-11-12T10:00:00.000Z");
  const byEvent = new Map();
  let activeBoardRequests = 0;
  let maxActiveBoardRequests = 0;

  const legs = Array.from({ length: 4 }, (_, index) => {
    const number = String(6080 + index);
    const departureMs = baseMs + index * 10 * 60_000;
    const arrivalMs = departureMs + 5 * 60_000;
    const tripId = `20261112_${new Date(departureMs).toISOString().slice(11, 16)}_nl-OpenOV_${382969680 + index}`;
    const departureIso = new Date(departureMs).toISOString();
    const arrivalIso = new Date(arrivalMs).toISOString();
    byEvent.set(`departures|${departureIso}`, number);
    byEvent.set(`arrivals|${arrivalIso}`, number);

    return {
      mode: "RAIL",
      tripId,
      from: {
        name: "Utrecht Centraal",
        uicCode: "8400621",
        departure: departureIso
      },
      to: {
        name: "Utrecht Terwijde",
        uicCode: "8400614",
        arrival: arrivalIso
      }
    };
  });

  const plan = {
    itineraries: legs.map((leg, index) => ({
      legs: [
        leg,
        { mode: "BUS", routeShortName: String(5 + index), from: {}, to: {} }
      ]
    })),
    ndovRealtimeMeta: {
      routeCrosswalkOutcomes: legs.map((leg, index) => ({
        tripId: leg.tripId,
        source: "openov-route-crossmatch",
        reason: "exact_openov_trip_id_match",
        parsedIdentity: { owner: "IFF", journey: String(6080 + index) }
      }))
    }
  };

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/api/v2/stations")) {
      return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.pathname.endsWith("/api/v2/departures") ||
        url.pathname.endsWith("/api/v2/arrivals")) {
      const kind = url.pathname.endsWith("/api/v2/departures")
        ? "departures"
        : "arrivals";
      activeBoardRequests += 1;
      maxActiveBoardRequests = Math.max(
        maxActiveBoardRequests,
        activeBoardRequests
      );

      try {
        await new Promise(resolve => setTimeout(resolve, 12));
        const plannedDateTime = url.searchParams.get("dateTime");
        const trainNumber = byEvent.get(`${kind}|${plannedDateTime}`);
        assert.ok(trainNumber, `onverwachte NS-bordaanvraag: ${kind} ${plannedDateTime}`);
        return new Response(JSON.stringify({
          payload: {
            [kind]: [{
              product: { number: trainNumber },
              plannedDateTime,
              actualDateTime: new Date(Date.parse(plannedDateTime) + 60_000).toISOString(),
              delayInSeconds: 60,
              cancelled: false
            }]
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      } finally {
        activeBoardRequests -= 1;
      }
    }

    throw new Error(`Unexpected NS test request: ${url.pathname}`);
  };

  try {
    await enrichNsTrainPlan(plan, {
      NS_API_SUBSCRIPTION_KEY: "selftest-key",
      APP_NAME: "OVLive",
      APP_VERSION: "selftest",
      APP_CONTACT: "test"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(plan.nsRealtimeMeta.candidateLegCount, 4);
  assert.equal(plan.nsRealtimeMeta.matchedLegCount, 4);
  assert.ok(
    maxActiveBoardRequests <= 4,
    `NS-bordbelasting te hoog: maximaal ${maxActiveBoardRequests} gelijktijdige bordverzoeken`
  );
  for (const itinerary of plan.itineraries) {
    assert.equal(itinerary.legs[0].nsRealtime.status, "matched");
    assert.equal(itinerary.legs[0].nsRealtime.departure.delaySeconds, 60);
    assert.equal(itinerary.legs[0].nsRealtime.arrival.delaySeconds, 60);
  }
  console.log("PASS: extra gemengde reisopties veroorzaken geen onbeperkte NS-burst; alle 4 treinritten behouden hun realtimevertraging");
}

console.log("Alle NS-regressietests geslaagd.");
