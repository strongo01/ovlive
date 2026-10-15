import assert from "node:assert/strict";
import {
  summarizeRealtimeEvent,
  findPropagatedRealtimeEvent,
} from "../src/openov-realtime-prediction.js";
import { findExactVehiclePositionForLeg, findRealtimeStopByScheduledEvent } from "../src/openov-realtime-prediction.js";

const scheduled = "2026-10-13T19:57:00.000Z";

// Geen halte-update mag niet veranderen in een realtimevoorspelling.
assert.equal(
  summarizeRealtimeEvent(null, "departure", scheduled),
  null,
);
console.log("PASS: ontbrekende halte-update levert geen voorspelling op");

// Een update-object zonder tijd en zonder vertraging is ook geen voorspelling.
const emptyUpdate = summarizeRealtimeEvent(
  { stopId: "4015385" },
  "departure",
  scheduled,
);
assert.equal(emptyUpdate?.time, null);
assert.equal(emptyUpdate?.delaySeconds, null);
assert.equal(emptyUpdate?.delayBasis, "unknown");
console.log("PASS: halte-update zonder bruikbare tijd of vertraging blijft onbekend");

// Een vertraging in seconden zonder absolute tijd blijft een vertraging,
// maar er wordt geen absolute vertrektijd verzonnen.
const delayOnly = summarizeRealtimeEvent(
  { effectiveDepartureDelaySeconds: 67 },
  "departure",
  scheduled,
);
assert.equal(delayOnly?.time, null);
assert.equal(delayOnly?.delaySeconds, 67);
assert.equal(delayOnly?.delayBasis, "source_or_gtfs_propagated_delay");
console.log("PASS: vertraging zonder absolute tijd blijft correct gescheiden");

// Een expliciete realtime-tijd die gelijk is aan de dienstregeling mag nul opleveren.
const explicitZero = summarizeRealtimeEvent(
  { departureTime: Date.parse(scheduled) / 1000 },
  "departure",
  scheduled,
  { hasPerTripTimestamp: true },
);
assert.equal(explicitZero?.time, scheduled);
assert.equal(explicitZero?.delaySeconds, 0);
assert.equal(
  explicitZero?.delayBasis,
  "absolute_prediction_minus_scheduled_time",
);
console.log("PASS: expliciete nulvertraging blijft geldig");

// Een absolute voorspelling heeft voorrang op een tegenstrijdige gerapporteerde delay.
const absoluteWins = summarizeRealtimeEvent(
  {
    departureTime: Date.parse(scheduled) / 1000 + 67,
    departureDelaySeconds: 0,
  },
  "departure",
  scheduled,
);
assert.equal(absoluteWins?.delaySeconds, 67);
console.log("PASS: absolute voorspelling heeft voorrang op gerapporteerde vertraging");


// Een absolute haltevoorspelling exact één dag later is geen betrouwbare
// 24-uursvertraging als de timestamp van de rit zelf ontbreekt.
const scheduledSeconds = Date.parse(scheduled) / 1000;
const nextDaySeconds = scheduledSeconds + 86400;

