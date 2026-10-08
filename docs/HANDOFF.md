# Handoff: Reader for Substack (Even Hub plugin for Even G2)

State as of **2026-10-07**: v0.1.1 code baseline `b963146` is on `main`, fast-forwarded after [branch CI](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37724951787) passed all tests, build and packaging. The relay is deployed at the same revision and v0.1.1 is **Published Beta** in Even Hub; v0.1.0 remains Private. [GitHub prerelease `v0.1.1-alpha.1`](https://github.com/CHL-work/substack-reader-for-evenhub/releases/tag/v0.1.1-alpha.1) points to `b963146`; its release workflow passed and attached the package. The owner's confirmed Even app account was invited on 2026-10-07; invitation acceptance, installation and real glasses checks remain unverified.

Read this file first, then [AGENTS.md](../AGENTS.md) (rules), then the docs it points to. The [README](../README.md) is written for the owner; this file is written for the next agent.

## 1. In one paragraph

Reader for Substack is an Even Hub plugin: a Vite + TypeScript web app (no UI framework) that runs inside the Even Realities phone app's WebView and shows public Substack posts as paginated text on Even G2 glasses through `@evenrealities/even_hub_sdk` 0.0.16. Substack sends no CORS headers and the Even WebView enforces both CORS and the `app.json` network whitelist, so all Substack traffic goes through a small stateless relay (`worker/relay.ts`) now deployed at `https://substack-reader-relay.chihin-lau-work.workers.dev`. v0.1.1 passed CI and is Published Beta in Even Hub. All three Substack API probes still return 429; RSS returned 200 for `on.substack.com` and `www.slowboring.com`, with 20 items counted for the latter and rechecked after deployment. v0.1.1 fixes RSS recovery in phone flows and cold glasses reading, with passing regressions. Built-in relay RSS fallback is enabled; only the optional rss2json service is disabled. **Real glasses operation remains unverified. The owner's confirmed tester account has been invited; acceptance is required before the app appears in My Plugins.**

## 2. Status

| Area | State | Evidence |
| --- | --- | --- |
| Phone UI (add by link / custom domain / @handle import / search, browse, Saved, settings, diagnostics, about) | v0.1.1 passed CI, including RSS recovery for adding links and browsing | Regression flows in `scripts/ui-ci.mjs`; API-only features remain subject to upstream throttling |
| Glasses UI (Home, Latest, Publications, Saved, History, reader with resume, end card, contextual menu, error frames) | v0.1.1 passed CI, including cold Saved/History/Continue RSS recovery | Unit regressions in `tests/unit/controller.test.ts` and UI flows with a stubbed bridge |
| Substack HTML to glasses text | Done | CI browser tests on 11+ synthetic fixtures (`tests/browser/html.test.ts`) |
| Relay (routes, allowlist, custom-domain checks, caps, rate limits, cache, CSP) | **Deployed**, revision `b963146`, protocol 1; direct health verified | [Deploy run 37725196005](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37725196005) succeeded |
| Storage (bridge storage + localStorage mirror, merge, sync stamps) | Done | CI unit tests (`tests/unit/storage.test.ts`) and UI scenarios 12–12e |
| Cloudflare setup | `workers.dev` ready; both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` encrypted GitHub secrets saved; `VITE_RELAY_ORIGIN` variable saved | Authorized Workers Scripts Write token expires 2027-01-06 |
| Packaging (`.ehpk`) | v0.1.1 local and branch CI build/pack passed; local package uploaded to Even Hub | [CI run](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37724951787); optional rss2json disabled |
| Real G2 hardware | **Not verified** | [device-checklist.md](device-checklist.md) is all unchecked |
| Substack reachability | API probes all 429; two tested RSS feeds 200; Slow Boring rechecked after deployment with 20 items | `subdomain`, `customDomain`, `substackCom` probes; RSS for `on.substack.com` and `www.slowboring.com` |
| Even Hub | [Project `com.chlwork.substackreader`](https://hub.evenrealities.com/hub/com.chlwork.substackreader): v0.1.1 visibly **Published Beta**; v0.1.0 Private | UI confirmed "Invite sent" on 2026-10-07; testing-group status **Invited**; acceptance/install unverified; public listing/review not started |
| GitHub prerelease | [`v0.1.1-alpha.1`](https://github.com/CHL-work/substack-reader-for-evenhub/releases/tag/v0.1.1-alpha.1) published at `b963146`; package attached | [Release workflow](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37725451196) passed all checks; asset SHA-256 matches the local package uploaded to Even Hub |

CI and release runs at the code baseline: `node scripts/ci-status.mjs b963146`.

Local v0.1.1 package uploaded to Even Hub: `artifacts/substack-reader-0.1.1.ehpk`, 118,238 bytes, SHA-256 `6f653b9ea133298bae4c6259a809003ff0b7be8530bf173b85f839d264fff750`. Build and pack passed with the sole relay whitelist entry and minimum Even app version 2.2.10 for SDK 0.0.16. CI validates the software; device operation still needs observation.

## 3. What to do next

### 3A. Remaining tester installation and device validation

An agent can perform the account steps with authorized access. Physical phone and glasses testing requires the owner.

1. **Accept the Beta invitation and install.** The owner confirmed their Even app account, and Even Hub displayed "Invite sent" on 2026-10-07. Its confirmation states that the app will appear in **My Plugins** once the invitation is accepted. Acceptance and installation are unverified; the owner must complete those steps. Future testers likewise need a testing-group invitation and acceptance. Keep tester emails and invitation links out of the public repository. CI, release packaging, Cloudflare deployment and Even Hub Beta publication are complete.
2. **Walk through [device-checklist.md](device-checklist.md) on real glasses** and record observed results, including cold Saved/History/Continue reading after restart. API-only search and @handle import can remain unavailable while RSS works; older posts outside the feed still require the API. Record these limits rather than marking the affected checks passed.
3. **Keep relay status accurate.** The deployed revision is `b963146`; after future deployments check `/v1/health?probe=1` and a feed route. The workflow only warns about a revision mismatch or upstream failure. Rotate the configured API token before 2027-01-06.

### 3B. Follow-up after deployment and device testing

1. **Interpret the relay probe** (`/v1/health?probe=1`, or the Deploy relay job summary). It probes one `*.substack.com` archive, one custom-domain archive and `substack.com` search:

   | Probe result | Meaning | Action |
   | --- | --- | --- |
   | All 200 | Substack accepts the relay | Nothing; proceed to device testing |
   | `subdomain` 403/challenge, `customDomain` 200 | Substack blocks this egress for `*.substack.com` only (seen from GitHub Actions IPs during research) | Try another host (OpenAI Sites: `.openai/README-sites.md`; Deno Deploy/Vercel per `docs/relay.md` "Other hosts"), or enable the rss2json fallback (`ENABLE_RSS2JSON_FALLBACK=1`, owner decision: off) |
   | `substackCom` 403 or empty | Search and @handle import fail; links still work | Same options; the phone already falls back to "paste a link" |
   | 429 | Shared-egress rate limiting; observed on all three deployed API probes | Use built-in RSS recovery for recent posts when feeds answer; respect retry delays and do not hammer Substack |

   Never "fix" a block by spoofing a browser User-Agent, rotating IPs or replaying cookies. The owner's projects explicitly forbid that.
2. **Act on device results.** Likely adjustments and where they live:
   - Swipe direction feels inverted: change the default of `invertSwipe` in `src/app/types.ts` (`defaultSettings`).
   - Taps or swipes do not arrive, or arrive twice: compare the Diagnostics event log with `mapEvent` in `src/events.ts` and the filter timings in `src/input.ts` (`DEFAULT_GESTURE_TIMING`).
   - Text overflows or the firmware scrolls inside a page: check `G2_LAYOUT` and the 27 px line height in `src/pagination.ts`; consider paginating to 6 lines by default.
   - Missing glyphs (boxes or blanks): extend the mapping table in `src/substack/html.ts` (`normalizeChars`; keep the file ASCII-only, use `\u` escapes).
   - Library lost after an app update: bridge storage persistence across updates is unverified (`src/storage.ts`).
3. **Release hygiene for each new build:** bump `version` in both `package.json` and `app.json` (the pack script refuses mismatches), push, wait for green CI, then tag `vX.Y.Z-alpha.N` as a GitHub pre-release.

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

Cloudflare deployment checks on 2026-10-07 supersede those earlier reachability observations for this relay: the three API probes returned 429, while RSS through `/v1/feed` returned 200 for `on.substack.com` and `www.slowboring.com`, with 20 items counted for Slow Boring. API recovery is not confirmed. v0.1.1 extends the existing built-in RSS recovery to the phone and cold reader paths; it does not enable rss2json or make older posts outside the feed available.

### Timings and limits in the code

| Value | Where |
| --- | --- |
| Bridge call bounds: 5 s per screen call, 4 s per storage call, 8 s hold for page creation, 150 ms single retry of a refused update | `src/events.ts`, `src/glasses.ts` |
| First frame waits up to 1.5 s for bridge data; attach retries after 1, 3, 10 s and on foreground/reconnect | `src/glasses.ts`, `src/main.ts` |
| Storage: 48,000 characters per document, saves debounced 800 ms, late rewrite at most every 30 s | `src/storage.ts` |
| Client request timeout 15 s; archive pages of 12 | `src/substack/api.ts`, `src/substack/types.ts` |
| Latest: up to 10 publications (setting 1–20), 2 at a time, 50 posts, cached 5 min | `src/app/controller.ts`, `src/app/types.ts` |
| Relay: 10 s upstream timeout, 3 redirects, caps 1 MiB archive/profile, 2 MiB search, 4 MiB post/feed; 60 requests/min per IP and route, 10/min for custom-domain proofs and probes | `worker/relay.ts`, `wrangler.toml` |

## 7. History

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

The owner's decisions so far (2026-10-06): relay on Cloudflare Workers; rss2json fallback off; name "Reader for Substack"; Even's gesture convention (double-tap back, exit on Home; long-press also back); free posts in full and paid posts as preview only; no persistent article text; CI-only tests.

## 8. Environment notes (owner's PC)

- Workspace policy (2026-10-07): `C:\Code` contains the four canonical repositories only. Keep this project's worktrees under its ignored `.worktrees/`, portable Node under `.tools/node/`, and research metadata/scratch files under `.local/research/`; keep project configuration in its own `.env`. Use Git worktree commands for relocation. See the [local workspace layout](../README.md#local-workspace-layout). Existing `docs/background/` records retain their historical paths.
- Windows 10; repo at `C:\Code\substack-reader-for-evenhub`. The sibling reference project is `C:\Code\lihkg-reader-for-evenhub` (GitHub `CHL-work/lihkg-reader-for-evenhub`, private); read it, never modify it from this project.
- Tools present: Git (with Git Credential Manager), Python via `py -3`, curl. Not present: system Node, `gh`.
- The repository is public: <https://github.com/CHL-work/substack-reader-for-evenhub>.
