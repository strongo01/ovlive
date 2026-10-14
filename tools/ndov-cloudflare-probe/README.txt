OVLive NDOV Cloudflare TCP/ZMTP probe (LOCAL ONLY)

Purpose
-------
This standalone, isolated Cloudflare Worker probes whether the Workers runtime can
open an outbound TCP socket to the public GOVI/NDOV best-effort ZeroMQ streams and
complete the ZMTP 3.x SUB handshake. It does not touch the OVLive planner route and
never writes to production or deploys anything.

Streams
-------
KV78Turbo: tcp://pubsub.besteffort.ndovloket.nl:7817
BISON:     tcp://pubsub.besteffort.ndovloket.nl:7658

The probe deliberately limits one request to one stream connection and a maximum
10-second receive window. KV78 uses /GOVI/KV8passtimes/ as its subscription prefix.
BISON subscribes to known operator prefixes, rather than every topic with '/'.
The test should not be run in parallel on another machine: GOVI states a fair-use
limit of one connection per consumer per stream.

Install into the test copy
--------------------------
Run the supplied installer:
  python3 ~/Downloads/ovlive-ndov-cloudflare-probe/install-ndov-cloudflare-probe.py \
    ~/Desktop/ovlive-cloudflare-ovapi-crossmatch-copy

Offline protocol self-test
--------------------------
From the project root:
  node tools/ndov-cloudflare-probe/scripts/zmtp-protocol-selftest.mjs

Run the isolated worker locally
-------------------------------
  cd ~/Desktop/ovlive-cloudflare-ovapi-crossmatch-copy/tools/ndov-cloudflare-probe
  npx wrangler dev --port 8791 --ip 127.0.0.1

Then open one of:
  http://127.0.0.1:8791/probe?stream=kv78&seconds=5
  http://127.0.0.1:8791/probe?stream=bison&seconds=5

Run only one probe at a time, and close it when it returns. It is normal that a local
runtime probe may fail due to unsupported local TCP sockets or the stream protocol;
the JSON response reports the exact stage. This has NOT been deployed.

Important constraints
--------------------
- Do not run `wrangler deploy` for this test-only worker.
- `workers_dev = false` and `preview_urls = false` are set as extra safeguards.
- The probe is intentionally read-only and does not change any OVLive files.
- The probe may receive public operational data; samples are capped in the response.
- This is not a long-lived subscriber or production ingestion architecture.
- Cloudflare TCP sockets support outbound connections. Durable Objects can be kept
  active by an outbound socket, but the documented keep-alive contribution of each
  connection is capped at 15 minutes; a production subscriber must implement robust
  reconnection/health-checking and shared storage. See Cloudflare TCP sockets docs.
