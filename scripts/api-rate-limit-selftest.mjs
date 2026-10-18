import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/api-rate-limit.ts", import.meta.url),
  "utf8"
);
const workerSource = await readFile(
  new URL("../src/index.ts", import.meta.url),
  "utf8"
);

// Statische dispatch-regressie: alle OVAPI-testendpoints moeten worden
// afgewezen voor publieke hosts voordat een specifieke handler kan lopen.
const ovapiGuard = workerSource.indexOf(
  'url.pathname.startsWith("/api/ovapi-test/") &&'
);
const ovapiMatchDispatch = workerSource.indexOf(
  'if (url.pathname === "/api/ovapi-test/match-plan")'
);
assert.ok(ovapiGuard >= 0, "OVAPI publieke-hostguard ontbreekt");
assert.ok(
  ovapiMatchDispatch > ovapiGuard,
  "OVAPI match-plan wordt vóór de publieke-hostguard afgehandeld"
);
console.log("PASS: publieke OVAPI-diagnoseroutes worden vóór dispatch geblokkeerd");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = "data:text/javascript;base64," +
  Buffer.from(compiled).toString("base64");
const { enforcePublicApiRateLimit } = await import(moduleUrl);
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "https://ovlive.pages.dev"
};

function request(url, ip = "203.0.113.8") {
  const requestHeaders = ip ? { "cf-connecting-ip": ip } : {};
  return new Request(url, { headers: requestHeaders });
}

function limiter(results = [true]) {
  const calls = [];
  return {
    calls,
    async limit(input) {
      calls.push(input.key);
      const value = results.length ? results.shift() : true;
      if (value instanceof Error) throw value;
      return { success: value };
    }
  };
}

assert.equal(
  await enforcePublicApiRateLimit(
    request("http://127.0.0.1:8787/api/plan", null),
    {},
    headers
  ),
  null
);
console.log("PASS: lokale Worker-aanvragen worden niet door productiequota geblokkeerd");

assert.equal(
  await enforcePublicApiRateLimit(
    request("https://ovlive.example/"),
    {},
    headers
  ),
  null
);
console.log("PASS: statische pagina's vallen buiten de API-limiet");

const missingIp = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime", null),
  { API_RATE_LIMITER: limiter() },
  headers
);
assert.equal(missingIp.status, 503);
console.log("PASS: publieke API zonder clientidentiteit faalt gesloten");

const missingBinding = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  {},
  headers
);
assert.equal(missingBinding.status, 503);
console.log("PASS: ontbrekende limiterbinding laat geen publieke API-aanvraag door");

const commonOk = limiter([true]);
assert.equal(
  await enforcePublicApiRateLimit(
    request("https://ovlive.example/api/realtime"),
    { API_RATE_LIMITER: commonOk },
    headers
  ),
  null
);
assert.deepEqual(commonOk.calls, ["client:203.0.113.8"]);
console.log("PASS: geldige publieke API-aanvraag verbruikt clientquotum");

const commonBlocked = limiter([false]);
const blockedResponse = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: commonBlocked },
  headers
);
assert.equal(blockedResponse.status, 429);
assert.equal(blockedResponse.headers.get("retry-after"), "60");
console.log("PASS: algemene limiet geeft HTTP 429 en Retry-After");

const planCommon = limiter([true]);
const planBlocked = limiter([false]);
const planResponse = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/plan"),
  { API_RATE_LIMITER: planCommon, PLAN_RATE_LIMITER: planBlocked },
  headers
);
assert.equal(planResponse.status, 429);
assert.deepEqual(planCommon.calls, ["client:203.0.113.8"]);
assert.deepEqual(planBlocked.calls, ["client:203.0.113.8"]);
console.log("PASS: reisplanning heeft een aparte strengere limiet");

const refreshCommon = limiter([true]);
const refreshBlocked = limiter([false]);
const refreshResponse = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime-refresh"),
  { API_RATE_LIMITER: refreshCommon, PLAN_RATE_LIMITER: refreshBlocked },
  headers
);
assert.equal(refreshResponse.status, 429);
assert.deepEqual(refreshCommon.calls, ["client:203.0.113.8"]);
assert.deepEqual(refreshBlocked.calls, ["client:203.0.113.8"]);
console.log("PASS: realtime-verversing deelt de aparte strengere reisplanninglimiet");

const failingLimiter = {
  async limit() { throw new Error("simulated limiter failure"); }
};
const failClosed = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: failingLimiter },
  headers
);
assert.equal(failClosed.status, 503);
console.log("PASS: storing in limiter faalt gesloten");

console.log("Alle API-rate-limit-selftests geslaagd.");
