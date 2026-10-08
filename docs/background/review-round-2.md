# Review round 2

- **Reviewed:** 247981a (diff 5e893eb..247981a)
- **Fixes landed in:** `04c2e0c`
- **Method:** Three lenses over the round-1 fix diff only (runtime, controller + content, relay), each with a skeptic.
- **Verdicts:** confirmed 11, refuted 2, uncertain 6

Point-in-time record (2026-10-06/07). Line numbers refer to the reviewed commit, not to the current code. Ids repeat across lenses in round 1 (content C1–C6 and relay C1–C3), so the lens is part of the id.

## Summary

| Id | Lens | Severity | Verdict | File | Summary |
| --- | --- | --- | --- | --- | --- |
| R1 | runtime | medium | confirmed | `src/storage.ts` | This is a regression from 5e893eb. Attach now unites the two copies item by item, so whenever the browser mirror is newer than the bridge copy, a deletion made in the mirror is undone and written back to both stores. That covers a removed publication or saved  |
| R3 | runtime | medium | confirmed | `src/glasses.ts` | writeFrame always ends with `last = snapshot`, even when the display state was invalidated while it was running (Connected or Disconnected, onLate, invalidate() from controller.redraw). The redraw queued for that invalidation then compares against the overwrit |
| K1 | controller-content | medium | confirmed | `src/app/controller.ts` | The stale-display guard (G4/K3 fix) turns every action into forceRedraw() while displayStale is set, including 'back', 'hold' and the OS contextual-menu items (menu:1 Home). The only exception is a 'back' at stack.length === 1. If frame writes keep failing at  |
| R4 | runtime | low | confirmed | `src/main.ts` | The 'Loading your library' gate is lifted on the first failed bridge read, not after the retries. The phone then shows an empty library and accepts edits, and when a retry later succeeds, mergePrefs takes the whole settings object from the newer copy whenever  |
| R6 | runtime | low | confirmed | `src/storage.ts` | mergePrefs unites two copies without checking prefsFit. The union of two copies that each fit can exceed MAX_KEY_CHARS (the new test shows fewer than 100 long saved posts fill 48k). writeDirty then gets null from serializePrefs, leaves dirty=false and reports  |
| K2 | controller-content | low | confirmed | `src/app/controller.ts` | displayStale is cleared only by a controller draw() that succeeds. When a screen write times out (BridgeTimeoutError, so displayStale = true) and then lands late, glasses.ts onLate (glasses.ts:248) re-renders `wanted` straight through queueRender. The display  |
| K3 | controller-content | low | confirmed | `src/substack/urls.ts` | The P9 narrowing of the share-text rule (at most 3 lines and exactly one link) brings back the C4 problem for any other paste that contains links. Each title or blurb line now goes through parseSubstackInput. Short titles start live relay searches, which round |
| Y1 | relay | low | confirmed | `worker/relay.ts` | The S5 fix runs inconclusive() on the mapping proof's first response before any fingerprint check. That response comes from an unverified host that has just failed the DNS checks, so a 401, 403 or Cloudflare challenge from any non-Substack site is now reported |
| Y2 | relay | low | confirmed | `worker/relay.ts` | Every mapping proof, including one for a genuine Substack domain that passes, takes a token from a 10-per-minute strict 'verify' budget. On the default workers.dev deployment, verdicts survive only in isolate memory, so legitimate users hit 429 RATE_LIMITED. W |
| Y3 | relay | low | confirmed | `worker/relay.ts` | Round-1 S3 is only half fixed. Hosts with no addresses now fail correctly. A host whose DNS answers definitively and points away from Substack but does not serve HTTPS still becomes 'unknown': a lapsed or parked domain, connection refused, a TLS error, or a Cl |
| Y4 | relay | low | confirmed | `worker/relay.ts` | The strict-budget check (admit) runs inside the verification promise that all concurrent callers share through pendingVerdicts. If the client that started the verification is over its 'verify' budget, every other client waiting on the same host also receives t |
| K1 | runtime | low | uncertain | `src/app/controller.ts` | The G4 fix intercepts every action except the root double-tap while displayStale is set. 'back' and 'hold' inside the reader or a list, and every contextual-menu item including 'Home' (menu:1), are turned into forceRedraw. When a frame keeps failing, the weare |
| R2 | runtime | low | uncertain | `src/glasses.ts` | SCREEN_TIMEOUT_MS bounds a whole frame: up to 3 sequential textContainerUpgrade calls plus up to 3 retries 150 ms apart. It does not bound each native call. On a slow link a full 3-field frame takes longer than 5 s and times out even though every write lands.  |
| R5 | runtime | low | uncertain | `src/glasses.ts` | Storage writes now time out at 4 s and the queue moves on, but onLate ignores late 'storage' results. A timed-out setLocalStorage that lands after a newer write leaves the bridge holding the older document, while the store believes the newer stamp is stored. T |
| R7 | runtime | low | refuted | `src/main.ts` | libraryReady() runs after controller.configurationChanged() in both attach branches. If configurationChanged throws, the store's observer guard swallows the error in onApplied, so libraryLoading stays true for the whole session and every library edit is refuse |
| R8 | runtime | low | uncertain | `src/glasses.ts` | createStartUpPageContainer is still called outside the serialized bridge queue, but storage calls now start before it. The 1.5 s head start ends at markApplied, which runs before attach's write-back flush, or at the bound, when reads may still be in flight. Pa |
| R9 | runtime | low | uncertain | `src/glasses.ts` | onLate re-sends the wanted frame after any late screen call, including a late shutDownPageContainer(1). An exit that timed out and then opens the OS exit dialog is immediately followed by textContainerUpgrade calls that write over or disturb the dialog the wea |
| Y5 | relay | low | uncertain | `worker/relay.ts` | Round-1 S4 is only partly fixed. Cache keys are now `${url.origin}/__relay-cache/p1/...`, but anyone sharing caches.default can compute that origin, so a co-tenant can still write a forged { verdict: 'pass' } with expires up to now+24h, which passes the new up |
| Y6 | relay | low | refuted | `pnpm-workspace.yaml` | Adding wrangler as a devDependency brings in workerd, whose postinstall pnpm skips: node_modules/.modules.yaml lists ignoredBuilds [workerd@1.20261006.1], because allowBuilds lists only esbuild. `wrangler deploy` does not need that script, since the platform b |

## Details

### runtime:R1 (medium, confirmed)

`src/storage.ts:383`

**Summary.** This is a regression from 5e893eb. Attach now unites the two copies item by item, so whenever the browser mirror is newer than the bridge copy, a deletion made in the mirror is undone and written back to both stores. That covers a removed publication or saved post, 'Clear reading' (positions, history and read ids come back, and lastOpen is restored through `newer.lastOpen ?? older.lastOpen`) and 'Reset settings' (isDefaultSettings(newer) hands the old settings back). The mirror normally gets ahead of the bridge on its own: mirroredKV.set writes localStorage synchronously, while the bridge write is queued behind renders (up to 5 s plus 5 s), bounded by a timeout, and cut off by the 1.5 s exit flush and dispose().

**Failure scenario.** 1) Session N is attached and both stores hold prefs at T1 with publication X. 2) The user removes X on the phone, or confirms 'Clear reading', and closes the Even app. 3) visibilitychange/pagehide calls flush, and mirroredKV.set writes localStorage at T2 at once. The bridge setLocalStorage waits in the queue behind a running render and never runs: the WebView is suspended, or exitApp disposes after 1.5 s and the queue rejects with 'reader closed'. Alternatively it times out and safeSet returns false. 4) On the next launch, load(browserKV) finds T2 without X, so found is true and there is no loading gate. attach reads the bridge at T1 with X, sees localStamp T2 >= T1, and runs mergePrefs(local, remote): unionBy appends X. memoryChanged, so X is back on the phone and the glasses, and because merged != remote, the doc is marked dirty and written to both stores. X is now permanently restored. With 'Clear reading', mergeProgress restores every position, history entry and read id, and lastOpen (so the 'Continue' item comes back). With 'Reset settings', the old settings are restored. The same thing happens for any removal made during a session whose attach failed (kv stays browserKV) and for removals made while the attach reads are in flight.

