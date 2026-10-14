# OVLive — Cloudflare Worker prototype

This is a **production-oriented test scaffold**, not a certified production journey planner yet. It is designed to run on Cloudflare Workers, with no local server required after deployment.

## What it does now

- Searches place names through Nominatim (OpenStreetMap) first, and falls back to Geoapify if Nominatim fails technically. Journey planning is provided by Transitous MOTIS v6.
- Keeps the Geoapify API key server-side in the Worker environment; it is not sent to the browser. The UI provides OpenStreetMap and Geoapify attribution.
- Fetches and decodes OpenOV / OVapi GTFS-Realtime feeds (`tripUpdates.pb`, `alerts.pb`, `trainUpdates.pb`, `vehiclePositions.pb`).
- Shows feed timestamp, measured age, HTTP status, entity count and raw normalized data.
- Explicitly marks unknown/stale feeds. It never infers “on time” from a missing update.
- Uses a same-origin frontend and a small set of fixed upstream URLs; it is not an arbitrary URL proxy.

## Important accuracy boundary

The journey planner currently **does not claim that every itinerary leg has been matched to a corresponding official realtime trip update**. Transitous and OpenOV can have mismatched GTFS identifiers or ingestion gaps. A production version must validate the identifier mapping and coverage per operator (NS, RET, HTM, GVB, Arriva, Connexxion, etc.) before it can safely show a delay/cancellation on an individual itinerary.

The OpenOV site lists its realtime products as KV78turbo (bus/tram/metro, DOVA source), NSAPIturbo (train, NS source) and GTFS-RT (OVapi source). These are distinct feeds with distinct coverage. Do not imply one GTFS-RT endpoint proves complete nationwide coverage.

## Requirements before public production use

1. Keep the source code public/open source if using Transitous, and check its current use policy. Transitous describes its API as best-effort, non-commercial and asks developers to contact the team before resource-intensive routing or multi-user traffic. Add a meaningful contact email/website and visible source attribution.
2. Replace `APP_CONTACT` in `wrangler.toml` with a real contact address or website.
3. Test feed timestamps and update coverage for each operator, including cancellations and alert selectors.
4. Add rate limiting / abuse protection (Cloudflare WAF/rate limiting or Turnstile) before exposing this as a public API. The current code has fixed upstreams but is not a complete abuse-control system.
5. Add monitoring and alerting for stale feeds, upstream errors and schema changes.
6. Implement verified itinerary-to-feed matching. Match by full trip identity (including service date/start time where required), not route alone. Missing realtime must display “geen realtimegegevens”, not “op tijd”.
7. Verify current terms and attribution for every upstream source, and provide an accessible privacy notice if logging user queries.

## Deploy to Cloudflare

1. Install Node.js LTS on your Mac if it is not installed.
2. Extract this ZIP and open Terminal in the `ovlive-cloudflare` folder.
3. Run:
   ```sh
   npm install
   npx wrangler login
   ```
4. Edit `wrangler.toml`: replace `APP_CONTACT` with your contact email or site URL. Do not deploy with the placeholder.
5. Configure the Geoapify fallback key. For local development, add `GEOAPIFY_API_KEY=your-key` to `.dev.vars` (that file is ignored by Git; never commit or share the key). For production, set it as a Cloudflare Worker secret:
   ```sh
   npx wrangler secret put GEOAPIFY_API_KEY
   ```
   Paste the key only into Wrangler's prompt. Nominatim remains the primary geocoder; Geoapify is used only after a technical Nominatim error.
6. Test locally (only for development):
   ```sh
   npm run dev
   ```
   Open the local URL shown by Wrangler. The app's backend requests still go to live upstream sources.
7. Deploy:
   ```sh
   npm run deploy
   ```
8. Open the deployed `workers.dev` URL and test `/api/health`, place search, then the feed viewer and journey planner.

## API routes

- `GET /api/health` — HTTP reachability check for each feed (not a timestamp validation).
- `GET /api/realtime?kind=tripUpdates&limit=300` — normalized GTFS-RT entities.
- `GET /api/realtime?kind=alerts&limit=300` — alerts.
- `GET /api/realtime?kind=trainUpdates&limit=300` — train update feed.
- `GET /api/realtime?kind=vehiclePositions&limit=300` — vehicle positions.
- `GET /api/geocode?q=Den%20Haag%20Centraal` — place search via Nominatim, with Geoapify as a technical-failure fallback.
- `GET /api/plan?fromPlace=52.07,4.30&toPlace=52.09,5.12` — journey planning proxy.
- `GET /api/stoptimes?stopId=...` — Transitous stop-time query.

## Sources

- openOV data catalogue: https://openov.nl/
- OpenOV GTFS-RT directory: https://gtfs.openov.nl/gtfs-rt/
- Transitous API and usage policy: https://transitous.org/api/
- Transitous API documentation: https://transitous.org/doc/
- GTFS-Realtime reference: https://gtfs.org/documentation/realtime/reference/
- OpenStreetMap copyright: https://www.openstreetmap.org/copyright

## Local validation performed here

The source files are generated, but live feed calls could not be verified from this environment because outbound DNS/network access was unavailable. Run `/api/health` after deploying to test the live endpoints from Cloudflare's network. Do not treat a successful deployment as proof of complete realtime coverage.
