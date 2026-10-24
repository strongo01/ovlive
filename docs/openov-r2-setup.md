# OpenOV route-shape refresh (Cloudflare R2)

The nightly workflow runs on standard GitHub-hosted runners for this **public** repository. GitHub documents standard Actions usage for public repositories as free; this is a supported free path, not a way to evade a paid quota.

## One-time setup

1. In Cloudflare, create an API token with the account permission **Workers R2 Storage: Edit**. Keep the token private.
2. Open **Settings → Secrets and variables → Actions** in this repository:
   https://github.com/strongo01/ovlive/settings/secrets/actions
3. Add repository secret `CLOUDFLARE_API_TOKEN` with that token.
4. Add repository secret `CLOUDFLARE_ACCOUNT_ID` with the Cloudflare Account ID (not the Zone ID).
5. Open **Actions → Refresh OpenOV trip shapes in Cloudflare R2 → Run workflow** and run it on `main`.

The workflow creates the `ovlive-openov-trip-shapes` R2 bucket if needed, builds the exact trip-ID/route-ID shape shards, uploads them under a versioned prefix, then publishes `manifest.json` last. A lifecycle rule expires old versioned shards after 14 days, keeping the current manifest's version and the previous versions available during refreshes.

## Deploy the Worker reader

After the first successful R2 refresh, update and deploy the Worker from branch `assistant/metro-resource-cache-prune-20261018`. That branch binds the `OPENOV_SHAPES` R2 bucket and reads only exact trip-ID + route-ID matches. The R2 bucket remains private; the Worker accesses it through its binding.

The workflow's scheduled refresh is at 22:35 UTC (23:35 Amsterdam during standard time, 00:35 during daylight saving time). The feed can be published later on some days. Check the Actions run log if a refresh fails; no new manifest is published until all new shards upload successfully.

## Cost and safety

R2 usage is subject to Cloudflare's current account limits/pricing. The workflow is intentionally separated from the Worker deployment: daily shape refreshes do not deploy the Worker. Do not commit API tokens or other secrets to the repository.