**Suggested fix.** Record how the mirror descends from the bridge, and unite the copies only when the bridge holds changes the mirror never saw. Keep a browser-only key, for example 'sr:sync:v1' = {prefs, progress}, holding the bridge savedAt that the mirror last matched. Update it only after a bridge setLocalStorage returned true (in writeDirty, when the mirrored target's primary write succeeded) and after a successful attach (set it to remote.savedAt, or to the merged stamp once written). In attach, when the doc is not pristine and remote.savedAt <= sync[name], the local copy descends from the bridge copy. Keep local wholesale (no union): set dirty if !sameContent(local, remote) and write it back. Use mergePrefs/mergeProgress only when remote.savedAt > sync[name]. Evicted mirrors lose the sync key with the docs, so they still adopt or unite correctly. Add tests: (a) mirror T2 without X, sync T1, bridge T1 with X: X stays removed and the bridge is rewritten; (b) clearReading in a mirror with sync = bridge savedAt: history, positions and lastOpen stay cleared; (c) evicted mirror plus an unattached session (no sync key): the copies are still united.

**Skeptic's reasoning.** In storage.ts attach (lines 541-575 at 247981a), any document that is not pristine is merged with mergePrefs/mergeProgress whichever copy is newer. mergePrefs unites publications and saved posts with unionBy. When the newer copy has default settings, isDefaultSettings hands back the older copy's settings. mergeProgress keeps every position, unites history and read ids, and takes `newer.lastOpen ?? older.lastOpen`. Nothing tells a deletion in the mirror apart from an item the mirror never had. The code comment admits it: 'The cost: an item removed in only one copy can come back.' At 5e893eb the newer savedAt won wholesale, so a removal recorded only in the mirror stuck. That makes this a real regression. mirroredKV.set writes localStorage synchronously while the bridge write waits in the queue and can time out (4 s), return false, or be cut off by the 1.5 s exit bound or dispose(). One correction: the reviewer says the mirror 'normally' gets ahead on its own. It does not. After the 800 ms debounce, both copies are normally written in the same flush. The trigger is a bridge write that failed or never ran: a close within about 800 ms of the edit, a timeout, false from setLocalStorage, or exit cut-off. The most reliable trigger is a whole session whose attach failed. That mode is designed in: main.ts says 'Edits now go to the browser copy; a later attach merges them'. Every removal, 'Clear reading' or 'Reset settings' from that session is undone at the next attach and written back to both stores. Undoing 'Clear reading' (history, read ids and lastOpen come back) is privacy-relevant. Medium.

**Fix notes.** 1) Add a mirror-only key, e.g. KEYS.sync = 'sr:sync:v1', holding {prefs, progress}: the bridge savedAt that the mirror last matched. Write it through the mirror KV only, never the bridge. 2) In writeDirty, when bridged and safeSet(target, ...) returned true (mirroredKV returns the primary's result), update sync[name] = stamp. 3) In attach, read the sync key from the mirror (safeGet + parse; absent or corrupt counts as -1). For a document that is not pristine with a parsed remote: if remote.savedAt <= sync[name], the mirror descends from the bridge. Keep local wholesale (merged = local), set dirty if !sameContent(local, remote), and run no union. Otherwise, as today, call mergePrefs/mergeProgress. After a successful attach, set sync[name] = remote.savedAt for documents adopted or already equal (the write-back updates it through writeDirty). 4) An evicted mirror loses the sync key along with the docs, so pristine adoption and union still work. Tests: (a) mirror T2 without X, sync T1, bridge T1 with X: X stays removed and the bridge is rewritten; (b) clearReading in the mirror with sync equal to bridge savedAt: history, positions, read and lastOpen stay cleared; (c) resetSettings likewise; (d) evicted mirror plus an unattached session (no sync key): still united.

### runtime:R3 (medium, confirmed)

`src/glasses.ts:289`

**Summary.** writeFrame always ends with `last = snapshot`, even when the display state was invalidated while it was running (Connected or Disconnected, onLate, invalidate() from controller.redraw). The redraw queued for that invalidation then compares against the overwritten `last`, finds every field equal and writes nothing, so the stale field stays on the display. This defeats both the reconnect redraw (G3) and the late-write recovery.

**Failure scenario.** (a) A render is in flight while the G2 is disconnected, and its body upgrade resolves true without being shown (the round-1 G3 case). Connected arrives during the title upgrade: last = null and link.connected() is true, so onReconnect -> controller.redraw -> invalidate -> render, which becomes the waiting slot. The in-flight render finishes title and footer and sets last = snapshot. The redraw finds body, title and footer equal to last and writes nothing, so the G2 keeps the old body while the model is on the new page, and the next swipe skips a page. (b) R11's body hangs and times out, then R12 is in progress when R11's body lands late. onLate sets last = null and, with renderPending() false, queues R12'. R12 finishes and sets last = R12. R12' skips the body, so the glasses show page 11's body under page 12's footer.

**Suggested fix.** Add `let displayEpoch = 0` and increment it in invalidate(), in the Disconnected, Connecting and Connected handlers, in onScreenError, in onLate, and after a successful exit(). In writeFrame, capture `const epoch = displayEpoch` before the loop and replace the final assignment with `last = epoch === displayEpoch ? snapshot : null`. Then a redraw requested during a write always resends every field. Add a glasses test: start a render, call invalidate() while its first upgrade is pending, queue the same frame again, and expect three upgrades for the second render.

**Skeptic's reasoning.** In glasses.ts writeFrame (line 289) the last statement is always `last = snapshot`. Any `last = null` set while that frame was being written is lost: invalidate(), the Disconnected/Connecting/Connected handlers, and onLate. Scenario (b) follows from the queue code alone. R11's body upgrade hangs. The user swipes again before 5 s, so R12 is waiting and controller displayStale stays false (seq !== drawSeq). At 5 s, bounded() rejects R11 and onScreenError sets last = null. R12 starts and issues its body. R11's body then resolves. abandoned(live) throws and finish() calls late('screen'). onLate sets last = null, and because R12's slot was released when it started, renderPending() is false, so R12' is queued. R12 writes title and footer and sets last = R12. R12' finds every field equal and writes nothing. If R11's late body reached the display after R12's body, the glasses show page 11's body under page 12's footer until the next frame, and the next swipe skips page 12. The late-write recovery therefore works only when the late answer arrives while the queue is idle, not in the case it was built for: a newer frame in flight. Scenario (a), Connected arriving mid-render, follows the same path for the new onReconnect redraw, but whether the earlier fields were lost depends on the device. The overwrite also existed in 5e893eb for Disconnected/Connected; the onLate and onReconnect recoveries it defeats are new.

**Fix notes.** Add `let displayEpoch = 0` and increment it everywhere last is nulled for an outside reason: invalidate(), the Disconnected/ConnectionFailed, Connecting and Connected handlers, onLate, onScreenError, and exit()'s operation. In writeFrame capture `const epoch = displayEpoch` before the loop and replace line 289 with `last = epoch === displayEpoch ? snapshot : null` (call link.written() and report('ready') either way, since the frame itself was accepted). Better still, update a per-field record as each upgrade resolves, only while the epoch is unchanged, so a later render rewrites only fields that are not known good. Test, using a fake bridge in glasses tests or a queue-level test: start render A, fire invalidate()/onLate while A's first upgrade is pending, queue the same frame again, and expect the second render to send all three upgrades.

### controller-content:K1 (medium, confirmed)

`src/app/controller.ts:939`

**Summary.** The stale-display guard (G4/K3 fix) turns every action into forceRedraw() while displayStale is set, including 'back', 'hold' and the OS contextual-menu items (menu:1 Home). The only exception is a 'back' at stack.length === 1. If frame writes keep failing at depth 2 or more, the wearer can no longer reach the root or the exit dialog. The code comment says that 'glasses that keep refusing frames cannot trap the wearer', but that is only true at the root. The G4 fix notes said back, hold and menu actions should still run normally. tests/unit/controller.test.ts:704 locks in the trap ('so does double-tap below the root (refused again)').

**Failure scenario.** The wearer is reading a post (stack: home > publications > posts > reader, depth 4). The text containers start refusing writes but touch events still arrive. Plausible causes: after an exit dialog was cancelled (glasses.ts itself notes the dialog 'may disturb the containers'), a degraded BLE link where every textContainerUpgrade hits SCREEN_TIMEOUT_MS, or a frame that fails deterministically (writeFrame throws RangeError when isReaderPage fails). One failed page turn sets displayStale = true. Each later swipe, tap, double-tap, long-press and the OS menu 'Home' item then calls forceRedraw(), which fails again and leaves displayStale true. The model never pops, so stack.length never becomes 1 and the root double-tap exit dialog (shutDownPageContainer, rendered by the OS rather than by text writes) is unreachable from the glasses. Before 247981a, blind double-taps still popped the model to the root and the next one opened the exit dialog. There is a related inverse case at the root: after menu Home's draw fails, the glasses still show the reader. The wearer double-taps meaning 'back to list', but because the model is at the root this opens the OS exit dialog.

**Suggested fix.** Intercept only the gestures whose meaning depends on what is on screen. Use `if (displayStale && (action === 'next' || action === 'previous' || action === 'select')) return forceRedraw()`. Let 'back', 'hold' and every 'menu:*' run normally: they navigate or open OS UI and are safe on a stale frame. Also bound it: keep a `redrawOffered` flag that is set when the guard fires and cleared on any successful draw. If the forced redraw also fails, let the next action through instead of intercepting forever. Change the test at controller.test.ts:700-705 so that double-tap below the root pops (view().kind becomes 'publications'), menu:2 still saves, and only the swipe or tap is converted into a redraw.

**Skeptic's reasoning.** At 247981a, controller.ts:939 reads `if (displayStale && !(action === 'back' && stack.length === 1)) return forceRedraw()`. displayStale is set at :323 when the latest draw is rejected for any reason other than being superseded. It is cleared at :319 only when the latest controller draw succeeds. While frames keep failing, every action at depth 2 or more (back, hold, menu:1 Home, and every other menu item) becomes forceRedraw(). That redraw fails again, the stack never pops, and the root double-tap exit dialog cannot be reached from the glasses. Nothing else clears the flag:
- onReconnect only fires on a real Connected event.
- The foreground redraw after 30 s is also just forceRedraw().
- The phone cannot escape either. Its remote buttons, including Back, and its 'Glasses Home' button (phone/actions.ts:641 and :660) also go through controller.onAction, so they are swallowed too. This happens even though the phone mirror shows the model frame (controller.current() returns `frame`, which is set before the render), so the phone is never acting on a stale frame.

At 5e893eb, onAction had no guard, so blind double-taps popped to the root and the next one opened the exit dialog. The test locks in the new behaviour: tests/unit/controller.test.ts:699-704 asserts that menu:2 and the below-root double-tap only redraw while frames keep being refused. The G4 fix notes said back, hold and menu should run normally. The comment at :937-938 claims the wearer cannot be trapped, which is true only at the root.

Whether the trap is reached depends on frames failing persistently (repeated refusals or timeouts, or a frame that fails deterministically). The test fixture models exactly that, and the root exception shows the author expected it. The wearer can still close the plugin from the Even app, so this is medium, not high. The inverse case (a failed menu-Home draw at the root, then a double-tap opens the exit dialog) is real but minor, because the OS dialog can be cancelled.

One correction to the suggested fix: letting menu:2 through unguarded in a posts list would save view.items[view.sel]. That is the row the model moved to, not the row the wearer sees highlighted, which is exactly the G4 hazard the test at :697-701 guards against.

**Fix notes.** In onAction, intercept only the actions whose effect depends on the page or row shown on screen:
```ts
const screenBound = action === 'next' || action === 'previous' || action === 'select' || (action === 'menu:2' && top().kind === 'posts')
if (displayStale && screenBound) return forceRedraw()
```
The following then run normally, because they navigate away or act on the whole view, not on the cursor: back, hold, menu:1 Home, menu:3, menu:4 and menu:5. A back in the reader is safe: positions are recorded only after a successful render, so leaveReader keeps the last page that was actually shown.

Optionally:
- Let phone-originated actions skip the guard, because the phone mirror shows the model. For example, add `onAction(action, { fromPhone: true })` from phone/actions.ts remote() and glasses-home.
- Bound the guard with a `redrawOffered` flag that is set when the guard fires and cleared on any successful draw, so a second consecutive failure lets the action through.

Update the comment at :937-938. Update tests/unit/controller.test.ts:699-708 so that:
- 'back' below the root pops (view().kind === 'publications'),
- menu:2 on a stale list cursor still only redraws,
- the invalidation counts are re-based.

### runtime:R4 (low, confirmed)

`src/main.ts:114`

**Summary.** The 'Loading your library' gate is lifted on the first failed bridge read, not after the retries. The phone then shows an empty library and accepts edits, and when a retry later succeeds, mergePrefs takes the whole settings object from the newer copy whenever any one field differs from the default. Changing one setting on the apparently empty library therefore wipes every setting the user had chosen in bridge storage.

**Failure scenario.** The WebView's localStorage was evicted, so loadedEmpty() is true and libraryLoading is true. The first getLocalStorage times out (4 s) or returns a non-string. The rejection handler calls libraryReady(), so the phone shows 'Get started' and 0 publications, and Settings shows defaults. The user sets 'Lines per page' to 6. The prefs doc is now not pristine: savedAt is T2 after the browser flush, with settings default except linesPerPage. The retry 1 s later succeeds: local T2 >= remote T1, newer = local, and isDefaultSettings(local.settings) is false, so merged settings = local settings. The bridge's invertSwipe=true, custom homeItems, footnotes and latestMaxPublications are replaced by defaults and written back to both stores. The user may also re-add publications they believe were lost.

**Suggested fix.** In main.ts, keep libraryLoading true while retries remain: in the rejection branch, call libraryReady() only when `retries >= ATTACH_RETRY_MS.length` after scheduleRetry, and show a phone notice such as 'Could not read your library yet; retrying'. The grace timer still covers the no-bridge case. In storage.ts mergePrefs, merge settings field by field instead of `isDefaultSettings(newer.settings) ? older.settings : newer.settings`: for each key in Settings, use newer[key] when it differs from defaultSettings()[key], else older[key], with homeItems compared by join(). Once R1's sync marker is in place, use this union path only when the bridge copy is not an ancestor of the local one.

**Skeptic's reasoning.** main.ts lines 114-118: the rejection handler of the first attach calls libraryReady() at once, before scheduleRetry(). In an evicted-mirror launch (loadedEmpty), a single getLocalStorage timeout (4 s) or a non-string value lifts the 'Loading your library' gate. The phone then shows an empty library and accepts edits (LIBRARY_ACTIONS are no longer refused). The retry 1 s later succeeds. A settings edit made in between gives the local copy savedAt or changedAt T2, which is greater than or equal to remote T1, and isDefaultSettings(local.settings) is false. mergePrefs therefore takes the local settings wholesale: defaults plus the single change. The result is written to both stores (!sameContent(merged, remote)), so the user's invertSwipe, homeItems, footnotes and so on are lost. Publications and saved posts are united, so re-adding them does no harm. The damage is limited to settings and needs a failed first read plus a settings edit in the retry window, or a whole unattached session. The wholesale settings merge is the root cause and also affects every unattached session. Low.

**Fix notes.** 1) main.ts rejection branch: call scheduleRetry() first, then call libraryReady() only when no retry was scheduled (`retries >= ATTACH_RETRY_MS.length` or retryTimer === undefined), and show a phone notice such as 'Could not read your library yet; retrying…'. retryAttach() on foreground or reconnect can set the gate again only if memory is still pristine. 2) storage.ts mergePrefs: merge settings field by field. `const d = defaultSettings(); for each key k: merged[k] = !same(newer[k], d[k]) ? newer[k] : older[k]`, comparing homeItems with join(','). 3) Once R1's sync marker exists, use the union/field merge only when the bridge copy is not an ancestor of the local one.

