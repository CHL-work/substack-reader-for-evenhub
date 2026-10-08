# Handoff: Reader for Substack (Even Hub plugin for Even G2)

## Active update: older posts (2026-10-08)

Changes from `fix/older-posts` through `6b3507f` have passed [CI](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37814056599) and been fast-forwarded to `main`. v0.1.2 is Published Beta, but **the owner's older-post issue remains blocked by Substack's responses to Cloudflare**. The owner is already using the app with two publications and reports that 陸行之 stops after four readable posts / cannot load older posts. Publisher identity is `andrewhclu.substack.com`. Live RSS has 20 posts, while the deployed archive API returns 429. RSS recovery has no older-page cursor (`nextOffset=null`), so older posts outside RSS remain inaccessible. There is no intentional four-post cap in the client; regressions cover all 20 RSS posts and the fourth-to-fifth transition. Do not describe this request as fully fixed until live older pages succeed from the chosen relay host.

An isolated Cloudflare probe confirmed `/sitemap.xml` 200 with 165 post URLs, normal `/archive` HTML 429, and an older `/p/<slug>` page 200 with public preloads. [Probe run](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37809714465) includes status/shape only and confirmed cleanup of the disposable Worker. Its temporary workflow was removed. The first probe run needed propagation delay and scoped API cleanup (Wrangler delete tried an ungranted KV permission); no token expansion or production change was made for the probe.

v0.1.2 adds bounded sitemap + public article-page recovery in the relay, and `source=sitemap` continuation in phone/glasses paging so API and sitemap offsets never mix. At most four public article pages are hydrated concurrently, within a shared 10-second deadline; partial failure fails the page for retry. Actual titles/dates come from post metadata, not sitemap lastmod. Public paid previews remain previews, no cookies/login/scripts, and no article bodies are persisted on the phone. RSS remains the last recovery path when public pages also fail. See [relay.md](relay.md) for the contract and security bounds.

The initial v0.1.2 commit `92298b9` passed [all branch CI checks](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37810911436) and was fast-forwarded to main. Its client package is **Published Beta** in Even Hub (118,326 bytes, SHA-256 `2c534ab27b62b13f6bedc711e26b4578d40ba4fd3223fee280c0f3f3c3d19e70`). Live verification caught extra sitemap namespace declarations and boolean script attributes; `6910b54` corrected both, passed [CI](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37811776355), and was deployed. Health confirmed `6910b54`; automatic first-page recovery returned four posts and `nextOffset=4`, and `/v1/post` for `what-if-tsmc-to-spend-us100bn-in` returned its public paid preview (1575 characters). The client package is unaffected by the parser-only correction. The `v0.1.2-alpha.1` and `.2` tags are source checkpoints, not published releases.

However, explicit older pages at offsets 4, 20 and 164 still returned upstream 429. A [second isolated probe](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37813038031) identified the remaining cause: sitemap 200, but public post URLs at offsets 4 (`understanding-the-balance-film-industry-be1`), 5 (`micron-turning-from-margin-to-capacity`) and 20 (`3-reasons-might-turn-nvidia-into`) each returned 429. Those pages answered 200 with matching metadata to honest requests from the owner's computer. The probe was removed successfully; no article body was logged or saved. Stop repeated probes of those refused pages, and do not spoof headers, send cookies or rotate IPs.

`wrangler.toml` now sets `PUBLIC_ARCHIVE_FALLBACK=0` to preserve the 20-post RSS list on Cloudflare. This switches off only automatic archive recovery; explicit sitemap requests and public post recovery remain supported. It prevents reducing the recent list to the first four accessible public pages. The owner has been asked whether an existing Deno Deploy/Vercel account is available, or whether hosting must stay on Cloudflare. **No answer yet; no other hosting account/project created.** The relay bundle is portable; a new accepted origin requires changing the GitHub build-origin variable and a new plugin package/whitelist. Sites also uses Cloudflare egress and is not a demonstrated fix.

