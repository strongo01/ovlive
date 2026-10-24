# Automatic OpenOV route-shape refresh (no R2)

OVLive can refresh the static OpenOV route shapes using the public repository's standard GitHub-hosted Actions runner and publish them to a dedicated Cloudflare Worker. This avoids the blocked private-repository Actions budget and does not use R2.

## One-time setup

1. In Cloudflare, open **Workers & Pages** and create a basic **Hello World Worker** named `ovlive-openov-shapes` if it does not already exist. This is a normal Workers project; do not create an R2 bucket or enable an R2 subscription.
2. Open **My Profile → API Tokens** (https://dash.cloudflare.com/profile/api-tokens) and create a token scoped to that Worker with **Workers Scripts: Edit** access. Cloudflare may require a Worker-level Editor role for an existing Worker. Do not grant R2 permissions.
3. Open https://github.com/strongo01/ovlive/settings/secrets/actions.
4. Add the repository secret `CLOUDFLARE_API_TOKEN` with the token.
5. Add the repository secret `CLOUDFLARE_ACCOUNT_ID` with the account ID shown in the Cloudflare dashboard. Do not use the Zone ID.
6. Open **Actions → Refresh OpenOV route shapes in Cloudflare Workers → Run workflow** on `main`.

This deployment creates/updates the separate `ovlive-openov-shapes` Worker with the complete generated static geometry dataset. Cloudflare deploys the new worker version only after the files have been built and checked. The prior version remains active if the build or deployment fails.

## Connect the main OVLive Worker

The route-shape reader on branch `assistant/metro-resource-cache-prune-20261018` uses a Cloudflare service binding named `OPENOV_SHAPES_ASSETS` pointing to `ovlive-openov-shapes`. Once the first geometry Worker deployment succeeds, deploy the main Worker from that branch so it can request exact shape shards through the service binding.

## Schedule and safety

The update is scheduled for 22:35 UTC. If OpenOV has not published a new GTFS file yet, the workflow fails before deployment; the old geometry version remains live. The builder only maps exact `trip_id` and `route_id` pairs, so this does not introduce fuzzy route matches.

The asset upload uses the Workers static-asset limits (20,000 files per version and 25 MiB per file); the workflow checks those limits before publication. There is no R2 bucket, R2 subscription or R2 billing requirement.