### runtime:R6 (low, confirmed)

`src/storage.ts:602`

**Summary.** mergePrefs unites two copies without checking prefsFit. The union of two copies that each fit can exceed MAX_KEY_CHARS (the new test shows fewer than 100 long saved posts fill 48k). writeDirty then gets null from serializePrefs, leaves dirty=false and reports failure. From then on no prefs write (settings, reorder, rehost) can be stored until the user removes enough items, and the bridge keeps the pre-merge document.

**Failure scenario.** The bridge holds 60 long saved posts (about 30k characters) and the mirror 60 different ones (after a failed-attach session or an evicted mirror plus re-saves). attach unites them into 120, capped at LIMITS.saved = 100, about 50k characters. apply(merged) runs and dirty is set; flush sees serializePrefs(...) === null, so success=false, dirty is cleared and onSaved(false) fires. Every later prefs save fails the same way, addSaved/addPublication return 'full' ('Storage is full') with a library the user never filled, and each relaunch rebuilds the same oversized union.

**Suggested fix.** In attach, after the prefs merge, enforce the cap: while !prefsFit(merged-as-state), drop the last older-only saved post, then the last older-only publication. Those are the items unionBy appended. Keep the original items of the newer copy. Alternatively make mergePrefs take a `fits` predicate. Add a test where both copies are about 30k characters, and expect the merged document to serialize to 48k characters or fewer and to be written to the bridge.

**Skeptic's reasoning.** mergePrefs (storage.ts 383-390) caps only by item count (LIMITS), never by size. attach applies the merged document and sets it dirty. writeDirty clears dirty, serializePrefs returns null, it `continue`s with success=false, and it writes neither the bridge nor the mirror. Memory keeps the oversized union, so prefsFit fails from then on: addSaved/addPublication return 'full' (shown as 'Storage is full'), and every later prefs save (settings, reorder, rehost) fails the same way. Both stores keep their pre-merge documents, so each relaunch rebuilds the same oversized union until the user removes items. The precondition is rare: two copies with largely disjoint lists of about 25-30k characters each, which takes a failed-attach session (or a mirror edited after R4's gate lifted) with many long saves. The phone does show 'Could not save'. Low.

**Fix notes.** In attach, after mergePrefs, enforce the size cap before apply(): while !prefsFit(stateWith(merged)), drop the last item that came only from the older copy, first from saved, then from publications. These are the items unionBy appended after the newer copy's own. Track them as `older-only` keys, or pass a `fits(doc)` predicate into mergePrefs so unionBy stops appending once the next item would not fit. Never drop the newer copy's own items. Test: two copies of about 30k characters each with disjoint saved lists merge to a document with serializePrefs(..) not null, and it is written to the bridge.

### controller-content:K2 (low, confirmed)

`src/app/controller.ts:318`

**Summary.** displayStale is cleared only by a controller draw() that succeeds. When a screen write times out (BridgeTimeoutError, so displayStale = true) and then lands late, glasses.ts onLate (glasses.ts:248) re-renders `wanted` straight through queueRender. The display then matches the model again, but the controller is never told. The wearer's next gesture is therefore swallowed and replaced by a full invalidate() and redraw of a frame the glasses already show.

**Failure scenario.** On a slow BLE hop, a page-turn write takes longer than SCREEN_TIMEOUT_MS. The controller's draw rejects with BridgeTimeoutError and displayStale becomes true. The native write then completes, so bounded() calls late('screen') and onLate runs queueRender(wanted), which fully writes the current page. The glasses now show the right page. The wearer swipes to the next page, but onAction sees displayStale, so the swipe does nothing visible and triggers forceRedraw(). That sets last = null and resends title, body and footer (three more BLE writes on an already slow link). On a link where timeouts keep recurring, roughly every other swipe is lost and each one doubles the write traffic.

**Suggested fix.** Send the late-write recovery through the controller so that its success clears the flag. In glasses.ts onLate, replace `queueRender(wanted)` with `opts.onReconnect?.()` (main.ts already wires this to controller.redraw()), or add a dedicated `opts.onRecovered`. Alternatively, add a `frameShown()` hook that the controller exposes and glasses calls after any successful writeFrame, which sets displayStale = false when the written snapshot equals the controller's `frame`.