The switch-off change `6b3507f` passed CI and [deployed successfully](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37814548333). Direct health confirmed revision `6b3507f`, protocol 1. At 17:12 UTC on 2026-10-08, normal archive requests returned `503 UPSTREAM_RATE_LIMITED` with upstream 429, allowing client RSS recovery, and the feed returned 200 with 20 items. Refresh the glasses list or reopen phone Browse to clear any retained sitemap cursor; actual reading of the fifth post on the owner's device remains unverified. Pending: the owner's hosting choice, actual older-page success from that host, and a device retest. Confirm the installed version is v0.1.2 before testing `source=sitemap` paging; v0.1.1 does not carry that cursor. No new GitHub release will be published while this older-post fix remains blocked. The published GitHub release remains `v0.1.1-alpha.1`; the v0.1.2 tags are source checkpoints only. Historical v0.1.1 records are retained in section 7. No local runtime tests are permitted.

Read this file first, then [AGENTS.md](../AGENTS.md) (rules), then the docs it points to. The [README](../README.md) is written for the owner; this file is written for the next agent.

## 1. In one paragraph

Reader for Substack is an Even Hub plugin: a Vite + TypeScript web app (no UI framework) that runs inside the Even Realities phone app's WebView and shows public Substack posts as paginated text on Even G2 glasses through `@evenrealities/even_hub_sdk` 0.0.16. Substack sends no CORS headers and the Even WebView enforces both CORS and the `app.json` network whitelist, so all Substack traffic goes through a stateless relay (`worker/relay.ts`) at `https://substack-reader-relay.chihin-lau-work.workers.dev`. v0.1.2 is Published Beta in Even Hub, and the owner is using the app with two publications. CI is green through deployed revision `6b3507f`, which disables automatic sitemap archive recovery on Cloudflare and preserves the 20 recent RSS posts. Older public article pages still return 429 from this host; changing hosts awaits the owner's answer and is not a demonstrated fix. Built-in RSS recovery remains enabled, rss2json remains disabled, and the detailed hardware checklist still needs observed results.

## 2. Status

