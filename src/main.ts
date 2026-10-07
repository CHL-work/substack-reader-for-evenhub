/**
 * Bootstrap and wiring only (SPEC sections 3.1 item 10, 4.5 and 5):
 * storage -> glasses controller -> phone UI -> G2 bridge. The phone works in
 * a plain browser too; without the Even app bridge the glasses side simply
 * waits (the pending connection still completes if the bridge appears late).
 */
import './styles.css'
import { createController } from './app/controller'
import { TEXT, messageFrame } from './app/frames'
import { APP_NAME, RELAY_BASE, VERSION, isRelayConfigured } from './config'
import { connectGlasses, type GlassesController, type GlassesMenuItem, type GlassesStorage } from './glasses'
import { createPhoneApp, type PhoneApp } from './phone/actions'
import { browserKV, bridgeKV, createStore } from './storage'
import { relayApi } from './substack/api'
import { buildArticle } from './substack/article'
import { parseFeed } from './substack/feed'

/** Contextual glasses menu (sent once; ids are handled by the controller). */
const MENU_ITEMS: GlassesMenuItem[] = [
  { itemID: 1, itemName: 'Home' },
  { itemID: 2, itemName: 'Save for later' },
  { itemID: 3, itemName: 'Next post' },
  { itemID: 4, itemName: 'Restart post' },
  { itemID: 5, itemName: 'Refresh' },
]
/** Show "Open this from the Even app" after this long without a bridge. */
const BRIDGE_GRACE_MS = 4000
/**
 * controller.start() waits this long at most for the bridge library (glassesMenu resume needs it),
 * and while the library is still loading, until it was read or the retries ran out.
 */
const START_WAIT_MS = 4000
/**
 * Retries after a failed bridge storage read. Foreground and reconnect try again at once; once the
 * library is known they also start a new round, while it loads they keep the round (and its bound).
 */