**Skeptic's reasoning.** Here is the sequence, traced through the code:
1. A controller draw times out. bounded() rejects with BridgeTimeoutError (events.ts:227), which is not superseded, so controller.ts:323 sets displayStale = true.
2. When the hung textContainerUpgrade finally settles, writeFrame reaches abandoned(live) and throws.
3. finish() sees settled && timedOut and calls late('screen').
4. glasses.ts:248-254 onLate sets last = null and calls queueRender(wanted).catch(() => undefined) whenever no render is pending.

That re-render writes the full current frame. Its success only updates glasses-internal state (last, link.written, report('ready')). The controller is never told, so displayStale stays true. The wearer's next swipe or tap is then swallowed by the guard at :939 and turned into forceRedraw(): invalidate plus a resend of all three containers, for a frame that is already on the display.

A side effect: the reader position for the late-landed page is not recorded (afterReaderRender only runs on a controller draw) until that forced redraw succeeds. The impact is one lost gesture plus one redundant full write per timed-out write that lands late, so low severity is right. The 'every other swipe lost' wording in the finding only applies on a link where timeouts recur constantly. Nothing in the code refutes the finding: onReconnect fires only on a Connected device event, and onStatus only feeds the phone.

**Fix notes.** In glasses.ts onLate, route the recovery through the controller so that its success clears displayStale and records the reader position:
```ts
onLate(kind) {
  if (kind !== 'screen' || disposed) return
  last = null
  if (queue.renderPending()) return
  if (opts.onReconnect) { try { opts.onReconnect() } catch {} }
  else if (wanted) queueRender(wanted).catch(() => undefined)
}
```
main.ts already wires onReconnect to controller.redraw(), which is forceRedraw. The GlassesOptions.onReconnect doc already covers 'after a failed screen write'.

Caveat: controller.redraw recomputes the frame, so a one-shot transient footer such as 'Saved for later' that `wanted` carried is dropped. If that matters, keep `transient` until a draw succeeds.

Alternative: add an explicit `frameShown(snapshot)` callback from glasses to the controller that clears displayStale when the written snapshot equals the controller's current `frame`.

### controller-content:K3 (low, confirmed)

`src/substack/urls.ts:265`

**Summary.** The P9 narrowing of the share-text rule (at most 3 lines and exactly one link) brings back the C4 problem for any other paste that contains links. Each title or blurb line now goes through parseSubstackInput. Short titles start live relay searches, which round-1 code dropped. Blurbs longer than 100 characters bring back the 'Search text is too long' error cards that C4 was meant to remove. C4 is fixed only for pastes of 3 lines or fewer.

**Failure scenario.** The user copies two share texts in one go: 'An A.I. legislator running a cost campaign\nhttps://www.slowboring.com/p/an-ai-legislator\nWhy prices rose\nhttps://foo.substack.com/p/prices'. Two links means shareText is false, so 'An A.I. legislator running a cost campaign' and 'Why prices rose' each become search cards that call /v1/search, return unrelated publications and count against the per-IP search limit. Round 1 dropped these lines. The same happens with a single share text of 4 or more lines (title, subtitle, author line, link): every text line is searched, and a long description line gives the error card 'Search text is too long (100 characters at most).', which is the original C4 scenario.

**Suggested fix.** Decide per line, not per paste, whether a line is decoration. In parseMany, treat a line as share-text decoration when isPlainText(line) is true and the paste has any link line within the same block (for example the nearest non-empty neighbour, above or below, contains HAS_SCHEME_RE), or when hasLink is true and the line would fail search validation (longer than SEARCH_MAX_CHARS or shorter than SEARCH_MIN_CHARS). Keep plain-text lines with no adjacent link as searches, which preserves P9's 'https://a\nhttps://b\nMatt Yglesias' case. Add tests for the two-share-text paste and for a 4-line share text with a 120-character blurb, both yielding only skipped cards and post cards.

**Skeptic's reasoning.** At 247981a, urls.ts:265 sets shareText only when the paste has at most 3 lines and exactly one link line. Otherwise :269 sends every plain-text line through parseSubstackInput. The two scenarios behave as the finding says:
- Two pasted share texts (4 lines, 2 links): shareText is false, so both titles become `search` results. phone/actions.ts:433-434 then calls api.searchPublications for each, which counts against the relay's normal 60/min per-client budget. The 5e893eb code dropped those lines (`hasLink && parsed.kind === 'search'` → continue).
- A 4-or-more-line single share text with a blurb over 100 characters: the blurb produces the 'Search text is too long' invalid card, which is the original C4 symptom. Short title or author lines become searches.

So C4 is fixed only for pastes of 3 lines or fewer. In mitigation:
- The narrowing is deliberate. It follows the round-1 P9 fix notes word for word and is documented in README.md:42 ('up to 3 lines').
- Search cards only offer results and never auto-add.
- The 'too long' card describes the input accurately.

The impact is therefore noise and some wasted relay calls, so low severity.

The suggested fix contradicts itself. It says an adjacency rule ('nearest non-empty neighbour has a link') would preserve P9's 'https://a\nhttps://b\nMatt Yglesias' search. But 'Matt Yglesias' is adjacent to 'https://b', so that rule would skip it.

**Fix notes.** Minimal fix: in parseMany, when any line contains a link, a plain-text line (isPlainText) longer than SEARCH_MAX_CHARS becomes skipped(line) instead of a 'too long' error. It can never be a valid search, so it must be a blurb. This removes the C4 error-card residue in every paste size.

Fuller fix: also treat as share text every run of plain-text lines that sits immediately before a link line (the title above its link, a pattern that repeats for several share texts pasted together). Keep plain text after the last link, or not followed by a link, as a search. This keeps the cases 'https://a\nhttps://b\nMatt Yglesias' and 'https://a\nMatt Yglesias\nNoah Smith\nx' as searches.

Tests:
- Add 'T1\nhttps://foo.substack.com/p/a\nT2\nhttps://bar.substack.com/p/b' → [skipped T1, post, skipped T2, post].
- Add a 4-line share text with a 120-character blurb → only skipped cards and the post.
- Update urls.test.ts:243-245: 'Great read' sits directly above its link, so it becomes skipped rather than a search.
- Update the README sentence about the 3-line limit.

### relay:Y1 (low, confirmed)

`worker/relay.ts:1025`

**Summary.** The S5 fix runs inconclusive() on the mapping proof's first response before any fingerprint check. That response comes from an unverified host that has just failed the DNS checks, so a 401, 403 or Cloudflare challenge from any non-Substack site is now reported as 503 UPSTREAM_BLOCKED ('Substack refused the relay connection'). It used to be a cached HOST_NOT_SUBSTACK. Only the S.substack.com check can be attributed to Substack.

**Failure scenario.** 1. A user adds 'example.com'. The apex sits on the publisher's own Cloudflare zone with Bot Fight Mode or another WAF, and only www.example.com is CNAMEd to Substack.
2. The DNS checks fail for the apex. mappingProof's first GET returns 403 or cf-mitigated: challenge with no x-served-by header, and inconclusive() turns it into { verdict: 'unknown', blocked }.
3. The relay answers 503 UPSTREAM_BLOCKED. withWwwRetry (src/phone/actions.ts:379) retries www only on HOST_NOT_SUBSTACK, so the add fails. Before 247981a, it got HOST_NOT_SUBSTACK and the www retry succeeded.
4. The same happens for any non-Substack site that 403s bots (for example, a user pasting a news site): the user is told Substack is blocking the relay.
5. The result is remembered for only 60 s in memory, so every minute each isolate repeats the proof against that third-party host and takes a strict 'verify' token. The old code cached the failure for 1 h.
6. For an already-followed publication, controller.fetchArchive also runs the useless feed fallback, because UPSTREAM_BLOCKED is in FEED_FALLBACK_CODES.
7. The S5 test case `first = () => html('denied', 401)` asserts this behaviour.

**Suggested fix.** 1. In mappingProof, classify the first response separately: `const refused = fingerprinted(first) ? inconclusive(first) : (first.status === 429 || first.status >= 500 ? UNKNOWN : null)`.
2. For an unfingerprinted 401, 403 or challenge, return a fail with a short life, e.g. `{ verdict: 'fail', ttlMs: VERDICT_NO_ADDRESS_MS }`. Let mappingProof return an optional ttlMs and have runChecks use `proof.ttlMs ?? VERDICT_FAIL_MS` in its fail branch.
3. Keep `inconclusive(check)` unchanged for the S.substack.com request; that is the case round-1 S5 described.
4. Update the S5 test: an unfingerprinted 401/403 on the first fetch should give 403 HOST_NOT_SUBSTACK with a 10-min stored fail. Add a fingerprinted-403 first-fetch case that still gives UPSTREAM_BLOCKED.

**Skeptic's reasoning.** The finding holds against 247981a. In mappingProof (relay.ts:1025), `inconclusive(first)` runs on the first response from the caller's host before any fingerprint check. Any 401, 403 or `cf-mitigated: challenge` from that host becomes `{verdict:'unknown', blocked}`. runChecks (:1080) keeps it as unknown with VERDICT_UNKNOWN_MS. verifyCustomDomain (:1148) keeps it for 60 s in memory only, and serve (:690) throws `unverified()`, which gives 503 UPSTREAM_BLOCKED.

