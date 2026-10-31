import { NdovFeedHub } from "./ndov-stream-hub.js";

// Exporteer dezelfde DO-klasse uit deze aparte Worker-bundle.
export { NdovFeedHub };

const HUB_ID = "ndov-shared-collector-v1";
const WORKER_NAME = "ovlive-ndov-kv78-parser-soak-test";
const MAX_SESSION_SECONDS = 120;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function callKv78Hub(env, pathname, seconds) {
  const id = env.NDOV_FEEDS.idFromName(HUB_ID);
  const stub = env.NDOV_FEEDS.get(id);
  const target = new URL(`https://ndov-hub.local${pathname}`);

  // Deze soak-test verzamelt uitsluitend KV78, nooit BISON.
  target.searchParams.set("stream", "kv78");

  if (seconds !== undefined) {
    target.searchParams.set("seconds", String(seconds));
  }
  if (pathname === "/status") {
    target.searchParams.set("includeRows", "0");
  }

  const response = await stub.fetch(target.toString());
  const body = await response.text();

  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/start" && url.pathname !== "/status") {
      return json({ ok: false, error: "Not found", worker: WORKER_NAME }, 404);
    }

    // De Worker is publiek bereikbaar via workers.dev, maar iedere actie vereist
    // een aparte Wrangler-secret. Het token staat nooit in een URL.
    const expectedToken = String(env.NDOV_TEST_TOKEN ?? "");
    const suppliedAuthorization = request.headers.get("authorization") ?? "";
    if (!expectedToken || suppliedAuthorization !== `Bearer ${expectedToken}`) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    if (url.pathname === "/status") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Use GET /status" }, 405);
      }
      return callKv78Hub(env, "/status");
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Use POST /start" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Expected a JSON body, for example {\"seconds\":120}" }, 400);
    }

    const seconds = Number(body?.seconds ?? MAX_SESSION_SECONDS);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < 10 ||
      seconds > MAX_SESSION_SECONDS
    ) {
      return json({
        ok: false,
        error: `seconds must be an integer between 10 and ${MAX_SESSION_SECONDS}`,
      }, 400);
    }

    return callKv78Hub(env, "/start", seconds);
  },
};
