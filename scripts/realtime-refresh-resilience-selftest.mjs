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
const frontendRefreshStart = frontend.indexOf("async function refreshLivePlanRealtime(");
const frontendRefreshEnd = frontend.indexOf("function startLivePlanRealtimeRefresh(", frontendRefreshStart);
assert.ok(frontendRefreshStart >= 0 && frontendRefreshEnd > frontendRefreshStart, "De realtime-verversingsfunctie ontbreekt");
const refreshFunction = frontend.slice(frontendRefreshStart, frontendRefreshEnd);
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
  worker,
  /const OPENOV_FEED_CACHE_TTL_MS = 30_000;/,
  "Grote trip- en treinfeeds mogen niet bij elke 10-secondenpoll opnieuw worden gedecodeerd"
);
assert.match(
  worker,
  /const OPENOV_VEHICLE_POSITION_CACHE_TTL_MS = 12_000;/,
  "De voertuigposities voor de live kaart moeten kort gecachet blijven"
);
assert.match(
  worker,
  /openovRealtimeFeedIndexCache\.tripEntities === tripEntities/
);
assert.match(
  worker,
  /openovRealtimeFeedIndexCache\.trainEntities === trainEntities/
);
assert.match(
  worker,
  /getOpenovRealtimeFeedIndexCache\(tripFeed, trainFeed\)/,
  "De zware ritindex moet tussen realtimepolls worden hergebruikt"
);
assert.match(
  worker,
  /decodeOpenovTripUpdates\(bytes, normalizedTripUpdateFilters\)/,
  "De planner moet de selectieve protobuf-decoder gebruiken voor ritupdates"
);
assert.match(
  worker,
  /buildOpenovTripUpdateFilters\(\s*openovLegs\.filter\(/,
  "De trip-updatefilter moet uit de relevante reisopties worden opgebouwd"
);
assert.match(
  worker,
  /safeOpenovFeed\(OPENOV\.tripUpdates, "tripUpdates", tripUpdateFilters\)/,
  "De volledige tripupdates-feed mag niet meer ongericht worden gedecodeerd tijdens plannerpolling"
);
assert.match(
  worker,
  /\[OVLIVE_TRIP_UPDATE_DECODE\]/,
  "De gerichte ritdecoder moet duur en decoded entity-aantallen loggen"
);
assert.match(
  worker,
  /const OPENOV_FEED_WAIT_TIMEOUT_MS = 10_000;/,
  "OpenOV-feeds moeten een begrensde wachttijd hebben"
);
assert.match(
  worker,
  /Promise\.race\(\[feedPromise, timeoutPromise\]\)/,
  "Een trage OpenOV-feed mag de volledige realtime-update niet ophouden"
);
assert.match(
  worker,
  /\[OVLIVE_OPENOV_FEED_WAIT_TIMEOUT\]/,
  "Een vastlopende OpenOV-feed moet zichtbaar worden gelogd"
);
assert.match(
  worker,
  /const OPENOV_FEED_INFLIGHT_MAX_AGE_MS = 18_000;/,
  "Vastgelopen single-flight beloften mogen niet permanent nieuwe polls blokkeren"
);
assert.match(
  worker,
  /stale_single_flight_evicted/,
  "Een vastgelopen feeddownload moet uit de gedeelde inflight-cache kunnen worden verwijderd"
);
assert.match(
  refreshHandler,
  /\[OVLIVE_REALTIME_REFRESH_OPENOV_START\]/,
  "De start van de OpenOV-verversingsstap moet zichtbaar worden gelogd"
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
console.log("PASS: planner decodet alleen relevante OpenOV-ritupdates en route-/dienstdatumkandidaten");
console.log("PASS: grote OpenOV-feeds en matcherindex worden hergebruikt om CPU-limiet te ontzien");
console.log("PASS: storingsfeeds zijn minder frequent en per bron wordt timing gelogd");
console.log("Alle realtime-refresh-resilience-selftests geslaagd.");
