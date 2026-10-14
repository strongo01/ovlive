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

console.log("Alle OpenOV-voorspellingsregressietests geslaagd.");
