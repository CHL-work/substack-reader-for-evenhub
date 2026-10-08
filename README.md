# Reader for Substack

An [Even Hub](https://hub.evenrealities.com) plugin that shows public Substack posts on Even Realities G2 glasses. You choose publications on your phone and read them on the glasses, one page at a time.

- Version 0.1.1, package id `com.chlwork.substackreader`, built with Even Hub SDK 0.0.16 (requires Even app 2.2.10 or later).
- English only. No account, no login, no cookies.
- This is an independent project. It is **not affiliated with Substack Inc. or Even Realities**.

Version 0.1.1 is published as **Beta** in [Even Hub](https://hub.evenrealities.com/hub/com.chlwork.substackreader), with a [GitHub prerelease](https://github.com/CHL-work/substack-reader-for-evenhub/releases/tag/v0.1.1-alpha.1). Automated checks passed; real G2 device acceptance is still pending. The owner's confirmed Even app account was invited on 2026-10-07. They must accept the invitation before the app appears in **My Plugins**; acceptance and installation are unverified. Future testers must likewise be invited to the testing group and accept their invitations.

The display name is defined in two places that must agree: `APP_NAME` in `src/config.ts` and `name` in `app.json`. `scripts/pack.mjs` refuses to package if they differ.

## Screenshots

None yet. Screenshots for the Even Hub listing must be taken with the simulator's screenshot function.

## How it works

```
 G2 glasses (576x288, text only)
      ^  title / body / footer text containers, gestures, contextual menu
      |  Bluetooth, via the Even app
      v
 Even app on the phone -> WebView running this plugin (.ehpk)
      |  phone UI: add publications, browse, settings, diagnostics
      |  glasses controller: Home, lists, reader; DOMParser HTML -> text; pagination
      |  storage: Even bridge storage (main copy) + WebView localStorage (mirror)
      |
      |  HTTPS GET, no cookies, no custom headers (whitelisted origin)
      v
 Relay (worker/relay.ts on Cloudflare Workers or OpenAI Sites)
      |  fixed read-only routes, host allowlist, honest User-Agent,
      |  trims Substack JSON, short edge cache, no logs, no storage
      v
 Substack: <name>.substack.com, custom domains, substack.com/api/v1/...
```

The phone cannot fetch Substack directly: Substack sends no CORS headers, the SDK has no native HTTP bridge, and Even Hub only lets a plugin reach origins listed in its `app.json` whitelist. The app therefore talks to one relay that you deploy. The relay's origin is baked into the build and added to the whitelist when the package is made.

Post HTML is converted to plain text on the phone and never inserted into the page. The text is paginated with Even's own font metrics (`@evenrealities/pretext`), so every page fits the glasses without scrolling. More detail: [architecture](docs/architecture.md), [glasses UI](docs/glasses.md), [relay API](docs/relay.md), [privacy](docs/privacy.md).

## Features

- **Add publications** by pasting a `*.substack.com` link, a custom domain (for example `www.slowboring.com`), a post or share link, an `@handle` (to import that person's public subscriptions), or a name to search for. Several lines are added one by one. Share text is shown as skipped instead of being searched: the title or blurb directly above a link (also when several share texts are pasted together), any text next to the link in a short share text (up to 3 lines with a single link), and a line too long to search in a paste that has a link.
- **Glasses Home:** Continue (the post you were reading), Latest (newest posts across your publications), Publications, Saved, and History. The items and their order are set on the phone.
- **Reader:** page counter, percentage and minutes left in the footer. Reading positions are saved, so a post reopens where you stopped, including when you launch the app from the glasses menu.
- **Gestures:** swipe to move or turn pages, tap to open or turn, double-tap to go back (and to exit from Home), plus a contextual menu (Home, Save for later, Next post, Restart post, Refresh). See [docs/glasses.md](docs/glasses.md).
- **Settings:** lines per page (7, 6 or 5), tap behaviour in the reader, inverted swipes, image placeholders, footnote placement, upper-case short headings, emoji removal, Home items, and how many publications feed Latest.
- **Readable conversion:** headings, quotes, lists, code, footnotes, tweets, images, galleries, embeds, formulas and polls are turned into plain text or short placeholders such as `[Image: caption]`. Characters the glasses font cannot draw are replaced.
- **Fallback:** if Substack blocks, rate-limits or cannot serve the first archive request, both phone and glasses try the publication's RSS feed through the same relay. You can add publications, browse and save recent posts, paste recent post URLs, and reopen saved posts after restarting. Only posts still present in the feed are available while the API is unavailable; RSS does not provide older archive pages, search, @handle imports or numeric share-link lookups.

## Limitations

- **Free posts are shown in full. Paid posts show only Substack's public preview**, followed by a card saying the rest is for paid subscribers. There is no login and no way to use a subscription.
- You need your own relay. Its origin is fixed at build time, so moving the relay means a new build and a new upload to Even Hub.
- Substack may block or rate-limit requests from Cloudflare Workers, especially for `*.substack.com` hosts and `substack.com` search. Check with `/v1/health?probe=1` after deploying (see [docs/relay.md](docs/relay.md)). The app reports the problem honestly; it never pretends to be a browser.
- The app uses Substack's undocumented web endpoints. They can change without notice.
- No images, audio or video on the glasses, only placeholders. Podcast posts show their text, if any.
- Article text is kept in memory only, so there is no offline reading. The Even WebView cannot use the network in the background.
- Search uses Substack's site-wide search and may return few results for some names. If it is unavailable, paste a publication URL; recent posts can still work through RSS when the archive API is rate-limited.
- Your library is kept twice: in the Even app's storage (the main copy) and in the WebView. The WebView remembers which version of the main copy it last matched, so edits that only reached the WebView (because the Even app's storage did not answer in time) are written back as they are, removals, "Clear reading" and "Reset settings" included. Only when the main copy holds changes the WebView never saw (for example after the WebView lost its copy) are the two merged item by item, so nothing is lost. The cost: in that case a publication or saved post removed in only one copy can come back; remove it again.

## Setup

Current setup (2026-10-07): the relay is deployed at [substack-reader-relay.chihin-lau-work.workers.dev](https://substack-reader-relay.chihin-lau-work.workers.dev). GitHub has both deployment secrets and the build origin configured. Live checks found HTTP 429 from Substack's archive/search APIs, while RSS feeds for `on.substack.com` and `www.slowboring.com` returned 200. Version 0.1.1 extends RSS recovery to phone onboarding and saved-post reopening. The optional rss2json service remains disabled. Real glasses testing is still required; see [the handoff](docs/HANDOFF.md) for deployment evidence, package status and next steps.

### 1. Deploy the relay

The relay is one file, `worker/relay.ts`. Pick one host:

- **Cloudflare, from GitHub Actions (recommended).**
  1. In Cloudflare, create an API token with the **Workers Scripts: Edit** permission, and make sure your account has a `workers.dev` subdomain (if you have never deployed a Worker, open Workers & Pages in the Cloudflare dashboard once to choose one).
  2. In this repository, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables → Actions → Secrets).
  3. Run **Actions → Deploy relay → Run workflow**. The Worker URL is `https://substack-reader-relay.<your-subdomain>.workers.dev`.
- **Cloudflare, from your computer** (PowerShell, portable Node):
  ```powershell
  $env:PATH = "C:\Code\substack-reader-for-evenhub\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
  pnpm install --frozen-lockfile
  pnpm exec wrangler login
  pnpm exec wrangler deploy --var REVISION:manual
  ```
  Wrangler is a pinned devDependency (4.148.0 in `pnpm-lock.yaml`), so the deploy runs the locked version, never a freshly resolved one.
- **OpenAI Sites** (the host used by the LIHKG reader): see [.openai/README-sites.md](.openai/README-sites.md).

Then open `https://<relay-origin>/v1/health?probe=1` in a browser. You should see `"service":"substack-reader-relay"` and `"protocol":1`, plus one probe result per kind of Substack host. The relay probes at most once a minute; reloading within that minute shows the same results with `"cached":true`. [docs/relay.md](docs/relay.md) explains how to read them.

### 2. Set the relay origin

Add the repository **variable** (not a secret) `VITE_RELAY_ORIGIN` with the bare origin, for example `https://substack-reader-relay.example-account.workers.dev`: https, and nothing after the host name except an optional `/`. It is public, because it ends up in the package's network whitelist.

Optional variable `ENABLE_RSS2JSON_FALLBACK=1` builds with `VITE_ENABLE_RSS2JSON_FALLBACK=1` and adds `https://api.rss2json.com` to the whitelist. Leave it unset: the app's built-in fallback uses the relay's own feed route, and Even Hub review expects every whitelisted domain to be used.

### 3. Build the package

- **In CI:** every push runs the **CI** workflow. When `VITE_RELAY_ORIGIN` is set, it uploads the artifact `substack-reader-ehpk` (`substack-reader-0.1.1.ehpk`). Publishing a GitHub release whose tag matches `package.json` (for example `v0.1.1-alpha.1`, marked as a pre-release) runs the **Release package** workflow, which attaches the `.ehpk` to the release.
- **Locally** (PowerShell, portable Node; this only builds and packs, it runs no tests):
  ```powershell
  $env:PATH = "C:\Code\substack-reader-for-evenhub\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
  pnpm install
  pnpm run check
  $env:VITE_RELAY_ORIGIN = "https://<relay-origin>"
  pnpm run build
  pnpm run pack      # -> artifacts/substack-reader-0.1.1.ehpk
  ```

`pnpm run pack` refuses to package when `dist/` was built for a different relay origin or version, when the Even Hub CLI prints a warning, or when the CLI does not stamp `min_app_version 2.2.10`. It needs network access to the npm registry, because the CLI looks up the SDK's minimum app version there.

### 4. Upload to Even Hub

1. Sign in at [hub.evenrealities.com](https://hub.evenrealities.com) with your developer account and open (or create) the project for `com.chlwork.substackreader`.
2. Under **Builds**, upload `substack-reader-0.1.1.ehpk` and write a short change log (Even requires one for every version).
3. A new build starts as **Private**. Promote it to **Beta** (open the build's Private badge, choose Beta, then Promote to Beta). The LIHKG reader once showed an "expired" message because this step was missed.
4. As a tester, install or update it in the Even app (Me → Beta tester). Private builds appear under Even Hub → Me → Apps → Private builds.
5. Work through [docs/device-checklist.md](docs/device-checklist.md) on real glasses. For the listing's privacy policy, use `https://<relay-origin>/privacy` together with [docs/privacy.md](docs/privacy.md).

## Development rules

Continuing the work? Read [docs/HANDOFF.md](docs/HANDOFF.md) (status, next steps, open issues) and [AGENTS.md](AGENTS.md) (rules for coding agents) first.

- **Runtime tests run only in GitHub Actions.** Every test script (`scripts/ci-tests.mjs`, `scripts/browser-ci.mjs`, `scripts/ui-ci.mjs`) throws unless `CI=true`. Locally you only install, type-check (`pnpm run check`), build and pack. Do not start a dev server, the simulator, Playwright or a browser locally.
- Check a commit's CI result, including failure details, with `node scripts/ci-status.mjs [commit] [--wait]` (GitHub job logs need a login; the test runners publish failures as annotations).
- Tests live in `tests/unit/*.test.ts` (Node, `node:test`), `tests/browser/*.test.ts` (Chromium with all network blocked, for `DOMParser` code) and `scripts/ui-ci.mjs` (phone and glasses flows against a stub of the Even bridge). Fixtures contain only invented text.
- Node is portable: prefix commands with the `PATH` line shown above. pnpm 10.32.1 comes from corepack (`packageManager` in `package.json`). Install with the committed lockfile.
- No UI framework. Strict TypeScript. `src/config.ts` is the only module that reads `import.meta.env`. `src/substack/html.ts` must stay ASCII-only.
- The relay never spoofs a browser, never sends cookies and never logs requests. Keep it that way.

| Path | Purpose |
| --- | --- |
| `src/main.ts`, `src/phone/` | Phone UI and wiring |
| `src/glasses.ts`, `src/events.ts`, `src/input.ts` | Even bridge wrapper, event mapping, gesture filter |
| `src/app/` | Glasses state machine (`controller.ts`), frames, formatting, app types |
| `src/substack/` | Relay client, input parsing, HTML to text, article header, RSS parsing, shared types |
| `src/pagination.ts`, `src/storage.ts` | Pagination with offsets; persisted state |
| `worker/` | The relay and its landing and privacy pages |
| `scripts/` | CI test runners, `ci-annotate.mjs` (failure annotations), `ci-status.mjs` (read CI results), `pack.mjs`, `check-relay-origin.mjs` |
| `.github/workflows/` | `ci.yml`, `release.yml`, `deploy-relay.yml` |
| `docs/` | Handoff (status and next steps), architecture, glasses UI, relay, privacy, device checklist; `docs/background/` holds the research and review records |

## Local workspace layout

On the owner's Windows computer, reserve `C:\Code` for `ai-trading-platform`, `stardust-itinerary`, `lihkg-reader-for-evenhub`, and `substack-reader-for-evenhub`. Each repository owns its related local files; do not create tools, research files, secrets, or extra checkouts alongside these four directories.

| Repository-relative path | Purpose |
| --- | --- |
| `.worktrees/` | Linked Git worktrees for this project; create or relocate them with `git worktree add` / `git worktree move` so Git keeps the registration valid. |
| `.tools/node/` | This computer's portable Node toolchain, including its corepack/pnpm shims. Use the updated `PATH` commands above. |
| `.local/research/` | Ignored local research metadata and scratch files. The rule against retaining article text or HTML still applies. |
| `.env` | Ignored project configuration, with `.env.example` as the committed template. |
| `node_modules/`, `dist/`, `artifacts/` | Existing ignored dependencies, build output, and release packages. |

`.worktrees/`, `.tools/`, `.local/`, and any repository-local `.pnpm-store/` are ignored. The installed dependencies currently use the pnpm cache under `%LOCALAPPDATA%\pnpm\store`; they do not need a cache at `C:\Code\.pnpm-store`. Keep source and durable documentation in their existing tracked directories. Historical references in `docs/background/` describe their original research environment.

The October 7, 2026 cleanup preserved the earlier relay research (`c.json`, `cache.md`, `gh_search.json`, `gh_search2.json`, `i280.json`, `iss.json`, and the empty `rd.json`) in `.local/research/relay-20261006/`. These files were mistakenly left in the LIHKG checkout; all seven were moved with matching SHA-256 hashes. The portable Node toolchain was moved intact into `.tools/node/`; Node 22.23.3, pnpm 10.32.1, and `pnpm run check` passed at the new location. Runtime tests remain CI-only.

Build and package discovery stays within the application: `tsconfig.json` includes only `src/`, `worker/`, `tests/`, and `vite.config.ts`; CI discovers tests only in `tests/unit/` and `tests/browser/`. Vite follows `index.html` and its imports and copies `public/`; `pack.mjs` stages only `dist/`, excluding the relay and hosting metadata. The Sites instructions stage the relay bundle and hosting file explicitly. The October 7 static compiler file-list audit found no inputs from `.worktrees/`, `.tools/`, `.local/`, or `.pnpm-store/`, and neither `public/` nor the existing package staging directory linked to those local directories. Keep these explicit boundaries when adding tools or packaging steps; Git ignore rules alone do not restrict a build.

## Configuration reference

| Name | Where | Purpose |
| --- | --- | --- |
| `VITE_RELAY_ORIGIN` | repository variable, or local env / `.env` | Relay origin baked into the build and whitelisted by `pack.mjs` |
| `ENABLE_RSS2JSON_FALLBACK` | repository variable, or local env at pack time | `1` whitelists `https://api.rss2json.com` (default off). In CI it also sets `VITE_ENABLE_RSS2JSON_FALLBACK=1` for the build. |
| `VITE_ENABLE_RSS2JSON_FALLBACK` | local env at build time | `1` lets the build call rss2json. `pack.mjs` refuses a build whose flag differs from `ENABLE_RSS2JSON_FALLBACK`. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | repository secrets | Used only by the Deploy relay workflow |
| `REVISION` | Worker variable | Optional; shown by `/v1/health` (the deploy workflow sets the short commit hash) |

## Trademarks

Substack is a trademark of Substack Inc. Even Realities, Even Hub and G2 are trademarks of Even Realities. They are named here only to describe what this app works with.
