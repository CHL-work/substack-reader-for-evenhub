# Review round 3

- **Reviewed:** 04c2e0c (diff 247981a..04c2e0c)
- **Fixes landed in:** `228e20f`
- **Method:** Three lenses over the round-2 fix diff (storage + startup, glasses queue + controller, relay). The relay lens found nothing. The round-3 fixes were then reviewed again and came back clean.
- **Verdicts:** confirmed 7

Point-in-time record (2026-10-06/07). Line numbers refer to the reviewed commit, not to the current code. Ids repeat across lenses in round 1 (content C1–C6 and relay C1–C3), so the lens is part of the id.

## Summary

| Id | Lens | Severity | Verdict | File | Summary |
| --- | --- | --- | --- | --- | --- |
| A1 | storage-startup | low | confirmed | `src/storage.ts` | The sync-stamp ancestry check covers only one direction. When the bridge is ahead of sr:sync:v1 but the browser copy has not changed since that match, the bridge copy descends from the browser copy and should be adopted. Instead attach still unites the two wit |
| A2 | storage-startup | low | confirmed | `src/storage.ts` | The R5 fix (onStorageLate -> store.resync) can loop forever. Every late answer to a timed-out setLocalStorage, including one that answered false or threw, marks both documents dirty and rewrites them 800 ms later. If the host keeps answering storage writes in  |
| A3 | storage-startup | low | confirmed | `src/main.ts` | The loading gate is meant to keep the 'Loading your library…' frame on the glasses through the retries (main.ts:76-78, docs/architecture.md:79). Before controller.start(), three paths draw the controller's own frame over it, and for an empty browser copy that  |
| A4 | storage-startup | low | confirmed | `src/main.ts` | The new LIBRARY_UNREAD notice, 'Could not load your library from the glasses; edits will be merged later.', names the wrong source. Bridge storage is the Even app's storage on the phone (glasses.ts: 'Bridge storage lives on the phone and works without the page |
| B1 | glasses-queue-controller | low | confirmed | `src/glasses.ts` | The R5 fix (onLate 'set' -> opts.onStorageLate -> store.resync) has no ordering check and no once-guard, so it can loop forever. Every late setLocalStorage answer marks both documents dirty and rewrites them, even when the late write carried the newest documen |
| B2 | glasses-queue-controller | low | confirmed | `src/events.ts` | R9 is only half fixed. display.late() skips the recovery only when the late call was itself the exit. A late textContainerUpgrade answer that arrives while an exit is queued or running, or after the exit dialog appeared, still queues render(wanted). The queue  |
| B3 | glasses-queue-controller | low | confirmed | `src/app/controller.ts` | The new pre-start guard says 'nothing draws over that frame', but controller.redraw (wired to onReconnect) and the foreground redraw in onLifecycle still call forceRedraw() before start(). They draw the model's Home frame, and with the library not yet loaded t |

## Details

### storage-startup:A1 (low, confirmed)

`src/storage.ts:647`

**Summary.** The sync-stamp ancestry check covers only one direction. When the bridge is ahead of sr:sync:v1 but the browser copy has not changed since that match, the bridge copy descends from the browser copy and should be adopted. Instead attach still unites the two with mergePrefs/mergeProgress, so a removal, 'Clear reading' or 'Reset settings' that reached the bridge but not the browser copy is undone and written back to both stores. This is the R1 resurrection in the other direction.

**Failure scenario.** 1) Session N is attached. Mirror prefs are at T1 with publication X, and sr:sync:v1 = {prefs: T1}. 2) The user removes X (or confirms Clear reading or Reset settings). writeDirty writes the bridge (setLocalStorage returns true) and the mirror at T2. The mirror then loses that write in one of two ways: (a) localStorage.setItem threw, for example on quota. writeDirty still counts the save as a success because `primary ? first : second` is true, and records no stamp. (b) The Even app process is killed within a few seconds of the edit. Chromium commits localStorage lazily, so the doc write and the stamp written after it are both lost, while the host's native store kept the bridge write. 3) Next launch: the mirror is T1 with X, synced = T1, and the bridge is T2 without X. Line 647 sees remote.savedAt (T2) > synced (T1) and merges. localStamp T1 < T2, so newer = remote, and unionBy appends X from the older (local) copy. merged != remote, so dirty is set and X is written back to the bridge and the mirror. With progress, mergeProgress brings back every position, history entry and read id, plus lastOpen (`newer.lastOpen ?? older.lastOpen`). With settings, mergeSettings restores every field the user had just reset to its default. docs/architecture.md:77 lists only 'mirror lost or no stamp' as the case that merges.

