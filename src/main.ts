/**
 * Bootstrap and wiring only (SPEC sections 3.1 item 10, 4.5 and 5):
 * storage -> glasses controller -> phone UI -> G2 bridge. The phone works in
 * a plain browser too; without the Even app bridge the glasses side simply
 * waits (the pending connection still completes if the bridge appears late).
 */
import './styles.css'
import { createController } from './app/controller'
import { APP_NAME, RELAY_BASE, VERSION, isRelayConfigured } from './config'
import { connectGlasses, type GlassesController, type GlassesMenuItem, type GlassesStatus } from './glasses'
import { createPhoneApp, type PhoneApp } from './phone/actions'
import { browserKV, bridgeKV, createStore, mirroredKV } from './storage'
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
  phone.draw()
  phone.setPhase('phone')

  // Persist before the WebView may be killed; tell the controller (resume redraw after 30 s).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void store.flush()
      controller.onLifecycle('background')
    } else {
      controller.onLifecycle('foreground')
    }
  })
  window.addEventListener('pagehide', () => { void store.flush() })

  let lastState: GlassesStatus['state'] = 'connecting'
  const grace = setTimeout(() => {
    if (glasses) return
    phone?.setNoBridge()
    phone?.setPhase('nobridge')
  }, BRIDGE_GRACE_MS)

  // Not awaited: in a plain browser the bridge never arrives, and the phone stays usable.
  connectGlasses({
    initialPage: controller.current(),
    menuItems: MENU_ITEMS,
    invertSwipe: () => store.state.settings.invertSwipe,
    onAction: action => controller.onAction(action),
    onStatus: status => {
      const reconnected = lastState === 'disconnected' && status.state === 'ready'
      lastState = status.state
      phone?.setGlassesStatus(status)
      if (reconnected) void controller.redraw()
    },
    onLifecycle: signal => controller.onLifecycle(signal),
    onLaunchSource: source => controller.onLaunchSource(source),
    onRawEvent: summary => phone?.logEvent(summary),
    onExit: async () => { await store.flush() },
  }).then(async connected => {
    clearTimeout(grace)
    glasses = connected
    try {
      // Bridge storage is the source of truth; localStorage stays a mirror.
      if (await store.attachBridge(mirroredKV(bridgeKV(connected), browserKV()))) controller.configurationChanged()
    } catch { /* Keep the browser copy; saving reports its own failures. */ }
    await controller.start()
    phone?.setPhase('glasses')
    phone?.draw()
  }, () => {
    clearTimeout(grace)
    phone?.setPhase('nobridge')
    // connectGlasses already reported the error through onStatus; the phone stays usable.
  })
}

const root = document.querySelector<HTMLElement>('#app')
if (root) {
  root.dataset.phase = 'boot'
  void boot(root).catch(() => {
    root.textContent = 'The reader could not start. Close and reopen it from the Even app.'
  })
}
