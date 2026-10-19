import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(
  new URL("../src/index.ts", import.meta.url),
  "utf8"
);
const frontend = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8"
);
const rateLimiter = await readFile(
  new URL("../src/api-rate-limit.ts", import.meta.url),
  "utf8"
);

const refreshStart = worker.indexOf(
  'if (isRealtimeRefresh && request.method === "POST")'
);
const refreshEnd = worker.indexOf(
  'if (url.pathname === "/api/health")',
  refreshStart
);
assert.ok(refreshStart >= 0, "Realtime-refresh handler ontbreekt");
assert.ok(refreshEnd > refreshStart, "Realtime-refresh handler heeft geen duidelijke grens");
const refreshHandler = worker.slice(refreshStart, refreshEnd);

assert.match(
  rateLimiter,
  /const isJourneyPlanRequest = url\.pathname === "\/api\/plan";/,
  "Alleen handmatig reisplannen moeten de strenge planlimiet gebruiken"
);
assert.match(
  frontend,
  /livePlanRealtimeFailureStreak/,
  "De frontend moet opeenvolgende tijdelijke fouten bijhouden"
);
assert.match(
  frontend,
  /livePlanRealtimeRetryAfterMs/,
  "De frontend moet automatisch kunnen back-offen"
);
assert.match(
  frontend,
  /Realtimegegevens zijn tijdelijk niet beschikbaar\. De bestaande tijden blijven staan; OVLive controleert automatisch opnieuw\./,
  "Tijdelijke storingen moeten de bestaande tijden behouden en automatisch opnieuw proberen"
);
const refreshStart = frontend.indexOf("async function refreshLivePlanRealtime(");
const refreshEnd = frontend.indexOf("function startLivePlanRealtimeRefresh(", refreshStart);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "De realtime-verversingsfunctie ontbreekt");
const refreshFunction = frontend.slice(refreshStart, refreshEnd);
const retryableBranchStart = refreshFunction.indexOf("if (retryable) {");
const nonRetryableBranchStart = refreshFunction.indexOf("} else if (statusElement)", retryableBranchStart);
assert.ok(retryableBranchStart >= 0 && nonRetryableBranchStart > retryableBranchStart,
  "Tijdelijke en niet-tijdelijke fouten moeten apart worden afgehandeld");
assert.doesNotMatch(
  refreshFunction.slice(retryableBranchStart, nonRetryableBranchStart),
  /Realtime-update mislukt: \$\{reason\}/,
  "Tijdelijke HTTP 503-fouten mogen niet de herhaalde ruwe foutstatus tonen"
);
assert.match(
  refreshFunction,
  /Realtime-update mislukt: \$\{reason\}/,
  "Niet-tijdelijke fouten moeten hun bruikbare foutdetails behouden"
);
assert.match(
  refreshHandler,
  /enrichTransitousPlan\(planData, \{ includeVehiclePositions: false \}\)/,
  "De 10-seconden-plannerupdate mag de volledige voertuigposities-feed niet opnieuw ophalen"
);
assert.match(
  worker,
  /const OPENOV_ALERTS_CACHE_TTL_MS = 30_000;/,
  "Storingsmeldingen moeten van de snelle ritfeeds gescheiden gecachet worden"
);
assert.match(
  refreshHandler,
  /\[OVLIVE_REALTIME_REFRESH_STAGE\]/,
  "Per-bron timingdiagnostiek ontbreekt"
);
assert.match(
  refreshHandler,
  /\[OVLIVE_REALTIME_REFRESH_COMPLETE\]/,
  "Volledige refresh-diagnostiek ontbreekt"
);

console.log("PASS: achtergrondpolling gebruikt geen strenge reisplanlimiet");
console.log("PASS: tijdelijke realtimefouten krijgen back-off en een rustige herstelmelding");
console.log("PASS: live kaart behoudt de eigen exacte voertuigpositie-update");
console.log("PASS: storingsfeeds zijn minder frequent en per bron wordt timing gelogd");
console.log("Alle realtime-refresh-resilience-selftests geslaagd.");