const unconfirmedDayShift = summarizeRealtimeEvent(
  {
    departureTime: nextDaySeconds,
    effectiveDepartureDelaySeconds: 86400,
  },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(unconfirmedDayShift?.time, null);
assert.equal(unconfirmedDayShift?.delaySeconds, null);
assert.equal(unconfirmedDayShift?.delayBasis, "unconfirmed_whole_day_offset");
console.log("PASS: onbetrouwbare verschuiving van 24 uur blijft onbekend");

// Dezelfde controle geldt wanneer alleen een delay van één dag is opgegeven.
const unconfirmedDelayOnly = summarizeRealtimeEvent(
  { effectiveDepartureDelaySeconds: 86400 },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(unconfirmedDelayOnly?.time, null);
assert.equal(unconfirmedDelayOnly?.delaySeconds, null);
console.log("PASS: losse vertraging van 24 uur zonder rit-timestamp wordt geweigerd");

// Een expliciete rit-timestamp schakelt deze specifieke beveiliging uit.
// Andere controles en de verdere beoordeling van de bron blijven nodig.
const timestampedDayShift = summarizeRealtimeEvent(
  { departureTime: nextDaySeconds },
  "departure",
  scheduled,
  { hasPerTripTimestamp: true },
);
assert.equal(timestampedDayShift?.delaySeconds, 86400);
console.log("PASS: verschuiving wordt niet blind weggefilterd bij een rit-timestamp");


// Een dienstregeling-echo zonder expliciete vertraging blijft onbekend.
const scheduledEpochSeconds = Date.parse(scheduled) / 1000;
const scheduleEcho = summarizeRealtimeEvent(
  { departureTime: scheduledEpochSeconds },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(scheduleEcho?.time, null);
assert.equal(scheduleEcho?.delaySeconds, null);
assert.equal(scheduleEcho?.delayBasis, "unconfirmed_schedule_echo");
console.log("PASS: onbevestigde dienstregeling-echo blijft onbekend");

// Een expliciete vertraging van nul die overeenkomt met de absolute
// voorspelling mag ook zonder timestamp per rit worden getoond.
const explicitOnTime = summarizeRealtimeEvent(
  {
    departureTime: scheduledEpochSeconds,
    departureDelaySeconds: 0,
  },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(explicitOnTime?.time, scheduled);
assert.equal(explicitOnTime?.delaySeconds, 0);
assert.equal(
  explicitOnTime?.delayBasis,
  "absolute_prediction_minus_scheduled_time",
);
console.log("PASS: expliciet gemelde nulvertraging blijft zichtbaar");

// Tegenstrijdige brongegevens mogen de beveiliging niet omzeilen.
const inconsistentDelay = summarizeRealtimeEvent(
  {
    departureTime: scheduledEpochSeconds,
    departureDelaySeconds: 47,
  },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(inconsistentDelay?.time, null);
assert.equal(inconsistentDelay?.delaySeconds, null);
assert.equal(inconsistentDelay?.delayBasis, "unconfirmed_schedule_echo");
console.log("PASS: tegenstrijdige vertraging blijft onbekend");

// Een echte afwijking wordt niet verborgen alleen omdat de rit-timestamp ontbreekt.
const smallRealDeviation = summarizeRealtimeEvent(
  {
    departureTime: scheduledEpochSeconds + 2,
    departureDelaySeconds: 2,
  },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(smallRealDeviation?.delaySeconds, 2);
assert.ok(smallRealDeviation?.time);
console.log("PASS: echte afwijking van 2 seconden blijft zichtbaar");


// Een exact gekoppelde rit met een afwijkende halte-ID mag alleen via
// een unieke, tijdgecorreleerde gebeurtenis een vertrekprognose leveren.
const fallbackBaseSeconds = Date.parse(scheduled) / 1000;
const fallbackRecord = {
  stopUpdates: [
    {
      stopId: "4118548",
      stopSequence: 1,
      departureTime: fallbackBaseSeconds + 12,
      departureDelaySeconds: 12,
    },
    {
      stopId: "3923974",
      stopSequence: 2,
      departureTime: fallbackBaseSeconds + 144,
      departureDelaySeconds: 24,
    },
    {
      stopId: "3924098",
      stopSequence: 3,
      arrivalTime: fallbackBaseSeconds + 420,
      arrivalDelaySeconds: 0,
    },
  ],
};

const correlatedDeparture = findRealtimeStopByScheduledEvent(
  fallbackRecord,
  "departure",
  scheduled,
);
assert.equal(correlatedDeparture?.method, "scheduled_time_correlated");
assert.equal(correlatedDeparture?.stop.stopId, "4118548");
assert.equal(correlatedDeparture?.deltaSeconds, 0);

const correlatedPrediction = summarizeRealtimeEvent(
  correlatedDeparture.stop,
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(correlatedPrediction?.delaySeconds, 12);
assert.equal(
  correlatedPrediction?.time,
  new Date((fallbackBaseSeconds + 12) * 1000).toISOString(),
);
console.log("PASS: alternatieve halte-ID met overeenkomende tijd geeft 12 sec vertraging");

// Een update voor een eerdere halte mag niet als aankomst bij UMC worden gebruikt.
const missingDestination = findRealtimeStopByScheduledEvent(
  fallbackRecord,
  "arrival",
  "2026-10-13T20:10:00.000Z",
);
assert.equal(missingDestination, null);
console.log("PASS: ontbrekende aankomstupdate wordt niet verzonnen");



// Een verse voertuigpositie van exact dezelfde route, rit en dienstinstantie
// wordt herkend, maar levert op zichzelf geen haltevertraging op.
const vehicleNow = Date.parse("2026-10-15T09:04:30.000Z") / 1000;
const vehicleLeg = {
  tripId: "20261015_11:03_nl-OpenOV_391215411",
  routeId: "nl-OpenOV_159450",
  from: {
    scheduledDeparture: "2026-10-15T09:03:00.000Z",
  },
};
const vehiclePosition = {
  tripId: "391215411",
  routeId: "159450",
  startDate: "20261015",
  startTime: "11:03:00",
  timestamp: Date.parse("2026-10-15T09:04:22.000Z") / 1000,
  latitude: 52.0804,
  longitude: 5.11916,
  stopId: "4118548",
};
const observedVehicle = findExactVehiclePositionForLeg(
  vehicleLeg,
  [vehiclePosition],
  vehicleNow,
);
assert.equal(observedVehicle?.matchMethod, "exact_trip_id_vehicle_position");
assert.equal(observedVehicle?.ageSeconds, 8);
assert.equal(observedVehicle?.tripId, "391215411");
console.log("PASS: verse voertuigpositie gekoppeld aan exacte ritinstantie");

// Een andere rit-ID mag nooit de positie van deze rit overnemen.
assert.equal(
  findExactVehiclePositionForLeg(
    { ...vehicleLeg, tripId: "20261015_11:18_nl-OpenOV_391215419" },
    [vehiclePosition],
    vehicleNow,
  ),
  null,
);
console.log("PASS: voertuigpositie van een andere rit wordt niet gekoppeld");

// Een andere exploitatiedatum mag niet worden gekoppeld.
assert.equal(
  findExactVehiclePositionForLeg(
    vehicleLeg,
    [{ ...vehiclePosition, startDate: "20261016" }],
    vehicleNow,
  ),
  null,
);
console.log("PASS: voertuigpositie met afwijkende dienstdatum wordt geweigerd");

// Zonder datum of starttijd kan het numerieke GTFS-trip-ID dubbel voorkomen.
assert.equal(
  findExactVehiclePositionForLeg(
    vehicleLeg,
    [{
      ...vehiclePosition,
      startDate: undefined,
      startTime: undefined,
    }],
    vehicleNow,
  ),
  null,
);
console.log("PASS: ambigue voertuigpositie zonder dienstinstantie wordt geweigerd");

// Een te oude positie mag geen actuele waarneming opleveren.
assert.equal(
  findExactVehiclePositionForLeg(
    vehicleLeg,
    [{
      ...vehiclePosition,
      timestamp: vehicleNow - 181,
    }],
    vehicleNow,
  ),
  null,
);
console.log("PASS: voertuigpositie ouder dan 180 seconden wordt geweigerd");



const propagationFeedTime = Date.parse("2026-10-15T09:47:26.000Z") / 1000;
// Op halte 16: aankomst 30 seconden vertraagd, vertrek 40 seconden vertraagd.
// De vertrekgebeurtenis is de meest recente geplande gebeurtenis vóór de doelhalte.
const propagationRecord = {
  feedTimestampSeconds: propagationFeedTime,
  stopUpdates: [{
    stopId: "3923896", stopSequence: 16,
    arrivalTime: Date.parse("2026-10-15T09:46:30.000Z") / 1000,
    arrivalDelaySeconds: 30,
    departureTime: Date.parse("2026-10-15T09:47:00.000Z") / 1000,
    departureDelaySeconds: 40,
    scheduleRelationship: "SCHEDULED"
  }]
};

const propagatedDeparture = findPropagatedRealtimeEvent(
  propagationRecord, "departure", "2026-10-15T09:58:00.000Z",
  { nowSeconds: propagationFeedTime, targetStopId: "3923746" }
);
assert.ok(propagatedDeparture);
assert.equal(propagatedDeparture.time, "2026-10-15T09:58:40.000Z");
assert.equal(propagatedDeparture.delaySeconds, 40);
assert.equal(propagatedDeparture.sourceStopId, "3923896");
assert.equal(propagatedDeparture.sourceEventTime, "2026-10-15T09:47:00.000Z");
console.log("PASS: vertraging wordt naar een volgende vertrekhalte doorgegeven");

const propagatedArrival = findPropagatedRealtimeEvent(
  propagationRecord, "arrival", "2026-10-15T10:11:00.000Z",
  { nowSeconds: propagationFeedTime, targetStopId: "3924104" }
);
assert.ok(propagatedArrival);
assert.equal(propagatedArrival.time, "2026-10-15T10:11:40.000Z");
console.log("PASS: vertraging wordt naar een latere aankomsthalte doorgegeven");

assert.equal(
  findPropagatedRealtimeEvent(
    propagationRecord, "departure", "2026-10-15T09:58:00.000Z",
    { nowSeconds: propagationFeedTime, targetStopId: "3923896" }
  ),
  null
);
console.log("PASS: bestaande doelhalte-update wordt niet overschreven");

assert.equal(
  findPropagatedRealtimeEvent(
    propagationRecord, "departure", "2026-10-15T09:58:00.000Z",
    { nowSeconds: propagationFeedTime + 181, targetStopId: "3923746" }
  ),
  null
);
console.log("PASS: verouderde feed wordt niet doorgetrokken");

assert.equal(
  findPropagatedRealtimeEvent(
    {
      feedTimestampSeconds: propagationFeedTime,
      stopUpdates: [{
        stopId: "3923896", stopSequence: 16,
        departureTime: propagationEventTime
      }]
    },
    "departure", "2026-10-15T09:58:00.000Z",
    { nowSeconds: propagationFeedTime, targetStopId: "3923746" }
  ),
  null
);
console.log("PASS: zonder expliciete vertraging ontstaat geen afgeleide tijd");

assert.equal(
  findPropagatedRealtimeEvent(
    {
      ...propagationRecord,
      stopUpdates: [
        ...propagationRecord.stopUpdates,
        { stopId: "later", stopSequence: 17, scheduleRelationship: "NO_DATA" }
      ]
    },
    "departure", "2026-10-15T09:58:00.000Z",
    { nowSeconds: propagationFeedTime, targetStopId: "3923746" }
  ),
  null
);
console.log("PASS: NO_DATA blokkeert onveilige vertragingpropagatie");

assert.equal(
  findPropagatedRealtimeEvent(
    propagationRecord, "departure", "2026-10-15T10:40:00.000Z",
    { nowSeconds: propagationFeedTime, targetStopId: "3923746" }
  ),
  null
);
console.log("PASS: te ver vooruit liggende haltes krijgen geen afgeleide voorspelling");

console.log("Alle OpenOV-voorspellingsregressietests geslaagd.");
