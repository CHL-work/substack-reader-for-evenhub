# Hosting the relay on OpenAI Sites

The relay (`worker/relay.ts`) can run on OpenAI Sites (`*.chatgpt.site`, the hosting the LIHKG reader uses) instead of Cloudflare. This file is instructions only. The repository contains no Sites project id, and nothing here deploys automatically: Sites versions are saved and deployed with the Sites tools in the owner's ChatGPT/Codex environment, which other tools cannot use.

## What Sites expects

- A **Worker build**: `dist/server/index.js`, an ES module whose default export has `fetch(request, env, ctx)`. `pnpm run build` writes exactly this file (an esbuild bundle of `worker/relay.ts`). The LIHKG project deployed `dist/server/index.mjs` with an older pipeline; the current one expects `index.js`.
- `dist/.openai/hosting.json` in the archive, naming the project. The relay is stateless, so it needs no database, no storage and no migrations:

  ```json
  { "project_id": "<new Sites project id>", "d1": null, "r2": null }
  ```

- A project of its own. Do not add the relay to the LIHKG project; that would tie two apps and their releases together.

## Steps

1. **Create a project** with the Sites tools and note its project id.
2. **Create `.openai/hosting.json`** at the repository root with the JSON above. The id is not a secret, so you may commit it; never commit Sites credentials.
3. **Build** (PowerShell, portable Node). The relay bundle does not depend on `VITE_RELAY_ORIGIN`.
   ```powershell
   $env:PATH = "C:\Code\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
   pnpm install
   pnpm run build
   ```
4. **Make a relay-only archive.** Only the Worker and the hosting file go in; the plugin's own files (`index.html`, `assets/`) are not needed by the relay.
   ```powershell
   $stage = "artifacts/site-relay-staging"
   if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
   New-Item -ItemType Directory -Force "$stage/dist/server", "$stage/dist/.openai" | Out-Null
   Copy-Item dist/server/index.js "$stage/dist/server/index.js"
   Copy-Item .openai/hosting.json "$stage/dist/.openai/hosting.json"
   tar -czf artifacts/site-relay-0.1.0.tar.gz -C $stage dist
   Get-FileHash artifacts/site-relay-0.1.0.tar.gz -Algorithm SHA256
   ```
   Record the source commit, the archive's SHA-256 and its size. `artifacts/` is git-ignored.
5. **Push the source** to the project's Sites source repository if your Sites flow asks for it. Keep any short-lived push credential in memory only, as the LIHKG project did.
6. **Save and deploy** the archive as a new site version with the Sites tools, and wait until the deployment reports success. Record the version and deployment ids.
7. **Make the site public.** The Even WebView sends no login, so a private site is unreachable for the app. A public audience needs the owner's explicit approval.
8. **Check it:** open `https://<site-origin>/v1/health?probe=1`. Expect `"service":"substack-reader-relay"`, `"protocol":1` and `"revision":null`, plus the three probe results (see [docs/relay.md](../docs/relay.md#health-and-probes)).
9. **Point the app at it:** set the repository variable `VITE_RELAY_ORIGIN` to the site origin (for example `https://<project>.<user>.chatgpt.site`). CI then builds the `.ehpk` with that origin in its network whitelist.

To update the relay later, repeat steps 3 to 6. The origin stays the same, so the plugin does not need a new package.

## Differences from Cloudflare

- **No rate-limit binding.** The relay falls back to an in-memory bucket of 60 requests per minute per client and route, per isolate, which is weaker when many isolates run.
- **One shared rate-limit key.** The relay trusts `CF-Connecting-IP` only when the request carries Cloudflare's `request.cf` object (a client could set the header anywhere else). If Sites requests have no `request.cf`, all clients share one bucket per route (60 per minute in total per isolate, and 10 per minute for custom-domain mapping proofs and health probes). Check this before sharing the app widely.
- **No `REVISION` variable** unless Sites lets you set runtime values, so `/v1/health` reports `revision: null`.
- **Edge cache unverified.** The relay uses `caches.default` when present and works without it.
- **Same kind of egress.** Sites runs on Cloudflare too, so Substack may treat its requests like a Worker's. Compare the health probes with the Cloudflare deployment.
- `scripts/pack.mjs` never puts `dist/server/` or `dist/.openai/` into the `.ehpk`, so the relay bundle and this hosting file never ship inside the plugin.