**Suggested fix.** Record which mirror document each match refers to, and adopt the bridge when only the bridge moved.
1) Store SYNC_KEY as {prefs: {bridge, mirror}, progress: {...}}. Read the old numeric form as {bridge: n, mirror: -1}.
2) writeDirty: when both writes succeeded, record {bridge: stamp, mirror: stamp}. Attach refresh: record {bridge: remote.savedAt, mirror: remote.savedAt}. Attach inSync: record {bridge: remote.savedAt, mirror: <the mirror doc's savedAt as loaded>}.
3) Keep the mirror doc's loaded savedAt per document (loadedAt[name]) and update it whenever the mirror doc is written.
4) In attach, before line 647: `if (remote.savedAt > sync[name].bridge && !dirty[name] && loadedAt[name] === sync[name].mirror)`. The mirror is unchanged since the match, so handle it like the pristine branch: apply(remote), set changed = true, refresh the mirror with raws[name] and the new stamps, and write nothing to the bridge. Merge only when both copies changed since the match, or when there is no stamp.
5) Tests: a mirror at T1 with X, sync {T1,T1}, and a bridge at T2 without X: X stays removed and there are no bridge writes. Add the same check for a cleared progress doc and a reset settings doc on the bridge.

**Skeptic's reasoning.** Traced at 04c2e0c. In writeDirty (storage.ts:706-712), when the bridge set returns true and the mirror set returns false, `primary ? first : second` counts the write as a success: savedAt becomes T2 in memory, dirty is cleared, and no stamp is pushed, so SYNC_KEY stays at T1. browserKV.set returns false on a quota or blocked-storage throw, and safeSet maps a throw to false, so this case is one the code is built to handle. On the next load the mirror document is T1 with X and synced = T1, because load keeps the stamp when the document exists (line 754). In attach, the document is not pristine (savedAt T1 > 0), remote.savedAt T2 > synced T1 (line 647), and localStamp = T1 < T2, so newer = remote and older = local. mergePrefs uses unionBy(remote, local), which appends X. mergeSettings takes each field that is still default on the newer (reset) copy from the older copy. mergeProgress unites positions, history and read, and resolves lastOpen as `null ?? older.lastOpen`. merged != remote, so line 663 sets dirty and the attach's flush writes the resurrected document to both stores. No later step corrects it. This is not a regression, since 247981a always merged; it is the mirror-image direction of R1, left unhandled. The kill-before-commit trigger (b) depends on WebView commit timing on the device, but trigger (a) runs deterministically through the code. Low: it needs a mirror write failure or loss while the bridge write succeeds.

**Fix notes.** Adopt the bridge copy when only the bridge moved since the last match.
(1) Simplest form: make the mirror document's savedAt always equal synced at match time. In attach, give the inSync branch (line 668) the same treatment as refresh: copy raws[name] to the mirror and stamp it, so a matched mirror document always carries savedAt === synced[name]. writeDirty and the refresh paths already keep them equal.
(2) In attach, before line 647: `if (!dirty[name] && savedAt[name] === synced[name] && remote.savedAt > synced[name]) { if (!sameContent(remote, local)) { apply(name, remote); changed = true } savedAt[name] = remote.savedAt; size[name] = raws[name].length; refresh.push({ name, raw: raws[name], stamp: remote.savedAt }); continue }`. Before attach, savedAt changes only through load or a mirror-only write, and that write always picks a stamp greater than the previous savedAt. So the equality means the mirror is unchanged since the match, and the bridge descends from it.
(3) If the inSync path is kept as it is, use the reviewer's variant instead: store SYNC_KEY as {name: {bridge, mirror}} and compare the loaded mirror savedAt with sync.mirror.
(4) Update docs/architecture.md:76-77.
(5) Add unit tests: a mirror at T1 with X, synced T1 and a bridge at T2 without X keeps X removed and makes zero bridge writes. Add the same check for a Clear-reading progress document (lastOpen stays null) and a Reset-settings prefs document.

### storage-startup:A2 (low, confirmed)

`src/storage.ts:770`

**Summary.** The R5 fix (onStorageLate -> store.resync) can loop forever. Every late answer to a timed-out setLocalStorage, including one that answered false or threw, marks both documents dirty and rewrites them 800 ms later. If the host keeps answering storage writes in more than STORAGE_TIMEOUT_MS (4 s), each rewrite times out, answers late and triggers the next one. The screen path got a 'one late redraw per frame' guard (lateRetried); the storage path has no bound.

