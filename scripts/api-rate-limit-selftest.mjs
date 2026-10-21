import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/api-rate-limit.ts", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

const ovapiGuard = workerSource.indexOf('url.pathname.startsWith("/api/ovapi-test/") &&');
const ovapiMatchDispatch = workerSource.indexOf('if (url.pathname === "/api/ovapi-test/match-plan")');
assert.ok(ovapiGuard >= 0, "OVAPI public diagnostic guard is missing");
assert.ok(ovapiMatchDispatch > ovapiGuard, "OVAPI match-plan is dispatched before the public-host guard");
console.log("PASS: public OVAPI diagnostic routes are blocked before dispatch");

const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
const { enforcePublicApiRateLimit } = await import(moduleUrl);
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "https://ovlive.pages.dev"
};
const defaultDeviceId = "a".repeat(32);

function request(url, ip = "203.0.113.8", deviceId = defaultDeviceId) {
  const requestHeaders = {};
  if (ip) requestHeaders["cf-connecting-ip"] = ip;
  if (deviceId !== null) requestHeaders["x-ovlive-device-id"] = deviceId;
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

assert.equal(await enforcePublicApiRateLimit(
  request("http://127.0.0.1:8787/api/plan", null),
  {},
  headers
), null);
console.log("PASS: local Worker calls bypass production quotas");

assert.equal(await enforcePublicApiRateLimit(
  request("https://ovlive.example/"),
  {},
  headers
), null);
console.log("PASS: static website requests are outside API quotas");

const missingIp = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime", null),
  { API_RATE_LIMITER: limiter(), DEVICE_API_RATE_LIMITER: limiter() },
  headers
);
assert.equal(missingIp.status, 503);
console.log("PASS: public API without client IP fails closed");

const missingBinding = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  {},
  headers
);
assert.equal(missingBinding.status, 503);
console.log("PASS: missing required limiter bindings reject public API calls");

const commonIpOk = limiter([true]);
const commonDeviceOk = limiter([true]);
assert.equal(await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: commonIpOk, DEVICE_API_RATE_LIMITER: commonDeviceOk },
  headers
), null);
assert.deepEqual(commonIpOk.calls, ["client:203.0.113.8"]);
assert.deepEqual(commonDeviceOk.calls, ["device:" + defaultDeviceId]);
console.log("PASS: general requests consume both IP fallback and browser quotas");

const commonIpBlocked = limiter([false]);
const deviceNotCalled = limiter([true]);
const ipBlockedResponse = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: commonIpBlocked, DEVICE_API_RATE_LIMITER: deviceNotCalled },
  headers
);
assert.equal(ipBlockedResponse.status, 429);
assert.equal(ipBlockedResponse.headers.get("retry-after"), "60");
assert.deepEqual(deviceNotCalled.calls, []);
console.log("PASS: IP fallback quota returns HTTP 429 and short-circuits later limiters");

const deviceBlockedResponse = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: limiter([true]), DEVICE_API_RATE_LIMITER: limiter([false]) },
  headers
);
assert.equal(deviceBlockedResponse.status, 429);
console.log("PASS: browser API quota can block a single browser without hitting the IP ceiling");

const planIp = limiter([true]);
const planDeviceApi = limiter([true]);
const planPerIp = limiter([true]);
const planPerDevice = limiter([false]);
const planDeviceBlocked = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/plan"),
  {
    API_RATE_LIMITER: planIp,
    DEVICE_API_RATE_LIMITER: planDeviceApi,
    PLAN_RATE_LIMITER: planPerIp,
    DEVICE_PLAN_RATE_LIMITER: planPerDevice
  },
  headers
);
assert.equal(planDeviceBlocked.status, 429);
assert.deepEqual(planIp.calls, ["client:203.0.113.8"]);
assert.deepEqual(planDeviceApi.calls, ["device:" + defaultDeviceId]);
assert.deepEqual(planPerIp.calls, ["client:203.0.113.8"]);
assert.deepEqual(planPerDevice.calls, ["device:" + defaultDeviceId]);
console.log("PASS: route planning consumes general and route-specific IP and browser quotas");

const planIpBlocked = limiter([false]);
const blockedPlanDevice = limiter([true]);
const planIpBlockedResponse = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/plan"),
  {
    API_RATE_LIMITER: limiter([true]),
    DEVICE_API_RATE_LIMITER: limiter([true]),
    PLAN_RATE_LIMITER: planIpBlocked,
    DEVICE_PLAN_RATE_LIMITER: blockedPlanDevice
  },
  headers
);
assert.equal(planIpBlockedResponse.status, 429);
assert.deepEqual(blockedPlanDevice.calls, []);
console.log("PASS: IP route-planning safety quota remains an independent backstop");

const refreshCommon = limiter([true]);
const refreshDevice = limiter([true]);
const refreshIpPlan = limiter([false]);
const refreshDevicePlan = limiter([false]);
assert.equal(await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime-refresh", "203.0.113.8", "b".repeat(32)),
  {
    API_RATE_LIMITER: refreshCommon,
    DEVICE_API_RATE_LIMITER: refreshDevice,
    PLAN_RATE_LIMITER: refreshIpPlan,
    DEVICE_PLAN_RATE_LIMITER: refreshDevicePlan
  },
  headers
), null);
assert.deepEqual(refreshCommon.calls, ["client:203.0.113.8"]);
assert.deepEqual(refreshDevice.calls, ["device:" + "b".repeat(32)]);
assert.deepEqual(refreshIpPlan.calls, []);
assert.deepEqual(refreshDevicePlan.calls, []);
console.log("PASS: frequent realtime polling uses general quotas, not route-planning quotas");

const noDeviceIdIpOnly = limiter([true]);
assert.equal(await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime", "203.0.113.9", null),
  { API_RATE_LIMITER: noDeviceIdIpOnly },
  headers
), null);
assert.deepEqual(noDeviceIdIpOnly.calls, ["client:203.0.113.9"]);
console.log("PASS: direct API clients without a browser ID remain protected by IP quotas");

const missingDeviceBinding = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: limiter([true]) },
  headers
);
assert.equal(missingDeviceBinding.status, 503);
console.log("PASS: a present browser ID requires its configured limiter");

const failingLimiter = { async limit() { throw new Error("simulated limiter failure"); } };
const failClosed = await enforcePublicApiRateLimit(
  request("https://ovlive.example/api/realtime"),
  { API_RATE_LIMITER: failingLimiter, DEVICE_API_RATE_LIMITER: limiter([true]) },
  headers
);
assert.equal(failClosed.status, 503);
console.log("PASS: a limiter error fails closed");

console.log("All API rate-limit regression tests passed.");