In 5e893eb the same response was a 'fail', cached for 1 h, giving HOST_NOT_SUBSTACK. The S5 test (relay.test.ts:617, `first = () => html('denied', 401)`, expecting UPSTREAM_BLOCKED) asserts the new behaviour.

On the client:
- withWwwRetry (actions.ts:379) retries www only on HOST_NOT_SUBSTACK, so an apex that 403s or challenges unknown agents no longer falls through to a www host that is on Substack.
- Any non-Substack site with bot protection now shows frames.ts' 'Substack refused the reader service. / Try again later.' instead of 'That site is not a Substack publication.'
- Each retry after 60 s repeats DoH and the proof and spends a 'verify' token.

The round-1 S5 notes did ask for this at both fetches, but the research it cites (datacenter egress to *.substack.com is 403'd while custom domains get 200) only supports it for the S.substack.com check. A Substack WAF block page on a custom domain would not carry x-served-by either, so an unfingerprinted refusal of the first fetch cannot be attributed to Substack.

Why low and not medium: the misreport is certain whenever a non-Substack site refuses the UA, but the apex/www regression needs a WAF on the apex that answers before any redirect rule. Whether that happens depends on the site's Cloudflare or WAF configuration, which cannot be checked here. Nothing is lost or exposed, and typing www by hand works.

**Fix notes.** In mappingProof, attribute a refusal of the first fetch only when it is fingerprinted:
```ts
const info = describe(first)
const refusedByHost = info.challenge || first.status === 401 || first.status === 403
const refused = fingerprinted(first) ? inconclusive(first)
  : refusedByHost ? null
  : first.status === 429 || first.status >= 500 ? UNKNOWN : null
if (refused || first.status !== 200 || !fingerprinted(first) || contentTypeOf(first) !== 'application/json') {
  await discard(first)
  return refused ?? (refusedByHost ? { verdict: 'fail', ttlMs: VERDICT_NO_ADDRESS_MS } : fail)
}
```
- Add an optional `ttlMs` to Outcome.
- In runChecks' fail branch, return `{ verdict: 'fail', ttlMs: proof.ttlMs ?? VERDICT_FAIL_MS }`.
- Keep `inconclusive(check)` unchanged for the S.substack.com request, which is the case round-1 S5 was about.
- Tests:
  - Change relay.test.ts:617 so an unfingerprinted 401 on the first fetch gives 403 HOST_NOT_SUBSTACK, with a stored fail expiring at now+600 000.
  - Add a fingerprinted 403 first-fetch case that still gives UPSTREAM_BLOCKED and nothing stored.
  - Update the docs/relay.md rule 2 wording to match.

### relay:Y2 (low, confirmed)

`worker/relay.ts:1077`

**Summary.** Every mapping proof, including one for a genuine Substack domain that passes, takes a token from a 10-per-minute strict 'verify' budget. On the default workers.dev deployment, verdicts survive only in isolate memory, so legitimate users hit 429 RATE_LIMITED. With the shared key (Sites) or free NXDOMAIN churn, one client can starve everyone.

**Failure scenario.** 1. docs/relay.md rule 9 says the Cache API is only best-effort on *.workers.dev, so pass verdicts effectively live only in the isolate's `verdicts` Map.
2. A user follows 12 or more publications whose custom domains are proxied through the publisher's own Cloudflare zone (no CNAME to the target and different IPs), so each one needs the mapping proof.
3. On a fresh isolate, loadLatest (controller.ts, LATEST_CONCURRENCY 2) fetches all of them at once. Every proof calls rateLimit('verify', call, true): RL_STRICT allows 10 per 60 s per IP per colo.
4. From the 11th domain on, the user gets 429 RATE_LIMITED with Retry-After 60. RATE_LIMITED is not in FEED_FALLBACK_CODES, so there is no fallback; Latest shows partial failures and opening those publications says to try again in 60 s. Redirect hops to such domains (x.substack.com → www.x.com) also take tokens.
5. Off Cloudflare, or on Sites without request.cf, clientKey() is 'shared', so 10 proofs per minute is the total for all users in the isolate. One client cycling resolvable random hosts (wildcard DNS) blocks every user's new verifications.
6. On any deployment, an attacker can evict legitimate pass memos for free. NXDOMAIN hosts fail at line 1076 without taking a strict token, and 180 random hosts per minute per IP churn the 2,000-entry `verdicts` Map. That Map evicts by insertion order (get does not refresh it), so pass entries are evicted and legitimate users must spend strict tokens to re-prove those domains.

**Suggested fix.** 1. Charge the strict budget only for proofs that do not pass. Before the proof, refuse only if the client is already known to be over budget: peek the local bucket, or with the binding keep a per-isolate `strictBlockedUntil` Map that is set when a post-proof limit() returns success:false. After a 'fail' or 'unknown' proof, call rateLimit('verify', call, true) to consume the token. A genuine Substack domain then never costs budget, and abusive hosts (which always fail) are still capped.
2. Keep pass verdicts in their own bounded Map, separate from fail and unknown verdicts, so failures can never evict passes.
3. Refresh LRU order on a memo hit: delete and set in verifyCustomDomain before returning the memo.
4. Optionally raise RL_STRICT to about 30 per 60 s for the shared-key case.

**Skeptic's reasoning.** The core mechanism is real. runChecks calls `await admit()` (relay.ts:1077) before every mapping proof, including ones that then pass. A genuine Substack custom domain that DNS cannot prove (for example, proxied through the publisher's own Cloudflare zone) therefore costs one 'verify' token per cold verification: RL_STRICT is 10 per 60 s per key per colo, or the 10 per minute local bucket. Only DNS passes and memo hits are free, as the S6 test documents.

On workers.dev the docs call the Cache API best-effort, so passes may live only in the isolate's `verdicts` Map. On a cold isolate, a user following more than 10 such domains gets 429 RATE_LIMITED for the rest of Latest. RATE_LIMITED is not in FEED_FALLBACK_CODES (controller.ts:123), so there is no fallback.

The finding overstates two sub-claims:
1. Shared key ('shared', off Cloudflare). The ordinary per-route bucket is also global there (60 per minute for everyone), and a client can already starve that. Starving the strict budget is not a distinct new hole.
2. Map churn. Round-1 S6 already noted this and it was not fixed. It got slightly cheaper: NXDOMAIN and 'unknown' outcomes are now remembered, so they enter the FIFO Map without a proof fetch or strict token. `verdicts.get()` does not refresh order. It only forces re-proofs where the Cache API holds nothing; otherwise storedVerdict reloads the pass.

It is low because it needs more than 10 proof-only (proxied, Orange-to-Orange (O2O)) custom domains per user per cold isolate, which is rare, and it heals within a minute.

**Fix notes.** 1. Charge the strict budget only for proofs that do not pass:
   - Before the proof, refuse only when the client is already known to be over budget. Keep a per-isolate `strictBlockedUntil: Map<clientKey, number>`. Set it when a strict limit() returns success:false, or from takeToken's wait for the local bucket.
   - After mappingProof returns 'fail' or 'unknown', call `rateLimit('verify', call, true)` and, if it throws, record the block.
   - A passing proof never costs budget. Abusive hosts always fail, so they are still capped after at most one extra proof per window.
2. Keep pass verdicts in their own bounded Map (for example, 2,000 entries), separate from fail and unknown, so free NXDOMAIN churn cannot evict passes.
3. On a memo hit in verifyCustomDomain, `verdicts.delete(host); verdicts.set(host, memo)` to make eviction LRU.
4. Add a test: 12 proof-only domains that pass for one IP with strictRateLimitPerMinute 10 should all return 200.

### relay:Y3 (low, confirmed)

`worker/relay.ts:1022`

**Summary.** Round-1 S3 is only half fixed. Hosts with no addresses now fail correctly. A host whose DNS answers definitively and points away from Substack but does not serve HTTPS still becomes 'unknown': a lapsed or parked domain, connection refused, a TLS error, or a Cloudflare 52x/530 with no origin. It is reported as UPSTREAM_UNAVAILABLE and now re-proved every 60 s against the user's strict budget.

**Failure scenario.** 1. A followed publication's custom domain lapses and now resolves to a parking IP that refuses TLS, or to a Cloudflare zone with no origin (530 with no fingerprint).
2. A/AAAA are non-empty, so line 1076 does not fire. mappingProof's get() throws, which returns UNKNOWN at :1023, or gets status ≥500, which inconclusive() turns into UNKNOWN.
3. runChecks returns 'unknown' with a 60 s memo. The user sees 'Substack is temporarily unavailable.' (503) indefinitely, the client runs the feed fallback, and the add flow's www retry never triggers.
4. Each Latest refresh more than 60 s after the last one re-runs DoH plus the proof and takes a 'verify' token. A few lapsed domains are enough to push the user's other proofs into 429 (see Y2).
5. The round-1 S3 fix notes explicitly asked for this case: treat a network error or 530 as 'fail' when DNS was definitive.

**Suggested fix.** 1. Pass `dnsDefinitive = cname !== null && a !== null && aaaa !== null && target !== null` from runChecks into mappingProof.
2. When dnsDefinitive is true, map these first-fetch outcomes to `{ verdict: 'fail', ttlMs: VERDICT_NO_ADDRESS_MS }`, which is HOST_NOT_SUBSTACK and stored for 10 min: a network error that is not a timeout (`!clock.expired()`), and an unfingerprinted 52x/530.
3. Keep timeouts and fingerprinted 429/5xx as UNKNOWN.
4. Add a relay test: a host with A records whose proof fetch throws should give 403 HOST_NOT_SUBSTACK with a 10-min stored verdict.