**Failure scenario.** setLocalStorage answers after about 5 s (a busy Even app or host).
1) A save runs writeDirty. The prefs set times out at 4 s, so bridgeKV.set returns false, dirty = true and onSaved(false). The same happens to progress, about 8 s in total.
2) Each native call then settles. events.ts:260 calls late('storage','set') whatever the outcome, glasses.ts:258 calls onStorageLate, and main.ts:203 calls store.resync().
3) resync -> markDirty(prefs, progress) -> flush 800 ms later -> two more 4 s timeouts -> two more late answers -> resync again, and so on.
The cycle repeats every ~9 s for as long as the host stays slow, with no user action. The single bridge queue is held by storage calls about 8 s of every 9, so each glasses page turn waits up to 4 s behind them. The phone shows 'Could not save' every cycle and the app keeps sending 48k-character documents. Before 04c2e0c a late storage answer did nothing, so a slow host only delayed user-triggered saves.

**Suggested fix.** 1) events.ts bounded(): pass the late outcome, `late(kind, label, ok && value === true)`. In glasses.ts onLate, call onStorageLate only when label === 'set' and the late write actually stored. A late false or a late rejection stored nothing.
2) storage.ts: allow at most one late-triggered rewrite until a bridge write succeeds again. Add `let resyncSpent = false`. In resync(): `if (!primary || resyncSpent) return; resyncSpent = true; markDirty(names)`. Clear resyncSpent in writeDirty when a bridge write returns true, and in save(). A doc whose rewrite times out stays dirty and goes out with the next user save, and sr:sync:v1 still protects the next launch.
3) Optionally pass the key so only that document is rewritten.
4) Test: a bridge KV whose set answers after 5 s with a fake clock. After one save, advance 60 s and expect at most 2 rewrites per document.

**Skeptic's reasoning.** Traced at 04c2e0c. In bounded() (events.ts:258-261), finish() calls late(kind, label) whenever a timed-out call settles. That covers resolve(true), resolve(false) and a rejection alike. glasses.ts:258-262 forwards every late 'set' to onStorageLate, and main.ts:203 calls store.resync(). resync (storage.ts:770-775) marks every document with savedAt > 0 dirty and schedules a flush 800 ms later. writeDirty then issues one bridge set per document through queue.run('storage', 4000). If setLocalStorage keeps answering after more than 4 s, each set times out and returns false, so the document stays dirty and onSaved(false) fires. Each set then answers late and triggers resync again, so the cycle runs about every 8-9 s with no user action. No guard comparable to the screen path's lateRetried exists, and nothing clears the loop except the host answering within 4 s. While it runs, each storage call holds the queue tail for up to 4 s, so render calls wait behind it. A late `false` or a late rejection, which stored nothing, also triggers a full rewrite. Before 04c2e0c a late storage answer did nothing. The loop only runs while the host stays slow, but late answers are exactly the condition this commit was written to handle.

**Fix notes.** (1) events.ts bounded(): change finish to `if (timedOut) late(kind, label, ok && value === true)`, and extend onLate to `(kind, label, landed: boolean)`. In glasses.ts onLate, call onStorageLate only when `label === 'set' && landed`.
(2) storage.ts: bound late-triggered rewrites. Add `let resyncSpent = false`. resync(): `if (!primary || resyncSpent) return; resyncSpent = true; ...markDirty(names)`. Reset resyncSpent = false in writeDirty when a bridge set returns true, and in save(), so each user save allows at most one follow-up rewrite. Documents that keep failing stay dirty and go out with the next user save, and sr:sync:v1 still protects the next launch.
(3) More precise, optional: pass the key with the late answer and rewrite only that document, and only when a newer set of the same key finished before the late one landed. A late `true` for the newest write of a key replaced nothing newer.
(4) Test with a fake clock and a bridge KV whose set answers true after 5 s: after one save, advancing 60 s gives at most 2 bridge writes per document, and a late `false` causes no rewrite.

### storage-startup:A3 (low, confirmed)

`src/main.ts:192`

**Summary.** The loading gate is meant to keep the 'Loading your library…' frame on the glasses through the retries (main.ts:76-78, docs/architecture.md:79). Before controller.start(), three paths draw the controller's own frame over it, and for an empty browser copy that is the first-run screen: onReconnect -> controller.redraw(), the phone's 'redraw-glasses' button, and the 30-s foreground redraw in controller.onLifecycle. The same reconnect/foreground also calls retryAttach(), which sets `retries = 0`, so each such event restarts the round and extends the gate. The comment at main.ts:208-210 claims the gate is bounded.