| Area | State | Evidence |
| --- | --- | --- |
| Phone UI (add by link / custom domain / @handle import / search, browse, Saved, settings, diagnostics, about) | v0.1.2 passed CI, including all 20 RSS items and sitemap cursor paging | Regression flows in `scripts/ui-ci.mjs`; owner has added two publications; API-only features remain subject to upstream throttling |
| Glasses UI (Home, Latest, Publications, Saved, History, reader with resume, end card, contextual menu, error frames) | v0.1.2 passed CI, including later RSS items, source-pinned older pages and cold Saved/History/Continue recovery | Unit regressions in `tests/unit/controller.test.ts` and UI flows with a stubbed bridge; older-page success is still blocked live |
| Substack HTML to glasses text | Done | CI browser tests on 11+ synthetic fixtures (`tests/browser/html.test.ts`) |
| Relay (routes, allowlist, custom-domain checks, caps, rate limits, cache, CSP) | **Deployed**, revision `6b3507f`, protocol 1; automatic public archive fallback off | [Deployment](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37814548333) passed; direct health, normal archive error and 20-item RSS verified at 17:12 UTC |
| Storage (bridge storage + localStorage mirror, merge, sync stamps) | Done | CI unit tests (`tests/unit/storage.test.ts`) and UI scenarios 12–12e |
| Cloudflare setup | `workers.dev` ready; both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` encrypted GitHub secrets saved; `VITE_RELAY_ORIGIN` variable saved | Authorized Workers Scripts Write token expires 2027-01-06 |
| Packaging (`.ehpk`) | v0.1.2 build/pack passed; client package uploaded and Published Beta | 118,326 bytes; SHA-256 recorded below; later relay-only changes do not change this client package |
| Real G2 hardware | Owner reports using the app, with a four-post / older-post problem; detailed acceptance remains incomplete | [device-checklist.md](device-checklist.md) is still unchecked; do not infer full hardware validation from CI |
| Substack reachability | Archive API 429; `andrewhclu.substack.com` RSS 200 with 20 items; sitemap 200 but selected older public pages 429 from Cloudflare | Live checks and [isolated probe](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37813038031); no further repeated probing of refused pages |
| Even Hub | [Project `com.chlwork.substackreader`](https://hub.evenrealities.com/hub/com.chlwork.substackreader): v0.1.2 **Published Beta** | Owner is already using the app with two publications; confirm installed version for the next retest; public listing/review not started |
| GitHub prerelease | Latest published release remains [`v0.1.1-alpha.1`](https://github.com/CHL-work/substack-reader-for-evenhub/releases/tag/v0.1.1-alpha.1) at `b963146`; package attached | [Release workflow](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37725451196) passed; asset hash matches the historical v0.1.1 package in section 7 |

CI at the current code baseline: `node scripts/ci-status.mjs 6b3507f`. `main` includes this revision. No GitHub v0.1.2 release is published or planned while the older-post fix remains blocked; `v0.1.2-alpha.1` and `.2` are source checkpoints only.

Local v0.1.2 package uploaded to Even Hub: `artifacts/substack-reader-0.1.2.ehpk`, 118,326 bytes, SHA-256 `2c534ab27b62b13f6bedc711e26b4578d40ba4fd3223fee280c0f3f3c3d19e70`. Build and pack passed with the sole relay whitelist entry and minimum Even app version 2.2.10 for SDK 0.0.16. CI validates the software; it does not confirm live older-post availability or complete hardware acceptance.

## 3. What to do next

### 3A. Hosting decision and device retest

The owner is already using the app. Physical phone and glasses retesting requires the owner; invitation acceptance is not a current blocker.

1. **Refresh or reopen the publication list.** Deployment of `6b3507f` and RSS availability are verified. An already-open list can retain its sitemap source, so Refresh on glasses or reopening Browse on the phone is needed to return to the recent RSS list. Previously cached automatic sitemap pages can take up to five minutes to expire after a configuration change. Do not repeatedly retry the already-refused older pages. Rotate the configured API token before 2027-01-06.
2. **Await the owner's hosting answer.** They were asked whether an existing Deno Deploy/Vercel account is available or hosting must stay on Cloudflare. Do not create another hosting account/project without that answer. Any proposed host still needs an honest, bounded reachability check; a successful alternative requires a new relay origin, build variable, plugin whitelist/package and device retest. Keep the current Cloudflare RSS route available while older-page recovery is blocked.
3. **Retest the installed app and record observations in [device-checklist.md](device-checklist.md).** Confirm the installed version before source-aware paging tests. Check scrolling/saving/reading beyond item four in the 20-item RSS list, then cold Saved/History/Continue after restart. Older posts outside RSS remain blocked on the current host; API-only search and public @handle import can also be unavailable. Do not mark affected checks passed or publish a new GitHub release as a completed older-post fix.

### 3B. Follow-up after deployment and device testing

1. **Interpret the relay probe** (`/v1/health?probe=1`, or the Deploy relay job summary). It probes one `*.substack.com` archive, one custom-domain archive and `substack.com` search:

   | Probe result | Meaning | Action |
   | --- | --- | --- |
   | All 200 | Substack accepts the relay | Nothing; proceed to device testing |
   | `subdomain` 403/challenge, `customDomain` 200 | Substack blocks this egress for `*.substack.com` only (seen from GitHub Actions IPs during research) | Await the owner's hosting choice, then assess a supported host per `docs/relay.md` "Other hosts"; Sites also uses Cloudflare egress and is not a demonstrated remedy. rss2json remains off by owner choice. |
   | `substackCom` 403 or empty | Search and @handle import fail; links still work | Same options; the phone already falls back to "paste a link" |
   | 429 | Shared-egress rate limiting; observed on all three deployed API probes | Use built-in RSS recovery for recent posts when feeds answer; respect retry delays and do not hammer Substack |

   Never "fix" a block by spoofing a browser User-Agent, rotating IPs or replaying cookies. The owner's projects explicitly forbid that.
2. **Act on device results.** Likely adjustments and where they live:
   - Swipe direction feels inverted: change the default of `invertSwipe` in `src/app/types.ts` (`defaultSettings`).
   - Taps or swipes do not arrive, or arrive twice: compare the Diagnostics event log with `mapEvent` in `src/events.ts` and the filter timings in `src/input.ts` (`DEFAULT_GESTURE_TIMING`).
   - Text overflows or the firmware scrolls inside a page: check `G2_LAYOUT` and the 27 px line height in `src/pagination.ts`; consider paginating to 6 lines by default.
   - Missing glyphs (boxes or blanks): extend the mapping table in `src/substack/html.ts` (`normalizeChars`; keep the file ASCII-only, use `\u` escapes).
   - Library lost after an app update: bridge storage persistence across updates is unverified (`src/storage.ts`).
3. **Release hygiene for a future releasable build:** bump `version` in both `package.json` and `app.json` (the pack script refuses mismatches), push and wait for green CI. Publish a GitHub prerelease only when the release scope is ready; do not publish one for the currently blocked older-post fix. Source tags alone are not published releases.

### 3C. Before a public Even Hub listing (owner decisions first)

- **Name:** "Reader for Substack" contains a trademark; public review may object. The alternative considered was "Newsletter Reader". The name lives in `src/config.ts` (`APP_NAME`) and `app.json` (`pack.mjs` checks they match; at most 20 characters, never "Even").
- **Privacy policy URL:** the relay serves one at `https://<relay-origin>/privacy` (`worker/landing.ts`); keep it in line with [privacy.md](privacy.md).
- **Screenshots:** Even requires simulator screenshots. The owner's rule bans running the simulator locally without permission, so ask first.
- **Icon:** `public/icon.svg` is an original greyscale page-with-lines glyph (no Substack logo).
- Even's review rules that the code already follows: no black first screen (a frame is drawn at startup), root double-tap calls `shutDownPageContainer(1)`, one container captures input, every whitelisted domain is used.

