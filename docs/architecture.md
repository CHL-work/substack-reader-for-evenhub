# Architecture

Reader for Substack is a Vite + TypeScript web plugin with no UI framework. It runs inside the Even Realities app's WebView (Chromium on Android, WKWebView on iOS) and draws text on the G2 glasses through `@evenrealities/even_hub_sdk` 0.0.16. All Substack data comes through one relay that the owner deploys (`worker/relay.ts`, see [relay.md](relay.md)).

## Components

```
G2 glasses  <--BLE-->  Even app  -->  WebView: index.html + JS bundle (the .ehpk)
                                         src/main.ts            wiring
                                         src/phone/*            phone UI
                                         src/glasses.ts         SDK bridge wrapper, one serialized write queue
                                         src/app/controller.ts  glasses state machine
                                         src/app/frames.ts      state -> {title, body, footer}
                                         src/substack/*         relay client, parsing, HTML -> text
                                         src/pagination.ts      pages with offsets (pretext font metrics)
                                         src/storage.ts         bridge storage + localStorage mirror
                                              |
                                              | HTTPS GET (simple CORS request)
                                              v
                                       Relay (Cloudflare Worker or OpenAI Sites)
                                              |
                                              v
                                       Substack hosts and substack.com/api/v1
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/config.ts` | The only reader of `import.meta.env`: `APP_NAME`, `VERSION`, `RELAY_BASE` (normalized `VITE_RELAY_ORIGIN`, or `null`), `ENABLE_RSS2JSON_FALLBACK` |
| `src/glasses.ts` | Connects to the Even bridge, creates the fixed 3-container page once (with the contextual menu), then updates text with `textContainerUpgrade` only. Diffs against the last good frame, serializes renders and bridge-storage calls on one queue, reports connection status, maps events and calls `shutDownPageContainer(1)` to exit. |
| `src/events.ts` | Pure event mapping (`mapEvent`) and diagnostics summaries (`describeEvent`), kept apart so Node tests never load the SDK |
| `src/input.ts` | Gesture filter: scroll debounce, phantom-scroll suppression after a write, tap cooldown, back/hold and menu dedupe |
| `src/pagination.ts` | Layout constants and `paginate()`, which splits text into pages that fit 544 px by 5, 6 or 7 lines of 27 px (and at most 1800 UTF-8 bytes), recording each page's start offset |
| `src/app/controller.ts` | Glasses navigation: a view stack (Home, Publications, posts list, reader), a generation counter that drops stale responses, loading and error frames, Latest merging, feed fallback, resume, position saving and the contextual menu |
| `src/app/frames.ts`, `src/app/format.ts` | Pure frame builders with the exact glasses wording; dates, minutes and percentages |
| `src/app/types.ts` | Settings, persisted state, view types and limits |
| `src/storage.ts` | Two JSON documents (`sr:prefs:v1`, `sr:progress:v1`), defensive normalizers, size caps, debounced saves (800 ms) and immediate flushes |
| `src/substack/api.ts` | Relay client (GET, `credentials: 'omit'`, no custom headers, 15 s timeout) and response normalizers |
| `src/substack/urls.ts` | Turns pasted text into a publication, post, post id, handle or search query; never fetches what was pasted |
| `src/substack/html.ts` | `htmlToReaderText`: walks a `DOMParser` document and produces plain reader text, footnotes and a paywall flag. ASCII-only source |
| `src/substack/article.ts` | Adds the header block (title, byline, date, reading time, paid or podcast notes) and the version used for cached positions |
| `src/substack/feed.ts` | Parses RSS XML (feed fallback) and rss2json JSON into post summaries and bodies |
| `src/substack/types.ts` | Shapes and constants shared by the client and the relay |
| `src/phone/*`, `src/main.ts` | Phone panels (Home with the glasses mirror and remote, Publications, Browse, Saved, Settings, Diagnostics, About) and startup wiring |
| `worker/relay.ts`, `worker/landing.ts` | The relay and its landing and privacy pages |

## Reading a post

1. The user taps a post in a glasses list. The controller pushes a reader view and renders `Loading…` before anything is awaited.
2. `api.getPost({host, slug})` (or `{id}` for share links) calls `GET <relay>/v1/post`. The relay fetches Substack and returns the trimmed post with its `bodyHtml`.
3. `buildArticle()` converts the HTML with `htmlToReaderText()` and prepends the header block. Converted articles are cached in memory (10 posts).
4. `paginate()` splits the text for the current lines-per-page setting.
5. A saved position opens at the page that contains its character offset. The offset is kept when only the lines-per-page setting changed; if the text itself may differ (a new converter version, different text settings or a new pagination version), the stored fraction of the post is used instead. A finished post reopens at page 1.
6. The page is rendered as `{title, body, footer}`. After the glasses accept the write, the position is recorded and saved (debounced 800 ms; flushed at once on back, on opening another post, when the app goes to the background, on `pagehide` and on exit).

If the relay redirects to another host (a publication moved to a custom domain), the stored publication and post references are updated to `meta.host`.

## Lists