**Failure scenario.** The browser copy was evicted, so libraryLoading is true, and the first bridge reads time out. The gate can now last up to about a minute: 4 attempts of up to 8 s each (12+ s if waiting behind the 8 s create hold), plus 1+3+10 s of backoff. A BLE blip during that time fires Disconnected then Connected, link.connected() returns true, and onReconnect calls controller.redraw(). forceRedraw/draw() do not check `started`, so frameFor(home, emptyState) draws firstRunFrame: 'No publications yet. On your phone, open Reader for Substack in the Even app and add a publication.' Meanwhile the phone shows 'Loading your library…' and refuses 'follow', and every glasses gesture except double-tap is ignored (started is false). The wearer is told the library is empty and to add publications, which is the exact impression the gate exists to prevent. The same reconnect calls retryAttach(), sets retries = 0 and starts a fresh round, so repeated reconnects or foregrounds while reads keep failing keep the gate up with no fixed bound. A wearer away for more than 30 s who returns (onLifecycle foreground) gets the same first-run frame.

**Suggested fix.** 1) In main.ts, while libraryLoading, re-show the loading frame instead of the controller frame: `onReconnect: () => { if (libraryLoading) { glasses?.invalidate(); void glasses?.render(LOADING_LIBRARY_FRAME).catch(() => undefined) } else void controller.redraw(); retryAttach() }`.
2) In controller.ts, make `redraw` (line 1028) and the foreground forceRedraw (line 993) no-ops while !started. configurationChanged keeps drawing, because it is how the loaded library first appears.
3) In retryAttach, do not reset the round while the gate is up: `if (!libraryLoading) retries = 0`. The first round then always ends within its bound and lifts the gate with the notice.
4) Add a ui-ci variant of 12e that fires a Connected event mid-gate and asserts the last glasses body still contains 'Loading your library'.

**Skeptic's reasoning.** Traced at 04c2e0c. In main.ts:205-213, `glasses = connected` is assigned before `await libraryKnown`, so during the gate controller draws reach the glasses. onReconnect (main.ts:192-195) calls controller.redraw(), which is forceRedraw (controller.ts:1028). forceRedraw calls draw() with no `started` check. computeFrame then calls frameFor(home), and with no publications and nothing saved isFirstRun is true, so the glasses get firstRunFrame ('No publications yet... add a publication'). glasses.ts:385-391 fires onReconnect after any Disconnected/Connecting followed by Connected. controller.onLifecycle('foreground') also calls forceRedraw after more than 30 s hidden, and so does the Diagnostics 'Resend frame' button (phone/actions.ts:662). Meanwhile onAction ignores every gesture except back while !started, so the wearer sees an empty-library prompt they cannot act on. The new onAction comment claims 'nothing draws over that frame', which these paths contradict. retryAttach (main.ts:155-159) sets retries = 0 on each reconnect or foreground. A running attach that then fails, or the next one, starts a fresh 1/3/10 s round, so each event extends the gate. This is new in 04c2e0c: before it, the first failed attach lifted the gate, so the window was at most about 4 s; now it can last roughly a minute.

**Fix notes.** (1) In main.ts add `function showLoading() { glasses?.invalidate(); void glasses?.render(LOADING_LIBRARY_FRAME).catch(() => undefined) }`. In onReconnect: `if (libraryLoading) showLoading(); else void controller.redraw(); retryAttach()`. In both foreground paths (the glasses onLifecycle and the document visibilitychange handler), call showLoading() when libraryLoading and the signal is foreground.
(2) In controller.ts, return Promise.resolve() from `redraw` while !started, and skip the forceRedraw in onLifecycle('foreground') while !started (keep the hiddenAt bookkeeping). configurationChanged keeps drawing, because it is how the loaded library, or the lifted gate, first reaches the glasses.
(3) In retryAttach: `if (!libraryLoading) retries = 0; void attach()`. While the gate is up, a reconnect or foreground then tries right away but does not reset the round, so the gate still lifts after at most 4 attempts.
(4) Add a ui-ci 12e variant that fires a Disconnected then Connected device status mid-gate and asserts the last glasses body still contains 'Loading your library' and never 'No publications yet' before the notice appears.

### storage-startup:A4 (low, confirmed)

`src/main.ts:38`

**Summary.** The new LIBRARY_UNREAD notice, 'Could not load your library from the glasses; edits will be merged later.', names the wrong source. Bridge storage is the Even app's storage on the phone (glasses.ts: 'Bridge storage lives on the phone and works without the page'), and the reads fail when the Even app does not answer, not because of the glasses. The notice also stays on screen after a later attach succeeds and merges, because onApplied's libraryReady() returns early once the gate is down.