### 3D. Backlog (not started; ideas, not commitments)

- Offline reading: a small LRU of converted article text (the owner chose "no persistent article text" for v0.1 because of Substack's terms; revisit only with the owner).
- Prefetch the next page or post while reading (v0.1 fetches only on demand).
- Substack Notes, podcasts transcripts, comments: not supported.
- Paid posts with the reader's own subscription: rejected (it would mean handling Substack cookies or sessions).
- Languages other than English (`app.json` `supported_languages: ["en"]`).
- Upgrade the toolchain (TypeScript 7, Vite 8, pnpm 12 exist; v0.1 stays on TypeScript 5.9.3, Vite 6.4.3, pnpm 10.32.1, which the LIHKG reader proved with this SDK).

### 3E. Known open issues and accepted trade-offs

These were found in review and deliberately left as they are, or only partly fixed. Details in [background/](background/).

| Issue | Where | Notes |
| --- | --- | --- |
| Cache entries on a shared Cloudflare cache are not authenticated (round 2 Y5) | `worker/relay.ts` | Acceptable on a dedicated account; documented right after security rule 9 in `docs/relay.md`. HMAC-signed entries would fix it. |
| Removed items can come back when both storage copies changed since they last matched | `src/storage.ts` (`mergePrefs`) | Chosen over ever losing a library; the sync stamp covers the common one-sided cases. |
| "Could not read your library…" notice stays after a later successful merge | `src/main.ts` | Cosmetic. |
| A late bridge write of the newest document is not counted as saved | `src/storage.ts` (`lateWrite`) | The phone keeps showing the failed save until the next save rewrites it. |
| Save for later on a posts list only redraws while the display is stale | `src/app/controller.ts` (`actsOnShown`) | Deliberate: it would otherwise save a row the wearer never saw. |
| Worst-case waits | `src/main.ts`, `src/events.ts` | The library gate can last about 46 s when every bridge read times out; a frame on a very slow link can take about 30 s (5 s per container update). Double-tap exit keeps working. |
| `pnpm install` prints "Ignored build scripts: workerd" | wrangler devDependency | Harmless; `wrangler deploy` does not need workerd. |
| The rss2json URL string is in the bundle even with the flag off | `src/substack/api.ts` | No request is made unless built with `VITE_ENABLE_RSS2JSON_FALLBACK=1`. |
| Substack endpoints are undocumented | `worker/relay.ts`, `src/substack/api.ts` | Normalizers are defensive; fixtures make breakage obvious in CI. |
| GitHub's `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19 | `.github/workflows/*.yml` | Watch the first CI run after that date (Playwright's `--with-deps` install is the likeliest break). |

## 4. How to work on this repo (summary; the rules are in AGENTS.md)

