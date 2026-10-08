# 05 — Best UX for reading long-form articles on Even G2 (evidence-based)

Researcher topic: real-world evidence for long-form reading UX on Even G2, applied to "Substack Reader for Even Hub".
Date: 2026-10-06. Method: GitHub API search plus shallow clones of about 35 open-source Even Hub/G2 apps (read-only, in the scratchpad), the official Even Hub docs, the official `everything-evenhub` developer kit, the Even Realities help center (via its public Zendesk JSON API), the SDK 0.0.16 / pretext 0.1.4 packages in `C:/Code/lihkg-reader-for-evenhub/node_modules`, and live CORS-proxy probes with curl.
No article text was copied. Repos are cloned at `C:/Users/cbn59/AppData/Local/Temp/claude/C--Code/8f1fde22-d56d-43b9-b666-db87a441fa25/scratchpad/research/repos/`.

---

## 0. TL;DR

1. **Page, don't scroll.** All mature readers pre-paginate text with `@evenrealities/pretext` against the inner box of the body container, at the fixed 27 px line height, and turn pages with `textContainerUpgrade` (no flicker, about 83 ms per call). They never let the firmware scroll text internally. The official template puts it bluntly: "On G2 you can't scroll. You turn pages."
2. **Gesture conventions to follow.** These match first-party Even features and the Hub QA rules:
   - swipe back on the temple (or swipe down on the ring) = next page;
   - swipe front (or ring up) = previous page;
   - single tap = confirm, or next page in the reader, or pause/resume while auto-scroll runs;
   - **double tap = back one level, and on the root page = `shutDownPageContainer(1)`** (the Hub rejects apps that don't do this);
   - tap then long-press (OS gesture) = system/contextual menu, where SDK ≥0.0.14 `menuObject` adds up to 10 app verbs;
   - nothing should depend on a plain long press.
3. **Layout.** Keep the sibling LIHKG layout: title line (1), body (7 lines, event capture), footer line (1). Dim the title and footer with `textColor` 2–3 and keep the body at 4. The footer shows `p/N · %` plus minutes left. Measured firmware metrics give about 60 chars per 544 px line, so roughly 60–70 English words per 7-line page. A 2,500-word post is about 40 pages (≈15 s each at ~240 wpm).
4. **CORS.** Every network-reading G2 app I found uses a proxy:
   - their own Cloudflare Worker (CyberNews, Reddit Feed, ER Browser, Glance's optional Worker), or
   - a public CORS proxy (NOS: corsproxy.io → allorigins → codetabs; epub-reader: codetabs; Glance: r.jina.ai).
   - **Live probe today:** r.jina.ai returned 401 (anonymous blocked), corsproxy.io returned 401 (API key now required), codetabs returned 522, and only allorigins returned 200. Public proxies are not viable for a published app. Use our own Worker.
5. **Background.**
   - iOS: the WKWebView keeps running.
   - Android: it may be suspended, so treat resume as a cold start.
   - **Beta/installed builds survive a phone lock; QR-sideloaded dev builds do not** (official QA guide).
   - Persist the reading position with `bridge.setLocalStorage`: debounce writes, flush on FOREGROUND_EXIT / SYSTEM_EXIT, and store a char offset rather than a page index.

---

## 1. Existing apps surveyed

### 1.1 Search method
- `https://api.github.com/search/repositories?q=<q>` for `evenhub` (91 results), `even_hub_sdk` (26), `even g2` (650), `evenrealities` (41), `g2 reader` (31), `teleprompter even`, `g2 epub`, `even hub reader`, and others. The unauthenticated API hit its rate limit after about 15 queries.
- The curated list https://github.com/pangoleen/awesome-even-realities-g2 (124★) has an "Apps – Productivity" section with about 15 readers.
- I could not list Even Hub store items from the web: `hub.evenrealities.com` is a Nuxt SPA, and the store is browsed in-app (help center "Even Hub" article). Glance's README says the closed-listing "ER Browser" has "~3K downloads on the Hub". ER Browser is actually open source: fabioglimb/even-browser.

### 1.2 Most relevant reader apps (code read)

| App (repo) | SDK | Pagination | Menus | Gestures | Progress UI | Remote content / CORS |
|---|---|---|---|---|---|---|
| **Official text-heavy template** (even-realities/evenhub-templates/text-heavy) | 0.0.10 | pretext `measureTextWrap`; packs whole paragraphs into pages, splits oversized paragraphs at whitespace; body 576×240 (pad 4); `floor(innerH/27)` lines | none | tap = next, swipe up (SCROLL_TOP) = prev, swipe down = next, double tap = `shutDownPageContainer(1)` | separate 30 px "pager" text container `3 / 12 · tap: next…` | none (local sample) |
| **Official EH-InNovel** (even-realities/EH-InNovel, Kotlin/Compose→JS) | 0.0.6 | naive 200-char fragments | native **ListContainer** of chapters on the left (110 px wide) + preview text box; double tap toggles full-screen reading | SCROLL_BOTTOM/TOP on text container = next/prev fragment, upgrade in place | none | local `books.json` |
| **epub-reader-g2** (chortya, v1.5.1, most mature) | 0.0.15 | pretext pixel metrics + hyphenation (9 langs); positions stored as **char offset + paginationVersion** (format v2) so repagination keeps the same text | home: Continue / Library (N) / Settings; on-glasses settings editor; selection boxes = bordered text containers sized to the longest label, plus a full-screen invisible capture container; **native contextual menu** while reading (Contents, Switch to Flow, Set/Go to bookmark, Main menu; Flow adds Faster/Slower) | swipe = page; tap = hide/show status bar (Paged) or play/pause (Flow); double tap = back one level, exit at mainMenu; "Hold" = OS menu; plain long-press used only defensively | bottom status bar: `HH:MM` clock + `Ch x/y Pg a/b` + Unicode progress bar; footer `textColor` 3, body 4 (user setting 1–4); Flow footer has chapter time-left from **measured** pace only | Gutenberg via `api.codetabs.com` CORS proxy (whitelisted) |
| **Glance** (tntpsu, web article reader, v0.5.7) | 0.0.10 | char-based ~400-char pages (paragraph > sentence > word breaks) + a large "chrome line" filter for web junk; "line mode" = 100-char steps | single full-screen text container with `>` cursor and a 5-row sliding window; tapping opens a modal **ListContainer picker** (header text + list) | reader: tap/swipe down = next, swipe up = prev, double tap = back a layer; double tap on sources = exit | `TITLE` / `Page i/N` / page / `[swipe] flip · [2x] back`; `✓` read marks (note: U+2713 is **not** in the firmware font, see §2.4) | `r.jina.ai` (URL→markdown) by default; optional user-deployed Cloudflare Worker (Mozilla Readability on `linkedom`) tried first; 30-day / 100-article body cache in bridge storage; resume `{source, article, page}`; "Save & open on glasses" from phone |
| **NOS Nieuws** (SachaEpskamp, RSS news) | 0.0.9 | word-wrap at 46 chars; reader shows 9 lines + footer and **scrolls 3 lines per swipe** (overlapping context) | text list, `▶ ` cursor, 9 rows; idle **marquee** on the selected long headline (1 char / 500 ms) | slide = cursor/scroll; tap = open/back; double tap = exit; `INVERT_SCROLL` flag because swipe direction was uncertain; 300 ms scroll debounce | `── 37% · slide: scroll · tap: back` | direct fetch first, then falls back through corsproxy.io → allorigins → codetabs, remembering the winner; all whitelisted; notes "dev-QR mode does not enforce the network whitelist" |
| **ER Browser** (fabioglimb/even-browser) | 0.0.9 | word-wrap 46 chars/line, 9 visible lines, line-by-line scroll with ▲/▼ indicators | header action bar `▶Read◀ Links Back`; Links mode lists numbered links | read: scroll content, tap = buttons; links: tap = follow; double tap = browser back | configurable lines per page, page-number toggle | its own hardened **Cloudflare Worker** proxy `${VITE_PROXY_URL}/browse?url=` with optional `X-Proxy-Key`; manifest whitelist `["https://","http://"]` (wildcard!) |
| **Readpane** (foxtheory222/ARCHIVED-g2reader) | 0.0.10 | pretext, 27 px; **density setting 5 / 6 / 8 lines (default 6)** preserving relative progress | library list; tap in reader opens a compact menu: Continue / Progress style / Density / Library | scroll-only page turns; tap = menu; double tap = host exit | progress cycles **percent / page number / hidden** | offline only; position persisted only after a confirmed glasses write |
| **TabNews** (Atzingen/even-g2-tabnews) | 0.0.14 | paginated reader | list shows **up to 3 titles per page, each up to 2 lines, with spacing**; `>` cursor; auto page change | list: tap = open, double tap = exit dialog; reader: tap = next page (back to list at end), swipe = prev/next, double tap = back to list keeping position | — | API is CORS-enabled, so direct fetch; refreshes every 30 min while the list is open |
| **Pace Reader** (jcpsimmons/g2-pace-reader) | 0.0.14 | RSVP: 3-word frame (prev / **focus** / next), extra dwell on punctuation and long words; 100–300 wpm, default 200 | contextual menu: Rewind sentence, Restart | tap = pause/resume, scroll = ±25 wpm, double tap = exit | — | none; "slow bridge responses reduce reading speed instead of skipping words" (next timer starts only after the write finishes) |
| **evenBooks** (KennyLowe, spec-driven) | 0.0.10 | ≤600 chars per page | — | — | **deliberately no chrome** (no page numbers, no loading or disconnect frames on glasses; errors on phone only); `↑ start of book` flash at clamp | local only |
| **Reddit Feed** (plungarini/reddit-feed-even) | 0.0.9 | 4 posts per page | double tap in feed = endpoint menu | **"double-scroll within 2 s at a boundary"** to load more (avoids accidental loads) | — | Cloudflare Worker (Hono) proxy |
| **CyberNews** (zakpatrik) | 0.0.13 | headline list | — | — | — | own Worker `cybernews-feed.*.workers.dev` (only whitelisted origin) |
| **Even-LotH** (sangularvilue) | — | text pre-rendered to an off-screen canvas, streamed as **image tiles** for pixel-smooth teleprompter auto-scroll | — | scroll = move; tap = pause/resume auto-scroll; double tap = exit | — | own Node backend scraper |
| **LIHKG Reader** (sibling, CHL-work) | 0.0.16 | binary search on pretext, 1,800-byte cap, grapheme-safe; title / 7-line body / footer | text menus (4 items, blank line between); phone manages menu order | tap = select, swipe up/down = prev/next, **long press = back**, double tap = exit dialog everywhere | `帖頁 p/N · s/M · #post` | own Worker / Android companion |

Other readers seen but not read in depth: even-aozora-reader, Nutshell (AI summaries), Daily App (RSS), G2-md-browser, Obsidian-on-G2, G2-Gmail, PRLens, arxeven, Math Reader (bitmaps + autoscroll), whisprompt/PitchBeam (teleprompters), even-my-news-hub, NoodleOfDeath/even-browser (screen-reader linearisation).

### 1.3 Patterns that recur
- **Pre-pagination with pretext**, rendering with `textContainerUpgrade`, and a single serialized write queue (all mature apps). Glance KNOWN_QUIRKS: "Concurrent `textContainerUpgrade` calls crash the BLE link."
- **The body must never overflow the event-capture container.** If it does, the firmware scrolls internally and SCROLL_TOP/BOTTOM fire only at the boundary. epub-reader saw this as "need two swipes to turn a page."
- **Phantom scroll after a re-layout.** epub-reader 1.4.2 found the device fires a spurious SCROLL right after `rebuildPageContainer`/upgrade, and the first swipe in a new menu was eaten. Its fix is to suppress scrolls for 40 ms after each text write and reset debounce state on view change. even-toolkit's defaults (`glasses/gestures.ts`):
  - same-direction scroll debounce 350 ms;
  - direction-change debounce 50 ms;
  - post-text-update suppression 80 ms;
  - tap cooldown 220 ms.

  The devguide (SDK 0.0.9) says one swipe can emit 5–10 scroll events, so it recommends a 300 ms cooldown.
- **Text-cursor menus (`>` or `▶`) vs native ListContainer.**
  - Text cursor gives full control: 2-line items, meta lines, footers. It costs one upgrade per cursor move.
  - ListContainer gives firmware-native highlight and scrolling with no BLE write per swipe. It is limited to 1–20 items, 64 chars each, one line each, 40 px rows, and no per-item styling. It can't be updated in place (rebuild ≈165 ms, flicker), and index 0 arrives as `undefined`.
- **Resume.** Glance, epub-reader, Readpane and TabNews all restore the last article and page. epub-reader stores the char offset; others store the page index, which drifts when pagination changes.
- **Launch source.** epub-reader: `onLaunchSource('glassesMenu')` plus a resolvable last book skips the home menu and goes straight to reading. 'appMenu' shows home.
- **Phone-side "send to glasses".** Glance's "Save & open on glasses" sets a one-shot pointer that the glasses consume on bootstrap and on foreground.

---

## 2. Hardware and platform facts (with sources)

### 2.1 Display
- **SDK canvas: 576×288 px per eye, 4-bit greyscale (16 green levels), monochrome green.** Sources: official docs `https://hub.evenrealities.com/docs/build/display` and the SDK README.
- **Physical spec sheet:** 640×350 resolution, **60 Hz** refresh, **1200 nits**, FoV 27.5°, Micro LED, waveguides, binocular, 98% passthrough, **BLE 5.4**, glasses battery 192 mAh / 0.744 Wh ("Regular use for 2 days"), case 2000 mAh (7 recharges), IP65. Source: help center Specs https://support.evenrealities.com/hc/en-us/articles/13499229138959-Specs.
  - The docs overview says "Bluetooth Low Energy 5.2". This is a minor discrepancy.
  - 576×288 is the app canvas within the 640×350 panel.
- **Font.** Single LVGL font with a fallback chain `evenroster` (415 glyphs) → `evenroster_crylgrek` (299) → `cn` (CJK, range-based) → `evenemoji` (102 glyphs). These come from the font tables embedded in `@evenrealities/pretext@0.1.4/dist/font_measure.js`, which I parsed.
  - **Line height is fixed at 27 px.**
  - No size, weight or alignment control. Missing glyphs are silently skipped.
- **Text limits** (official docs):
  - `createStartUpPageContainer` and `rebuildPageContainer`: 1,000 chars per text container;
  - `textContainerUpgrade`: 2,000 chars;
  - "~400–500 characters" fill a full screen.
- **Text brightness.** `textColor` takes 0–4 (SDK 0.0.14+; default 4; omitting it on an upgrade keeps the current value). epub-reader uses body 4 and footer 3, and excludes 0 because it may be invisible.
- **Containers.** 8 text/list + 4 image per page; exactly one `isEventCapture: 1`; `containerName` ≤16 chars. The aleapc devguide reports reliability problems above 4 containers (SDK 0.0.9 era).
- **User display settings in the Even app** (help center "Display Adjustment", https://support.evenrealities.com/hc/en-us/articles/13755064994831):
  - brightness 1–100 or auto;
  - per-eye calibration;
  - distance presets Near / Mid / Far (foreground layer ≈1 / 2 / 3 m);
  - height slider.

  Apps cannot control any of these.

### 2.2 Measured text capacity (computed from the pretext font tables)
- Frequency-weighted average lowercase advance is **≈10.1 px**, space is 5 px, so an average English word plus space is ≈53 px.
- A 544 px inner width (LIHKG layout) fits **≈60 chars, about 10 words, per line**.
- A 7-line body fits ≈71 words in theory, or ≈60–65 after wrap waste and paragraph gaps. Glance's own pretext measurement agrees: 400 chars ≈ 8 lines at 564 px.
- epub-reader measured a 59-char line at 593 px, wider than 576, so pixel-fit the footer with `pxTruncate` and do not count characters.
- **Implication:** at ~60 words per page, a 1,500 / 2,500 / 5,000-word post is about 25 / 42 / 83 pages. At ~240 wpm silent reading that is about 15 s per page, so one page turn every ~15 s.

### 2.3 Glyph coverage relevant to Substack text (from the pretext tables)

| Status | Characters |
|---|---|
| Present | ‘ ’ “ ” (U+2018/2019/201C/201D), – — (en and em dash), … (ellipsis), • (bullet), · (middle dot), « », € £ ° × − → ™ †, NBSP |
| Present via CJK range (fullwidth-ish 20 px advance) | ━ ─ │ █ ● ○ ★ ▶. **Caveat:** the `cn` font is range-based, so a range hit does not prove the glyph exists. The even-g2-notes glyph tables confirm the box/block/geometric ones on the simulator. |
| **Missing** | ✓ (U+2713) (Dingbats; even-g2-notes says the whole U+2700–273F range is absent), U+200B zero-width space, U+2009 thin space, ` (backtick) |
| Emoji | pretext 0.1.4 ships a 102-glyph `evenemoji` font, but even-g2-notes (simulator, Feb 2025) says emoji are absent. Strip emoji, or test on hardware. |

The first-party Teleprompt app highlights characters "that the glasses do not support" (firmware ≥2.2.9). That confirms missing glyphs are a real issue. The content cleaner should normalise zero-width and thin spaces, strip or replace emoji, and replace ✓ with ASCII or ●.

### 2.4 Input devices and gestures
From help center "How to Control" (https://support.evenrealities.com/hc/en-us/articles/13754911116047, table parsed):

| R1 ring | G2 temple touchpad | Display off | Display on |
|---|---|---|---|
| Single tap | Single tap | — | Confirm (in a list) / switch full ↔ compact view (in a card) |
| Double tap | Double tap | Dashboard | **Back** |
| Tap then long-press | Tap then long-press | Menu | **Menu** |
| Scroll up | **Scroll front** (swipe toward the lens) | — | Scroll up |
| Scroll down | **Scroll back** (swipe toward the ear) | — | Scroll down |
| — | Tap 5× quickly on both sides | Restart | Restart |
| — | Hold both sides 1 s | Silent mode | Silent mode |

Further details:
- Menu article (https://support.evenrealities.com/hc/en-us/articles/14269160297999): firmware ≥2.2.9 opens the Menu with **tap then long-press for 1 s**; older firmware used a long-press alone. Menu browsing uses swipe forward/back on the glasses and swipe up/down on the R1.
- **SDK mapping** (official handle-input skill in even-realities/everything-evenhub; SDK 0.0.16 `OsEventTypeList`):
  - CLICK 0, SCROLL_TOP 1 (swipe up / front), SCROLL_BOTTOM 2 (swipe down / back), DOUBLE_CLICK 3;
  - FOREGROUND_ENTER 4, FOREGROUND_EXIT 5, ABNORMAL_EXIT 6, SYSTEM_EXIT 7, IMU 8;
  - LONG_PRESS 9, LONG_PRESS_RELEASE 10 (SDK 0.0.14+, Even App 2.2.9+).
  - Long-press events arrive on `sysEvent` with `eventSource`: 1 = right temple, 2 = ring, 3 = left temple (preserved since 0.0.15).
- **Envelope routing:**
  - Official kit: with a text container capturing, scrolls arrive as `textEvent` and click/double-click as `sysEvent`.
  - With a list capturing, swipes are handled natively ("no event fired", per the official skill; community notes say boundary events arrive as `listEvent`) and clicks arrive as `listEvent`.
  - The aleapc devguide (SDK 0.0.9) says real hardware sends taps and scrolls via `sysEvent` while the simulator uses `textEvent`.
  - **Handle all three envelopes.** Protobuf drops zero values: CLICK arrives with `eventType` undefined, and `currentSelectItemIndex` 0 arrives undefined.
- **Contextual menu** (https://hub.evenrealities.com/docs/build/contextual-menu):
  - Opened by the user with "tap then long press".
  - The OS always shows the slots "Display off", "Brightness" and "Close <app>".
  - Up to **10 custom items** via `menuObject`; `itemName` ≤32 UTF-8 bytes (recommend <~16 ASCII).
  - Clicks arrive as `menuItemClickEvent {itemID}`. Opening fires FOREGROUND_ENTER and dismissing fires FOREGROUND_EXIT.
  - Labels should be verbs (fire-and-forget). Rebuilding without `menuObject` clears the items. Requires SDK 0.0.14+ and Even App 2.2.9+.
  - epub-reader built a lifecycle reducer so menu ENTER/EXIT is not mistaken for backgrounding. Its rule is "No feature may depend on long-press (OS menu owns tap+hold)."
- **R1 ring** (help center "Glasses control", https://support.evenrealities.com/hc/en-us/articles/17451427112975): same functions as the temples; worn on the index finger with the touchpad toward the thumb. A support article exists for "gesture recognition is inaccurate". Ring battery lasts 3–4 days.
- **Submission QA:** "Core flow must run end-to-end on glasses + ring input alone."

### 2.5 Update cost / throughput
Measured by even-g2-notes `docs/performance.md` on firmware 2.2.7.14, Even App 2.2.7, SDK 0.0.13:

| Call | Cost |
|---|---|
| `textContainerUpgrade` | **≈83 ms per call** |
| `rebuildPageContainer` | **≈165 ms flat** (with a brief flicker) |
| `createStartUpPageContainer` | ≈100–135 ms; one-shot only — a retry is rejected after ≈2.1 s, so latch "called", not "succeeded" |
| `updateImageRawData` | ≈104 ms + 3.9 ms/KB |

- Payload size barely matters; the call count is the cost. Break-even between upgrades and a rebuild is 2 containers.
- So a page turn that updates body and footer is about 170 ms. Updating only the body when the title is unchanged is about 83 ms. The LIHKG renderer already skips unchanged fields.
- The official display doc says images need ≥100 ms between sends. Images are not needed for this app.
- `getAppLocation` took about 3 s, which illustrates that awaiting slow phone APIs inside the event dispatcher drops taps. Never await network calls inside the gesture handler; render "Loading…" first.
- The official glasses-ui skill says to debounce `setLocalStorage` because it "shares the same BLE link". This is an official claim but unverified.

### 2.6 Lifecycle, background and phone lock
- **Official background page** (https://hub.evenrealities.com/docs/build/background-lifecycle):
  - iOS WKWebView keeps running in the background with JS state intact.
  - Android Chromium WebView may be suspended under memory pressure, so treat it as a cold start.
  - Audio and location streams stop when suspended.
  - Beta QA includes a 5-minute lock test.
- **Official QA** (https://hub.evenrealities.com/docs/ship/app-submission):
  - "Beta builds survive phone lock; local testing/QR sideload does not."
  - With the phone locked and Even backgrounded, the app must render "within reasonable time. No infinite spinner, no black screen."
  - It must stay alive and responsive after 2 min idle.
  - Root double-tap must open the system exit dialog (`shutDownPageContainer(1)`; mode 0 or custom confirmations are rejected).
  - First run: no black screens, and an on-glasses message explaining required setup.
  - Name ≤20 chars and **must not contain "Even"**; `min_sdk_version` floor is 0.0.14.
- **SDK changelog:**
  - 0.0.10 "Enhanced WebView background keep-alive";
  - 0.0.16 "Fixed repeated execution of setTimeout / setInterval callbacks". The minified SDK wraps `window.setTimeout/setInterval`.
  - 0.0.16 requires Even App ≥2.2.10 (`minAppVersion` in its package.json).
- **Community keep-alive hack** (even-toolkit `glasses/keep-alive.ts`): a silent 1 Hz oscillator at gain 0.001 plus a never-resolving `navigator.locks` request. epub-reader uses it.
- **Timers.** aleapc devguide: timers keep firing in the background but render calls are dropped. Pause on FOREGROUND_EXIT and resume on FOREGROUND_ENTER.
- **Exit dialog quirk.** `shutDownPageContainer(1)` fires FOREGROUND_ENTER when the dialog appears, FOREGROUND_EXIT if the user cancels, and SYSTEM_EXIT if the user confirms. The polarity is inverted, so arm a flag. Duplicate sys events arrive about 50–100 ms apart; dedupe within ~600 ms. The image-channel wedge after this dialog only matters for image apps.
- **Contradictions to flag:**
  1. The official everything-evenhub `background-state` skill describes a "Headless WebView migration" with `setBackgroundState` / `onBackgroundRestore`, but these are **not exported by SDK 0.0.16** (I grepped `index.d.ts`). Readpane's learning log and Glance's quirks file also say they are absent.
  2. Official docs say browser `localStorage` is disk-persisted and survives. even-g2-notes, Glance, epub-reader and Hands-Free report that browser localStorage and IndexedDB do not reliably persist in the `.ehpk` WebView, and that IndexedDB `open()` can hang at boot.

  Safe choice: `bridge.setLocalStorage` / `getLocalStorage` as the source of truth, behind an in-memory write-through cache. There is no delete, so write `''`.

### 2.7 Head-up / dashboard
- Dashboard (help center, https://support.evenrealities.com/hc/en-us/articles/14269247458319): double tap while the display is off opens it.
- The "Head-Up Display" setting shows information when looking up (troubleshooting articles 17143825606927 and 17143921759759).
- Dashboard has a first-party **News widget**: tap to expand, swipe to browse, tap to open, double tap to return to the list, 5 stories per set, swipe down past the end to load the next set. This is a good model of Even's own reading conventions.
- **First-party Teleprompt** (https://support.evenrealities.com/hc/en-us/articles/14273863878415):
  - AI / Auto (fixed speed) / Manual modes;
  - in Auto, swipe adjusts position and auto-scroll continues; single tap = pause/resume; double tap = exit prompt;
  - already-read text turns grey in AI mode;
  - the glasses list shows only the 20 most recent scripts ("limited local memory");
  - files ≤255 KB;
  - adjustable prompting-area height and width (firmware ≥2.2.6).
- Unknown: how head-up activation interacts with a running Even Hub plugin.

### 2.8 Battery
- Official: glasses ≈2 days of regular use, ring 3–4 days. No published continuous-display figure.
- Micro LED is emissive (black = off), so less lit text and lower `textColor` should cost less power. **This is an inference, not measured.**
- Phone side: avoid polling. NOS refreshes every 5 min and TabNews every 30 min while the list is open. Fetch on launch, on foreground and on explicit refresh. Avoid per-second clock tickers; epub-reader updates its clock once per minute.

---

## 3. Networking evidence relevant to Substack (CORS)
- Official networking doc: whitelist = "full origin (`https://api.example.com`) - bare hostnames and wildcards aren't supported", and "Adding a domain to `app.json` does **not** override CORS". The recommended fix is "proxy through a server you control … then put that server's domain in the whitelist."
- **Contradicting evidence:**
  - ER Browser ships `"whitelist": ["https://", "http://"]` and is reportedly on the Hub. This may be grandfathered from the SDK 0.0.9 era.
  - arxeven lists bare hostnames.
  - Neither should be copied.
- NOS README: "dev-QR mode does not enforce the network whitelist; always test the installed build too." Glance quirk: the simulator doesn't enforce `app.json` permissions at all.
- Glance quirk: WebSocket handshakes fail opaquely inside the Even WebView. Use HTTP `fetch`, and wrap binary bodies in `Blob`.
- **Live probe, 2026-10-06** (curl, `Origin: https://example.app`, against a Substack `/feed`):

  | Proxy | Result |
  |---|---|
  | `r.jina.ai` | 401 `AuthenticationRequiredError` ("blocked from performing anonymous queries due to bad network reputation") |
  | `corsproxy.io` | 401 "A valid API key is required" |
  | `api.codetabs.com` | 522 |
  | `api.allorigins.win/raw` | 200, ACAO echoed |

  The public-proxy chains used by NOS, epub-reader and Glance are now mostly broken. **Recommendation:** a small dedicated Cloudflare Worker, as the sibling LIHKG project already has. It should:
  - allowlist only Substack origins and paths (`/feed`, `/api/v1/archive`, `/api/v1/posts/<slug>`, `substack.com/api/v1/publication/search`, custom domains verified as Substack);
  - set ACAO;
  - pass through without storing content;
  - optionally strip HTML server-side to reader text, the way Glance's Worker uses Readability + linkedom (jsdom does not deploy on Workers);
  - cache briefly at the edge (feed TTL a few minutes).

---

## 4. Recommended UX for Substack Reader (concrete)

### 4.1 Principles
1. Glasses = reading and light navigation. Phone = setup, search, management and settings. This follows the sibling LIHKG split and Glance.
2. Every glasses screen renders immediately. Show a Loading line before any await, and never leave a black screen (QA).
3. Page turns must feel instant: upgrade the body only, include the footer only when it changes, use a single serialized queue, and suppress phantom scrolls.
4. Gestures should match first-party Even conventions so users don't relearn them. Double tap = Back everywhere except root, where it is the system exit.
5. Nothing essential should depend on a plain long-press or on the contextual menu. The menu is for shortcuts only, and every menu action must also be reachable some other way, or be non-essential.

### 4.2 Glasses information architecture
```
Home (root)                 text-cursor menu, ≤4–5 items, phone can reorder/hide
 ├─ Continue: <title>       (shown only if an article is in progress; jumps straight into reader)
 ├─ Latest  (N new)         merged newest-first list from followed publications
 ├─ Publications (N)        → publication → its archive list
 ├─ Saved (N)               posts saved from phone or glasses menu ("read later")
 └─ (optional) History      recently opened
Article list                3 entries per screen × 2 lines (title + meta), ">" cursor, last row "Load older…"
Reader                      title / body / footer, see 4.3
End-of-post card            "End · 41/41" + Tap: next post · 2×tap: list
```
- **Launch:**
  - `onLaunchSource('glassesMenu')` with an in-progress article → go straight to the Reader at the saved offset. Show "Resumed · 34%" in the footer for one render.
  - Otherwise → Home.
  - Register `onLaunchSource` before the first render (it fires once).
- **Home layout:** title "Substack Reader" (or chosen store name) plus optional battery or `HH:MM`. Body holds 4 items with blank lines between (LIHKG `menuBody`). Footer `Tap open · 2×tap exit`.
- **Article list entry (2 lines):**
  - line 1: `> Post title…`, pixel-truncated with `pxTruncate`;
  - line 2: `  Pub name · 2d · 12 min · Paid`.
  - Mark unread with `●` and read with `○`, or plain text. **Do not use ✓** (missing glyph).
  - The footer `4/37 · Tap read · 2×tap back` gives the list position.
  - TabNews validated 3 entries × 2 lines on a page.
  - Alternative: a native ListContainer, which gives zero-latency swipes but only single-line 64-char items. Keep it as a fallback if text-cursor swipes feel laggy on hardware.
- **Pagination of lists:** text-cursor window moves automatically. Swiping past the last item opens "Load older…". Optionally use Reddit Feed's "double-scroll within 2 s at the boundary" to avoid accidental loads.

### 4.3 Reader page layout (reuse LIHKG `G2_LAYOUT`)
| Area | Geometry | Content | `textColor` |
|---|---|---|---|
| Title (id 1) | x12 y4 552×35, 1 line | `Pub · Post title` (pixel-truncated). On page 1, optionally show the full title wrapped into the body instead. | 2–3 |
| Body (id 2, **isEventCapture 1**) | x12 y43 552×197, 7 lines, inner 544×189 | one pretext-measured page; must never overflow | 4 (user setting 1–4) |
| Footer (id 3) | x12 y249 552×35, 1 line | `12/41 · 29% · 9 min left` (pixel-fit). Optional `━━━━────` bar or `HH:MM`. Auto mode adds `▶ 240 wpm` / `❚❚`. Avoid ❚ until glyph-verified; use "Paused". | 2–3 |

- **Density setting:** 7 (default), 6 or 5 lines, after Readpane's 5/6/8. Changing it repaginates and keeps the char offset.
- **Option to hide chrome:** "Focus mode" gives a full 9-line body with no title or footer. This follows epub-reader's tap-to-hide and evenBooks' no-chrome principle.
- **Page 1:** the title (up to 2 wrapped lines), then subtitle or byline · date · `N min read`, a blank line, then the body starts.
- **Text conversion of Substack HTML:**
  - paragraphs separated by a blank line;
  - headings on their own line, optionally prefixed `■ ` or followed by a `━━` rule;
  - lists `• `; blockquotes prefixed `│ `;
  - images → `[Image: caption/alt]`, or dropped if there is no caption;
  - footnotes → `[1]` inline and collected at the end;
  - links → text only;
  - embedded tweets and videos → `[Embedded post]`;
  - subscribe, share and paywall widgets dropped;
  - normalise NBSP and ZWSP, strip emoji, map ✓ to ASCII.
- **Page breaks:** prefer paragraph boundaries when the loss is under a quarter page, as the official template does (paragraph packing) and LIHKG does (whitespace back-off). Never split a heading from its first paragraph line, if feasible.

### 4.4 Gestures (reader)
| Input | Manual mode | Auto mode (running) |
|---|---|---|
| Swipe back (temple) / ring down → SCROLL_BOTTOM | next page | jump forward one page, keep running |
| Swipe front / ring up → SCROLL_TOP | previous page | back one page, keep running |
| Tap | next page (one-finger ring reading; matches template, Glance, TabNews). On the last page, show the end card. | pause / resume (first-party Teleprompt convention) |
| Double tap | back to list (position saved) | pause, then back |
| Tap then long-press (OS) | contextual menu: `Auto-scroll`, `Faster`, `Slower`, `Save for later`, `Next post`, `Restart post`, `Sections`, `Mark unread`, `Home` (≤10 items, ≤16 ASCII each) | same |
| Plain long press | ignored, or optional "pause" only | pause (safety stop) |

- **Debounce:** ~300–350 ms for the same scroll direction, 50 ms for a direction change, and ignore scrolls for 40–80 ms after every text write (phantom scroll). Tap cooldown ~220 ms. Reset gesture state on every view change.
- Taps on the ring may be accidental ("temple touches are the most common accidental input", epub-reader). Make "next page" recoverable (swipe back), and never put destructive actions on a single tap.

### 4.5 Auto-advance (optional, teleprompter-like)
- Dwell per page = `words_on_page / wpm × 60 s`, plus about 0.5 s per paragraph break or heading. Default 230 wpm, range 120–400, step ±20 from the menu, set on the phone. Pace Reader caps at 100–300 for RSVP; page mode can go higher.
- Start the next timer only after the previous write resolves (Pace Reader pattern).
- **Pause automatically** on FOREGROUND_EXIT, contextual-menu open, `isWearing === false`, glasses disconnect, and end of post.
- **On resume after more than ~60 s idle,** re-show the same page. Optionally show the previous page's last line as a one-line context ("auto-rewind", epub-reader).
- **Alternative "step" mode** (setting): each swipe advances half a page or 3 lines, keeping overlap for context. This follows NOS (3-line steps) and Glance (line mode). It helps readers who lose their place on a HUD.
- Only show "min left" from measured pace, and only after ~60 s of reading. epub-reader never fabricates the estimate. Before that, show `%` only.

### 4.6 Resume, cache, offline
- **Position record:** `{postKey (pub host + slug or post id), charOffset, paginationVersion, pageHint, updatedAt}` in bridge storage.
  - Resume by char offset (epub-reader v2), so changing density or line count lands on the same text.
  - Debounce writes by ~800 ms; save immediately on FOREGROUND_EXIT, SYSTEM_EXIT, ABNORMAL_EXIT and article switch.
  - Persist only after the glasses write succeeds (Readpane).
- **Last-open pointer:** written once per article open, not per page turn. epub-reader went from 5 bridge writes per page turn down to 2 debounced writes.
- **Cache cleaned text, not HTML.** The whole post is fetched at open and paginated locally, so all pages are available offline once opened.
  - **Prefetch:** when a list loads in the foreground, prefetch the top N unread posts (default 3, settings 0/3/5/10). While reading, prefetch the next post in the list at ~80% progress.
  - **Store:** LRU 30 posts / 30 days (Glance used 100 / 30 days). Bridge storage holds the index; bodies go to bridge storage per key (epub-reader proved large values work), with IndexedDB as a best-effort accelerator only.
  - Never cache content server-side in the proxy.
- **Read state:** mark read at the ≥90% / end card. "Mark unread" is in the menu.

### 4.7 Phone (companion WebView) responsibilities
- **Add publications:** paste a URL (`*.substack.com`, custom domain, or a post URL whose publication is inferred), `@handle`, or search via `substack.com/api/v1/publication/search`. Allow pasting many URLs (one per line). A user's subscription list isn't available without login (out of scope).
- **Manage:** reorder, remove, per-publication "include in Latest", rename label (short glasses label ≤20 chars).
- **Browse and send:** a phone article list with "Read on glasses" (one-shot pointer, consumed on glasses bootstrap and foreground, as in Glance) and "Save for later". Paste any Substack post URL to read it.
- **Settings:**
  - lines per page (7/6/5) and focus mode;
  - turn mode (page / half-page);
  - tap action (next page / none);
  - auto-scroll on/off and wpm;
  - footer content (page / % / time-left / clock);
  - text brightness 1–4;
  - prefetch count; clear cache;
  - Home menu items and order;
  - advanced: proxy endpoint and diagnostics (Glance-style fetch log);
  - optional Paid / free-preview display.
- **Now reading:** mirror the current page plus progress on the phone (official template `mirrorCompanion`), with Prev / Next / Pause buttons that go through the same action pipeline (epub-reader symmetry). This helps when the glasses or ring input is awkward.
- **Phone-only messages:** connection status, write failures, storage-full. evenBooks keeps "disconnected" off the glasses. On reconnect, re-issue the current frame (all frames are pure functions of state).

### 4.8 Error and empty states on the glasses (short, with an action hint)
| Situation | Body | Footer |
|---|---|---|
| First run, no publications | `Add publications on your phone:\nEven app → Substack Reader.` | `2×tap exit` |
| Loading list/article | `Loading <pub>…` (render before fetch) | `2×tap cancel` |
| Network / proxy unreachable | `Can't reach the reader service.` (+ `Showing saved copy` if cached) | `Tap retry · 2×tap back` |
| Rate-limited (429) | `Busy — try again in a minute.` | `Tap retry · 2×tap back` |
| Paid post (truncated) | preview pages, then an end card `Paid post — preview ends here.\nOpen on phone to read.` | `2×tap back` |
| Audio/video-only post | `No text in this post (podcast/video).` | `Tap next post · 2×tap back` |
| Extraction failed / empty | `Couldn't extract text.\nOpen on phone.` | `2×tap back` |
| End of list | `No more posts.` | `2×tap back` |

- Map raw errors to friendly one-liners (Glance `friendlyError`). Use 12–15 s fetch timeouts (NOS uses 12 s), with no infinite spinners.

---

## 5. Evidence / URL index
- Official docs:
  - https://hub.evenrealities.com/docs/build/display
  - …/build/page-lifecycle
  - …/build/device-apis
  - …/build/contextual-menu
  - …/build/networking
  - …/build/background-lifecycle
  - …/build/design-guidelines
  - …/ship/app-submission
- Official kit:
  - https://github.com/even-realities/everything-evenhub (skills: handle-input, glasses-ui, font-measurement, design-guidelines, background-state)
  - https://github.com/even-realities/evenhub-templates (text-heavy)
  - https://github.com/even-realities/EH-InNovel
- SDK: `@evenrealities/even_hub_sdk@0.0.16` README/d.ts (local), `@evenrealities/pretext@0.1.4` (local; font tables parsed).
- Help center:
  - Specs 13499229138959
  - How to Control 13754911116047 / 13772400722063
  - Menu 14269160297999
  - Teleprompt 14273863878415
  - Dashboard 14269247458319
  - Display Adjustment 13755064994831
  - Even Hub 15688149217167
  - Glasses control 17451427112975
- Community docs:
  - https://github.com/nickustinov/even-g2-notes (display.md, input-events.md, page-lifecycle.md, performance.md, packaging.md, device-apis.md)
  - https://github.com/aleapc/even-hub-devguide (sdk-quirks.md, lifecycle.md)
  - https://github.com/fabioglimb/even-toolkit (gestures.ts, keep-alive.ts)
  - https://github.com/pangoleen/awesome-even-realities-g2
- Apps:
  - https://github.com/chortya/epub-reader-g2
  - https://github.com/tntpsu/Glance (KNOWN_QUIRKS.md)
  - https://github.com/SachaEpskamp/NOSnieuws_G2
  - https://github.com/fabioglimb/even-browser
  - https://github.com/foxtheory222/ARCHIVED-g2reader
  - https://github.com/Atzingen/even-g2-tabnews
  - https://github.com/jcpsimmons/g2-pace-reader
  - https://github.com/KennyLowe/evenbooks
  - https://github.com/plungarini/reddit-feed-even
  - https://github.com/zakpatrik/CyberNews-evenrealities-app
  - https://github.com/sangularvilue/Even-LotH
- Reddit r/EvenRealities: the JSON API returned 403 to curl and web search returned no direct threads, so there is **no Reddit evidence** in this report.

## 6. Open questions / uncertainties
- Exact swipe-direction mapping on real G2. The help center says "front" = scroll up = SCROLL_TOP, but NOS ships an `INVERT_SCROLL` flag and Readpane's docs describe "ring forward = next". Verify on hardware.
- Whether a plain single-temple long press reaches the app as LONG_PRESS_EVENT on firmware ≥2.2.9, or is consumed. The LIHKG sibling uses it for "back"; epub-reader avoids it.
- Envelope routing on current firmware (`sysEvent` vs `textEvent` for taps and scrolls). Docs and community disagree; handle all.
- Persistence of browser localStorage and IndexedDB in installed `.ehpk` builds: official docs say it persists, community says it doesn't. The bridge storage quota is unknown.
- `setBackgroundState` / headless-WebView migration is described by the official skill but not exported in SDK 0.0.16.
- Glyph coverage for `cn`-range symbols (━ ● ▶ │) and emoji (pretext has an emoji font; older notes say there are none). Verify on device.
- Real page-turn latency on BLE 5.4 hardware with SDK 0.0.16 / Even App ≥2.2.10. The measurements are from 2.2.7 / SDK 0.0.13.
- Whether wildcard network whitelists (ER Browser) are still accepted by the current pack validator and review. Docs say no.
- Whether the app name may include "Substack" (trademark and impersonation review); the Hub forbids "Even" in names.
- Battery impact of sustained reading or auto-scroll; there is no measured data.
- Whether head-up / dashboard activation or "Display off" from the system menu pauses the plugin (FOREGROUND_EXIT?).