**Failure scenario.** The Even app's getLocalStorage fails for one round, so after about 14-60 s the phone shows 'Could not load your library from the glasses…'. The user checks or reconnects the glasses, which is not the problem. The phone also suggests the library lives on the glasses. A foreground event later attaches and merges successfully (ui-ci 12e), but the stale 'Could not load your library' notice stays above the now-complete lists until the user switches tabs, so the user may conclude the merge failed and re-add items.

**Suggested fix.** 1) Reword, for example: 'Could not read your library from the Even app yet. Changes you make now are kept and combined with it once it can be read.'
2) When a later attach succeeds, clear the notice. In the onApplied callback, if the gate had been lifted with LIBRARY_UNREAD, call something like `phone?.replaceNotice(LIBRARY_UNREAD, 'Library loaded from the Even app.')`, a small PhoneApp method that changes `notice` only when it still equals the given text.
3) Update ui-ci 12e and docs/architecture.md:79 to match.

**Skeptic's reasoning.** Traced at 04c2e0c. main.ts:38 has the text 'Could not load your library from the glasses...'. The reads it describes are bridge getLocalStorage calls, which go to the Even app's storage on the phone (glasses.ts:307, 'Bridge storage lives on the phone and works without the page'), so the notice sends the user to the wrong component. Stale notice: libraryReady(LIBRARY_UNREAD) puts the text in phone `notice` through setLibraryLoading (phone/actions.ts:869). When a later foreground or reconnect attach succeeds, onApplied calls libraryReady(), which returns early because libraryLoading is already false (main.ts:87). phone.draw() then redraws with the old notice. Only setPanel (a tab switch) or another action that sets a notice clears it. ui-ci 12e never sees this because openTab('settings') clears the notice before the merge. The impact is user-facing only, with no data effect.

**Fix notes.** (1) Reword LIBRARY_UNREAD, for example: 'Could not read your library from the Even app yet. Changes you make now are kept and combined with it once it can be read.' Update docs/architecture.md:79 and the ui-ci 12e assertion to match.
(2) Add a PhoneApp method `replaceNotice(from: string, to: string)` that sets notice = to and calls requestDraw() only when notice === from. In main.ts, keep `let unreadShown = false` and set it when libraryReady(LIBRARY_UNREAD) runs. In the attachBridge onApplied callback: `if (unreadShown) { unreadShown = false; phone?.replaceNotice(LIBRARY_UNREAD, 'Library loaded from the Even app.') }`.
(3) In ui-ci 12e, after the visibilitychange, stay on the same panel and assert that the notice no longer contains LIBRARY_UNREAD.

### glasses-queue-controller:B1 (low, confirmed)

`src/glasses.ts:261`

**Summary.** The R5 fix (onLate 'set' -> opts.onStorageLate -> store.resync) has no ordering check and no once-guard, so it can loop forever. Every late setLocalStorage answer marks both documents dirty and rewrites them, even when the late write carried the newest document. A late refusal or rejection triggers the same rewrite, because bounded() calls late() whatever the outcome. If each set takes longer than STORAGE_TIMEOUT_MS (4 s), every rewrite times out and lands late, and that schedules the next rewrite. The display side got a lateRetried guard for this exact loop (R2), but storage did not.

**Failure scenario.** The Even app answers setLocalStorage in about 4.5 s (slow host or busy link), or refuses after more than 4 s. The user changes one setting. writeDirty runs W1 for prefs; it times out at 4 s, so bridgeKV.set returns false, dirty=true and onSaved(false). At 4.5 s W1 lands: finish() -> late('storage','set') -> onStorageLate -> store.resync() -> markDirty(['prefs','progress']) -> flush 800 ms later -> two more sets, each timing out at 4 s and landing late -> resync again, and so on. With no further user action the store rewrites both documents roughly every 9 s for as long as the latency lasts. Each set holds the serialized bridge queue for up to 4 s, so page turns wait up to about 8 s behind storage writes on every cycle. lastSaveOk stays false, so the phone keeps showing 'not saved' although every write landed.