- **No local runtime tests.** The owner's standing rule (also for the LIHKG reader): never run the test runners, a dev server, Playwright, a browser or the Even simulator locally. Locally only `pnpm install`, `pnpm run check`, `pnpm run build`, `pnpm run pack`, and `node --check`. Every test runner throws unless `CI=true`.
- **Toolchain:** no system Node. Portable Node 22.23.3 with a corepack pnpm 10.32.1 shim is in `C:\Code\substack-reader-for-evenhub\.tools\node`; prepend it to `PATH` per command (PowerShell: `$env:PATH = "C:\Code\substack-reader-for-evenhub\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"`; Bash: `export PATH="/c/Code/substack-reader-for-evenhub/.tools/node:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0`).
- **The CI loop is the test loop:** commit on a branch, push, then `node scripts/ci-status.mjs --wait`. GitHub job logs need a login (there is no `gh` CLI), so the test runners publish failure details as annotations (`scripts/ci-annotate.mjs`), which the status script prints. Anonymous GitHub API calls are limited to 60 per hour.
- **Tests:** write them carefully because you cannot run them: trace each expectation against the code, keep them deterministic (fake clocks; see `tests/unit/helpers.ts`), and update existing expectations whenever behaviour changes. Conventions: `tests/unit/*.test.ts` (`node:test`, bundled by esbuild), `tests/browser/*.test.ts` (Chromium, every network request aborted, uses `tests/browser/harness.ts`), `scripts/ui-ci.mjs` (production build with a stubbed Even bridge and a fake relay at `https://relay.ci.invalid`). Fixtures hold invented text only.
- **Git:** the local clone has a repo-level identity `CHL-work <131831160+CHL-work@users.noreply.github.com>` (set it again in a fresh clone). End commit messages with the `Co-Authored-By` trailer your harness specifies. Work on a branch, wait for green CI, then fast-forward `main` (`git push origin HEAD:main`). Pushing uses Git Credential Manager.

## 5. Map of the code and docs

| Path | What |
| --- | --- |
| [README.md](../README.md) | Owner-facing overview, setup, build, upload, configuration |
| [docs/architecture.md](architecture.md) | Components, every module's responsibility, reading flow, lists, persistence and merge rules, build, testing, decisions |
| [docs/glasses.md](glasses.md) | Layout geometry, gestures and filter, contextual menu, every frame's exact wording, reader text, lifecycle |
| [docs/relay.md](relay.md) | Relay routes, envelope, error codes, security rules, health probe, deployment options, client contract |
| [docs/privacy.md](privacy.md) | What is stored, what the relay sees, third parties |
| [docs/device-checklist.md](device-checklist.md) | Manual acceptance on real glasses (unchecked) |
| [docs/background/](background/) | Research reports, the original blueprint and its corrections, three review rounds |
| [.openai/README-sites.md](../.openai/README-sites.md) | Hosting the same relay bundle on OpenAI Sites |
| `src/main.ts` | Startup wiring: store, phone UI, glasses connection, bridge-storage attach with retries |
| `src/glasses.ts`, `src/events.ts`, `src/input.ts` | SDK wrapper; event mapping, bridge queue and display state (Node-testable); gesture filter |
| `src/app/controller.ts`, `frames.ts`, `format.ts`, `types.ts` | Glasses state machine; pure frame builders; formatting; shared app types and settings defaults |
| `src/substack/` | `api.ts` relay client, `urls.ts` input parsing, `html.ts` HTML to text, `article.ts` header block, `feed.ts` RSS/rss2json, `types.ts` shared with the relay |
| `src/pagination.ts`, `src/storage.ts` | Pages with offsets (pretext metrics); persisted state |
| `src/phone/view.ts`, `src/phone/actions.ts`, `src/styles.css` | Phone panels, handlers, styles |
| `worker/relay.ts`, `worker/landing.ts` | The relay; its landing and privacy pages |
| `scripts/` | `ci-tests.mjs`, `browser-ci.mjs`, `ui-ci.mjs` (CI-only runners), `ci-annotate.mjs`, `ci-status.mjs`, `pack.mjs`, `check-relay-origin.mjs` |
| `.github/workflows/` | `ci.yml` (every push), `release.yml` (published release), `deploy-relay.yml` (manual) |

## 6. Facts worth knowing

### Even Hub platform (checked 2026-10-06)

