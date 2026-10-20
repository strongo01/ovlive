import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/ns-train-details.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
const { normalizeNsTrainDetails } = await import(moduleUrl);

const data = normalizeNsTrainDetails(
  {
    payload: {
      materieelType: "VIRM",
      aantalBakken: 6,
      treinLengteMeters: 162,
      voorzieningen: {
        toilet: true,
        wifi: true,
        rolstoelToegankelijk: true,
        stopcontact: false
      }
    }
  },
  { payload: { prognose: "HIGH" } },
  "3525",
  "2026-10-20T08:30:00.000Z"
);

assert.equal(data.ok, true);
assert.equal(data.crowdForecast?.level, "high");
assert.equal(data.crowdForecast?.label, "Druk");
assert.equal(data.trainType, "VIRM");
assert.equal(data.unitCount, 6);
assert.equal(data.unitLabel, "delen");
assert.equal(data.lengthMeters, 162);
assert.equal(data.facilities.length, 4);
assert.equal(data.facilities.find(item => item.key === "toilet")?.available, true);
assert.equal(data.facilities.find(item => item.key === "stopcontact")?.available, false);
assert.equal(data.status, "available");
console.log("PASS: NS-drukte, materieel, expliciete lengte en voorzieningen worden genormaliseerd");

// NS kan voorzieningen ook als items/labels teruggeven, niet alleen als losse
// true/false-eigenschappen. Test die vorm, inclusief een expliciete afwezigheid.
const itemBased = normalizeNsTrainDetails(
  {
    payload: {
      materieelDelen: [{ volgnummer: 1 }, { volgnummer: 2 }, { volgnummer: 3 }, { volgnummer: 4 }],
      platformitems: [
        { type: "WC", beschikbaar: false },
        { type: "WIFI" },
        { naam: "ROLSTOELTOEGANKELIJK", aanwezig: true },
        { code: "USB" }
      ]
    }
  },
  null,
  "3525"
);
assert.equal(itemBased.unitCount, 4);
assert.equal(itemBased.unitLabel, "delen");
assert.equal(itemBased.facilities.find(item => item.key === "toilet")?.available, false);
assert.equal(itemBased.facilities.find(item => item.key === "wifi")?.available, true);
assert.equal(itemBased.facilities.find(item => item.key === "rolstoel")?.available, true);
assert.equal(itemBased.facilities.find(item => item.key === "stopcontact")?.available, true);
assert.equal(itemBased.facilities.length, 4);
console.log("PASS: voorzieningen uit NS-platformitems worden getoond en treindelen heten 'delen'");

const calm = normalizeNsTrainDetails(
  { payload: { crowdForecast: "LOW", length: 160 } },
  null,
  "661"
);
assert.equal(calm.crowdForecast?.level, "low");
assert.equal(calm.lengthMeters, null, "een lengte zonder bekende eenheid mag niet als meters worden gepresenteerd");
assert.equal(calm.facilities.length, 0);
assert.equal(calm.status, "available");
console.log("PASS: ontbrekende eenheden en voorzieningen worden niet ingevuld of gegokt");

const unknown = normalizeNsTrainDetails(
  null,
  null,
  "661",
  "2026-10-20T08:30:00.000Z",
  ["Drukteprognose: HTTP 403"]
);
assert.equal(unknown.ok, false);
assert.equal(unknown.crowdForecast, null);
assert.equal(unknown.lengthMeters, null);
assert.equal(unknown.facilities.length, 0);
assert.equal(unknown.status, "no_details");
assert.equal(unknown.errors.length, 1);
console.log("PASS: ontbrekende NS-data blijft onbekend en wordt niet als rustig of afwezig getoond");

const ui = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const realtime = await readFile(new URL("../src/ns-train-realtime.ts", import.meta.url), "utf8");
assert.ok(ui.includes("ns-train-details-button"), "UI must provide the on-demand train-details control");
assert.ok(ui.includes("function bindNsTrainDetailsButtons"));
assert.ok(ui.includes("fetch('/api/ns/train-details?'"));
assert.ok(ui.includes("class=\"ns-train-consist\""), "UI must show a visual train-composition diagram");
assert.ok(ui.includes("data-station-code="), "UI must pass the train's departure station for station-specific detail data");
assert.ok(!ui.includes("De ontvangen ritgegevens bevestigen op dit moment geen specifieke voorzieningen."),
  "UI should not show an unhelpful empty-facilities notice");
assert.ok(worker.includes('url.pathname === "/api/ns/train-details"'));
assert.ok(worker.includes('url.searchParams.get("stationCode")'), "Worker must validate and accept a station code");
assert.ok(realtime.includes("departureStationCode: fromCode"), "matched NS train legs must carry the departure station code");
console.log("PASS: UI shows train composition and requests station-specific NS details securely");