**Suggested fix.** Rewrite only when the late write may have replaced a newer confirmed one, and treat any other late success as a completed save. (1) In glasses.ts storageSet, report a late answer per call, carrying the key and value. For example, give BridgeQueue.run an optional per-call `onLate(ok, value)` that finish() calls, and have storageSet pass `(ok, v) => { if (ok && v === true) opts.onStorageLate?.(key, value) }`. A late refusal or rejection did not land, so it never triggers a rewrite. Drop the label==='set' branch from the global onLate. (2) Change store.resync(key, raw) to: name = doc for key; stamp = parseStored(raw)?.savedAt. If savedAt[name] > stamp, a newer write was confirmed before this one landed, so call markDirty([name]). Otherwise set savedAt[name] = stamp, and when changedAt[name] <= stamp (nothing edited since that write was serialized) set dirty[name] = false and ok = true, with no rewrite. A rewrite's own late landing is then never older than the confirmed savedAt, so no loop is possible. Test: every set resolves true 4.5 s after a 4 s timeout; after one edit, expect exactly one bridge write per document and no further writes after the late answer.

**Skeptic's reasoning.** I traced this at 04c2e0c. In events.ts bounded() (finish, lines 258-262), any settle after a timeout calls late(kind, label), whether ok is true or false. glasses.ts:261 forwards every late 'set' to opts.onStorageLate with no outcome, key or value, and main.ts:203 wires that to store.resync(). In storage.ts:770-775, resync() calls markDirty() on every document with savedAt > 0 or dirty. That sets changedAt = now and schedules a flush after SAVE_DEBOUNCE_MS (800 ms). It does not check whether the late write was older than a confirmed one, it has no once-guard, and a late refusal or rejection triggers it too.

The loop with every setLocalStorage taking about 4.5 s:
1. writeDirty sends W(prefs). At 4 s it times out: bridgeKV.set returns false, dirty.prefs = true, ok = false, onSaved(false).
2. At 4.5 s W lands, so late, onStorageLate, resync, markDirty(both), and a flush 0.8 s later.
3. That writeDirty sends prefs then progress. Each holds the queue 4 s, times out and lands late, and each late landing calls resync again. A late landing while writeDirty is still running reschedules the flush, which chains behind it on `chain`.

The loop sustains itself with no user action, keeps lastSaveOk false, and keeps the shared bridge queue busy about 8 of every 9 s, so page turns wait up to about 4 s behind storage sets.

Why low and not medium:
- It needs the phone-local Even app storage call to answer consistently later than 4 s. That is an abnormal host state; a one-off late answer, such as after a WebView suspension, gives one extra rewrite that normally completes in time and ends the cycle.
- No data is lost.
- The same latency already makes every user-triggered save time out without the loop. The loop adds idle rewrites, queue contention and load on an already slow host.

The defect itself is deterministic: a late refusal still triggers a rewrite, and there is no guard.

**Fix notes.** 1) events.ts: pass the outcome to late answers. Change finish's late path to `late(kind, label, ok, value)` and BridgeQueueOptions.onLate to `(kind, label, ok, value)`. Alternatively, give run() an optional per-call `onLate(ok, value)` that finish() calls instead.

2) glasses.ts storageSet: forward a late answer only when it reports a stored value. Use a per-call callback, `(ok, v) => { if (ok && v === true) opts.onStorageLate?.(key, value) }`, and drop the generic `label === 'set'` branch. A late false or rejection never landed, and the document is already dirty from the timeout.

3) storage.ts: change resync to `resync(key, raw)`:
   - Map the key to its document name.
   - Read `stamp = savedAtOf(raw)`.
   - If `savedAt[name] > stamp`, a newer write was confirmed before this one landed: call markDirty([name]).
   - Otherwise this is the newest write that landed. Set savedAt[name] = stamp. If `changedAt[name] <= stamp`, also set dirty[name] = false, ok = true and call onSaved(true). Do not rewrite.
   A rewrite's own late landing then always carries a stamp at or above savedAt, so it cannot loop. A writeDirty in flight keeps its own outcome.

4) Update main.ts to `onStorageLate: (key, raw) => store.resync(key, raw)`.

5) Tests:
   - Every set resolves true 4.5 s after its 4 s timeout. After one edit, expect exactly one bridge write and no further writes after the late answer, with lastSaveOk() true.
   - A late false triggers no write.
   - A late older write landing after a confirmed newer one triggers exactly one rewrite.

### glasses-queue-controller:B2 (low, confirmed)

`src/events.ts:447`

**Summary.** R9 is only half fixed. display.late() skips the recovery only when the late call was itself the exit. A late textContainerUpgrade answer that arrives while an exit is queued or running, or after the exit dialog appeared, still queues render(wanted). The queue places that recovery behind the exit, so it runs right after shutDownPageContainer(1) opens the OS exit dialog and sends all three container updates over the dialog.

