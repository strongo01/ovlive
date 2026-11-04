import { NdovFeedHub } from "./ndov-stream-hub.js";

// Exporteer dezelfde DO-klasse uit deze aparte Worker-bundle.
export { NdovFeedHub };

// Geheugen-soak: draait KV78 én BISON in ÉÉN gedeeld Durable Object (zoals productie) in de
// continue modus, zodat het gecombineerde geheugen over langere tijd zichtbaar wordt.
// Dit is een aparte Worker met een eigen DO-namespace: geen productiegegevens of -isolate.
// Zet NDOV_COMPACT_RECORDS = "false" voor de baseline en "true" voor de gepatchte variant.
const HUB_ID = "ndov-shared-collector-v1";
const STREAMS = ["kv78", "bison"];

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

async function callHub(env, pathname, stream) {
  const stub = env.NDOV_FEEDS.get(env.NDOV_FEEDS.idFromName(HUB_ID));
  const target = new URL(`https://ndov-hub.local${pathname}`);
  target.searchParams.set("stream", stream);
  if (pathname === "/status") target.searchParams.set("includeRows", "0");
  const response = await stub.fetch(target.toString());
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body };
}

// Compacte samenvatting; geen rijen of events in de respons.
function summarize(stream, result) {
  const b = result.body ?? {};
  return {
    stream, httpStatus: result.status, state: b.state ?? null, error: b.error ?? null,
    startedAt: b.startedAt ?? null, latestMessageAt: b.latestMessageAt ?? null,
    messageCount: b.messageCount ?? null, rawBytes: b.rawBytes ?? null,
    storedKv78RowCount: b.storedKv78RowCount ?? null, storedKv6TripCount: b.storedKv6TripCount ?? null,
    continuousEnabled: b.continuousEnabled ?? null,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["/start", "/status", "/stop"].includes(url.pathname)) return json({ ok: false, error: "Not found" }, 404);

    const expectedToken = String(env.NDOV_TEST_TOKEN ?? "");
    if (!expectedToken || request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const variant = { compactRecords: String(env.NDOV_COMPACT_RECORDS ?? "true").toLowerCase() !== "false" };

    if (url.pathname === "/status") {
      if (request.method !== "GET") return json({ ok: false, error: "Use GET /status" }, 405);
      const results = await Promise.all(STREAMS.map((s) => callHub(env, "/status", s)));
      return json({ ok: true, variant, streams: results.map((r, i) => summarize(STREAMS[i], r)) });
    }
    if (request.method !== "POST") return json({ ok: false, error: `Use POST ${url.pathname}` }, 405);

    const action = url.pathname === "/start" ? "/continuous/enable" : "/continuous/disable";
    const results = await Promise.all(STREAMS.map((s) => callHub(env, action, s)));
    return json({ ok: results.every((r) => r.status < 400), variant, action, streams: results.map((r, i) => ({ stream: STREAMS[i], httpStatus: r.status, body: r.body })) });
  },
};
