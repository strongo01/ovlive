OVLive NDOV KV17 diagnostic patch (local test only)

This patch adds a standalone `latestMutations` sample to the isolated NDOV stream hub's /status output. It parses common KV17 events such as CANCEL, RECOVER, SHORTEN, LAG, CHANGEPASSTIMES, CHANGEDESTINATION, MUTATIONMESSAGE, and NOTMONITORED. It keeps a bounded sample across subscribed operators, not only U005/U011/U073, because KV17 events are relatively sparse.

It does NOT apply these mutation events to /api/plan or actual itineraries. KV15 is not implemented by this patch. Do not deploy the test hub.

Install (after stopping Wrangler with Ctrl+C):
  cd ~/Downloads
  unzip -o ovlive-ndov-kv17-diagnostic-patch.zip
  python3 ~/Downloads/ovlive-ndov-kv17-diagnostic-patch/apply-kv17-diagnostic-patch.py \
    ~/Desktop/ovlive-cloudflare-ovapi-crossmatch-copy

Test:
  cd ~/Desktop/ovlive-cloudflare-ovapi-crossmatch-copy/tools/ndov-cloudflare-stream-hub
  node scripts/selftest.mjs
  npx wrangler dev --config wrangler.toml --port 8792 --ip 127.0.0.1

Then in another terminal:
  curl -s 'http://127.0.0.1:8792/start?seconds=120' | python3 -m json.tool
  # wait until the session has completed
  curl -s 'http://127.0.0.1:8792/status' | python3 -m json.tool

Expected: BISON may contain a `latestMutations` array when KV17 payloads are received. Availability depends on what publishers send during the window. Live event availability is not guaranteed by this patch.