**Failure scenario.** On the Home root, a selection draw F hangs on its body upgrade. At 5 s queue.call times out, F rejects, and the controller sets displayStale. The display looks frozen, so the wearer double-taps. 'back' at the root is not intercepted (not actsOnShown), so exitApp -> glasses.exit() -> queue.run('screen', ..., 'exit') sends shutDownPageContainer(1). The link recovers. With FIFO answers, F's late body answer arrives first, so late('upgrade') runs: invalidate(), label !== 'exit', renderPending() is false, and lateRetried !== F, so render(F) is queued behind the exit. The exit answers, the dialog appears, and display.invalidate() runs. The recovery then sends body, title and footer (known is {}) while the wearer is answering the exit dialog. This is the disturbance R9 described, and the 'exit' label check was added to prevent it.

**Suggested fix.** Make the display aware of an exit. Add `let exiting = false` in createDisplay and expose `exitRequested()` and `exitFailed()`. In glasses.ts exit(), call display.exitRequested() before queue.run. Call display.exitFailed() when shutDownPageContainer returns false, but not on a timeout, since the dialog may still appear. A render requested by the app (Display.render, called from glasses.render) sets exiting = false. The late recovery must call an internal render path that leaves the flag alone. In late(): `invalidate(); if (exiting || label === 'exit' || !wanted || queue.renderPending() || lateRetried === wanted) return`. Nothing is lost: the failed draw left the controller's displayStale set, so the wearer's next gesture after cancelling forces a full redraw. Test: in displayFixture, time out an upgrade, queue an exit through the queue with display.exitRequested(), answer the late upgrade and then the exit, and expect no further upgrade calls.

**Skeptic's reasoning.** I traced this at 04c2e0c. display.late (events.ts:445-450) skips the recovery only when the late call itself was labelled 'exit'. A late 'upgrade' runs invalidate(); then, if wanted is set, renderPending() is false and lateRetried !== wanted, it calls render(wanted).

In the scenario:
1. Draw F's body upgrade times out after 5 s (queue.call). write() throws, the 'render' run rejects, and onScreenError fires. The controller sets displayStale because F is the latest draw.
2. A root double-tap is not actsOnShown, so onHome calls exitApp, deps.exit and glasses.exit. That runs queue.run('screen', ..., 'exit'), which starts at once, or after F if F is still in flight.
3. F's native upgrade answers late, before or after shutDownPageContainer answers. late('screen', 'upgrade') then calls render(F). queue.render puts a waiting slot behind the exit on `tail`, or runs it at once if the exit already finished.
4. Once the exit succeeds (display.invalidate, so known = {}), write(F) sends body, title and footer while the OS exit dialog is up. Nothing in write() or late() knows an exit was requested.

The order of the two answers does not matter: any late upgrade answer between the exit request and dispose triggers the recovery over the dialog. This breaks the invariant the 04c2e0c fix documents, 'A late exit dialog is never drawn over', and leaves R9 only half fixed.

It stays low:
- It needs an upgrade that took longer than 5 s, plus an exit requested before that late answer.
- Whether three upgrades visibly disturb the dialog depends on the device. R9 was accepted on that same premise.
- lateRetried limits it to one recovery per frame.

**Fix notes.** In createDisplay, add `let exiting = false`. Expose `exitRequested()` (sets it) and `exitFailed()` (clears it).

In glasses.ts exit():
- Call display.exitRequested() synchronously before queue.run, so a late answer that arrives while the exit is queued is covered too.
- Inside the operation, call display.exitFailed() when shutDownPageContainer returns false, before throwing.
- On a timeout, leave the flag set, because the dialog may still appear.

Split render:
- An app render (Display.render, used by glasses.render) sets exiting = false.
- The late recovery calls an internal `send(page)` that leaves the flag alone.

In late():
```ts
invalidate()
if (exiting || label === 'exit' || !wanted || queue.renderPending() || lateRetried === wanted) return
```
Nothing is lost: the failed draw left displayStale set in the controller, and every field is invalidated, so the next gesture after a cancelled dialog redraws everything.

Test in displayFixture:
1. Time out an upgrade.
2. Call exitRequested() and queue the exit through the queue.
3. Answer the late upgrade, then the exit.
4. Expect no further upgrade calls.
5. Expect the next app render to send all three fields.

### glasses-queue-controller:B3 (low, confirmed)

`src/app/controller.ts:1028`

**Summary.** The new pre-start guard says 'nothing draws over that frame', but controller.redraw (wired to onReconnect) and the foreground redraw in onLifecycle still call forceRedraw() before start(). They draw the model's Home frame, and with the library not yet loaded that is the first-run frame 'No publications yet ... add a publication'. It replaces 'Loading your library'. 04c2e0c lengthens this pre-start window: main.ts now awaits libraryKnown before start(), which lasts until the bridge read succeeds or every retry has failed (over 40 s in the worst case, and each reconnect or foreground restarts the retry round).

