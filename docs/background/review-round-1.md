# Review round 1

- **Reviewed:** 0dafad2 / 5e893eb
- **Fixes landed in:** `247981a`
- **Method:** Four lenses (glasses runtime, relay security, content pipeline, phone UI + storage) over the whole v0.1 code, each finding checked by an adversarial skeptic.
- **Verdicts:** confirmed 30, uncertain 4

Point-in-time record (2026-10-06/07). Line numbers refer to the reviewed commit, not to the current code. Ids repeat across lenses in round 1 (content C1–C6 and relay C1–C3), so the lens is part of the id.

## Summary

| Id | Lens | Severity | Verdict | File | Summary |
| --- | --- | --- | --- | --- | --- |
| C1 | content | high | confirmed | `src/substack/html.ts` | Any <p> whose whole text is a 'Read more' link stops the conversion (st.cut = true) and marks the post as paywalled. This happens at any position and nesting level (top level, inside an li, blockquote or callout), in API bodies as well as RSS bodies. The rule  |
| G2 | glasses | high | confirmed | `src/storage.ts` | A bridge storage read that fails looks the same as an absent key. After connecting, main.ts calls attachBridge, which then marks both documents dirty and writes the in-memory copy over bridge storage, which is the source of truth. If the browser mirror is empt |
| G1 | glasses | medium | confirmed | `src/glasses.ts` | The serialized bridge queue has no per-call timeout and does not merge queued renders. One bridge call that never settles (textContainerUpgrade, getLocalStorage or setLocalStorage) blocks every later write: page turns, the root exit dialog, Redraw and storage  |
| G3 | glasses | medium | confirmed | `src/main.ts` | main.ts redraws on reconnect only when the previous status was exactly 'disconnected'. A render that fails while the glasses are disconnected reports 'error' and replaces that status. A render that succeeds reports 'ready', so report() then drops the Connected |
| G4 | glasses | medium | confirmed | `src/app/controller.ts` | When the glasses reject or fail a frame, draw() discards the rejection and nothing retries it. The reader model has already moved to the new page while the glasses still show the old one, so the next swipe goes to the page after the one the user never saw. The |
| P1 | phone | medium | confirmed | `src/main.ts` | Bridge storage is attached only after createStartUpPageContainer succeeds. The phone UI can be edited before that happens, and attachBridge then merges whole documents by newest savedAt. Together these let the bridge copy of the user's library (the source of t |
| P2 | phone | medium | confirmed | `src/storage.ts` | attachBridge cannot tell a failed bridge read from an absent key. It then always marks both documents dirty and writes memory to the bridge, so one failed read can wipe the stored library. |
| S1 | relay | medium | confirmed | `worker/relay.ts` | The /v1/feed route passes upstream XML through verbatim from the relay's own origin, with no sandboxing CSP and only a check that the body starts with '<'. The custom-domain check can be bypassed, so an attacker can make the relay serve script-capable XML. The |
| C3 | content | low | confirmed | `src/substack/urls.ts` | UNSAFE_SCHEME_RE matches 'data:', 'file:', 'javascript:', 'vbscript:' and 'blob:' anywhere they follow a non-alphanumeric character. Ordinary words with a colon in share text or search text are therefore rejected as unsafe links, and the whole paste fails. The |
| C4 | content | low | confirmed | `src/substack/urls.ts` | parseMany drops decoration lines only when they parse as kind 'search'. Lines that fail search validation still become entries and produce spurious error cards whenever the paste contains a link: a title over 100 characters, a 1-character line, a line containi |
| C5 | content | low | confirmed | `src/substack/html.ts` | Some fairly common symbols are missing from all four firmware fonts (checked against pretext's glyph tables and cn ranges) and have no NFKD decomposition, so the coverage fallback turns them into '[?]'. Affected: currency signs ₹ U+20B9, ₽ U+20BD, ₺ U+20BA, ₴  |
| C6 | content | low | confirmed | `src/substack/types.ts` | PUBLIC_HOST_RE, which urls.ts uses as HOST_RE and the relay also uses, requires an all-letter TLD ([a-z]{2,63}). It therefore rejects every IDN TLD after URL punycoding (.рф → xn--p1ai, .中国 → xn--fiqs8s, .みんな → xn--q9jyb4c). The SPEC promises 'punycode via URL |
| G5 | glasses | low | confirmed | `src/app/controller.ts` | loadLatest writes latestCache even when the load was cancelled. Fetches aborted by Back count as 'failed', so a partial merged list is cached for 5 minutes. |
| G6 | glasses | low | confirmed | `src/app/controller.ts` | When a Refresh of an already loaded posts list fails or is cancelled, double-tap pops the whole list and its loaded older pages. Tap-retry then reloads in 'initial' mode, so the selected post is not kept. Only failed 'older' loads are restored to the loaded li |
| G7 | glasses | low | confirmed | `src/app/controller.ts` | On the last loaded post, 'Next post' (end-card tap or menu item 3) shows 'No more posts.' even when the list still has a 'Load older posts…' row (nextOffset !== null). |
| G8 | glasses | low | confirmed | `src/main.ts` | The first glasses frame (initialPage) and the first redraw come only from the browser localStorage mirror. Bridge storage, the source of truth, is applied only after attachBridge has also written both documents back. On launches where the mirror is empty, the  |
| P4 | phone | low | confirmed | `src/storage.ts` | Within the allowed limits (100 publications, 100 saved posts) the prefs document can exceed MAX_KEY_CHARS. serializePrefs then returns null, no prefs write happens again, but the add flows still report success. |
| P5 | phone | low | confirmed | `src/main.ts` | The first glasses frame is built from state loaded from localStorage alone. If localStorage was not persisted, every launch opens on the first-run screen ('No publications yet... add a publication'), and Home input is ignored until the bridge reads finish. |
| P6 | phone | low | confirmed | `src/app/controller.ts` | After a phone edit, configurationChanged only clamps the glasses Home and Publications cursors by index. Removing or reordering publications, hiding Home items, or clearing reading (which removes 'Continue') moves the cursor onto a different item. |
| P8 | phone | low | confirmed | `src/phone/actions.ts` | The C4 www retry applies only to 'publication' inputs. A post link typed with an apex custom domain fails, while the same domain works when added as a publication. |
| P9 | phone | low | confirmed | `src/substack/urls.ts` | parseMany drops every plain-text line, without any message, as soon as any line contains a link. A list that mixes links and names produces fewer result cards than lines and no feedback, which departs from 'one per non-empty line'. |
| S2 | relay | low | confirmed | `worker/relay.ts` | /v1/health?probe=1 is public and uncached. Each call makes 3 Substack requests (on.substack.com archive, slowboring.com archive, substack.com top/search) from the shared Worker egress, limited only by the general 60/min per IP per route limiter. |
| S3 | relay | low | confirmed | `worker/relay.ts` | A custom domain that does not exist (NXDOMAIN), or exists but does not answer HTTPS, is reported as 503 UPSTREAM_UNAVAILABLE ('Substack is temporarily unavailable.') instead of HOST_NOT_SUBSTACK, and the verdict is never cached. Here dohQuery returns [] for St |
| C1 | relay | low | confirmed | `worker/relay.ts` | Profile handles are forwarded and cache-keyed with their original case, but Substack's public_profile lookup is case-sensitive and lowercase. Verified live: /api/v1/user/thezvi/public_profile returns 200, while /api/v1/user/TheZvi/public_profile returns 404 {" |
| S5 | relay | low | confirmed | `worker/relay.ts` | mappingProof turns a Substack block into a cached 'fail'. A 403 or cf-mitigated challenge on the first fetch (line 923: status !== 200 leads to 'fail'), or on the S.substack.com check (line 945: not a redirect leads to 'fail'), is cached for 1 h as HOST_NOT_SU |
| C2 | relay | low | confirmed | `worker/relay.ts` | ArchivePage.publication is found only through publishedBylines[].publicationUsers[].publication with id === publication_id. Verified live on on.substack.com (publication_id 1): none of the 3 archive items has a byline publication with id 1 (staff and guest byl |
| S6 | relay | low | confirmed | `worker/relay.ts` | Every syntactically valid non-substack.com host that fails the DNS checks reaches mappingProof, which makes the relay GET https://<arbitrary host>/api/v1/archive?sort=new&offset=0&limit=1. The fetch is blind, but the host is caller-chosen. Next, it GETs https: |
| S7 | relay | low | confirmed | `worker/relay.ts` | The rate-limit key uses the raw CF-Connecting-IP header. Cloudflare sets that header, but on the documented alternative hosts (Deno Deploy, Vercel; docs/relay.md:134) the client controls it, so each request can pick its own bucket. On Cloudflare, IPv6 clients  |
| C3 | relay | low | confirmed | `worker/relay.ts` | /v1/post?id accepts any safe integer up to 16 digits, but Substack's by-id endpoint returns 400 {"errors":[{"param":"id","msg":"Invalid value"}]} for ids above 2147483647 (verified live: 2147483647 returns 404, 2147483648 returns 400). Upstream 400 falls throu |
| S8 | relay | low | confirmed | `.github/workflows/deploy-relay.yml` | The deploy step runs 'pnpm dlx wrangler@4.148.0' with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment. dlx resolves wrangler's transitive dependency tree fresh on every run, outside pnpm-lock.yaml, so a compromised or yanked transitive releas |
| C2 | content | medium | uncertain | `src/substack/html.ts` | latexToText uses a regex lookbehind literal, /(?<!\\)&/g. Its build target is es2022 (vite.config.ts), so esbuild does not lower it. WKWebView before iOS 16.4 (Safari 16.4) rejects lookbehind at parse time. The research notes this ('iOS 16.4+ for lookbehind'), |
| P3 | phone | medium | uncertain | `src/glasses.ts` | Bridge storage get and set calls run in the same serialized queue as screen writes, with no timeout. If the host never answers one storage call, all later glasses renders stall, and so does controller.start() (main awaits attachBridge before start). |
| P7 | phone | low | uncertain | `src/storage.ts` | addPublication dedupes by host only. The same publication can be followed twice under different hosts even though its Substack id is known. |
| S4 | relay | low | uncertain | `worker/relay.ts` | Verdicts and response bodies are stored under a fixed, generic synthetic origin (https://relay.cache/p1/...), not the relay's own origin or any deployment-specific namespace. Cached entries are trusted as-is. storedVerdict accepts any {verdict:'pass', expires} |

## Details

### content:C1 (high, confirmed)

`src/substack/html.ts:414`

**Summary.** Any <p> whose whole text is a 'Read more' link stops the conversion (st.cut = true) and marks the post as paywalled. This happens at any position and nesting level (top level, inside an li, blockquote or callout), in API bodies as well as RSS bodies. The rule should only strip Substack's RSS paid-preview tail, which is always the last element of content:encoded. I checked live data. Anonymous API bodies of paid posts have no tail and just end mid-paragraph with an ellipsis (slowboring 'with-a-new-agenda-the-build-america', audience only_paid). The Slow Boring /feed shows the tail as the final <p>, wrapped in whitespace. So the rule never helps on the API path and can only do harm there. CI does not catch it: fixture 11 only covers the true tail case.

**Failure scenario.** A free post (audience 'everyone') from a link digest or roundup: <p>Summary of story A.</p><p><a href="https://nytimes.com/a">Read more</a></p><h3>Story B</h3>... The renderBlock('p') regex /^read more$/i matches, so st.cut becomes true and every renderChildren loop breaks. Story B and everything after it are silently dropped. paywalled becomes true, so the body ends with '[Preview ends here. The rest of this post is for paid subscribers.]', and buildArticle adds the '[Paid post · free preview only]' header (result.paywalled || isGated). The reader sees a truncated, complete free article labelled as a paid preview. The same thing happens for RSS-fallback bodies of free posts, and when the link paragraph sits inside a list item ('<li><p>…</p><p><a>Read more</a></p></li>'): the rest of the list and the whole remaining article vanish.

**Suggested fix.** Delete the generic check at html.ts:414. In htmlToReaderText, after the footnote pre-pass, strip only the trailing tail. Walk from root.lastElementChild, skipping whitespace text nodes and removed footnote divs. If that element is a <p> whose only element child is an <a> and whose trimmed textContent matches /^read more$/i, remove it and set st.cut = true. Optionally, only do this when the href matches the post URL (pass the post link as an option; feed.ts already has samePost). Hardening along the same lines: only honour PAYWALL_SELECTOR cut markers when opts.audience !== 'everyone', so a stale PaywallToDOM node left in a post that was later made free cannot truncate it either. Add a fixture with a mid-body 'Read more' link in an 'everyone' post that expects the full text and paywalled === false.

**Skeptic's reasoning.** html.ts:414 checks every <p> reached through renderBlock: `el.querySelector('a') && /^read more$/i.test(textContent.trim())` sets st.cut = true. Nothing restricts it by position, by audience or by href. Every renderChildren loop then breaks on `if (st.cut) break`. renderList's forEach keeps calling renderChildren for the later <li>s, but each of those breaks at once, so the remaining items come out empty. htmlToReaderText:558 then sets paywalled = st.cut || ..., which appends PAID_PREVIEW_NOTE, and buildArticle (article.ts:100) adds PAID_PREVIEW_HEADER because of result.paywalled. converterOptions passes audience 'everyone' for free posts, but html.ts never checks it before cutting. The project's own fixture shows the problem: in tests/fixtures/feed/substack-feed.xml the FREE item 'weekly-links' ends with <p><a href=".../a-free-essay-about-tidy-gardens">Read more</a></p>. feed.ts correctly classifies it as FREE through hasReadMoreTail + samePost, yet html.ts marks that body as a paid preview. A live probe of slowboring.com/feed confirms the real tail always has the same shape: the last element of content:encoded, wrapped in whitespace, with an href equal to the item's own post URL. Free items end with Share buttons instead. tests/browser/html.test.ts:245 explicitly encodes the mid-body cut ('...Read more</a></p><p>Hidden.</p>' expects 'Hidden.' to be dropped), so CI cannot catch this. Severity stays high: when it triggers, free content is silently lost and the post is falsely labelled paid. The trigger, a free post with an exact 'Read more' link paragraph, is a realistic pattern; the repo's own fixture models it.

**Fix notes.** 1) Delete the check at html.ts:414 so 'p' just does `return renderChildren(el, ctx, out, st)`. 2) In htmlToReaderText, after the footnote pre-pass and BEFORE `renderChildren(root, base, blocks, st)`, strip only the trailing tail. Walk back from root.lastChild, skipping text nodes whose data is only whitespace and comment nodes (nodeType 8). If the node found is an Element with localName 'p', its only element child is an 'a', /^read more$/i matches its trimmed textContent, and opts.audience !== 'everyone' (undefined, as in the tests' {}, still counts as eligible), then call node.remove() and set a LOCAL flag `let tailCut = true`. Do NOT set st.cut before rendering: renderChildren checks `if (st.cut) break` first, so that would empty the whole body. Then use `const paywalled = st.cut || tailCut || gated || ...`. Optionally pass the post URL as a new option and require samePost-style host+path equality, like feed.ts:114. 3) Update tests/browser/html.test.ts:245: either move the Read more paragraph to the end, or assert that 'Hidden.' is KEPT and paywalled === false when the paragraph is not last. Fixture 11 and the r11 assertion keep passing, because there the tail is the last element and opts is {}. 4) Add tests: (a) '<p>A.</p><p><a href="https://nytimes.com/a">Read more</a></p><h3>B</h3><p>C.</p>' with {audience:'everyone'} contains B and C, and paywalled is false; (b) a list item containing a 'Read more' link paragraph keeps the later items; (c) the weekly-links feed body converted with audience 'everyone' gives paywalled false. Skip the PAYWALL_SELECTOR-gating idea unless it is verified against real data; nothing shows stale PaywallToDOM nodes in free posts.

### glasses:G2 (high, confirmed)

`src/storage.ts:476`

**Summary.** A bridge storage read that fails looks the same as an absent key. After connecting, main.ts calls attachBridge, which then marks both documents dirty and writes the in-memory copy over bridge storage, which is the source of truth. If the browser mirror is empty or stale, the user's publications, saved posts, settings and progress are overwritten.

**Failure scenario.** Cold start where window.localStorage was cleared or evicted; research/02 says the .ehpk WebView does not reliably keep it. store.load(browserKV()) therefore yields defaults. The first bridge getLocalStorage then rejects or resolves to a non-string because the host is not fully ready. glasses.storageGet maps a non-string to an empty string, and bridgeKV.get/safeGet catch the rejection and also return an empty string. mirroredKV.get returns the empty mirror copy, so readDocs gives value null for both documents. attachBridge keeps the defaults in memory, sets dirty for both documents and calls flush(), which writes the defaults under sr:prefs:v1 and sr:progress:v1 on the bridge. Everything the user had is permanently replaced.

**Suggested fix.** Tell a failed read apart from an absent key. Make bridgeKV.get rethrow errors and non-string results; only an empty-string result means absent, per the C-rule. Have readDocs report a per-document failure. In attachBridge, when the bridge read of a document failed, neither mark it dirty nor write it; keep kv on the mirror and retry the attach later, for example on the next foreground or after a backoff. As a further guard, never write a document that still equals the pristine defaults over a bridge key that has not yet been read successfully.

**Skeptic's reasoning.** I traced the whole path. main.ts:33 loads only browserKV. main.ts:101 calls store.attachBridge(mirroredKV(bridgeKV(g), browserKV())). storage.ts:399-402 readDocs goes through safeGet, then mirroredKV.get at storage.ts:318, which wraps the primary in safeGet again. bridgeKV.get at storage.ts:294-300 catches every error and returns ''. glasses.ts:317-321 storageGet maps any non-string to ''. A rejected or garbled bridge read therefore returns exactly what an absent key returns. With an empty or stale mirror, parseStored('') gives null, both `value !== null` branches are skipped (storage.ts:480-493), and storage.ts:494-500 then marks both documents dirty unconditionally and flushes. The in-memory copy (defaults, or the stale mirror) is written over sr:prefs:v1 and sr:progress:v1 on the bridge, and nothing can undo it. I cannot verify how often getLocalStorage rejects on a real device. The SDK is obfuscated and documents no timeout. The other precondition, an empty mirror, is the case the design was built to handle (research/02 §1.7, SPEC risk table). Two things make this more than theoretical. (1) The G1 fix (a per-call timeout) turns any slow read into a rejection, and so into this data loss, unless the two are fixed together. (2) The same loss happens with no read failure at all. The test 'Unsaved phone edits made before the bridge arrived beat an older bridge copy' (tests/unit/storage.test.ts:381-390) enshrines whole-document last-writer-wins. With an empty mirror, a user who sees an empty phone UI and adds one publication before attach finishes gets a newer localStamp, so the bridge's full prefs document is discarded and overwritten with that single publication.

**Fix notes.** (1) glasses.ts storageGet: let rejections propagate. Return value for strings, return '' for null/undefined (the SDK says a missing key is ''; do not risk never attaching on a host that sends null), and throw for any other type. (2) storage.ts bridgeKV.get: remove the try/catch so errors propagate. mirroredKV.get: call primary.get(key) directly so a primary error rejects instead of going through safeGet; keep safeGet only for the mirror. (3) storage.ts attachBridge: do not use readDocs/safeGet. Read each key in try/catch and record a per-document ok flag. If any primary read failed, return false and leave kv, dirty and changedAt untouched. main.ts then retries attach with backoff (for example 1 s, 3 s, 10 s) and again on the next foreground or reconnect; until then kv stays browserKV. (4) Even when the reads succeed, mark a document dirty only if memory actually has something newer: localStamp(name) > remoteSavedAt, where an absent remote counts as -1, AND the in-memory document is not pristine (savedAt > 0 or dirty). Never write pristine defaults over a key. When the remote document was adopted, refresh only the mirror (browserKV.set) and skip the redundant bridge write. (5) For the pre-attach-edit path: either disable phone edits until attach succeeds or the 4 s grace ends, or merge publications/saved by key (union, newest addedAt) instead of whole-document last-writer-wins. Update the storage.test.ts case at line 381 to match. (6) If G1's timeout is added, a timed-out storageGet must reject, so step 3 treats it as a failure and not as absent.

### glasses:G1 (medium, confirmed)

`src/glasses.ts:190`

**Summary.** The serialized bridge queue has no per-call timeout and does not merge queued renders. One bridge call that never settles (textContainerUpgrade, getLocalStorage or setLocalStorage) blocks every later write: page turns, the root exit dialog, Redraw and storage flushes. When the call finally settles, every stale frame queued behind it is written in turn.

**Failure scenario.** A BLE hop stalls a textContainerUpgrade for about 30 s; research/02 says these hangs happen. Gestures are still accepted: lastWriteAt does not change and each swipe is at least 300 ms apart, so view.page goes N+1 to N+5 and five render ops pile up behind the stalled call. The glasses look frozen. A double-tap on Home queues shutDownPageContainer(1) behind the stall, so no exit dialog appears, which fails the store-review rule that the root double-tap must open it. The phone's Redraw button is queued behind the stall too. If the call never settles, the glasses stay frozen until the app restarts, because attachBridge/start() also wait on the same queue. If it settles late, the five frames are written one after another and the reader jumps several pages.

**Suggested fix.** Inside enqueue, race every bridge call against a timeout of about 4-5 s that rejects with a timeout error. The existing catch then sets last = null and reports the error, and the queue moves on. Merge renders: keep a single pendingFrame, and have render() replace it while an op is queued, so only the newest frame is written and superseded render promises resolve as no-ops. Let exit() skip queued renders, or put it at the front of the queue, so the root double-tap always reaches shutDownPageContainer(1).

**Skeptic's reasoning.** glasses.ts:190-201 enqueue chains every bridge call (render, exit, storageGet, storageSet) on a single promise and has no timeout, so one call that never settles blocks every later call. Gestures are not gated on the queue: input.ts:68 suppresses scrolls only within 80 ms after a successful write, and lastWriteAt (glasses.ts:300) changes only on success, so swipes 300 ms or more apart are accepted. controller.onReader (controller.ts:734-737) increments view.page and enqueues one render per swipe. The root double-tap (onHome -> exitApp -> deps.exit -> glasses.exit, glasses.ts:307-316) and the phone's Redraw (actions.ts:599 -> controller.redraw) are both enqueued behind the stalled call. If the stall happens during attachBridge's storage reads, main.ts:101-103 never reaches controller.start(). exitApp's 1.5 s bound covers only onExit, not the queue. The trigger is device behavior I cannot verify. Research/02 §3 quotes the platform skill: 'a single flaky hop can hang ~30s; add a per-call timeout'. LIHKG has no timeout either, so it is no evidence against this. One correction to the scenario: after a late settle, the reader 'jumps several pages', but that only replays the swipes the user made, so the final page matches the model. The real harm is the frozen display and the blocked exit dialog and Redraw.

**Fix notes.** In enqueue, wrap operation() in Promise.race against a timer: about 5000 ms for render and exit, about 4000 ms for storage. The timer rejects with new Error('G2 did not answer in time.'). Keep a handle on the raced native promise; if it settles after the timeout, set last = null, because a late textContainerUpgrade may overwrite a newer frame, and the next render must resend all fields. Coalesce renders: keep one pendingRender {snapshot, resolve, reject}. If render() is called while a render op is queued but not started, replace the snapshot and reject the superseded promise with a sentinel SupersededError. The enqueue catch must skip report() for that error, and controller.draw already ignores rejections, so no position is recorded for a frame that was never shown. With coalescing plus the timeout, exit() waits at most one timeout. Do not bypass the queue for exit, because that breaks the 'serialize all bridge calls' rule. The fix must ship together with the G2 fix: a timed-out storageGet must count as a read failure, not an absent key.

### glasses:G3 (medium, confirmed)

`src/main.ts:87`

**Summary.** main.ts redraws on reconnect only when the previous status was exactly 'disconnected'. A render that fails while the glasses are disconnected reports 'error' and replaces that status. A render that succeeds reports 'ready', so report() then drops the Connected 'ready' as a duplicate. In both cases nothing redraws after reconnect, even though glasses.ts has set last = null.

**Failure scenario.** The user opens a post, and the G2 disconnects while the fetch is in flight (out of range, or put in the case). The fetch completes, draw() runs, and textContainerUpgrade fails, so the queue catch calls report('error') and lastState becomes 'error'. On reconnect, Connected leads to report('ready'), but reconnected is false because lastState is not 'disconnected', so controller.redraw() is never called. The glasses keep showing 'Loading…' while the model is on page 1. Phone edits made while disconnected (configurationChanged, then a failed render) lead to the same stale frame. A user who sees the stuck Loading frame and double-taps triggers cancel and pop, and loses their place.

**Suggested fix.** Handle reconnect in glasses.ts, independent of report() de-duplication. Keep a wasDisconnected flag that is set on Disconnected or ConnectionFailed. On Connected with that flag set, clear it, set last = null and call a new opts.onReconnect?.(), which main.ts wires to controller.redraw(). Alternatively, keep a sticky needsRedraw in main.ts that is set on 'disconnected' and cleared only after a redraw completes, not on whichever status comes next.

**Skeptic's reasoning.** main.ts:87 sets reconnected only when lastState === 'disconnected'. glasses.ts:138-144 report() de-duplicates on state+message. While disconnected, any draw can replace that status: an in-flight fetch completing (loadReader/loadPosts call draw), configurationChanged after a phone edit, onLifecycle('foreground') after more than 30 s hidden (controller.ts:834-837, a common case: glasses in the case while the user is on the phone), or the phone remote. If textContainerUpgrade rejects or returns false, the queue catch reports 'error', lastState becomes 'error', and the later Connected -> report('ready') gives reconnected === false. If it resolves true while disconnected, render reports 'ready'. That falsely counts as a reconnect and triggers an immediate redraw while still disconnected, and the real Connected 'ready' is then dropped as a duplicate. Either way, no redraw follows the actual reconnect. glasses.ts:268-270 sets last = null but renders nothing. The glasses show a stale frame (for example 'Loading…' while the model is on page 1) until the next gesture. That gesture acts on the hidden model: a swipe goes to page 2, and a tap with tapInReader 'next' skips page 1. What the G2 shows right after a reconnect (old content or blank) depends on the device and is unverified.

**Fix notes.** Detect the reconnect in glasses.ts, independent of report(). Add `let linkLost = false`. On Disconnected/ConnectionFailed set linkLost = true (keep last = null and the report). On Connected: last = null; if (linkLost) { linkLost = false; try { opts.onReconnect?.() } catch {} }; then report('ready'). Add `onReconnect?(): void` to GlassesOptions. In main.ts pass onReconnect: () => { void controller.redraw() } and delete the lastState/reconnected logic in onStatus. A sticky flag kept only in main.ts is not enough, because the real Connected 'ready' can be de-duplicated away entirely. The 'displayStale' guard proposed under G4 also covers the first gesture after a reconnect.

### glasses:G4 (medium, confirmed)

`src/app/controller.ts:266`

**Summary.** When the glasses reject or fail a frame, draw() discards the rejection and nothing retries it. The reader model has already moved to the new page while the glasses still show the old one, so the next swipe goes to the page after the one the user never saw. The error text tells the user to 'Try the page again', which skips that page.

**Failure scenario.** The reader is on page 10 and the user swipes next, so onReader sets view.page = 11 and calls draw(). textContainerUpgrade returns false and glasses.ts reports 'G2 rejected the body update. Try the page again.' The glasses still show page 10. The user swipes next again, view.page becomes 12, and page 12 is drawn in full. Page 11 is never shown. A tap with tapInReader 'next' behaves the same way. On a list, the cursor the user sees is one row off from the model's view.sel, so the next tap opens a different post than the highlighted one.

**Suggested fix.** In draw(), when the render rejects, retry once after about 300-500 ms if generation, top() and the computed frame are unchanged: call deps.invalidate() and then draw() again. Alternatively, in glasses.render(), retry a rejected textContainerUpgrade once before throwing. As a last resort, roll the reader's view.page back to the last page whose render succeeded, which positionShown/afterReaderRender already track.

**Skeptic's reasoning.** controller.ts:269-284 draw() sets frame = page, updates the phone mirror, and on rejection only discards the error (`() => undefined`). Only afterReaderRender is skipped. Nothing retries, and the model mutation that came before draw (view.page += 1 at controller.ts:736/747, view.sel = sel at 717 and 687, homeSelId at 659) is never rolled back. glasses.ts:299 throws on accepted === false and the catch sets last = null, so the next render resends everything. The next swipe then increments again from the unseen page, so page 11 is skipped, and in lists a tap opens view.items[view.sel], one row away from the highlighted one. The 'Try the page again' text appears only in the phone status (glasses.ts:198 -> onStatus), not on the glasses, so the wearer gets no warning. How often textContainerUpgrade returns false depends on the device, but the code expects it to happen. The test at controller.test.ts:534 checks only that positions are not recorded before acceptance; nothing covers a rejection.

**Fix notes.** Two parts. (a) glasses.ts render: when bridge.textContainerUpgrade returns false, wait about 150 ms and retry the same upgrade once before throwing, which absorbs transient refusals. (b) controller.ts: add `let displayStale = false`. In draw(), set displayStale = false in the fulfilment handler and displayStale = true in the rejection handler; a rejection caused by a superseded render, if G1 coalescing is added, should not set it. In onAction, before dispatching, when displayStale is true and the action is 'next', 'previous' or 'select', call `return this.redraw()` (invalidate + draw) and do not change the model. 'back', 'hold' and menu actions still run normally. The user then always sees the model state before a navigation acts on it. This also fixes the stale frame after a reconnect in G3. Leave view.page as it is, without rollback: once the redraw succeeds, the screen and the model agree and afterReaderRender records the position.

### phone:P1 (medium, confirmed)

`src/main.ts:96`

**Summary.** Bridge storage is attached only after createStartUpPageContainer succeeds. The phone UI can be edited before that happens, and attachBridge then merges whole documents by newest savedAt. Together these let the bridge copy of the user's library (the source of truth) be overwritten or never loaded.

**Failure scenario.** The spec treats this case as the main storage risk: the Even app's WebView localStorage was not persisted. Boot runs store.load(browserKV()) and gets empty defaults, so the phone shows 'Get started / No publications yet' while the bridge still holds 30 publications. (a) The glasses are off, or createStartUpPageContainer returns 1, 2 or 3 or hangs. connectGlasses rejects, main.ts:106 only sets phase 'nobridge', and attachBridge never runs. Every edit in that session goes to localStorage only and the bridge library is never shown. Say the user re-adds 1 publication with savedAt T2. On the next launch with glasses, mirroredKV.get returns the localStorage copy (T2 > T1). attachBridge finds remote.savedAt not > localStamp, then flushes, writing a 1-publication prefs doc over the bridge and losing 29 publications. If localStorage did not persist, the session's edits are lost instead. (b) Page creation is slow (BLE) and the user adds a publication before the two bridge reads finish. writeDirty stamps localStorage with now(), the stamp beats the bridge copy, and the bridge library is replaced the same way.

**Suggested fix.** Separate storage from page creation. As soon as waitForEvenAppBridge() resolves, attach bridge storage, whether or not createStartUpPageContainer succeeds. To do that, give connectGlasses a storage-only handle, or call bridge.getLocalStorage/setLocalStorage from main. Until the first bridge read finishes, or the no-bridge grace period expires, show the phone lists as 'Loading your library...' with add, remove and reorder disabled. In attachBridge, if memory was loaded from an absent document (savedAt 0) and the bridge copy exists, merge instead of replacing the whole document: union publications by host and saved posts by refKey, keep the bridge order, and append local additions.

**Skeptic's reasoning.** The code paths are as described. In main.ts:81-110, attachBridge runs only inside the .then of connectGlasses, and that promise resolves only after createStartUpPageContainer returns 0 (glasses.ts:220-245). On a non-zero result or a throw, the rejection handler (main.ts:106) only sets the phase, so bridge storage, which lives on the phone, is never read in that session even though waitForEvenAppBridge already resolved. Before attach, store.kv is browserKV and nothing in phone/actions.ts blocks edits: changed() calls store.save, and no phase guard exists. attachBridge (storage.ts:476-502) compares remote.savedAt with localStamp(), which is max(savedAt, changedAt) when dirty. Any edit made on top of empty defaults therefore beats an older bridge copy, and the whole document is then written back. Scenario (b) is literally the behaviour that tests/unit/storage.test.ts:381-389 codifies ('Unsaved phone edits made before the bridge arrived beat an older bridge copy'): the bridge's publication list is replaced by the single new one. mirroredKV.get picks the newer savedAt (storage.ts:321), so scenario (a)'s next-launch overwrite also follows. I downgraded from high because both triggers depend on device behaviour I cannot verify. The startup window is normally short: createStartUpPageContainer takes about 100-135 ms per research 05, plus two local reads. Scenario (a) needs localStorage to be lost while the bridge keeps its copy (for example after a plugin update), followed by a session where page creation fails or hangs (glasses off?), followed by localStorage persisting. It is unknown what create does without glasses. The impact when it does happen is loss of the whole library.

**Fix notes.** (1) Decouple storage from page creation. In glasses.ts add `onBridgeReady?(storage: StorageBridge): void` to GlassesOptions and call it right after `waitForEvenAppBridge()` resolves, before createStartUpPageContainer. Its storageGet/storageSet use the existing `enqueue(..., false)` closures (move the `enqueue`/`queue` definitions above the create call; they already are). In main.ts, start the attach from that callback: `attachPromise = store.attachBridge(mirroredKV(bridgeKV(storage), browserKV()))`. In the connect .then, `await attachPromise` before `controller.start()`, so the attach also runs when create fails. (2) Add `store.ready()`/`phone.setLibraryLoading(bool)`. While a bridge exists and the attach is pending, render the publications/saved lists as 'Loading your library…' and disable the add form, follow, remove, reorder, settings and clear actions. Re-enable after the attach finishes, or when the 4 s no-bridge grace timer fires in a plain browser. (3) In attachBridge, when memory's base document was absent (record `loadedAbsent[name] = docs[name].value === null` in load()) and the bridge copy exists, merge instead of comparing stamps. Prefs: take the remote doc, then append local publications whose host (and non-null id) is not present, and append local saved refs whose refKey is not present. Keep remote settings unless local settings were changed this session. Progress: union positions by postId keeping the larger updatedAt, history by refKey (MRU), read ids, and keep remote lastOpen unless local has one. Update the storage.test.ts case at lines 381-389 to expect ['bridge.substack.com','mine.substack.com'].

### phone:P2 (medium, confirmed)

`src/storage.ts:476`

**Summary.** attachBridge cannot tell a failed bridge read from an absent key. It then always marks both documents dirty and writes memory to the bridge, so one failed read can wipe the stored library.

**Failure scenario.** bridge.getLocalStorage rejects, returns a non-string, or the controller is already disposed. glasses.storageGet / bridgeKV.get / safeGet turn that into ''. mirroredKV.get then returns the localStorage copy, which is '' when the WebView did not persist it, so docs.prefs.value and docs.progress.value are both null. attachBridge skips the merge but still runs `dirty[name] = true` for both documents and calls flush(). Empty default prefs and progress are written to the bridge, replacing the user's publications, saved posts, positions and history for good.

**Suggested fix.** Return a distinct failure from bridgeKV.get: throw, or return null for an error and '' only for a confirmed absent key. In attachBridge, if any bridge read failed, do not switch kv to the bridge and do not write. Keep the mirror only and retry the attach later, for example on the next foreground or after a backoff. Write a document to the bridge only when memory is strictly newer than the bridge copy or the bridge copy is confirmed absent, never unconditionally.

**Skeptic's reasoning.** I traced the path end to end. glasses.storageGet rejects when bridge.getLocalStorage rejects. bridgeKV.get (storage.ts:294-301) catches the error and returns '', and safeGet would do the same. mirroredKV.get (318-322) then returns the localStorage value when the primary value is ''. If localStorage is empty (the spec's own top storage risk), readDocs yields value null for both documents. attachBridge skips both merges, then unconditionally sets dirty[name]=true for both documents (496-499) and flushes. writeDirty serializes the empty defaults and safeSet writes them through mirroredKV to the bridge, so bridge success counts as success. The stored library, saved posts and progress are overwritten. I refuted one sub-case: if the controller is already disposed, enqueue also rejects the writes ('The G2 reader is closed.'), so nothing is overwritten. The realistic trigger is a single transient getLocalStorage rejection followed by a successful setLocalStorage. Rejection is plausible because the SDK's callEvenApp→postMessage surfaces host errors, but its frequency is unknown. That is why this is medium rather than high.

**Fix notes.** Make a failed read distinguishable. (a) bridgeKV.get: drop the try/catch so it rethrows, and treat a non-string, non-null result as an error (throw). Map null/undefined to '' (absent). (b) mirroredKV.get: `const first = primary ? await primary.get(key) : ''` with no swallowing, so a primary failure propagates. Keep `safeGet(mirror, key)` for the mirror. (c) In attachBridge, read with `source.get` inside try/catch rather than readDocs/safeGet. On any throw, `return false` without assigning `kv = source` and without marking anything dirty. Expose a retry: main.ts retries the attach on the next 'foreground' lifecycle signal and after 5 s/15 s backoff, at most 3 tries. (d) After a successful read, mark dirty only the documents where memory is strictly newer than the remote copy, or where the remote copy is confirmed absent ('' returned), instead of both unconditionally. Add a unit test where bridge get rejects once, local is empty and the bridge holds a library: assert the bridge value is unchanged and store.backend() is still 'localStorage'.

### relay:S1 (medium, confirmed)

`worker/relay.ts:1197`

**Summary.** The /v1/feed route passes upstream XML through verbatim from the relay's own origin, with no sandboxing CSP and only a check that the body starts with '<'. The custom-domain check can be bypassed, so an attacker can make the relay serve script-capable XML. The check can be bypassed three ways: (a) a 'pass' verdict is cached for 24 h (VERDICT_PASS_MS, in memory and caches.default) while the Worker's fetch resolves DNS again on every request; (b) the A/AAAA-intersection check (flatteningCheck, line 900) compares against target.substack-custom-domains.com, which resolves to multi-tenant Cloudflare anycast addresses (live: 104.18.36.24 and 172.64.151.232, with matching 2606:4700:44xx IPv6 addresses) that say nothing about which zone serves the host; (c) the x-served-by and x-cluster fingerprint headers can be forged by any origin.

**Failure scenario.** 1. The attacker sets www.evil.tld CNAME target.substack-custom-domains.com with TTL 60, then calls GET /v1/archive?host=www.evil.tld. The verdict is cached as 'pass' for 24 h in that isolate and colo. 2. The attacker repoints DNS to their own server. That server answers /feed with 'x-served-by: Substack', 'Content-Type: application/xml' and the body <html xmlns="http://www.w3.org/1999/xhtml"><script>...</script></html>. 3. The victim opens https://<relay>/v1/feed?host=www.evil.tld. The relay returns the body as application/xml; charset=utf-8 with no CSP, and the browser renders XHTML and runs the script on the relay origin. The relay domain now hosts attacker content: phishing, and a Safe Browsing listing that would break the app's only whitelisted origin. The bad response is also cached at the edge for 600 s.

**Suggested fix.** Add 'Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'' to every non-HTML response by putting it in CORS_HEADERS or responseHeaders. It is harmless for fetch() consumers. In the feed branch, require the document element to be <rss (after an optional <?xml ...?> declaration and whitespace), and reject any '<?xml-stylesheet' processing instruction or 'http://www.w3.org/1999/xhtml' namespace before caching or returning. Also cap the A/AAAA-intersection 'pass' TTL to a few minutes, or require a mapping proof in addition, because shared anycast IPs prove nothing.

**Skeptic's reasoning.** I traced the feed path end to end and found no guard that stops this. serve() (relay.ts:1174) checks only hostVerdict. Behind that, the feed is gated only by checks the origin itself controls: fingerprinted() (:670) is a header check any origin can forge, FEED_TYPE_RE is the origin's own Content-Type, and /^\s*</ (:1198). The body is then returned with XML_TYPE and CORS_HEADERS (:154), which carry nosniff and Referrer-Policy but no CSP. Browsers render application/xml whose elements are in the XHTML or SVG namespace and run their <script>. So a top-level navigation to /v1/feed?host=<attacker host> runs attacker script on the relay origin.

The verification can be bypassed:
(a) A 'pass' is memoised for 24 h (:1028, VERDICT_PASS_MS), but fetch() re-resolves DNS on every request.
(b) A live DoH probe confirms target.substack-custom-domains.com A = 104.18.36.24 and 172.64.151.232. These are shared Cloudflare anycast addresses.
(c) Fingerprint headers can be forged.

No TTL timing is even needed. runChecks() (:957) passes on a DoH query with type=CNAME alone. An attacker running the authoritative DNS can answer CNAME queries with the Substack target and A queries with their own IP, so a fresh check in any colo or isolate passes while the Worker connects to the attacker's server. The attacker only needs a valid certificate, e.g. a Let's Encrypt wildcard.

Impact is limited: the relay origin holds no cookies or secrets. A service worker cannot be planted because the relay never serves a JavaScript MIME type. What remains is phishing, defacement, and the Safe Browsing or Cloudflare-abuse risk to the app's only whitelisted origin. Medium stands.

**Fix notes.** 1. Primary fix. In relay.ts:154 add 'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'" to CORS_HEADERS. htmlResponse's PAGE_CSP passed via `extra` still overrides it for '/' and '/privacy', because extra is spread last in responseHeaders (:204). CSP has no effect on fetch() consumers.
2. Alternative or additional. Serve the feed (both :1200 and replay :1162) as 'text/plain; charset=utf-8'. The client tolerates this: api.ts:480 accepts any non-JSON content type, and feed.ts:195 parses with DOMParser 'application/xml' regardless. Update docs/relay.md line 20 and any relay.test.ts assertion on the XML type.
3. Optional defense in depth only. In the feed branch (:1198), require that the first element after an optional <?xml?> declaration and comments is <rss, and reject '<?xml-stylesheet'. This is not sufficient alone: XHTML- or SVG-namespaced <script> nested inside <rss> still runs in an XML document.
4. Do not rely on shortening VERDICT_PASS_MS. The split-answer DNS trick defeats even a fresh check, so custom-domain bodies must be treated as untrusted and made non-renderable.

### content:C3 (low, confirmed)

`src/substack/urls.ts:51`

**Summary.** UNSAFE_SCHEME_RE matches 'data:', 'file:', 'javascript:', 'vbscript:' and 'blob:' anywhere they follow a non-alphanumeric character. Ordinary words with a colon in share text or search text are therefore rejected as unsafe links, and the whole paste fails. The rule is unnecessary there: SCHEME_URL_RE plus the 'non-http' check already reject any real non-http scheme URL, and bare text is never fetched.

**Failure scenario.** The user pastes single-line share text 'Big Data: why the hype died https://foo.substack.com/p/big-data'. parseSubstackInput sees ' Data:' and returns invalid('That kind of link is not supported.'), so the valid link cannot be added. A search for 'JavaScript: weekly' or 'data: privacy' is refused the same way. In a multi-line paste, a title line 'Data: a primer' produces an extra error card.

**Suggested fix.** Only treat these as schemes when they form a URL-like token. Test the trimmed input with /^(?:javascript|vbscript|data|file|blob):/i (scheme at the very start), and test each whitespace-separated token with /^(?:javascript|vbscript|data|file|blob):\S/i. Do not test against arbitrary word boundaries. Keep the existing SCHEME_URL_RE 'notHttp' rejection.

**Skeptic's reasoning.** urls.ts:51 `/(?:^|[^a-z0-9+.-])(?:javascript|vbscript|data|file|blob):/i` matches ' Data:' in 'Big Data: why the hype died https://foo.substack.com/p/big-data' (a space is a non-alphanumeric character). parseSubstackInput:203 returns invalid(unsafe) before the URL is ever extracted, so a valid single-line share text is refused. Searches such as 'data: privacy' or 'JavaScript: weekly' are refused the same way, and a multi-line paste with a title line 'Data: a primer' gets an extra error card, because parseMany only drops kind 'search'. The rule adds no safety: pasted text is never fetched or navigated, and SCHEME_URL_RE plus the notHttp check already reject any non-http scheme URL. Low severity, because it needs a title or query containing one of these words immediately followed by a colon.

**Fix notes.** Smallest change that keeps every existing test in tests/unit/urls.test.ts:104-112 and :205 passing ('javascript:alert(1)', 'data:text/html,...', 'file:///etc/passwd', 'look javascript:alert(1)', 'javascript:x'): only match when a non-space character follows the colon. Change line 51 to `/(?:^|[^a-z0-9+.-])(?:javascript|vbscript|data|file|blob):(?=\S)/i`. Lookahead is safe on every WebView. Add tests: parseSubstackInput('Big Data: why the hype died https://foo.substack.com/p/big-data') gives the post, and parseSubstackInput('data: privacy') gives a search.

### content:C4 (low, confirmed)

`src/substack/urls.ts:246`

**Summary.** parseMany drops decoration lines only when they parse as kind 'search'. Lines that fail search validation still become entries and produce spurious error cards whenever the paste contains a link: a title over 100 characters, a 1-character line, a line containing 'Data:' (see C3), or a dotted word such as 'U.S.'. The SPEC says plain-text lines in a paste with a link are decoration.

**Failure scenario.** The user pastes share text: 'An A.I. legislator running a cost campaign\nManny Rutinel is one of the few politicians to have spent his career trying to govern A.I. In the race to represent Colorado…\nhttps://www.slowboring.com/p/an-ai-legislator-running-a-cost-campaign'. Result: the post card, plus an error card 'Search text is too long (100 characters at most).' for the description line. 'U.S.' on its own line gives 'That is not a valid web address.'

**Suggested fix.** In parseMany, when hasLink is true, process only lines that contain a scheme URL (HAS_SCHEME_RE) or start with '@'. Skip every other line, whatever kind it parses to. For example: if (hasLink && !HAS_SCHEME_RE.test(line) && !line.startsWith('@')) continue.

**Skeptic's reasoning.** parseMany (urls.ts:246) skips only `parsed.kind === 'search'` when hasLink. A decoration line over 100 characters becomes invalid(searchLong), a 1-character line becomes invalid(searchShort), 'U.S.' becomes invalid(host) because the TLD 's' fails HOST_RE, and 'Data: x' becomes invalid(unsafe) (see C3). addAll in src/phone/actions.ts:398 turns each of these into its own card, so error cards appear next to the valid post card. The valid entry is still processed, so this is cosmetic and confusing rather than blocking. The spec source is urls.ts's own doc comment ('plain-text lines are share-text decoration ... dropped'), not SPEC.md. The SUGGESTED FIX IS WRONG, though. Processing only lines that contain a scheme URL or start with '@' would also drop bare-domain lines, which would break the existing test at tests/unit/urls.test.ts:195. That test expects 'www.slowboring.com' to be kept from 'Great read\nhttps://foo.substack.com/p/my-slug\n\n@thezvi\r\nwww.slowboring.com...'.

**Fix notes.** In parseMany, when hasLink is true, skip only lines that would be treated as free text: `if (hasLink && !HAS_SCHEME_RE.test(line) && !line.startsWith('@') && (/\s/.test(line) || !line.includes('.'))) continue` (before or instead of the kind==='search' check). This drops long or short descriptions, titles and 'Data: x' lines, and keeps bare domains such as www.slowboring.com. A lone dotted token like 'U.S.' still yields an error card; that is acceptable, since it is indistinguishable from a mistyped domain. Add a test: a paste of a 120-character description line, a '!' line and a post URL yields only the post.

### content:C5 (low, confirmed)

`src/substack/html.ts:68`

**Summary.** Some fairly common symbols are missing from all four firmware fonts (checked against pretext's glyph tables and cn ranges) and have no NFKD decomposition, so the coverage fallback turns them into '[?]'. Affected: currency signs ₹ U+20B9, ₽ U+20BD, ₺ U+20BA, ₴ U+20B4, ₦ U+20A6, ₱ U+20B1, ₫ U+20AB, ₸ U+20B8, and ballot boxes ☐ U+2610 and ☒ U+2612. CHAR_MAP covers ☑ but not ☐ or ☒. Common characters such as quotes, dashes, superscripts, € £ ¥ ° ± → ≥, Polish and Turkish letters are all covered.

**Failure scenario.** An Indian or Ukrainian publication writes 'costs ₹500' or 'ціна 200 ₴', which appears on the glasses as 'costs [?]500' or 'ціна 200 [?]'. A to-do list '☐ Buy flour / ☒ Proof dough' renders as '[?] Buy flour / [?] Proof dough'.

**Suggested fix.** Add CHAR_MAP entries: '₹':'Rs', '₽':'RUB ', '₺':'TRY ', '₴':'UAH ', '₦':'NGN ', '₱':'PHP ', '₫':'VND ', '₸':'KZT ', '☐':'[ ]', '☒':'[x]'. Bump CONVERTER_VERSION, because cached reading offsets depend on the output text.

**Skeptic's reasoning.** Checked against node_modules/@evenrealities/pretext/dist/font_measure.js. getAdvW looks for the codepoint string as a key in each font's glyphs map, then in the cn font's ranges. None of 8377 (U+20B9), 8381, 8378, 8372, 8358, 8369, 8363, 8376, 9744 (U+2610) or 9746 (U+2612) appears as a glyph key in any font. The cn ranges skip them too: they jump 8208..8481 with no 836x-838x entries, and 9742-9743 then 9756, so U+2610 and U+2612 are not covered. U+20AC and U+20A9 are present. None of these characters has an NFKD decomposition, and none is a mark or pictograph. normalizeChars therefore emits the \u0000 marker, and the text becomes '[?]'. CHAR_MAP covers U+2611 but not U+2610 or U+2612. The same normalizeChars feeds titles through article.ts line(). Low severity: limited to specific currencies and checkbox lists.

**Fix notes.** Add \u-escaped entries to CHAR_MAP in html.ts, keeping the source ASCII-only: '₹': 'Rs ', '₽': 'RUB ', '₺': 'TRY ', '₴': 'UAH ', '₦': 'NGN ', '₱': 'PHP ', '₫': 'VND ', '₸': 'KZT ', '☐': '[ ]', '☒': '[x]'. A trailing space is safe: tidy/finish collapse doubles and trim line ends, and line() collapses \s+. Bump CONVERTER_VERSION to 2, because articleVersion embeds it and stored offsets must not be reused for changed text. Add a normalizeChars test that uses the production isCovered.

### content:C6 (low, confirmed)

`src/substack/types.ts:20`

**Summary.** PUBLIC_HOST_RE, which urls.ts uses as HOST_RE and the relay also uses, requires an all-letter TLD ([a-z]{2,63}). It therefore rejects every IDN TLD after URL punycoding (.рф → xn--p1ai, .中国 → xn--fiqs8s, .みんな → xn--q9jyb4c). The SPEC promises 'punycode via URL', but those hosts can never be added or fetched.

**Failure scenario.** A user pastes https://пример.рф/p/post (a Substack custom domain on a Cyrillic TLD). new URL gives hostname 'xn--e1afmkfd.xn--p1ai', and HOST_RE fails on the TLD 'xn--p1ai'. The result is invalid('That is not a valid web address.'). normalizeHost returns null, so requireHost and pubMetaFrom reject the host too.

**Suggested fix.** Allow punycode TLDs: /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/. The relay shares this constant, so both sides change together.

**Skeptic's reasoning.** PUBLIC_HOST_RE (types.ts:20) ends in `[a-z]{2,63}$`, so a punycode TLD such as 'xn--p1ai' fails. normalizeHost, hostProblem/parseUrl, pubMetaFrom and the relay's isPublicationHost (relay.ts:263) all reject hosts like 'xn--e1afmkfd.xn--p1ai'. IDN labels below the TLD do pass, so 'bücher.de' works. Note that SPEC.md:652 literally specifies this HOST_RE, so the regex follows the spec text but contradicts the 'punycode via URL' intent. Real-world impact is very small: Substack custom domains on IDN TLDs are very rare. Low.

**Fix notes.** Update the shared constant in src/substack/types.ts (the phone and the relay change together): `/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/`. RESERVED_TLDS and BLOCKED_TLD_RE need no change. Add urls and relay tests: 'https://пример.рф/p/post' gives the post on host 'xn--e1afmkfd.xn--p1ai', and 'foo.xn--' is still rejected.

### glasses:G5 (low, confirmed)

`src/app/controller.ts:413`

**Summary.** loadLatest writes latestCache even when the load was cancelled. Fetches aborted by Back count as 'failed', so a partial merged list is cached for 5 minutes.

**Failure scenario.** The user opens Latest with 6 publications. Two archives have loaded when the user double-taps to cancel. cancel() aborts the signal, the remaining fetches reject with ABORTED or 'Cancelled.', and failed = 4 is less than 6, so latestCache = {items from 2 pubs, failed: 4}. The user reopens Latest within 5 minutes, and loadLatest(force=false) returns the cached partial list with the footer '· 4 failed'. Posts from 4 healthy publications are missing until the user finds Refresh in the contextual menu.

**Suggested fix.** After settleAll, if signal.aborted, throw without touching latestCache. Optionally, also skip caching or shorten the TTL when failed > 0, so a transient failure does not stay for 5 minutes.

**Skeptic's reasoning.** onPosts back -> cancel() (controller.ts:234-238) aborts the signal. In settleAll, queued tasks reject with 'Cancelled.' (controller.ts:404) and in-flight getArchive calls reject with ApiError('ABORTED') (api.ts:406). ABORTED is not in FEED_FALLBACK_CODES, so fetchArchive rethrows. With 2 of 6 loaded, failed = 4 < 6, so the code does not throw at line 419 and latestCache is set to the partial list (line 428). loadPosts then drops the result through `gen !== generation` (line 443), but the cache is already written. Reopening Latest within 5 minutes runs openPosts -> loadPosts 'initial' -> loadLatest(force = false), which returns the cached partial list with the footer '· 4 failed' (frames.ts:231). Only menu Refresh (force = true) recovers. The same partial cache is written when a new begin() supersedes the load.

**Fix notes.** In loadLatest, directly after `const results = await settleAll(...)`, add `if (signal.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'ABORTED' })`, before any rehost() or latestCache write. loadPosts' catch already ignores it because gen !== generation. Optionally, skip the cache write or give it a shorter TTL (for example 30 s) when failed > 0, so transient failures do not stick for 5 minutes.

### glasses:G6 (low, confirmed)

`src/app/controller.ts:682`

**Summary.** When a Refresh of an already loaded posts list fails or is cancelled, double-tap pops the whole list and its loaded older pages. Tap-retry then reloads in 'initial' mode, so the selected post is not kept. Only failed 'older' loads are restored to the loaded list.

**Failure scenario.** The user is in a publication list with 4 archive pages loaded and the cursor on post 30, and picks Refresh from the menu (loadPosts 'refresh', view.older = false). The network fails, so the error frame shows 'Tap retry · 2×tap back'. Double-tap: view.older is false, so pop() returns to Publications and the loaded list and position are gone. If the user taps retry instead, loadPosts(view, 'initial') runs with keep = null, so the cursor no longer tracks the post that was selected.

**Suggested fix.** Record the mode of the pending load, for example view.pendingMode = mode, and treat a 'refresh' of a list that has items like 'older': on cancel or error, Back restores state 'ready' with the old items, and retry calls loadPosts(view, view.pendingMode) so the selection key is kept.

**Skeptic's reasoning.** loadPosts sets view.older = (mode === 'older') (controller.ts:435), so a 'refresh' of a loaded list leaves older false. During the refresh the frame is loadingFrame with footer '2×tap cancel' (frames.ts:70-71, 214). Back during loading or error checks `view.older && view.items.length` (controller.ts:698); that is false, so pop() discards the list, its loaded older pages and the cursor. The items are never cleared during a refresh, so restoring them would be trivial. Tap-retry (line 710) and the phone's retry() (line 868) both call loadPosts(view, 'initial'), so keep is null and selectKey keeps only the numeric index. If new posts arrived at the top, the cursor lands on a different post. Menu Refresh in the error state (line 793) does keep the key, which is inconsistent. Note: SPEC line 821 says loading/error back = 'cancel and pop', so this is literally per spec. But the code already makes an exception for 'older' for the same reason, and the 'cancel' footer suggests the list would come back, so it is a low-severity UX inconsistency, not a spec violation.

**Fix notes.** Replace the boolean with `pendingMode?: 'initial' | 'older' | 'refresh'` on PostsState, set in loadPosts (`view.pendingMode = mode`) and cleared on success. In onPosts back/hold, restore the loaded list when `view.state !== 'ready' && view.pendingMode !== 'initial' && view.items.length`: state 'ready', error null, pendingMode undefined, then draw. Retry everywhere (onPosts error select, controller.retry, menu 5 in the error state) with `loadPosts(view, view.pendingMode ?? 'initial')`, so 'refresh' keeps the selection key and 'older' appends. postsFrame needs no change.

### glasses:G7 (low, confirmed)

`src/app/controller.ts:603`

**Summary.** On the last loaded post, 'Next post' (end-card tap or menu item 3) shows 'No more posts.' even when the list still has a 'Load older posts…' row (nextOffset !== null).

**Failure scenario.** A publication list shows 12 posts plus 'Load older posts…'. The user reads post 12 to the end card and taps for the next post. list.items[index+1] is undefined, so the glasses say 'No more posts.' although the archive has more. The user has to go back, tap Load older, then open the next post by hand.

**Suggested fix.** In nextPost, if there is no next item and list.kind === 'posts' && list.nextOffset !== null, show a Loading frame, fetch the next archive page into the list (the same merge as loadPosts 'older'), then open its first new item with replace: true. At minimum, show a hint such as 'Load older posts in the list' instead of 'No more posts.'

**Skeptic's reasoning.** nextPost (controller.ts:608-620) looks only at list.items[index+1] and otherwise shows TEXT.noMorePosts. By correction C1, a publication list's nextOffset stays non-null until an empty page arrives (controller.ts:357; api.ts:272), so nearly every freshly opened publication list has a 'Load older posts…' row. On its last loaded post, the end-card tap or menu 3 says 'No more posts.' although more exist. The unit test at controller.test.ts:362-393 asserts this for a list built with archiveReply(nextOffset = 2), so the behavior is enshrined, not accidental. SPEC line 820 allows 'or show No more posts', so this is misleading wording or a missing feature, not a crash.

**Fix notes.** Minimal fix: in nextPost, when there is no next item and `list?.kind === 'posts' && list.nextOffset !== null`, set transient = { body: 'End of loaded posts.\nGo back and tap\nLoad older posts.', footer: TEXT.backFooter } instead of noMorePosts, and update the test. Fuller fix: run a new async helper with begin(): show a loading frame (replaceTop with a loading reader placeholder, or a transient 'Loading…'), fetchArchive(list.source.host, list.nextOffset, …), merge the new items into list.items exactly as loadPosts 'older' does (dedupe by refKey, update nextOffset), check gen, then openReader(firstNew, { replace: true }), or show noMorePosts if the page was empty.

### glasses:G8 (low, confirmed)

`src/main.ts:82`

**Summary.** The first glasses frame (initialPage) and the first redraw come only from the browser localStorage mirror. Bridge storage, the source of truth, is applied only after attachBridge has also written both documents back. On launches where the mirror is empty, the glasses first show the first-run setup frame.

**Failure scenario.** On Android the .ehpk WebView loses localStorage, which research/02 calls unreliable. On every launch, controller.current() is firstRunFrame ('No publications yet. On your phone, open Reader for Substack…'), and the start-up container is created with it. The correct Home or resumed reader appears only after 2 bridge reads, 2 bridge writes of up to 48k chars each, configurationChanged() and start(). A reviewer or user who relaunches sees the setup frame first, which looks like a violation of 'Setup remembered across launches'.

**Suggested fix.** Read bridge storage before createStartUpPageContainer: after waitForEvenAppBridge, call bridge.getLocalStorage for both keys, for example through an opts.beforeCreate(storage) hook in connectGlasses, apply them to the store, and build initialPage from the merged state. Alternatively, call controller.configurationChanged() as soon as the remote documents are applied, before the write-back flush in attachBridge.

**Skeptic's reasoning.** main.ts:33 loads only browserKV. main.ts:82 sends controller.current() as initialPage. With frame still null, current() returns frameFor(home), which is firstRunFrame when isFirstRun(state) (no publications and nothing saved, frames.ts:130-132). The correct frame comes only after attachBridge, which does 2 queued bridge reads plus an awaited flush of 2 bridge writes (storage.ts:476-501), then configurationChanged() and start() (main.ts:101-103). So whenever the mirror is empty, the first-run setup text is shown briefly. Gestures meanwhile are ignored by onHome's isFirstRun guard, so this is cosmetic. The duration is unverified: research/02 notes bridge storage probably lives on the phone, so it is likely well under a second unless G1's stall occurs. The 'store-review violation' framing is overstated, but the flash is real and the write-back needlessly delays the correct frame. During that window the phone UI also looks empty, which invites the pre-attach edit that causes data loss (see G2).

**Fix notes.** Prefer not reading bridge storage before createStartUpPageContainer, which the SDK says must be called at startup. Instead split attachBridge: add an option `onApplied?(changed: boolean)` and call it right after the remote documents are applied, before the write-back flush() is started. In main.ts pass onApplied: changed => { if (changed) controller.configurationChanged() }. The render is then enqueued before the storage writes. Together with G2 step 4 (skip pointless write-back), the correct Home or resumed frame appears after just the 2 reads.

### phone:P4 (low, confirmed)

`src/storage.ts:214`

**Summary.** Within the allowed limits (100 publications, 100 saved posts) the prefs document can exceed MAX_KEY_CHARS. serializePrefs then returns null, no prefs write happens again, but the add flows still report success.

**Failure scenario.** Typical entries: a Publication is about 115 characters, and a saved PostRef with 80-character title and slug, host and ISO date is about 350. That gives about 11.5k + 35k + settings, or roughly 47-49k, at full limits. At the per-field caps (title 200, slug 200, host 253) the saved list alone reaches about 95k. When the 100th save tips it over, the phone shows 'Saved. Open Saved on the glasses to read it.' writeDirty clears the dirty flag and gives up ('retrying cannot help'). From then on, settings changes, reorders and follows stay in memory only and are lost when the app closes. The only prompt is a generic 'Could not save' alert.

**Suggested fix.** Check size before adding. In addSaved and addPublication (or their callers in actions.ts and in the controller's menu Save for later), dry-run serializePrefs on the state with the new item. If it would exceed MAX_KEY_CHARS, return 'full' with 'Storage is full - remove a saved post first.' Also lower the stored caps for PostRef title and slug (for example 120) to leave headroom.

**Skeptic's reasoning.** serializePrefs (storage.ts:214-218) returns null above 48,000 chars, and the prefs document has no eviction (by design in SPEC 3.5). writeDirty clears dirty.prefs and records failure (424-427), and every later save() fails the same way while the state stays oversized. I checked the arithmetic. A typical PostRef serializes to about 320-450 chars (key overhead about 190 chars plus host, slug, title, pubName and an ISO date), and a Publication to about 115-120. 100 saved posts with long-ish titles and slugs (about 450 each) plus 30 publications is about 49k, which exceeds the cap while staying inside LIMITS (100/100). addSaved (556-563), addPublication (574-581) and the glasses menu 'Save for later' (controller.ts:763-772) do not check size, so they report 'Saved…'/'Saved for later'. I downgraded to low for two reasons. It needs near-maximum usage. And the phone does show the 'Could not save. Your latest changes are kept until the app closes.' alert (view.ts:173-174) about 800 ms later, so the user is warned, though not told why or how to fix it.

**Fix notes.** In storage.ts, add a size guard to the add helpers. In addSaved, after `state.saved.push(valid)`: `if (serializePrefs(state, Number.MAX_SAFE_INTEGER) === null) { state.saved.pop(); return 'full' }`. Do the same in addPublication with state.publications.pop(). Use a 16-digit stamp so the measurement is an upper bound. Distinguish the message by adding an AddResult 'tooLarge', or by reusing 'full' with new texts. Phone toggleSaved: 'Storage is full. Remove some saved posts first.' followText: 'Storage is full. Remove a publication or saved post first.' Controller menu hint: 'Saved list is full'. Optionally also lower TITLE_MAX for PostRef to 120 and store slugs up to 120, to leave headroom.

### phone:P5 (low, confirmed)

`src/main.ts:82`

**Summary.** The first glasses frame is built from state loaded from localStorage alone. If localStorage was not persisted, every launch opens on the first-run screen ('No publications yet... add a publication'), and Home input is ignored until the bridge reads finish.

**Failure scenario.** A user with 20 followed publications launches from the glasses. store.load(browserKV()) returns empty, so the initialPage is firstRunFrame() telling them to add a publication on the phone. onHome ignores taps and swipes because isFirstRun is true. The real Home appears only after the page is created, both bridge reads complete and configurationChanged() runs. If P1 or P3 happens, the misleading screen stays.

**Suggested fix.** If the local load found no documents (savedAt 0 for both), create the startup page with a neutral 'Loading your library...' frame instead of firstRunFrame. That still satisfies the no-black-screen rule. Switch to Home after attachBridge, or after a short timeout. Alternatively, do a bounded (≤500 ms) bridge read before createStartUpPageContainer.

**Skeptic's reasoning.** main.ts:82 passes controller.current(), which is computed from the state loaded from localStorage only. With empty localStorage, frameFor returns firstRunFrame ('No publications yet. On your phone, open … and add a publication.'), and onHome ignores everything except double-tap while isFirstRun is true (controller.ts:653). The real Home appears after attachBridge returns true and configurationChanged() redraws, or when start() draws. On a healthy device this is a transient misleading frame lasting a fraction of a second. It persists only if the attach never completes (P1/P3). It only matters when localStorage was not persisted, which the spec flags as a device risk, so severity is low.

**Fix notes.** In storage.ts, expose `loadedEmpty(): boolean`, true when load() found neither document (docs.prefs.value === null && docs.progress.value === null). In frames.ts add `loadingLibraryFrame()` = messageFrame(APP_NAME, 'Loading your library…', TEXT.exitFooter). In main.ts pass `initialPage: store.loadedEmpty() ? loadingLibraryFrame() : controller.current()`. controller.start(), which runs after the attach, then draws the real Home or first-run frame. If no attach happens (create failed), nothing is shown on the glasses anyway.

### phone:P6 (low, confirmed)

`src/app/controller.ts:832`

**Summary.** After a phone edit, configurationChanged only clamps the glasses Home and Publications cursors by index. Removing or reordering publications, hiding Home items, or clearing reading (which removes 'Continue') moves the cursor onto a different item.

**Failure scenario.** On the glasses Publications list the cursor is on 'Slow Boring' (index 4). On the phone the user removes the publication at index 1, or moves one above it. changed('prefs') -> configurationChanged keeps sel = 4, which is now a different publication, and the next tap opens the wrong archive. The same happens on Home after 'Clear reading history' drops the Continue row: the cursor shifts to the next entry.

**Suggested fix.** Before the change, record the selected item's identity: the host for the publications view, the HomeEntry id for Home. After the state changes, re-select by identity (as selectKey already does for posts views), and clamp only when that item no longer exists.

**Skeptic's reasoning.** This is partly refuted. The Home claim is false: syncHome (controller.ts:244-251) tracks the selected entry by id (homeSelId), which onHome updates on every move. After 'Clear reading history' drops Continue, the cursor stays on the same entry (for example Latest moves from index 1 to 0), and it clamps only when the selected entry itself disappears. The Publications view is index-based: configurationChanged only does `view.sel = clampIndex(view.sel, state.publications.length)` (line 849), and nothing re-syncs a non-top publications view when it is popped back to. Removing or reordering a publication above the cursor therefore moves the highlight to a different publication. The glasses redraw immediately, so the user sees the moved cursor before tapping, which keeps this low.

**Fix notes.** Mirror the homeSelId approach for publications. Add `selHost?: string` to the publications view (or a module-level `pubSelHost`). Set it whenever onPublications changes sel, and when the view is pushed (state.publications[0]?.host). Add `syncPublications(view)`: `const i = view.selHost ? state.publications.findIndex(p => p.host === view.selHost) : -1; view.sel = i >= 0 ? i : clampIndex(view.sel, state.publications.length); view.selHost = state.publications[view.sel]?.host`. Call it from computeFrame for kind 'publications', as syncHome is called for home, and from configurationChanged in place of the bare clamp. In rehost(from, to), update selHost when it equals `from`.

### phone:P8 (low, confirmed)

`src/phone/actions.ts:377`

**Summary.** The C4 www retry applies only to 'publication' inputs. A post link typed with an apex custom domain fails, while the same domain works when added as a publication.

**Failure scenario.** The user types 'slowboring.com/p/some-post'. parseSubstackInput gives {kind:'post', host:'slowboring.com'}. getPost fails with HOST_NOT_SUBSTACK because the apex is not served by Substack, so the card says 'This address is not served by Substack.' Typing 'slowboring.com' alone succeeds through followHost's www retry.

**Suggested fix.** Wrap the post lookup like followHost: on HOST_NOT_SUBSTACK, if wwwAlternative(parsed.host) is non-null and ctx.live(), retry getPost({host: alternative, slug}) once. If the retry also fails, report the original error.

**Skeptic's reasoning.** parseSubstackInput('slowboring.com/p/some-post') has no space and contains a dot, so it goes through parseUrl('https://…'), then publicationPath, giving {kind:'post', host:'slowboring.com', slug}. processInput's 'post' case (actions.ts:375-379) calls api.getPost once with no www retry, while followHost (349-358) does retry. A curl probe confirms the apex is not Substack: https://slowboring.com/p/test returns 301 from 'Server: Caddy' with no x-served-by: Substack header. The relay therefore fails host verification or the fingerprint check (relay.ts:1106-1108/1184) with HOST_NOT_SUBSTACK, and the card shows 'This address is not served by Substack.' The impact is low because shared post links normally carry the www host.

**Fix notes.** In actions.ts processInput, case 'post' only (a postId has no host): `let result; try { result = await api.getPost({ host: parsed.host, slug: parsed.slug }, ctx.signal) } catch (err) { const alt = codeOf(err) === 'HOST_NOT_SUBSTACK' ? wwwAlternative(parsed.host) : null; if (!alt || !ctx.live()) throw err; try { result = await api.getPost({ host: alt, slug: parsed.slug }, ctx.signal) } catch { throw err } }`. Keep the existing postId branch unchanged. Factor the retry into a helper `withWwwRetry(host, call)` that followHost can share.

### phone:P9 (low, confirmed)

`src/substack/urls.ts:246`

**Summary.** parseMany drops every plain-text line, without any message, as soon as any line contains a link. A list that mixes links and names produces fewer result cards than lines and no feedback, which departs from 'one per non-empty line'.

**Failure scenario.** The user pastes 'https://astralcodexten.substack.com' and 'Matt Yglesias' on two lines. hasLink is true, so the search line is skipped: only one card appears, and the second entry is silently ignored. The user assumes the search found nothing or that it was added.

**Suggested fix.** Keep the share-text heuristic only for short blobs, for example when the text lines sit next to the single link and the paste has 3 lines or fewer. Otherwise parse every line. Or add an 'info' card per skipped line ('Skipped "Matt Yglesias" (looks like share text); add it on its own line to search').

**Skeptic's reasoning.** parseMany (urls.ts:241-246) sets hasLink when any line contains scheme://, then silently skips every line that parses as 'search', adding no card. Pasting 'https://astralcodexten.substack.com' and 'Matt Yglesias' on two lines yields one card, and nothing on the phone mentions the second line. This is a deliberate share-text heuristic, tested in tests/unit/urls.test.ts:194-199 ('share-text titles dropped'), but it departs from SPEC 3.6's 'one per non-empty line' and gives no feedback. Impact is minor UX.

**Fix notes.** Keep the heuristic, but make it visible and narrower. (1) Apply it only to share-text-shaped pastes: exactly one line contains a link and there are at most 3 non-empty lines. Otherwise parse every line, including searches. (2) When lines are skipped, have parseMany return them, for example a new ParsedInput kind `{ kind: 'skipped'; text: string }` with resultKey null. In processInput, map it to `{ id, kind: 'message', label: text.slice(0, 60), text: 'Skipped (looks like share text). Put it on its own line to search.', tone: 'info' }`. Update urls.test.ts:194-199 to match.

### relay:S2 (low, confirmed)

`worker/relay.ts:1232`

**Summary.** /v1/health?probe=1 is public and uncached. Each call makes 3 Substack requests (on.substack.com archive, slowboring.com archive, substack.com top/search) from the shared Worker egress, limited only by the general 60/min per IP per route limiter.

**Failure scenario.** One client loops GET /v1/health?probe=1 at 60/min, which drives 180 uncached Substack requests per minute from this relay's zone. A handful of IPs or a botnet scales this linearly. Substack is known to 429 or 403 datacenter and Worker traffic, and can single out this zone through the CF-Worker header (research 06 §1.3). Once it does, every real user's archive, post, profile and search calls fail with UPSTREAM_RATE_LIMITED or UPSTREAM_BLOCKED, even though those routes are otherwise edge-cached.

**Suggested fix.** Memoize the probe result per isolate for 60-300 s (store {probes, at} and reuse it while it is fresh), and optionally put it in caches.default under a synthetic key. Give probe=1 its own much stricter limit, e.g. a separate route key with 3/min in the local bucket and a check before the binding. Alternatively, run probes only when a deploy-time secret query token matches an env var. The diagnostics panel can still show the cached result.

**Skeptic's reasoning.** Each call to health() (:1229) with probe=1 makes 3 uncached upstream GETs (:1233). It sits behind only rateLimit('health'), which is 60/min per IP per colo through RL (wrangler.toml simple limit=60, period=60) or the per-isolate bucket. So 180 Substack requests/min per IP is real.

The finding's premise that the other routes are 'otherwise edge-cached' is weak, though:
- Every other route can be cache-busted. A unique offset, q, slug or handle is a guaranteed cache miss, so each route already allows 60 upstream requests/min per IP.
- On the default workers.dev deployment, docs/relay.md:84 itself says the Cache API is only best-effort.
probe=1 therefore triples the per-route rate but opens no new abuse class. The probe is spec-mandated: the Diagnostics button (actions.ts:721) and the deploy workflow use it. Low.

**Fix notes.** In createRelay, memoise the probe result and the in-flight probe per isolate: `let probeMemo: { at: number; probes: HealthProbe[] } | null` plus a pending promise. At :1232, reuse the result while now() - at < 60_000 (up to 300 s is fine). This caps Substack traffic at 3 requests per isolate per window, whatever the request rate.

Optionally, also call rateLimit('health-probe', ...) with a lower budget. takeToken (:826) currently uses one global perMinute, so it would need a capacity parameter to support that. No client change is needed; actions.ts:721 shows whatever comes back.

### relay:S3 (low, confirmed)

`worker/relay.ts:957`

**Summary.** A custom domain that does not exist (NXDOMAIN), or exists but does not answer HTTPS, is reported as 503 UPSTREAM_UNAVAILABLE ('Substack is temporarily unavailable.') instead of HOST_NOT_SUBSTACK, and the verdict is never cached. Here dohQuery returns [] for Status 3, so flatteningCheck returns 'fail', but mappingProof then fetches https://<host>/api/v1/archive. That fetch throws, or the Worker gets a 530/1016 response, and both paths become 'unknown', so runChecks returns 'unknown'.

**Failure scenario.** A user adds the typo 'www.slowbornig.com'. The relay runs a CNAME lookup, A/AAAA lookups, and a fetch that fails on DNS, then answers 503 'Substack is temporarily unavailable.' Because the code is UPSTREAM_UNAVAILABLE, the client's FEED_FALLBACK_CODES (controller.ts:110) immediately retry /v1/feed, which reruns every lookup and returns 503 again. The user is told to retry later and never learns the address is wrong. phone/actions.ts followHost also skips its www. retry because that only triggers on HOST_NOT_SUBSTACK. A followed publication whose custom domain lapsed burns about 8 subrequests per Latest refresh, indefinitely.

**Suggested fix.** In runChecks, when the CNAME, A and AAAA answers were all definitive (not null) and A plus AAAA contain no addresses, return 'fail' without running mappingProof, because a host with no addresses cannot be served by anyone. More generally, when DNS answered definitively and pointed away from Substack, treat a network error or 530 in mappingProof's first fetch as 'fail' rather than 'unknown', so it is cached for 1 h and reported as HOST_NOT_SUBSTACK.

**Skeptic's reasoning.** Traced for an NXDOMAIN host:
1. dohQuery returns [] for Status 3 (:877), so the CNAME result is not null and `unknown` stays false.
2. flatteningCheck gets a=[], aaaa=[] and a cached target list, finds no intersection, and returns 'fail' (:906).
3. mappingProof then fetches https://<host>/... (:915). A Worker fetch to an unresolvable host either throws, giving 'unknown' (:917), or returns a 52x/530 status, giving 'unknown' (:919).
4. runChecks returns 'unknown' (:968). That is not cached (:1027), and serve throws UPSTREAM_UNAVAILABLE (:1183).

On the client:
- followHost retries the www. variant only on HOST_NOT_SUBSTACK (actions.ts:355).
- controller.fetchArchive sends UPSTREAM_UNAVAILABLE to getFeed (controller.ts:110, :359).
- getFeed (main.ts:39) calls /v1/feed, which runs the whole uncached verification again and fails the same way.

So a typo'd custom domain shows 'Substack is temporarily unavailable', and a followed domain that has lapsed repeats about 2×4 subrequests on every refresh. The behaviour is wrong, but the error is recoverable and nothing is lost, so I rate it low rather than medium.

**Fix notes.** 1. Make flatteningCheck (:900) also report whether the host resolves, e.g. return { verdict, noAddresses: a !== null && aaaa !== null && addresses([...a, ...aaaa]).length === 0 }. DoH A/AAAA answers already follow CNAME chains, so empty means the Worker cannot connect either.
2. In runChecks (:962), if noAddresses is true and cname !== null, return 'fail' before mappingProof.
3. Optionally cache this case with a shorter TTL, e.g. 10 min instead of VERDICT_FAIL_MS, so a newly configured domain recovers quickly. That needs runChecks to return the TTL to verifyCustomDomain (:1028).
4. Result: the client gets 403 HOST_NOT_SUBSTACK, followHost tries the www. variant once, and the feed fallback is not triggered.

### relay:C1 (low, confirmed)

`worker/relay.ts:520`

**Summary.** Profile handles are forwarded and cache-keyed with their original case, but Substack's public_profile lookup is case-sensitive and lowercase. Verified live: /api/v1/user/thezvi/public_profile returns 200, while /api/v1/user/TheZvi/public_profile returns 404 {"error":"profile not found"}. Neither the relay (HANDLE_RE allows A-Z) nor the client (urls.ts parseHandle, api.ts getProfile) lowercases the handle.

**Failure scenario.** A user types '@TheZvi' (the add box has autocapitalize=none, so case is kept as typed) or pastes https://substack.com/@TheZvi. The relay requests /api/v1/user/TheZvi/public_profile, Substack returns 404, and the phone shows 'This Substack profile was not found.' for a profile that exists. Case variants also fragment the profile cache.

**Suggested fix.** In profilePlan, use const handle = (params.get('handle') ?? '').replace(/^@/, '').toLowerCase() before the HANDLE_RE test, the upstream URL and cacheKey. Lowercase in the client's parseHandle and getProfile as well.

**Skeptic's reasoning.** A live probe with the relay's User-Agent gave:
- substack.com/api/v1/user/TheZvi/public_profile: 404 application/json
- .../thezvi/public_profile: 200

No code path lowercases the handle:
- relay profilePlan (:520) only strips '@', and HANDLE_RE (:130) allows A-Z.
- client urls.ts parseHandle (:110-112), the substack.com/@X path (:144-145), and api.ts getProfile (:462) keep the original case.

So '@TheZvi', or a pasted substack.com/@TheZvi, gives PROFILE_NOT_FOUND for a profile that exists. The cache key (:533) is also case-split. All tests use lowercase handles.

**Fix notes.** 1. relay.ts:520: `const handle = (params.get('handle') ?? '').replace(/^@/, '').toLowerCase()`, applied before the HANDLE_RE test, href and cacheKey.
2. Client: in urls.ts parseHandle return `{ kind: 'handle', handle: handle.toLowerCase() }`, and in api.ts:462 lowercase `value` so client-side dedupe and the relay request agree.
3. Optionally add a relay test asserting that /v1/profile?handle=%40TheZvi requests /api/v1/user/thezvi/public_profile.

### relay:S5 (low, confirmed)

`worker/relay.ts:945`

**Summary.** mappingProof turns a Substack block into a cached 'fail'. A 403 or cf-mitigated challenge on the first fetch (line 923: status !== 200 leads to 'fail'), or on the S.substack.com check (line 945: not a redirect leads to 'fail'), is cached for 1 h as HOST_NOT_SUBSTACK. Research 06 §1.3 says datacenter egress to *.substack.com is often 403'd while custom domains get 200. blockedFailure deliberately reports the same 403s as UPSTREAM_BLOCKED on the main path.

**Failure scenario.** A real Substack custom domain whose DNS does not reveal Substack (for example, proxied through the publisher's own Cloudflare zone, so there is no visible CNAME and the IPs differ) can only pass the mapping proof. If Substack WAF-blocks the Worker on *.substack.com, the check fetch gets 403. The verdict 'fail' is cached for 1 h, and users get 403 HOST_NOT_SUBSTACK ('This address is not served by Substack') instead of UPSTREAM_BLOCKED, so the client's feed fallback (which keys on UPSTREAM_BLOCKED) never runs.

**Suggested fix.** In mappingProof, return 'unknown' (not cached) when either response is 401 or 403 or describe(response).challenge is true, matching the 429/5xx handling. In serve and nextHop, surface such an 'unknown' as UPSTREAM_BLOCKED rather than UPSTREAM_UNAVAILABLE when the cause was a block.

**Skeptic's reasoning.** In mappingProof:
- The first fetch treats only 429 and >=500 as 'unknown' (:919). Any other non-200, including 403 and a cf-mitigated challenge, becomes 'fail' (:923).
- The S.substack.com check likewise turns a 403 into 'fail', because 403 is not a redirect (:945).
- verifyCustomDomain then caches the 'fail' for 1 h (:1028), and serve reports HOST_NOT_SUBSTACK (:1184).

This contradicts SPEC line 1063 ('Never cache 403, 429 or 5xx') and the blockedFailure policy on the main path (:818).

The finding overstates one consequence. The feed fallback could not rescue this case anyway: getFeed (main.ts:39) calls /v1/feed, which runs the same hostVerdict, and rss2json is not part of getFeed. The real harms are the wrong error code and a failure that sticks for 1 h after the block lifts. It only affects custom domains whose DNS hides Substack, during a *.substack.com block. Low.

**Fix notes.** 1. In mappingProof, at :919 and :943, treat `status === 401 || status === 403 || describe(resp).challenge` like 429/5xx and return 'unknown', so it is not cached.
2. To show the correct code, have runChecks and verifyCustomDomain carry a reason, e.g. return { verdict: 'unknown', blocked: RelayUpstreamInfo }. Then serve (:1183) and nextHop (:1068) can throw RelayFailure('UPSTREAM_BLOCKED', { upstream }) instead of UPSTREAM_UNAVAILABLE.
3. Add a relay test: mapping proof where the S.substack.com check gets 403 should give 503 UPSTREAM_BLOCKED, and the verdict should not be stored.

### relay:C2 (low, confirmed)

`worker/relay.ts:454`

**Summary.** ArchivePage.publication is found only through publishedBylines[].publicationUsers[].publication with id === publication_id. Verified live on on.substack.com (publication_id 1): none of the 3 archive items has a byline publication with id 1 (staff and guest bylines have no publicationUsers, or have other publications), so publication is null. phone/actions.ts followHost requests limit:1, which leaves a single item to match.

**Failure scenario.** A user adds on.substack.com, or any publication whose latest post is a guest post or has a staff byline. The relay returns publication:null, and followHost stores name = result.host. The publication then appears as 'on.substack.com' instead of 'On Substack' in the phone list, on the glasses Publications menu and in post metadata, and stays that way because the name is saved at add time.

**Suggested fix.** In followHost, request ARCHIVE_PAGE_SIZE items instead of 1 so more bylines can match. When publication is still null, resolve it from the first post's id through /v1/post?id=<id>; the by-id response carries publication{name, base_url}, verified live: 'On Substack'. In the relay, also accept a byline publication whose computed host equals finalHost when no id match exists.

**Skeptic's reasoning.** A live probe of on.substack.com/api/v1/archive?limit=3 showed:
- All items have publication_id 1.
- Item 1 has no bylines.
- Items 2 and 3 have bylines whose publicationUsers are either null or name publication 4210070 (arielleswedback).
- Archive items have no other publication field.

So bylinePublication (:359) finds nothing and archive `publication` is null.

followHost (actions.ts:351) asks for limit:1 and stores `name = pub?.name || result.host` (:361). The stored name is never refreshed: controller.fetchArchive (controller.ts:349) uses the archive name only for post refs, and loadBrowse (actions.ts:538) updates only the transient browse state. The Publications list therefore permanently shows the host instead of 'On Substack'. The effect is cosmetic, so low.

**Fix notes.** 1. phone/actions.ts:351 and :356: request `limit: ARCHIVE_PAGE_SIZE` (already imported) instead of 1.
2. If result.page.publication is still null and result.page.posts[0] exists, call `api.getPost({ id: posts[0].id }, ctx.signal)`; PhoneApi includes getPost. Use `.publication?.name` when `.publication.host === result.host`. The by-id route returns a top-level publication, verified live for on.substack.com.
3. Optionally backfill: in controller.fetchArchive (controller.ts:349), when result.page.publication?.name exists and the stored publication's name equals its host, update the name and call store.save('prefs').

### relay:S6 (low, confirmed)

`worker/relay.ts:915`

**Summary.** Every syntactically valid non-substack.com host that fails the DNS checks reaches mappingProof, which makes the relay GET https://<arbitrary host>/api/v1/archive?sort=new&offset=0&limit=1. The fetch is blind, but the host is caller-chosen. Next, it GETs https://<S>.substack.com/... for an S named in the attacker's JSON. 'unknown' outcomes (5xx, 429, timeouts) are never cached, and wildcard DNS defeats the per-host 1 h 'fail' cache.

**Failure scenario.** An attacker cycles GET /v1/archive?host=<random>.victim.tld (wildcard DNS) and /v1/post and /v1/feed with the same hosts. Each request makes the relay send a GET to victim.tld plus 5 DoH lookups: up to 180 victim requests per minute per client IP across the three host routes, from Cloudflare's shared Worker egress, attributed to the relay's zone. The relay also churns the 2,000-entry verdict LRU, which evicts legitimate verdicts.

**Suggested fix.** Run mappingProof only when the host's A/AAAA answers are non-empty and fall in Cloudflare ranges (Substack is behind Cloudflare), or only when the client explicitly asked for a new publication (e.g. a 'verify=1' flag on the add flow, rate-limited separately at a few per minute). Cache 'unknown' mapping-proof results briefly (60 s) per host, and give verification its own rate-limit key (e.g. `${ip}:verify`) with a low budget.

**Skeptic's reasoning.** Any host that passes PUBLIC_HOST_RE, is not reserved or a blocked TLD, is outside *.substack.com and has no memoised verdict goes through 3 DoH lookups and then a blind GET to https://<host>/api/v1/archive?sort=new&offset=0&limit=1 (:915). 'unknown' is never cached (:1027), and with wildcard DNS every random label is a new host, so the 1 h fail cache does not help.

With 60/min per IP on each of /v1/archive, /v1/post?host=&slug= and /v1/feed, that is up to 180 GETs/min per IP to a victim domain, sent from Cloudflare egress and carrying the relay's CF-Worker zone attribution. It is 1:1 (no amplification), the path is fixed, and the response is not reflected, so impact is mostly abuse-report and reputation risk. The behaviour is inherent to spec C4(c). Low.

**Fix notes.** 1. Throttle cold verifications separately. In serve, before hostVerdict (:1182), detect a cache miss: no entry in `verdicts` and nothing from storedVerdict for a custom domain. In that case consume an extra token from key `${ip}:verify` with a small budget, e.g. 10/min. takeToken (:826) would need a capacity argument, or use a second RL binding in wrangler.toml.
2. Combined with the S3 fix (no A/AAAA addresses means 'fail' without mappingProof), NXDOMAIN wildcard abuse costs no outbound fetch.
3. Optionally cache 'unknown' from mappingProof for 60 s per host. Restricting the proof to Cloudflare IP ranges is brittle and not recommended.

### relay:S7 (low, confirmed)

`worker/relay.ts:846`

**Summary.** The rate-limit key uses the raw CF-Connecting-IP header. Cloudflare sets that header, but on the documented alternative hosts (Deno Deploy, Vercel; docs/relay.md:134) the client controls it, so each request can pick its own bucket. On Cloudflare, IPv6 clients get one bucket per /128, so a /64 provides effectively unlimited buckets.

**Failure scenario.** Deployed on Vercel or Deno after Substack blocks Cloudflare egress, a script sends 'CF-Connecting-IP: <random>' with each request. Every request gets a fresh 60/min bucket, so the limiter is a no-op, and the 10,000-entry map keeps evicting real users' buckets. On Cloudflare, an IPv6 client rotates addresses within its /64 to the same effect.

**Suggested fix.** Read CF-Connecting-IP only when request.cf exists (i.e. on Cloudflare); otherwise use the platform's trusted client-IP source, or one global bucket per route as the docs already describe. Normalize IPv6 keys to the /64 prefix before building `${client}:${route}`.

**Skeptic's reasoning.** rateLimit (:846) trusts CF-Connecting-IP unconditionally. On Cloudflare the edge sets that header, but on the documented alternative hosts, Deno Deploy and Vercel Edge (docs/relay.md:134), a client can send any value. Each request can then get a fresh bucket, which bypasses the local limiter.

The docs claim the opposite ('all clients share one rate-limit bucket per route'), so the documentation is also wrong. On Cloudflare, an IPv6 client is keyed per /128 and can rotate addresses within its /64 to get unlimited buckets, through both RL and the local bucket.

Eviction at MAX_BUCKETS only resets other users' buckets to full, so it loosens limits rather than denying anyone. This affects only abuse resistance, and mostly non-default hosts. Low.

**Fix notes.** In rateLimit (:846):
1. Read the header only when running on Cloudflare: `const onCf = typeof (request as { cf?: unknown }).cf === 'object' && (request as { cf?: unknown }).cf !== null`. Otherwise use 'unknown', which matches docs/relay.md:134.
2. If raw contains ':', expand '::' and key on the first four hextets, e.g. `${h1}:${h2}:${h3}:${h4}::/64`.
3. Add a test that 'CF-Connecting-IP' variations without request.cf share one bucket, and that two addresses in the same /64 share a bucket.

### relay:C3 (low, confirmed)

`worker/relay.ts:471`

**Summary.** /v1/post?id accepts any safe integer up to 16 digits, but Substack's by-id endpoint returns 400 {"errors":[{"param":"id","msg":"Invalid value"}]} for ids above 2147483647 (verified live: 2147483647 returns 404, 2147483648 returns 400). Upstream 400 falls through to the generic non-2xx branch (line 1121) and becomes 502 UPSTREAM_ERROR.

**Failure scenario.** A user pastes substack.com/home/post/p-99999999999 (a typo or a mangled share link). The relay answers 502 'Substack could not complete this request.' instead of 404 POST_NOT_FOUND or 400 INVALID_PARAM. The client treats it as a server failure and invites pointless retries.

**Suggested fix.** Cap ID_RE validation at 2147483647 in postPlan and in the client's POST_ID_RE/postIdOf, returning INVALID_PARAM. Or map an upstream 400 on the by-id template to POST_NOT_FOUND through the plan's notFound handler, extending the 404 branch to cover 400 for that plan.

**Skeptic's reasoning.** A live probe of substack.com/api/v1/posts/by-id/2147483648 returned HTTP 400 application/json with x-served-by: Substack and x-cluster: substack, body {"errors":[{"param":"id","msg":"Invalid value"}]}.

In fetchUpstream:
- blockedFailure returns null (not 403, 429 or 5xx).
- fingerprinted() is true.
- 400 is neither a redirect nor a 404.
- So the response hits the generic branch (:1121) and becomes 502 UPSTREAM_ERROR.

On the input side, relay ID_RE (:131) and client POST_ID_RE (urls.ts:61) both accept up to 16 digits, so a mistyped long p-<id> link reaches Substack. Real ids are about 2e8. The only effect is a misleading error on a typo, so low.

**Fix notes.** Preferred fix, future-proof: in fetchUpstream (:1117) also route `response.status === 400` to plan.notFound when the plan is the by-id template. Add a Plan flag, e.g. `badRequestIsNotFound: true`, set only in postPlan's id branch (:473), so the result is POST_NOT_FOUND (404, edge-cached 60 s).

Alternative: reject ids above 2147483647 with INVALID_PARAM in postPlan (:471), and in urls.ts postIdOf (:122) with invalid(INVALID_REASONS.postId). Note this hard-codes Substack's current int32 limit.

### relay:S8 (low, confirmed)

`.github/workflows/deploy-relay.yml:67`

**Summary.** The deploy step runs 'pnpm dlx wrangler@4.148.0' with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment. dlx resolves wrangler's transitive dependency tree fresh on every run, outside pnpm-lock.yaml, so a compromised or yanked transitive release runs with an account token that can rewrite the relay.

**Failure scenario.** A malicious patch release of one of wrangler's non-exact transitive dependencies is published. The next manual 'Deploy relay' run installs it during pnpm dlx and it reads CLOUDFLARE_API_TOKEN. The attacker can then deploy their own Worker as substack-reader-relay and serve forged content to every app user, since the relay origin is the app's only whitelisted host.

**Suggested fix.** Add wrangler@4.148.0 as an exact devDependency so it is locked in pnpm-lock.yaml and installed by the existing 'pnpm install --frozen-lockfile'. Then deploy with 'pnpm exec wrangler deploy --var "REVISION:${GITHUB_SHA::7}"'. Scope the token to Workers Scripts:Edit on this one account only, and consider a GitHub environment with required reviewers for the secrets.

**Skeptic's reasoning.** deploy-relay.yml:67 runs `pnpm dlx wrangler@4.148.0 deploy` with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment. wrangler is not in package.json devDependencies and does not appear in pnpm-lock.yaml (grep finds nothing). dlx therefore resolves wrangler's dependency tree fresh on every run, outside the frozen lockfile. That tree includes range-pinned dependencies (unenv's defu/pathe/ohash/ufo, and miniflare's undici/sharp), and some of them load while wrangler bundles the Worker.

A compromised transitive release would run with the deploy token. docs/relay.md:115 and :124-125 describe the same dlx usage. This is a supply-chain hardening issue on a manually triggered workflow, not a runtime bug. Low.

**Fix notes.** 1. Add "wrangler": "4.148.0" (exact) to devDependencies and regenerate pnpm-lock.yaml.
2. Change deploy-relay.yml:67 to `pnpm exec wrangler deploy --var "REVISION:${GITHUB_SHA::7}"`, and update docs/relay.md lines 115 and 124-125.
3. If adding workerd (about 100 MB) to every CI install is unwanted, use a separate deploy/package.json with its own lockfile instead, installed with --frozen-lockfile only in deploy-relay.yml.
4. Scope the token to Workers Scripts:Edit on this one account, and consider a protected GitHub environment for the secrets.

### content:C2 (medium, uncertain)

`src/substack/html.ts:176`

**Summary.** latexToText uses a regex lookbehind literal, /(?<!\\)&/g. Its build target is es2022 (vite.config.ts), so esbuild does not lower it. WKWebView before iOS 16.4 (Safari 16.4) rejects lookbehind at parse time. The research notes this ('iOS 16.4+ for lookbehind'), but nothing enforces a minimum. Because html.ts is statically imported (main.ts -> article.ts -> html.ts), the failure is a SyntaxError for the whole bundle, not just for LaTeX posts. The Even app's minimum iOS is unknown, so this is plausible rather than confirmed.

**Failure scenario.** A user on iOS 15.x or 16.0–16.3 opens the plugin. JavaScriptCore throws SyntaxError: Invalid regular expression: invalid group specifier name while parsing the main chunk. No module runs: the phone page stays blank, the glasses container is never created, and the app looks dead. Nothing in-app shows an error.

**Suggested fix.** Avoid lookbehind. For example, protect escaped ampersands with a sentinel first: s = s.replace(/\\&/g, '\u0003').replace(/&/g, ' ') at line 176, then restore '\u0003' to '&' next to the existing '\u0001'/'\u0002' restores. Alternatively use s.replace(/(^|[^\\])&/g, '$1 ') applied twice for adjacent '&&'. Optionally add a CI grep that fails on '(?<' in src/.

**Skeptic's reasoning.** The premise checks out. html.ts:176 uses the regex literal `/(?<!\\)&/g`. vite.config.ts sets build.target 'es2022', and lookbehind is ES2018, so esbuild treats it as supported and emits it unchanged. dist/assets/index-BwmGSupr.js (a single chunk) contains `.replace(/(?<!\\)&/g," ")` inside function X5. On a JavaScriptCore without lookbehind (Safari/WKWebView before 16.4), the whole chunk fails to parse and nothing runs. Android Chromium WebViews are unaffected. No other ES2022-only syntax was found in the bundle (no class static blocks), so this literal is probably the only parse-level blocker for iOS 15 / 16.0-16.3. Whether real users are affected depends on the Even Realities iOS app's minimum iOS version. Neither the research nor the SDK states it (only minAppVersion 2.2.10), and the device/App Store requirement cannot be verified here. If the app supports iOS 15, the result is a blank plugin with no error, so medium. If it requires iOS 16.4 or later, there is no impact.

**Fix notes.** Replace the lookbehind with a single-pass equivalent at html.ts:176: `.replace(/\\?&/g, m => (m === '&' ? ' ' : m))`. A bare & becomes a space and `\&` is left as-is, so the existing line 177 `\\([%$&_#])` still turns it into '&'. The semantics match `(?<!\\)&`, including adjacent '&&' and the earlier `\\\\`->'; ' step. No sentinel or restore step is needed. Optionally add a CI check (in scripts/pack.mjs or the ui-ci script) that fails when the built dist/assets/*.js matches /\(\?<[=!]/. Named groups `(?<name>` are fine and should not be blocked. No CONVERTER_VERSION bump is needed, since the output is identical.

### phone:P3 (medium, uncertain)

`src/glasses.ts:317`

**Summary.** Bridge storage get and set calls run in the same serialized queue as screen writes, with no timeout. If the host never answers one storage call, all later glasses renders stall, and so does controller.start() (main awaits attachBridge before start).

**Failure scenario.** The SDK bundle has a single setTimeout (the bridge-ready re-check) and no call timeout. If the host never resolves getLocalStorage (older host, host busy, dropped callHandler reply), the enqueue chain never settles. Every later render (swipe, tap, menu) queues behind it, so the glasses stay frozen on the startup frame. main.ts:101 never gets past attachBridge, so controller.start() and launch-from-glasses-menu resume never run, and every store flush through the bridge also hangs.

**Suggested fix.** Race each storage operation inside the queue against a timeout (about 2-3 s). On timeout, resolve with a read failure, which feeds P2's handling, or with false for set. Alternatively, run storage calls on their own queue instead of the screen queue. In main.ts, do not block controller.start() on attachBridge: start right away and call configurationChanged() when the attach finishes.

**Skeptic's reasoning.** The code facts hold. enqueue (glasses.ts:190-201) chains every operation on one promise with no timeout. storageGet/storageSet use that queue (317-327), as SPEC 3.1 item 7 requires. main.ts:101 awaits attachBridge (two reads plus two writes through the queue) before controller.start(). The SDK bundle contains a single setTimeout, the 100 ms bridge-ready re-check, and callEvenApp is a bare postMessage await, so the SDK has no per-call timeout. If the host never answers one storage call, every later render queues behind it and start() never runs, so the glasses stay on the startup frame. Whether the Even app ever leaves getLocalStorage/setLocalStorage unanswered cannot be verified without a device. Storage is phone-local, but the official skill claims it 'shares the same BLE link', and community notes report BLE calls hanging for about 30 s. A render call that hangs freezes the queue the same way, so this is a general queue-robustness gap, not a storage-only one.

**Fix notes.** In glasses.ts add `const STORAGE_TIMEOUT_MS = 3000` and a helper `withTimeout<T>(p: Promise<T>, ms, onTimeout: () => T | never)` built from Promise.race and a setTimeout that is cleared in finally. storageGet: `enqueue(() => withTimeout(bridge.getLocalStorage(key), STORAGE_TIMEOUT_MS, () => { throw new Error('Bridge storage timed out.') }), false)`. With the P2 fix, the throw counts as a read failure, not as absent. storageSet: `withTimeout(..., () => false)`. Optionally give textContainerUpgrade a timeout too (about 5 s, then throw so `last = null` and the queue recovers). In main.ts, bound the attach: `await Promise.race([store.attachBridge(...), new Promise(r => setTimeout(r, 4000))])` before `controller.start()`. If the attach finishes later and returns true, call controller.configurationChanged().

### phone:P7 (low, uncertain)

`src/storage.ts:577`

**Summary.** addPublication dedupes by host only. The same publication can be followed twice under different hosts even though its Substack id is known.

**Failure scenario.** The user follows a publication from Search, where the relay gives host foo.substack.com and id 123 (custom_domain_optional, or the search payload has no custom domain). Later they paste www.foo.com, and getArchive returns host www.foo.com with publication id 123. addPublication returns 'added', so Publications shows the same newsletter twice on the phone and glasses, uses two of the 100 slots, and Latest fetches it twice.

**Suggested fix.** In addPublication, also return 'exists' when an entry has the same non-null id. Optionally update that entry's host to the verified one and save. Show 'Already following <name>'.

**Skeptic's reasoning.** addPublication dedupes by host only (storage.ts:577), even when a positive id is known. However, the common duplicate paths self-heal or never arise. The relay's archive host is the post-redirect host: a curl probe shows slowboring.substack.com/api/v1/archive returns 301 to www.slowboring.com. Search and profile hosts prefer base_url, then a non-optional custom domain. When a list fetch later reveals a different host, rehostPublication drops the old entry if the new host is already followed (storage.ts:594-601). A persistent duplicate needs a publication whose subdomain and custom domain both serve 200 without redirecting, for example with custom_domain_optional. I could not confirm that Substack behaves that way.

**Fix notes.** In addPublication, after host validation: `if (valid.id !== null && state.publications.some(item => item.id === valid.id)) return 'exists'`. Optionally, when the existing entry's host differs and the new host came from a verified archive fetch (followHost), replace the existing entry's host instead and return 'exists' so the phone says 'Already following <name>.'

### relay:S4 (low, uncertain)

`worker/relay.ts:984`

**Summary.** Verdicts and response bodies are stored under a fixed, generic synthetic origin (https://relay.cache/p1/...), not the relay's own origin or any deployment-specific namespace. Cached entries are trusted as-is. storedVerdict accepts any {verdict:'pass', expires} whose expires is in the future, with no upper bound, and replay serves any cached 200 body with meta.cached set to true. PLAUSIBLE: this only matters where caches.default is shared with code the owner does not control, such as OpenAI Sites or Workers for Platforms dispatch namespaces (which the relay explicitly supports), or a zone shared with other Workers.

**Failure scenario.** A co-tenant Worker sharing the cache namespace runs cache.put('https://relay.cache/p1/host-verdict?host=evil.tld', {verdict:'pass', expires:1e15}). The relay then permanently treats evil.tld as Substack and proxies it, which leads to S1. The co-tenant can also run cache.put('https://relay.cache/p1/v1/post?host=on.substack.com&slug=x', <forged envelope>, max-age large), and app users opening that post are served the forged article. A second deployment of this open-source relay on the same platform would also silently share entries.

**Suggested fix.** Build cache keys under the relay's own request origin (new URL(request.url).origin) plus a per-deployment random salt from an env var, e.g. `${origin}/__cache/${env.CACHE_SALT}/p1/...`. In storedVerdict, reject entries whose expires is later than now() + VERDICT_PASS_MS. Alternatively, keep 'pass' verdicts only in isolate memory, or HMAC the stored verdict JSON with a Worker secret and verify it on read.

**Skeptic's reasoning.** The code facts are correct. storedVerdict (:993) accepts any 'pass' whose expiry is in the future, with no upper bound, and replay (:1155) trusts any cached 200.

Exploiting this, however, requires a third party with write access to the same caches.default. On the default Cloudflare deployment the cache belongs to the owner's own zone, and on workers.dev it is best-effort or a no-op, so only the owner's Workers could write to it.

The finding says the relay 'explicitly supports' Workers for Platforms. That is not accurate: docs/relay.md and .openai/README-sites.md mention OpenAI Sites (which runs on Cloudflare), Deno and Vercel, not WfP. Whether OpenAI Sites tenants share a cache namespace (cache isolation per user Worker) cannot be verified here; that unverifiable platform behaviour is what this depends on.

Even if poisoning were possible, a forged 'pass' only enables what S1 already allows through DNS. A forged post body is rendered as text on the glasses (DOMParser, never adopted into the live DOM).

**Fix notes.** 1. Cheap and always correct: at relay.ts:993 also require `expires <= now() + VERDICT_PASS_MS` (and, for 'fail', `<= now() + VERDICT_FAIL_MS`).
2. Prefixing keys with the request origin does not help against a co-tenant that shares the cache, because the co-tenant can compute the same key.
3. Real isolation needs one of these:
   (a) keep 'pass' verdicts only in the in-isolate `verdicts` Map and put only 'fail' in caches.default;
   (b) HMAC the stored verdict JSON, and optionally response bodies, with a Worker secret, e.g. env.CACHE_KEY, and verify it in storedVerdict and replay.
   Sites may not support env secrets, so (a) is the portable option.