- Packages: `@evenrealities/even_hub_sdk` 0.0.16 (latest; requires Even app 2.2.10), `@evenrealities/evenhub-cli` 0.1.14 (`evenhub pack`), `@evenrealities/pretext` 0.1.4 (firmware font metrics). All pinned exactly.
- Official docs: <https://hub.evenrealities.com/docs> (the networking page states the two gates: whitelist and CORS). Official templates: <https://github.com/even-realities/evenhub-templates> (`text-heavy` was the model).
- Display 576 × 288, greyscale green. Text containers: at most 1000 characters at page creation and 2000 per upgrade, container names at most 16 characters, 1 to 12 containers (at most 8 text), exactly one with `isEventCapture: 1`. Contextual menu: at most 10 items, 32 UTF-8 bytes each. `createStartUpPageContainer` works once per page; this app never calls `rebuildPageContainer`.
- Events: CLICK is `0` and protobuf omits it, so a missing `eventType` inside an envelope is a tap. Clicks and scrolls may arrive in `sysEvent`, `textEvent` or `listEvent`.
- Whitelist entries are exact `https://` origins (no wildcards). The CLI does not validate them.
- Review rules: name at most 20 characters without "Even", a privacy policy covering backend domains, no black first screen, root double-tap must call `shutDownPageContainer(1)`.

### Substack (probed 2026-10-06)

- No `Access-Control-Allow-Origin` on any endpoint. Publication API works on `*.substack.com` and custom domains alike.
- `GET {host}/api/v1/archive?sort=new&offset=&limit=` returns a bare array without bodies, and fewer items than `limit`. `GET {host}/api/v1/posts/{slug}` returns `body_html`; for paid posts it is only the public preview (no paywall marker in the HTML). `GET substack.com/api/v1/posts/by-id/{id}` accepts ids up to 2147483647.
- `GET substack.com/api/v1/top/search?query=` works for honest clients; `publication/search` does not. `GET substack.com/api/v1/user/{handle}/public_profile` lists public subscriptions; handles are lowercase and the lookup is case-sensitive.
- RSS (`{host}/feed`) has full HTML for free posts; paid items end with a "Read more" link paragraph.
- Requests from datacenter IPs (seen from GitHub Actions) sometimes get 403 on `*.substack.com` while custom domains answer.

Cloudflare checks supersede those earlier reachability observations for this relay. On 2026-10-07 the three API probes returned 429, while RSS returned 200 for `on.substack.com` and `www.slowboring.com` (20 Slow Boring items). On 2026-10-08, `andrewhclu.substack.com` RSS returned 20 items and its sitemap listed 165 posts, but selected older public pages still returned 429 from Cloudflare. Deployed revision `6b3507f` disables automatic sitemap archive recovery to preserve RSS; explicit sitemap and public-post HTML recovery remain available. Neither live API recovery nor older-page access has been established. See the active update for evidence and remaining work.

### Timings and limits in the code

| Value | Where |
| --- | --- |
| Bridge call bounds: 5 s per screen call, 4 s per storage call, 8 s hold for page creation, 150 ms single retry of a refused update | `src/events.ts`, `src/glasses.ts` |
| First frame waits up to 1.5 s for bridge data; attach retries after 1, 3, 10 s and on foreground/reconnect | `src/glasses.ts`, `src/main.ts` |
| Storage: 48,000 characters per document, saves debounced 800 ms, late rewrite at most every 30 s | `src/storage.ts` |
| Client request timeout 15 s; archive requests ask for 12, public sitemap recovery returns at most 4 per page; returned cursor controls paging | `src/substack/api.ts`, `src/substack/types.ts`, `worker/relay.ts` |
| Latest: up to 10 publications (setting 1–20), 2 at a time, 50 posts, cached 5 min | `src/app/controller.ts`, `src/app/types.ts` |
| Relay: 10 s shared upstream deadline, 3 redirects, caps 1 MiB archive/profile/sitemap, 2 MiB search, 4 MiB post/feed/public HTML; 60 requests/min per IP and route, 10/min for custom-domain proofs, probes and uncached public archive recovery | `worker/relay.ts`, `wrangler.toml` |

## 7. History

### Historical v0.1.1 release record (2026-10-07; superseded for current deployment)

