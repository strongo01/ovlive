import assert from "node:assert/strict";
import { summarizeRealtimeEvent } from "../src/openov-realtime-prediction.js";

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


// Een tijd die de dienstregeling exact herhaalt zonder rit-timestamp
// bewijst niet dat de trein realtime is gevolgd.
const scheduledEpochSeconds = Date.parse(scheduled) / 1000;
const scheduleEcho = summarizeRealtimeEvent(
  {
    departureTime: scheduledEpochSeconds,
    departureDelaySeconds: 0,
  },
  "departure",
  scheduled,
  { hasPerTripTimestamp: false },
);
assert.equal(scheduleEcho?.time, null);
assert.equal(scheduleEcho?.delaySeconds, null);
assert.equal(scheduleEcho?.delayBasis, "unconfirmed_schedule_echo");
console.log("PASS: dienstregeling-echo zonder rit-timestamp blijft onbekend");

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

console.log("Alle OpenOV-voorspellingsregressietests geslaagd.");