**Skeptic's reasoning.** This is unfixed round-1 scope, not a regression. Round-1 S3's summary explicitly covered a host that 'exists but does not answer HTTPS', and its suggested_fix asked to treat a network error or 530 as 'fail' when DNS is definitive. The commit implemented only the no-address short-circuit (relay.ts:1076).

With A/AAAA records present and no intersection with the target, mappingProof's first get():
- throws, giving UNKNOWN at :1023, or
- returns 5xx, which inconclusive() maps to UNKNOWN.
runChecks (:1080) then returns 'unknown' with a 60 s memo, so a lapsed or parked domain that refuses TLS, or a Cloudflare zone with no origin, gets 503 UPSTREAM_UNAVAILABLE indefinitely. That triggers the useless feed fallback and skips the www retry.

New since round 1: each re-verification after the 60 s memo spends a strict 'verify' token (admit at :1077). The 60 s memo is an improvement over 5e893eb, which never cached it.

The impact is recoverable and not a security issue.

**Fix notes.** 1. Pass `dnsDefinitive = cname !== null && a !== null && aaaa !== null && target !== null` from runChecks into mappingProof(host, dnsDefinitive).
2. When dnsDefinitive is true, return `{ verdict: 'fail', ttlMs: VERDICT_NO_ADDRESS_MS }` (needs the optional Outcome.ttlMs from Y1) in two cases:
   - get() throws and `!clock.expired()` (a connection or TLS error, not a timeout);
   - an unfingerprinted 530.
3. Keep timeouts, 429, 502, 503, 504 and 520-524 as UNKNOWN. An Orange-to-Orange (O2O)-proxied genuine Substack domain returns unfingerprinted 52x during a Substack origin outage, and caching that as a fail would wrongly show HOST_NOT_SUBSTACK for 10 min.
4. Test: a host with A records whose proof fetch throws a TypeError should give 403 HOST_NOT_SUBSTACK with a stored fail at now+600 000. A proof fetch that times out should still give 503 UPSTREAM_UNAVAILABLE and nothing stored.

### relay:Y4 (low, confirmed)

`worker/relay.ts:1139`

**Summary.** The strict-budget check (admit) runs inside the verification promise that all concurrent callers share through pendingVerdicts. If the client that started the verification is over its 'verify' budget, every other client waiting on the same host also receives that client's 429 RATE_LIMITED and Retry-After, even though they have budget left.

**Failure scenario.** 1. Client A, an abuser or simply a user over budget, requests /v1/archive?host=H for a cold, proxied custom domain H. verifyCustomDomain starts `work` with A's call and stores it in pendingVerdicts.
2. Client B requests H while A's DoH lookups are in flight. B takes the `pending` branch at :1139 and awaits A's promise.
3. A's admit() throws RATE_LIMITED, so B also gets 429 with A's retryAfterSeconds. Nothing is remembered.
4. An attacker who has used up their own verify budget can keep H pending almost continuously, at up to 180 requests per minute across the three host routes with roughly 100-300 ms DoH windows. Any legitimate user verifying H in that isolate then mostly gets 429.

**Suggested fix.** In the pending branch, retry under the waiter's own identity when the shared work failed only because of the originator's budget:
`if (pending) return pending.catch(error => { if (error instanceof RelayFailure && error.code === 'RATE_LIMITED') return verifyCustomDomain(host, call); throw error })`
The waiter then runs its own checks and spends its own budget. Retries are bounded, because each one is preceded by a full DoH round started by another caller.
Alternatively, split the work: share the DNS stage, and call admit per caller before joining a shared proof.

**Skeptic's reasoning.** The mechanism is verified.
- verifyCustomDomain builds `work` with the originator's `call`. runChecks' `admit` is `() => rateLimit('verify', call, true)` (:1146), and `work` is stored in pendingVerdicts (:1157).
- A concurrent caller for the same host returns `pending` directly (:1139).
- If the originator's strict budget is exhausted, admit throws RelayFailure('RATE_LIMITED', {retryAfterSeconds: <originator's wait>}). That rejects the shared promise, so every waiter gets 429 with the originator's Retry-After although its own budget is untouched.
- Nothing is remembered on that path, so the host stays cold and the pattern can repeat.

The reverse case is harmless: an over-budget waiter piggybacks for free.

It is low because:
- The waiter must hit the same isolate during a window of about two DoH round trips (roughly 100-300 ms).
- Targeted abuse is unreliable across a colo's many isolates.
- Accidental collisions need a client that is over budget (see Y2) to be cold-verifying the same host at the same moment.

**Fix notes.** Keep the originator's budget failure out of the shared promise. In verifyCustomDomain's pending branch:
```ts
if (pending) return pending.catch(error => {
  if (error instanceof RelayFailure && error.code === 'RATE_LIMITED') return verifyCustomDomain(host, call)
  throw error
})
```
- The originator's `finally` runs first, because its `await work` reaction was registered first, so the retry starts a fresh verification under the waiter's own budget or joins a newer one.
- The retries are bounded, because each needs another caller's full DoH round.
- Cleaner alternative: share only the DNS and stored-verdict stage. Have the shared work resolve to a `needsProof` sentinel, call `admit` per caller, then share a separate `pendingProofs` promise.
- Add a test: two concurrent requests for one cold proof-only host, where the first IP is over budget. The second IP should get a verdict (200 or 403 HOST_NOT_SUBSTACK), not 429.

### runtime:K1 (low, uncertain)

`src/app/controller.ts:939`

**Summary.** The G4 fix intercepts every action except the root double-tap while displayStale is set. 'back' and 'hold' inside the reader or a list, and every contextual-menu item including 'Home' (menu:1), are turned into forceRedraw. When a frame keeps failing, the wearer cannot leave it. Round 1 asked that back, hold and menu actions keep running normally.

**Failure scenario.** The reader is on a page whose body the G2 refuses on every attempt: textContainerUpgrade returns false on the retry too, a RangeError comes from isReaderPage after normalizeReaderText, or every full write times out on a slow link (see R2). draw() rejects and displayStale becomes true. The wearer double-taps to go back: stack.length is 2 or more, so forceRedraw sends the same frame, it fails again, and displayStale stays true. Long press, the contextual menu (Home, Next post, Refresh) and the phone's Remote, Back and 'glasses-home' buttons all call controller.onAction, so every one of them is turned into a failing redraw too. The user is stuck on that post until the Even app is force-closed. Before 247981a, a failed frame left the old frame on the display, but back and next still worked.

**Suggested fix.** Intercept only navigation that depends on the frame on display: `if (displayStale && (action === 'next' || action === 'previous' || action === 'select')) return forceRedraw()`. Let 'back', 'hold' and 'menu:*' dispatch normally, because they change the view and draw a new frame. Also limit the interception to one per stale frame: record `staleRedrawSeq = drawSeq` when forceRedraw is issued because of displayStale. If the following action finds displayStale still true and staleRedrawSeq unchanged (the redraw failed too), clear displayStale and dispatch the action, so a frame that always fails cannot trap navigation. Add controller tests in which render always rejects: back from the reader returns to the list, and menu:1 reaches Home.

**Skeptic's reasoning.** The code does what the finding says. Line 939 sends every action except the root double-tap to forceRedraw while displayStale is set, including back/hold below the root and every menu:* item (Home too), plus the phone Remote and 'glasses-home' buttons. If the redraw is refused again, displayStale stays true (seq === drawSeq). This differs from round-1's G4 guidance (intercept only next/previous/select), but it is deliberate: controller.test.ts lines 694-705 assert that 'a menu item redraws instead' and 'so does double-tap below the root', and docs/glasses.md line 110 documents it. Intercepting menu:2 (Save for later on a cursor the wearer never saw) is justified. Intercepting back, hold and menu:1 gains nothing. The claimed trap needs a frame that fails every time while other frames would succeed. I found no deterministic cause. Every frameFor body goes through fitBody, and paginate normalizes before measuring, so the RangeError path is not reachable. While disconnected, or on R2's slow link, every frame fails, and back would not help either. With transient refusals the cost is one swallowed back or Home gesture. Whether the trap happens depends on unverified device refusal behavior.

**Fix notes.** Limit the interception to actions that act on the frame on display: `const cursorAction = action === 'next' || action === 'previous' || action === 'select' || action === 'menu:2' || action === 'menu:3'`, then `if (displayStale && cursorAction) return forceRedraw()`. Let back, hold, menu:1 (Home), menu:4 and menu:5 dispatch, because they draw a new frame. Also intercept only once per stale frame: record `staleRedrawSeq = drawSeq` when forcing. If the next action finds displayStale still set and drawSeq === staleRedrawSeq + 0 (the forced redraw failed too), clear displayStale and dispatch normally. Update the test at controller.test.ts 694-705 and add one where render always rejects: back from the reader reaches the list, and menu:1 reaches Home.

### runtime:R2 (low, uncertain)

`src/glasses.ts:253`