**Failure scenario.** The WebView mirror was evicted (loadedEmpty), so the glasses are created showing LOADING_LIBRARY_FRAME, and the bridge reads are slow or failing, so start() waits on libraryKnown. The G2 then goes through Connecting -> Connected; this is common when the reader is launched while the glasses are still reconnecting. link.connected() returns true -> onReconnect -> controller.redraw() -> forceRedraw() -> draw(). With an empty state, frameFor(home) returns firstRunFrame(), so the wearer, whose library is stored, is told there are no publications and to add some on the phone. The phone refuses those edits while loading. Gestures do nothing except double-tap exit until the library loads or the retries run out. Backgrounding the app for more than 30 s inside the window does the same through onLifecycle('foreground').

**Suggested fix.** Before start(), the controller should not draw the model. In controller.ts use `redraw: () => (started ? forceRedraw() : Promise.resolve())`, and in onLifecycle only call forceRedraw() when `started`. In main.ts onReconnect, re-send the startup frame while the controller has not started: `if (!controllerStarted) { glasses?.invalidate(); void glasses?.render(libraryLoading ? LOADING_LIBRARY_FRAME : controller.current()).catch(() => undefined) } else void controller.redraw()`, setting controllerStarted after `await controller.start()`. Extend the controller test 'before start only the root double-tap acts' to call controller.redraw() and onLifecycle('background'/'foreground' after 30 s) before start and assert that t.frames.length stays 0.

**Skeptic's reasoning.** I traced this at 04c2e0c.

The pre-start draw paths:
- controller.ts:1028 is `redraw: forceRedraw`, with no `started` check.
- onLifecycle('foreground') calls forceRedraw() when the app was hidden longer than FOREGROUND_REDRAW_MS. It is reached from glasses FOREGROUND_ENTER and from main.ts visibilitychange, and it has no `started` check either.
- forceRedraw calls deps.invalidate, then draw(), then computeFrame(). With an empty state, frameFor('home') returns firstRunFrame(), whose text is 'No publications yet ... add a publication' (frames.ts:284). draw() sets `frame`, notifies the phone and calls deps.render. That reaches the device, because main.ts sets `glasses = connected` before awaiting attachApplied and libraryKnown.

The window:
- glasses.ts subscribes to onDeviceStatusChanged before connectGlasses returns. Connecting or Disconnected followed by Connected makes link.connected() return true, which calls onReconnect and then controller.redraw().
- In the loadedEmpty case, 04c2e0c makes main.ts await libraryKnown before start(). libraryKnown resolves only when the library is applied or when a whole retry round has failed. That is up to about 8+1+8+3+8+10+8 ≈ 46 s, and retryAttach on a reconnect or foreground resets retries and extends it.
- So within this window a reconnect, or a foreground after more than 30 s, replaces LOADING_LIBRARY_FRAME with the first-run frame. The new onAction comment, 'nothing draws over that frame', is therefore false.

It stays low:
- The frame is temporary. libraryReady, then libraryChanged, then configurationChanged, then draw() redraws the real library once it loads.
- The phone shows 'Loading your library' and refuses edits.
- It needs an empty browser copy, slow or failing bridge reads, and a reconnect or a long background inside the window.
- When the library is not loading (the ≤4 s window), the initial frame already is the model frame, so a redraw is harmless.

**Fix notes.** Gate on main.ts `libraryLoading`. start() awaits libraryKnown, so `started` implies the library is no longer loading.

1) controller.ts:
- Use `redraw: () => (started ? forceRedraw() : Promise.resolve())`.
- In onLifecycle('foreground'), call forceRedraw() only when `started`. Still clear hiddenAt.

2) main.ts onReconnect:
```ts
if (libraryLoading) { glasses?.invalidate(); void glasses?.render(LOADING_LIBRARY_FRAME).catch(() => undefined) } else void controller.redraw()
retryAttach()
```
Do the same for a pre-start foreground if a redraw of the startup frame is wanted there. If a main.ts `controllerStarted` flag is used instead, set it synchronously before calling controller.start(), not after `await controller.start()`. Otherwise a startup-frame render issued while start()'s draw is still waiting in the coalescing slot replaces that draw (SupersededRenderError) and leaves the loading frame up after start.

3) Test: extend 'before start only the root double-tap acts'. Call controller.redraw() and onLifecycle('background'), then 'foreground' after 31 s, all before start(). Assert that t.frames stays empty and that start() then draws exactly once.