const ATTACH_RETRY_MS = [1000, 3000, 10_000] as const
/** First glasses frame while the bridge library is still being read and the browser copy was empty. */
const LOADING_LIBRARY_FRAME = messageFrame(APP_NAME, 'Loading your library\u2026', TEXT.exitFooter)
/** Phone notice when the loading gate is lifted because every bridge read of a round failed. */
const LIBRARY_UNREAD = 'Could not read your library from the Even app; edits will be merged when it answers.'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function boot(root: HTMLElement): Promise<void> {
  let phone: PhoneApp | null = null
  let glasses: GlassesController | null = null

  const store = createStore({ onSaved: ok => phone?.saved(ok) })
  await store.load(browserKV())

  const controller = createController({
    render: page => (glasses ? glasses.render(page) : Promise.resolve()),
    exit: () => (glasses ? glasses.exit() : Promise.resolve()),
    api: relayApi,
    getFeed: async (host, signal) => parseFeed(await relayApi.getFeedXml(host, signal), host),
    store,
    buildArticle: (post, publication, settings) => buildArticle(post, publication, settings),
    now: () => Date.now(),
    relayConfigured: isRelayConfigured,
    onPhoneUpdate: () => phone?.glassesChanged(),
    resetGestures: () => glasses?.resetGestures(),
    invalidate: () => glasses?.invalidate(),
  })

  phone = createPhoneApp({
    root,
    store,
    controller,
    api: relayApi,
    appName: APP_NAME,
    version: VERSION,
    relayOrigin: RELAY_BASE,
    now: () => Date.now(),
  })
  // Nothing in the browser copy: the library may still be in bridge storage.
  // Until it was read, every retry of the first round failed, or there is no
  // bridge, the phone shows "Loading your library" instead of an empty list
  // that invites edits, and the glasses keep their loading frame.
  let libraryLoading = store.loadedEmpty()
  let markKnown = () => undefined as void
  const libraryKnown = libraryLoading ? new Promise<void>(resolve => { markKnown = resolve }) : Promise.resolve()
  phone.setLibraryLoading(libraryLoading)
  phone.draw()
  phone.setPhase('phone')

  function libraryReady(notice?: string) {
    if (!libraryLoading) return
    libraryLoading = false
    markKnown()
    phone?.setLibraryLoading(false, notice)
  }

  /** The glasses lists and frame follow the library; a throw here must not keep the gate shut. */
  function libraryChanged() {
    try { controller.configurationChanged() } catch { /* Drawn again on the next action. */ }
  }

  /**
   * Send the "Loading your library" frame again in full (the glasses reconnected while it is up).
   * Only while the gate is up: then the controller has not started and draws nothing, and the
   * gate's end (libraryChanged) draws the model after this frame.
   */
  function showLoading() {
    if (!libraryLoading || !glasses) return
    glasses.invalidate()
    void glasses.render(LOADING_LIBRARY_FRAME).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Bridge storage (the source of truth), attached as soon as the bridge
  // exists, independent of page creation. A failed read never overwrites it:
  // retry with backoff, and again on every foreground and reconnect.

  let bridgeStorage: GlassesStorage | null = null
  let attachRunning = false
  let attachApplied: Promise<void> = Promise.resolve()
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  /** Resolves once the bridge documents were merged into memory, or the attempt failed. */
  function attach(): Promise<void> {
    const storage = bridgeStorage
    if (!storage || store.attached()) return Promise.resolve()
    if (attachRunning) return attachApplied
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    attachRunning = true
    let markApplied = () => undefined as void
    attachApplied = new Promise<void>(resolve => { markApplied = resolve })
    store.attachBridge(bridgeKV(storage), changed => {
      // Before the write-back: the glasses and phone show the library at once.
      // While loading, the glasses may still show the "Loading your library" frame.
      const wasLoading = libraryLoading
      libraryReady()
      if (changed || wasLoading) libraryChanged()
      if (changed) phone?.draw()
      markApplied()
    }).then(() => {
      retries = 0
    }, () => {
      // Nothing was written. While retries remain, the library stays "loading" (an edit on an
      // apparently empty library would only race the bridge copy). Once they ran out, edits go to
      // the browser copy, and a later attach (foreground, reconnect) merges them.
      scheduleRetry()
      if (!libraryLoading || retryTimer !== undefined) return
      libraryReady(LIBRARY_UNREAD)
      libraryChanged()
    }).catch(() => undefined).finally(() => {
      attachRunning = false
      markApplied()
    })
    return attachApplied
  }

  function scheduleRetry() {
    if (store.attached() || retryTimer !== undefined || retries >= ATTACH_RETRY_MS.length) return
    const wait = ATTACH_RETRY_MS[retries]!
    retries += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void attach()
    }, wait)
  }

  /**
   * Foreground or reconnect: try now. Once the library is known, with a fresh round of retries;
   * while it loads, within the current round, so the gate still lifts after its last retry.
   */
  function retryAttach() {
    if (!bridgeStorage || store.attached()) return
    if (!libraryLoading) retries = 0
    void attach()
  }

  // Persist before the WebView may be killed; tell the controller (resume redraw after 30 s).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void store.flush()
      controller.onLifecycle('background')
    } else {
      controller.onLifecycle('foreground')
      retryAttach()
    }
  })
  window.addEventListener('pagehide', () => { void store.flush() })

  const grace = setTimeout(() => {
    if (glasses || bridgeStorage) return
    libraryReady()
    phone?.setNoBridge()
    phone?.setPhase('nobridge')
  }, BRIDGE_GRACE_MS)

  // Not awaited: in a plain browser the bridge never arrives, and the phone stays usable.
  connectGlasses({
    // Called after onBridgeReady's bounded wait, so the first frame can show the bridge library.
    initialPage: () => (libraryLoading ? LOADING_LIBRARY_FRAME : controller.current()),
    onBridgeReady: storage => {
      bridgeStorage = storage
      return attach()
    },
    menuItems: MENU_ITEMS,
    invertSwipe: () => store.state.settings.invertSwipe,
    onAction: action => controller.onAction(action),
    onStatus: status => phone?.setGlassesStatus(status),
    onReconnect: () => {
      // While the library loads, the controller has not started and the loading frame is the app's.
      if (libraryLoading) showLoading()
      else void controller.redraw()
      retryAttach()
    },
    onLifecycle: signal => {
      controller.onLifecycle(signal)
      if (signal === 'foreground') retryAttach()
    },
    onLaunchSource: source => controller.onLaunchSource(source),
    onRawEvent: summary => phone?.logEvent(summary),
    onExit: async () => { await store.flush() },
    onStorageLate: (key, value) => store.lateWrite(key, value),
    onFrameShown: () => controller.frameShown(),
  }).then(async connected => {
    clearTimeout(grace)
    glasses = connected
    // A glassesMenu launch resumes lastOpen, which may only be in bridge storage. An empty browser
    // copy keeps the "Loading your library" frame until the library was read or the retries ran out
    // (bounded: every read times out after 4 s, and a foreground or reconnect never restarts the
    // round while it loads), instead of drawing the first-run screen.
    await Promise.race([attachApplied, delay(START_WAIT_MS)])
    await libraryKnown
    await controller.start()
    phone?.setPhase('glasses')
    phone?.draw()
  }, () => {
    clearTimeout(grace)
    phone?.setPhase('nobridge')
    // connectGlasses already reported the error through onStatus; the phone
    // stays usable, and bridge storage (if the bridge exists) still attaches.
  })
}

const root = document.querySelector<HTMLElement>('#app')
if (root) {
  root.dataset.phase = 'boot'
  void boot(root).catch(() => {
    root.textContent = 'The reader could not start. Close and reopen it from the Even app.'
  })
}