At that time, v0.1.1 baseline `b963146` was fast-forwarded to `main` after [branch CI](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37724951787) passed all tests, build and packaging. The relay was deployed at the same revision in [run 37725196005](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37725196005), and v0.1.1 became Published Beta in Even Hub; v0.1.0 was Private. [GitHub prerelease `v0.1.1-alpha.1`](https://github.com/CHL-work/substack-reader-for-evenhub/releases/tag/v0.1.1-alpha.1) points to `b963146`; its release workflow passed and attached the package. This remains the latest published GitHub release, but it is not the current deployed code or latest Even Hub Beta.

The local v0.1.1 package uploaded to Even Hub was `artifacts/substack-reader-0.1.1.ehpk`, 118,238 bytes, SHA-256 `6f653b9ea133298bae4c6259a809003ff0b7be8530bf173b85f839d264fff750`. CI and release runs for that historical baseline: `node scripts/ci-status.mjs b963146`.

The Even Hub UI displayed "Invite sent" for the owner's confirmed app account on 2026-10-07, and acceptance/installation were not yet observed then. That historical uncertainty is superseded by the owner's 2026-10-08 report of using the app with two publications. Detailed device-checklist acceptance is still incomplete. Keep tester emails and invitation links out of the public repository.

### Commit history

| Commit | What |
| --- | --- |
| `8e8ad30` | Owner's initial commit (README only) |
| `0dafad2` | v0.1.0 implementation from the blueprint (research by six parallel agents, built by eight) |
| `0ffae72` | CI failures published as annotations; all suites run even after a failure |
| `b7fb869`, `5e893eb` | Home cursor follows its entry when "Continue" appears (first real bug found by CI) |
| `247981a` | Fixes for review round 1 (34 findings; e.g. free posts cut at a "Read more" link and labelled paid, a failed bridge read overwriting the library, script-capable XML from forged custom domains) |
| `04c2e0c` | Fixes for review round 2 (deletions resurrected by the merge, a stale display trapping the wearer, relay verification edge cases) |
| `228e20f` | Fixes for review round 3 (late storage answers looping, bridge-only edits merged away, redraws over the loading frame and the exit dialog) |
| `0f8c717` | Handoff, agent guide and CI status helper; deployed relay and Private Even Hub v0.1.0 baseline |
| `b963146` | v0.1.1 phone and cold glasses RSS recovery with passing regressions; coordinated workspace layout/docs/ignore changes; main fast-forwarded, relay deployed and Even Hub Beta published; tagged `v0.1.1-alpha.1` |
| `92298b9` | v0.1.2 source-aware sitemap/public-page recovery and 20-item RSS regressions; CI passed, main fast-forwarded, client Published Beta; live older-page success remained unverified |
| `6910b54` | Handles additional sitemap namespaces and boolean HTML script attributes; CI passed and relay deployed; later live checks exposed older-page 429 responses |
| `6b3507f` | Disables automatic public archive recovery on Cloudflare to preserve 20-item RSS; CI passed, main fast-forwarded and relay deployment/live revision verified; older-post issue remains blocked |

The owner's decisions so far (2026-10-06): relay on Cloudflare Workers; rss2json fallback off; name "Reader for Substack"; Even's gesture convention (double-tap back, exit on Home; long-press also back); free posts in full and paid posts as preview only; no persistent article text; CI-only tests.

## 8. Environment notes (owner's PC)

- Workspace policy (2026-10-07): `C:\Code` contains the four canonical repositories only. Keep this project's worktrees under its ignored `.worktrees/`, portable Node under `.tools/node/`, and research metadata/scratch files under `.local/research/`; keep project configuration in its own `.env`. Use Git worktree commands for relocation. See the [local workspace layout](../README.md#local-workspace-layout). Existing `docs/background/` records retain their historical paths.
- Windows 10; repo at `C:\Code\substack-reader-for-evenhub`. The sibling reference project is `C:\Code\lihkg-reader-for-evenhub` (GitHub `CHL-work/lihkg-reader-for-evenhub`, private); read it, never modify it from this project.
- Tools present: Git (with Git Credential Manager), Python via `py -3`, curl. Not present: system Node, `gh`.
- The repository is public: <https://github.com/CHL-work/substack-reader-for-evenhub>.