**Summary.** SCREEN_TIMEOUT_MS bounds a whole frame: up to 3 sequential textContainerUpgrade calls plus up to 3 retries 150 ms apart. It does not bound each native call. On a slow link a full 3-field frame takes longer than 5 s and times out even though every write lands. writeFrame then throws in abandoned() after the last field, onLate sets last = null and calls queueRender(wanted), which sends a full 3-field frame again. That frame times out the same way, so the cycle repeats with no limit. Meanwhile the controller's displayStale turns every gesture into forceRedraw, another full frame that also times out, so the app livelocks.

**Failure scenario.** Each upgrade takes about 2 s at the edge of BLE range. Page turns (body + footer, about 4 s) still succeed, but one transient failure, or any reconnect (onReconnect -> controller.redraw -> invalidate), forces a 3-field write of about 6 s. At 5 s the bound rejects: onScreenError reports 'G2 did not answer in time.' and the controller sets displayStale. At 6 s the footer lands, abandoned(live) throws and onLate re-queues the same frame with last = null: another 6 s write, another timeout, another late answer, and so on forever. Each swipe the user makes becomes forceRedraw, a full 6 s write that also times out, so displayStale is never cleared and pages cannot be turned. The timed-out writes overlap the next queued call on the BLE link, which slows it further. Before the fix, these frames were merely slow.

**Suggested fix.** (1) Bound each bridge call, not the frame. In writeFrame, race each `upgrade()` against its own timer, about 4 s per call, inside the operation; give queue.run('screen') a frame bound of at least 3 × per-call + 3 × UPGRADE_RETRY_MS, or no outer bound. (2) When a timed-out writeFrame still completes every field (the loop finishes but live() is false) and `wanted === snapshot`, set `last = snapshot` and call link.written() instead of throwing into a re-render. Re-render on a late answer only when a newer frame was requested after the late one started. (3) Limit late re-renders to one per wanted snapshot (keep `lateRetried = snapshot` and skip when it is equal). (4) Optionally let a late completion clear the controller's displayStale through a callback such as opts.onFrameShown, so the next gesture is not used up by a redraw.

**Skeptic's reasoning.** The mechanism is real. queue.render(SCREEN_TIMEOUT_MS, ...) bounds the whole writeFrame (up to 3 upgrades plus 150 ms retries) with one 5 s timer. When the timer fires, bounded() rejects, so onScreenError sets last=null and the controller sets displayStale. The in-flight upgrade then resolves, and the next abandoned(live) throws, either before the next field or at the end. finish() calls late('screen'), and onLate sets last=null and queues wanted again as a full 3-field write. That write hits the same bound. There is no counter and no check that the late frame was the wanted one, so the cycle repeats for as long as the latency lasts. Each user gesture becomes another full forceRedraw. It does need sustained latency of about 1.7 s or more per textContainerUpgrade (about 1.25 s with one refusal-retry) to push a full frame past 5 s. Research puts create at about 100-135 ms, and the documented hazard is a single ~30 s hang. A single hang recovers after one late re-render at normal speed. Whether sustained multi-second upgrades happen at the edge of BLE range cannot be checked here. Before 247981a such frames were only slow.

**Fix notes.** 1) Track `last` per field: after each accepted upgrade, when the display epoch is unchanged (see R3), set `last = { ...(last ?? blank), [field]: snapshot[field] }` so a re-render after a timeout rewrites only the missing fields and converges. 2) In onLate, skip the re-render when the late operation was the wanted snapshot and it wrote every field. Have writeFrame record `completed = snapshot` before abandoned() throws at the end, and set last = snapshot (link.written()) instead. 3) Allow at most one late re-render per wanted snapshot (`lateRetried === wanted` guard). 4) Optionally bound each native call (about 4 s inside writeFrame) and give the frame an outer bound of at least 3 × per-call + 3 × UPGRADE_RETRY_MS. 5) Optionally add GlassesOptions.onFrameShown so a late full completion clears the controller's displayStale.

### runtime:R5 (low, uncertain)

`src/glasses.ts:251`

**Summary.** Storage writes now time out at 4 s and the queue moves on, but onLate ignores late 'storage' results. A timed-out setLocalStorage that lands after a newer write leaves the bridge holding the older document, while the store believes the newer stamp is stored. The strict serialization before 247981a ruled out this reordering.

**Failure scenario.** W1 (prefs at T2, after the user removed X) hangs in setLocalStorage. After 4 s bridgeKV.set returns false, so dirty=true and onSaved(false). The user adds Y, and the debounced flush runs W2 (prefs at T3, without X, with Y), which the queue starts immediately and which succeeds, so savedAt.prefs = T3. W1 then completes natively and the bridge holds the T2 document without Y. Nothing marks prefs dirty again. On the next launch the bridge is at T2 and the mirror at T3, and the merge (R1) brings X back, or Y is missing wherever the mirror was lost.

**Suggested fix.** Surface late storage completions. Have onLate('storage') call a new GlassesOptions.onStorageLate?(). In main.ts, wire it to a new store.resync() that marks both documents dirty, sets changedAt to now and schedules a flush, so the newest documents are written after the late one. Alternatively, make storage writes carry their stamp, and on a late completion compare it with savedAt[name] and rewrite when the late stamp is older.

**Skeptic's reasoning.** onLate (glasses.ts line 251) ignores kind 'storage'. A setLocalStorage that times out makes bridgeKV.set return false (dirty stays true) and lets the queue move on, so a newer write W2 can start and succeed while W1 is still pending natively. The bridge ends up holding W1's older document only if the host applies W1 after W2. A FIFO native handler would apply W1 first and W2 would win. The ordering is host behavior that cannot be checked here. The scenario also overstates the damage: W1 (T2) already lacks X, so the union cannot bring X back. The real harms are Y missing wherever the mirror was lost, or a resurrection when W1 contained an item W2 removed (the R1 class). The reordering was ruled out before only because a hung call blocked everything (round-1 G1), so this is an accepted trade-off unless the host reorders.

**Fix notes.** Pass late storage completions up. Extend BridgeQueueOptions.onLate to (kind) as today, and in glasses.ts forward kind==='storage' to a new GlassesOptions.onStorageLate?(). In main.ts wire that to a new store.resync() that marks both documents dirty (changedAt = now) and schedules a flush, so the newest documents are written after the late one. Alternatively, tag each storageSet with its savedAt, and on a late completion rewrite when that stamp is older than savedAt[name].

### runtime:R7 (low, refuted)

`src/main.ts:108`

**Summary.** libraryReady() runs after controller.configurationChanged() in both attach branches. If configurationChanged throws, the store's observer guard swallows the error in onApplied, so libraryLoading stays true for the whole session and every library edit is refused with 'Loading your library…'. In the failure branch, a throw also skips libraryReady() and scheduleRetry(): the trailing `.catch(() => undefined)` swallows it, so nothing retries until the next foreground.

**Failure scenario.** The bridge library loads, onApplied(changed=true) calls controller.configurationChanged(), and syncHome, repaginate or frameFor throws on unexpected merged data. createStore catches it ('Observer errors are isolated'), attachBridge resolves and store.attached() becomes true, so no further attach happens. libraryReady() never ran: the Publications, Saved and Settings panels show the loading card permanently, and every LIBRARY_ACTIONS button and the add form refuse input.

**Suggested fix.** Call libraryReady() first in both branches, and isolate the controller call: `libraryReady(); try { if (changed || wasLoading) controller.configurationChanged() } catch { /* drawn on next action */ }`, capturing wasLoading before libraryReady(). In the rejection branch, run scheduleRetry() before any observer call, or wrap that call in try/catch.

**Skeptic's reasoning.** The ordering is as described: libraryReady() runs after controller.configurationChanged() in both branches, and the store's observer guard plus the trailing .catch would swallow a throw. However, no reachable throw exists. configurationChanged works on normalized state only. syncHome, syncPublications and selectKey are index arithmetic, repaginate calls paginate on article text already paginated once, and draw() isolates deps.render and notifyPhone in try/catch. Every frameFor body goes through fitBody. The failure scenario assumes an unspecified exception 'on unexpected merged data' that the normalizers rule out. markApplied still runs in .finally, so the glasses start is not blocked either. This is hardening, not a defect at 247981a.

**Fix notes.** Optional hardening: capture `const wasLoading = libraryLoading`, call libraryReady() first, then `try { if (changed || wasLoading) controller.configurationChanged() } catch { /* drawn on the next action */ }`. In the rejection branch, call scheduleRetry() and libraryReady() before any controller call, or wrap that call in try/catch.

### runtime:R8 (low, uncertain)

`src/glasses.ts:321`

**Summary.** createStartUpPageContainer is still called outside the serialized bridge queue, but storage calls now start before it. The 1.5 s head start ends at markApplied, which runs before attach's write-back flush, or at the bound, when reads may still be in flight. Page creation therefore overlaps getLocalStorage/setLocalStorage, which breaks the 'one serialized chain for every bridge call' rule (SPEC 3.1 item 7) that the rest of the module now enforces.

**Failure scenario.** With a mirror that differs from the bridge, attach merges and calls onApplied, so settleWithin resolves. It then marks the documents dirty and flushes two setLocalStorage calls through the queue. connectGlasses continues at once into createStartUpPageContainer while those writes are in flight. Likewise, if the bridge reads take more than 1.5 s, create runs alongside the pending getLocalStorage. If the host does not support concurrent calls, as the serialization rule assumes, page creation or the storage write can fail. A non-zero create result leaves the session without glasses: no retry, phase 'nobridge'.