- **Publication list:** the relay's archive route, 12 posts per request. A "Load older posts…" row stays while `nextOffset` is not `null`. Substack often returns fewer posts than asked for, so a short page never ends the list; only an empty one does.
- **Latest:** the first N publications marked "In Latest" (N is a setting, default 10) are fetched 2 at a time, merged newest first, deduplicated and cut to 50. Publications that fail are counted in the footer (`· 2 failed`). The result is cached in memory for 5 minutes; Refresh skips the cache.
- **Saved and History:** local lists, no network.
- **Feed fallback:** when the first archive page fails with `UPSTREAM_BLOCKED`, `UPSTREAM_RATE_LIMITED` or `UPSTREAM_UNAVAILABLE`, the controller fetches `GET <relay>/v1/feed` once and shows the feed's recent posts. Their HTML is kept in memory so opening them needs no further request. If the feed also fails, the original archive error is shown.

## Persistence

| Key | Contents | Limits |
| --- | --- | --- |
| `sr:prefs:v1` | Publications (ordered), saved posts (ordered), settings | 100 publications, 100 saved posts |
| `sr:progress:v1` | Reading positions, history, read post ids, the last opened post | 150 positions, 50 history entries, 500 read ids |

- Each document carries `savedAt`. Even's bridge storage (`setLocalStorage`/`getLocalStorage`) is the main copy and the WebView's `localStorage` is a mirror; on load the newer copy wins. The bridge returns `''` for a missing key.
- Each value stays under 48,000 characters. If progress grows too large, the oldest positions, then history, then read ids are evicted. If a document still does not fit, the save fails and the phone shows that it could not save.
- Article text and HTML are never persisted. Only post references (id, host, slug, title, publication name, date, paywall flag, word count) are stored.

## Glasses rendering

One fixed layout is created once with `createStartUpPageContainer`: a title line, a 7-line body that captures input, and a footer line. Every later update is `textContainerUpgrade`; the app never calls `rebuildPageContainer`. Every frame body is fitted to the body container, so the firmware never has to scroll it. Details, gestures and the exact wording are in [glasses.md](glasses.md).

## Build and packaging

- `pnpm run build` runs `tsc --noEmit`, `vite build` (with `base: './'`) and an esbuild bundle of the relay to `dist/server/index.js`. Vite also writes `dist/build-info.json` with the version, the normalized relay origin and the rss2json flag, and fills the `index.html` title from `app.json`'s name.
- `pnpm run pack` (`scripts/pack.mjs`) checks that `dist/` was built for the same relay origin and version, that `app.json` and `package.json` versions match, and that `app.json`'s name equals `APP_NAME`. It writes the network permission (the relay origin, plus `https://api.rss2json.com` only with `ENABLE_RSS2JSON_FALLBACK=1`) into a copy of `app.json`, copies `dist/` without `server/` and runs `evenhub pack --sdk-ver 0.0.16`. It fails if the CLI prints a warning or does not stamp `min_app_version 2.2.10`.
- `scripts/check-relay-origin.mjs` validates `VITE_RELAY_ORIGIN` (https, bare origin, not a local or example host) and prints `configured=true|false` for CI.

## Testing

The owner's rule is that runtime tests run only in GitHub Actions; every test runner throws unless `CI=true`. Locally the project is only installed, type-checked, built and packed.

| Runner | What it covers |
| --- | --- |
| `scripts/ci-tests.mjs` (`pnpm run test:ci`) | Node `node:test` files in `tests/unit/`: pagination, input filter, event mapping, storage, frames, controller, URL parsing, relay client, article header and the relay itself (with stubbed `fetch`). esbuild bundles each file first. |
| `scripts/browser-ci.mjs` (`pnpm run test:browser:ci`) | `tests/browser/` in Playwright Chromium on `about:blank` with every network request aborted: HTML-to-text fixtures and RSS parsing. Any network attempt fails the run. |
| `scripts/ui-ci.mjs` (`pnpm run test:ui:ci`) | The production build in Chromium with a stubbed Even bridge and a fake relay: phone flows and glasses navigation. |

Workflows: `ci.yml` (every push and pull request: check, the three test runners, build, and pack when the relay origin is set), `release.yml` (on a published GitHub release: the same checks on the tag, then the `.ehpk` is attached) and `deploy-relay.yml` (manual Cloudflare deploy and health probe).

## Decisions

- **Relay instead of direct fetches:** Substack sends no CORS headers and the SDK has no native HTTP bridge. Even's documentation recommends proxying through a server you control.
- **HTML conversion on the phone:** the relay passes `body_html` through unchanged, so the converter can be fixed or tuned with a plugin update alone, and is tested against fixtures in a real browser engine.
- **Text containers only:** menus are text with a `>` cursor rather than the native list container, which cannot be updated in place.
- **Double-tap is back**, and on Home it opens the system exit dialog (`shutDownPageContainer(1)`), as Even's review rules require.
- **Bridge storage first:** Even's guidance says WebView storage may not survive restarts of a packaged plugin.
- **No paid content:** the app never handles Substack cookies or logins.