**Suggested fix.** Run the create through the queue: `const result = await queue.run('screen', CREATE_TIMEOUT_MS, () => bridge.createStartUpPageContainer(...))`, with a bound longer than SCREEN_TIMEOUT_MS. It then waits for queued storage calls, and later calls wait for it. Alternatively, await a queue drain (queue.run('storage', STORAGE_TIMEOUT_MS, async () => undefined)) right before create.

**Skeptic's reasoning.** This is accurate as a description. settleWithin(ready, 1500) ends at markApplied, which runs inside onApplied before attach's mirror refresh and bridge write-back flush, or else at the 1.5 s bound. createStartUpPageContainer is called directly, not through queue.run. It can therefore overlap setLocalStorage write-backs (whenever merged != remote) or slow getLocalStorage reads, which breaks the module's own 'one serialized chain' rule. At 5e893eb the attach ran only after create, so the overlap is new. Whether the Even host handles concurrent bridge calls badly is device and host behavior, and the result of an overlap cannot be shown here. In the common in-sync relaunch there is no write-back, so overlap needs divergence or slow reads.

**Fix notes.** Run the create through the queue: `const result = await queue.run('screen', CREATE_TIMEOUT_MS, () => bridge.createStartUpPageContainer(...))` with CREATE_TIMEOUT_MS of about 8 s (longer than SCREEN_TIMEOUT_MS). Note that onScreenError would then report a create timeout, which is acceptable because create failure is already fatal. A smaller alternative is to drain the queue right before create with `await queue.run('storage', STORAGE_TIMEOUT_MS, async () => undefined).catch(() => undefined)`. That still lets later storage calls overlap create, so the queue.run form is better.

### runtime:R9 (low, uncertain)

`src/glasses.ts:248`

**Summary.** onLate re-sends the wanted frame after any late screen call, including a late shutDownPageContainer(1). An exit that timed out and then opens the OS exit dialog is immediately followed by textContainerUpgrade calls that write over or disturb the dialog the wearer is meant to answer.

**Failure scenario.** The root double-tap queues exit(), and shutDownPageContainer(1) takes more than 5 s on a busy link. It times out, onScreenError reports an error, and the wearer double-taps again, queuing a second exit. The first call then lands, the OS exit dialog appears, and onLate runs: last = null and renderPending() is false, so queueRender(wanted) writes all three containers while the dialog is up, followed by the second shutDownPageContainer. Whether the dialog is dismissed or hidden depends on the device. Either way, the store-review rule that a root double-tap shows a usable exit dialog is at risk.

**Suggested fix.** Let the queue report which call settled late. For example, change onLate(kind) to onLate(kind, label), with exit using label 'exit'. Alternatively, set `exitPending = true` in exit() and clear it on the next queueRender from the controller. Skip the late re-render when the late call was an exit. Instead, set last = null so that the next controller render resends every field.

**Skeptic's reasoning.** In the code, a timed-out exit() that settles later reaches onLate('screen'), which sets last=null and queues `wanted` (all three containers) whenever no render is pending. The SDK documents only 'exitMode 1 shows the foreground interaction layer; the user decides whether to exit'. It does not say whether the promise resolves when the dialog appears or when the user answers. If it resolves when the dialog appears, the late re-render can land on top of the dialog, as the finding describes. If it resolves on the user's choice, a dialog left open for more than 5 s causes a spurious 'G2 did not answer in time.' and lets queued renders and storage calls run under the dialog, and a cancel then triggers a late re-render (which is desired). Either way the impact depends on unverified host and dialog behavior.

**Fix notes.** Let the queue say which operation settled late: change onLate(kind) to onLate(kind, tag) and have exit() run with tag 'exit'. In glasses.ts onLate, when tag === 'exit', only set last = null (and increment the R3 epoch) and do not queue a re-render. The controller's next render resends every field. Also consider a longer bound for exit (for example 30 s) with no screen-error report on its timeout, in case shutDownPageContainer(1) resolves only on the user's decision.

### relay:Y5 (low, uncertain)

`worker/relay.ts:1100`

**Summary.** Round-1 S4 is only partly fixed. Cache keys are now `${url.origin}/__relay-cache/p1/...`, but anyone sharing caches.default can compute that origin, so a co-tenant can still write a forged { verdict: 'pass' } with expires up to now+24h, which passes the new upper-bound check. replay() still serves any cached 200 body. The per-deployment salt or HMAC from the round-1 fix was not implemented, and docs/relay.md now overclaims isolation.

**Failure scenario.** On a platform where caches.default is shared, such as Sites or a zone shared with other Workers:
1. A co-tenant runs `cache.put('https://<relay-origin>/__relay-cache/p1/host-verdict?host=evil.tld', {verdict:'pass', expires: Date.now()+23*3600e3})`.
2. storedVerdict accepts it, because the expiry is at most now + VERDICT_PASS_MS, and the relay proxies evil.tld for 23 h.
3. Alternatively, the co-tenant puts a forged envelope at `<ns>/v1/post?host=on.substack.com&slug=x`, and app users are served the forged post.
4. docs/relay.md rule 9 says relays at different origins 'never read each other's entries', which is true only for honest neighbours.

**Suggested fix.** Use the round-1 option that works everywhere:
- In verifyCustomDomain, read only 'fail' verdicts from the Cache API and keep 'pass' in isolate memory only. A forged fail is merely a self-DoS.
- Or HMAC the stored verdict JSON and cached bodies with a Worker secret (env.CACHE_SECRET) and verify the HMAC in storedVerdict and replay.
- Optionally add env.CACHE_SALT to cacheNs.
- Reword docs/relay.md rule 9 so it does not promise isolation from co-tenants.

**Skeptic's reasoning.** The code facts are accurate. cacheNs is `${url.origin}/__relay-cache/p1`, which anyone can compute. storedVerdict (:1109-1110) accepts any pass with now < expires ≤ now+24h, so a forged entry with expires now+23h is accepted. replay() still serves any cached 200. No salt or HMAC was added.

So S4 is only partly addressed: the cheap expiry bound and per-origin separation for honest deployments are in; protection against co-tenant writes is not. Round-1 S4's own fix notes said an origin prefix does not help against a co-tenant.

Exploiting it still depends on platform behaviour that cannot be verified here: whether untrusted code can cache.put into the relay's caches.default namespace under the relay's hostname. On Cloudflare the cache is the owner's zone, and on workers.dev it is best-effort or a no-op. For OpenAI Sites tenant isolation it is unknown.

Round-1 rated this 'uncertain'/low, and nothing changes that. The docs wording ('never read each other's entries') is true for honest relays and only implies isolation from hostile ones.

**Fix notes.** Portable option: in verifyCustomDomain, read only 'fail' verdicts from the Cache API, so storedVerdict ignores 'pass'. Keep passes in the isolate Map, ideally the separate pass Map from Y2. A forged 'fail' is only a self-DoS, bounded at 1 h by the existing expiry cap.

Where secrets exist, HMAC the verdict JSON and the cached envelopes with env.CACHE_SECRET, using crypto.subtle HMAC-SHA-256 over key + body, stored in a response header. Verify it in storedVerdict and replay, treating a mismatch as a miss.

Reword docs/relay.md rule 9 to: 'keys are namespaced per relay origin; the edge cache is trusted, so do not deploy where untrusted code shares caches.default'.

### relay:Y6 (low, refuted)

`pnpm-workspace.yaml:1`

**Summary.** Adding wrangler as a devDependency brings in workerd, whose postinstall pnpm skips: node_modules/.modules.yaml lists ignoredBuilds [workerd@1.20261006.1], because allowBuilds lists only esbuild. `wrangler deploy` does not need that script, since the platform binary comes from an optionalDependency resolved at runtime. The decision is left implicit, though: every install (ci.yml, release.yml, deploy) warns, and it fails outright under strictDepBuilds, which pnpm 11 makes the default.

**Failure scenario.** 1. Anyone running pnpm with strict-dep-builds=true, or after a future packageManager bump to pnpm 11, runs `pnpm install --frozen-lockfile`.
2. The install exits with an ignored-builds error for workerd, and the deploy workflow plus every CI job fail at the install step.
3. Today, under pnpm 10.32.1, the only effect is an 'Ignored build scripts: workerd' warning on every install.

**Suggested fix.** Make the review decision explicit in pnpm-workspace.yaml:
```
allowBuilds:
  esbuild: true
  workerd: false
```
`wrangler deploy` and `pnpm exec wrangler` work without workerd's install.js, and leaving it disabled keeps a lifecycle script from running in workflows.

**Skeptic's reasoning.** No failure happens with 247981a:
- package.json pins `packageManager: pnpm@10.32.1`.
- ci.yml, deploy-relay.yml and release.yml all use pnpm/action-setup@v6 with `version: 10.32.1`.
- In pnpm 10 `strictDepBuilds` defaults to false, so an ignored workerd build is only a warning.
- The local node_modules/.modules.yaml shows the install completed, with ignoredBuilds: [workerd@1.20261006.1].
- `wrangler deploy` bundles with esbuild, which allowBuilds already permits, and does not need workerd's install.js; the platform binary comes from the @cloudflare/workerd-* optional dependency.

The finding itself says the only effect today is a warning. The failure needs a future pnpm 11 bump or an opt-in strict flag, and that would fail loudly at install with an obvious fix. This is configuration hygiene, not a defect in this commit.

**Fix notes.** Optional hygiene: add `workerd: false` under `allowBuilds` in pnpm-workspace.yaml so the decision is explicit and pnpm stops warning on every install.
