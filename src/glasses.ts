import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  isMenuNameWithinLimit,
  isValidMenuItemID,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { createGestureFilter } from './input'
import {
  OsEvent, SCREEN_TIMEOUT_MS, STORAGE_TIMEOUT_MS, createBridgeQueue, createDisplay, createLinkTracker, describeEvent, mapEvent,
} from './events'
import type { Display, FrameField, GlassesAction, GlassesPage, GlassesStatus, LaunchSource, LifecycleSignal } from './events'
import { G2_BODY_LINES, G2_LAYOUT, G2_TEXT_PADDING, bodyBox, isReaderPage, normalizeReaderText, paginate, truncateGlassesLabel } from './pagination'

export { OsEvent, SupersededRenderError, describeEvent, mapEvent } from './events'
export type { GlassesAction, GlassesPage, GlassesStatus, LaunchSource, LifecycleSignal, MappedEvent } from './events'

export interface GlassesMenuItem { itemID: number; itemName: string }

/** Bridge storage only; usable before (and even without) the glasses page. */
export interface GlassesStorage {
  storageGet(key: string): Promise<string>
  storageSet(key: string, value: string): Promise<boolean>
}

export interface GlassesOptions {
  /**
   * First frame, sent with createStartUpPageContainer (no black screen). A
   * function is called after onBridgeReady's wait, so it can use bridge data.
   */
  initialPage: GlassesPage | (() => GlassesPage)
  /**
   * The Even app bridge exists: bridge storage works from here on, whether or
   * not the page can be created. Page creation waits for the returned promise
   * for at most BRIDGE_READY_WAIT_MS, so the first frame can use bridge data.
   */
  onBridgeReady?(storage: GlassesStorage): void | Promise<unknown>
  /** Contextual menu, sent once on create (the page is never rebuilt). */
  menuItems?: GlassesMenuItem[]
  /**
   * Accepted for compatibility and unused: the overflow guard always checks
   * the physical 7-line body container, because menus and status frames use
   * all 7 lines even when the reader paginates to 5 or 6.
   */
  bodyLines?: () => number
  invertSwipe: () => boolean
  onAction(action: GlassesAction): void | Promise<void>
  onStatus?(status: GlassesStatus): void
  /**
   * The glasses came back after a disconnect, or after a failed screen write:
   * what they show is unknown, so resend the whole current frame. Independent
   * of onStatus de-duplication.
   */
  onReconnect?(): void
  /** May fire for the OS menu overlay too; handlers must be idempotent. */
  onLifecycle?(signal: LifecycleSignal): void
  /** Registered before the page is created; the host fires it once. */
  onLaunchSource?(source: LaunchSource): void
  /** Diagnostics ring buffer: envelope + type + source only, never content. */
  onRawEvent?(summary: string): void
  /**
   * SYSTEM_EXIT / ABNORMAL_EXIT / pagehide, once. Bridge storage still works
   * while the returned promise is pending (bounded to 1.5 s); then dispose().
   */
  onExit?(): void | Promise<void>
  /**
   * A setLocalStorage that timed out stored `value` under `key` after all (a
   * late refusal or error stored nothing and is not reported). It may have
   * replaced a newer value: the store decides whether to write it again.
   */
  onStorageLate?(key: string, value: string): void
  /**
   * The newest frame rendered is fully on the display, also when its render()
   * already rejected (an update that timed out landed, and the late recovery
   * wrote the frame): the app can stop treating the display as stale.
   */
  onFrameShown?(): void
}

export interface GlassesController extends GlassesStorage {
  /**
   * Resolves after the frame was written. Rejects with an Error named
   * 'SupersededRenderError' when a newer render replaced it before it was
   * written (not shown; do not retry), and with any other Error when the
   * bridge refused it or one container update did not answer within
   * SCREEN_TIMEOUT_MS. Only fields that differ from what the glasses are
   * known to show are sent.
   */
  render(page: GlassesPage): Promise<void>
  /** shutDownPageContainer(1): the OS exit dialog; cancelling keeps the app usable. Waits for at most one render. */
  exit(): Promise<void>
  /**
   * bridge.getLocalStorage through the same serialized queue. '' only for an
   * absent key (null, undefined or ''); rejects when the read failed, timed
   * out (STORAGE_TIMEOUT_MS) or returned something other than a string.
   */
  storageGet(key: string): Promise<string>
  /** bridge.setLocalStorage through the same serialized queue; rejects on failure or timeout. */
  storageSet(key: string, value: string): Promise<boolean>
  /** Clear the scroll debounce; call on every glasses view change. */
  resetGestures(): void
  /** Forget the last frame so the next render resends title, body and footer. */
  invalidate(): void
  /** Unsubscribe and reject new writes; does not close the native app. */
  dispose(): void
}

export const GLASSES_MESSAGES = {
  connecting: 'Connecting to G2\u2026',
  ready: 'G2 connected.',
  disconnected: 'G2 disconnected. Reconnect in the Even app.',
  closed: 'Reader closed.',
} as const

/** Compile-time guard: the ordinals copied into events.ts must equal the SDK enum. */
export const SDK_EVENT_TYPES = {
  CLICK: OsEventTypeList.CLICK_EVENT,
  SCROLL_TOP: OsEventTypeList.SCROLL_TOP_EVENT,
  SCROLL_BOTTOM: OsEventTypeList.SCROLL_BOTTOM_EVENT,
  DOUBLE_CLICK: OsEventTypeList.DOUBLE_CLICK_EVENT,
  FOREGROUND_ENTER: OsEventTypeList.FOREGROUND_ENTER_EVENT,
  FOREGROUND_EXIT: OsEventTypeList.FOREGROUND_EXIT_EVENT,
  ABNORMAL_EXIT: OsEventTypeList.ABNORMAL_EXIT_EVENT,
  SYSTEM_EXIT: OsEventTypeList.SYSTEM_EXIT_EVENT,
  IMU_DATA_REPORT: OsEventTypeList.IMU_DATA_REPORT,
  LONG_PRESS: OsEventTypeList.LONG_PRESS_EVENT,
  LONG_PRESS_RELEASE: OsEventTypeList.LONG_PRESS_RELEASE_EVENT,
} as const satisfies { readonly [K in keyof typeof OsEvent]: (typeof OsEvent)[K] }

const CREATE_CONTENT_LIMIT = 1000
/** Bridge storage values above this are refused without a bridge call (SPEC: keys stay < 48k chars). */
export const MAX_BRIDGE_VALUE_CHARS = 48_000
const EXIT_FLUSH_LIMIT_MS = 1500
/** createStartUpPageContainer waits at most this long for onBridgeReady (bridge storage reads). */
export const BRIDGE_READY_WAIT_MS = 1500
/** Later bridge calls wait at most this long for createStartUpPageContainer (the page itself is awaited unbounded). */
const CREATE_HOLD_MS = 8000
const CONTAINER_IDS: Record<FrameField, number> = { title: 1, body: 2, footer: 3 }

/** Wait for `promise` (its outcome ignored), but never longer than `ms`. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })
  return Promise.race([promise.then(() => undefined, () => undefined), limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'G2 display update failed.'
}

function clampChars(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const char of text) {
    if (out.length + char.length > max) break
    out += char
  }
  return out
}

/** Title/footer as one pixel-fitted line; body normalized and guarded against overflow. */
function snapshotOf(page: GlassesPage): GlassesPage {
  return {
    title: truncateGlassesLabel(page.title),
    body: normalizeReaderText(page.body),
    footer: truncateGlassesLabel(page.footer),
  }
}

function validMenu(items: GlassesMenuItem[] | undefined): MenuContainerProperty | undefined {
  if (!items?.length) return undefined
  const seen = new Set<number>()
  const valid: MenuItemProperty[] = []
  for (const item of items) {
    if (valid.length >= 10) break
    if (!isValidMenuItemID(item.itemID) || seen.has(item.itemID)) continue
    if (!item.itemName || !isMenuNameWithinLimit(item.itemName)) continue
    seen.add(item.itemID)
    valid.push(new MenuItemProperty({ itemID: item.itemID, itemName: item.itemName }))
  }
  return valid.length ? new MenuContainerProperty({ menuItems: valid }) : undefined
}

/**
 * All bridge interaction stays here. The app owns navigation, content and
 * resume state; this module only draws text, stores strings and converts
 * hardware events into filtered application actions.
 */
export async function connectGlasses(opts: GlassesOptions): Promise<GlassesController> {
  let lastReport = ''
  const report = (state: GlassesStatus['state'], message: string) => {
    const key = `${state}\n${message}`
    if (key === lastReport) return
    lastReport = key
    // A phone UI callback must not poison the bridge write chain.
    try { opts.onStatus?.({ state, message }) } catch { /* Observer errors are isolated. */ }
  }
  report('connecting', GLASSES_MESSAGES.connecting)
  const bridge = await waitForEvenAppBridge()

  let unsubscribeLaunch = () => undefined as void
  try {
    unsubscribeLaunch = bridge.onLaunchSource(source => {
      try { opts.onLaunchSource?.(source) } catch { /* Observer errors are isolated. */ }
    })
  } catch { /* An older host without launch source keeps working. */ }

  let disposed = false
  let exiting = false
  let unsubscribeEvents = () => undefined as void
  let unsubscribeDevice = () => undefined as void
  /** Disconnects and failed writes: the next Connected asks for a full redraw. */
  const link = createLinkTracker()
  let lastWriteAt = -Infinity
  const clock = () => performance.now()
  const filter = createGestureFilter(clock)

  function dispose() {
    if (disposed) return
    disposed = true
    unsubscribeEvents()
    unsubscribeDevice()
    unsubscribeLaunch()
    window.removeEventListener('pagehide', exitApp)
    report('closed', GLASSES_MESSAGES.closed)
  }

  /** Run onExit (storage flush) once, bounded in time, then dispose. */
  function exitApp() {
    if (exiting || disposed) return
    exiting = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = Promise.resolve().then(() => opts.onExit?.()).catch(() => undefined)
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, EXIT_FLUSH_LIMIT_MS) })
    void Promise.race([flush, limit]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      dispose()
    })
  }

  // One serialized chain for every bridge call (page creation included), each
  // native call bounded by a timeout. A failed or hung native call never
  // blocks later page turns, exits or saves.
  const queue = createBridgeQueue({
    closed: () => disposed,
    onScreenError(error, label) {
      // A failed frame already forgot the field it was writing; an exit may have left the dialog up or not.
      if (label === 'exit') display.invalidate()
      link.writeFailed()
      if (!disposed) report('error', errorMessage(error))
    },
    onLate(kind, label) {
      // Late storage writes are reported per call (storageSet), with their key and value.
      if (!disposed && kind === 'screen') display.late(label)
    },
  })

  const display: Display = createDisplay({
    queue,
    // Never send textColor on upgrades, so the created brightness is kept.
    upgrade: (field, content) => bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CONTAINER_IDS[field],
      containerName: field,
      content: content || ' ',
    })),
    check(page) {
      if (!isReaderPage(page.body, G2_BODY_LINES)) throw new RangeError('Reader body exceeds one G2 page. Paginate the text before rendering.')
    },
    onWrite() {
      lastWriteAt = clock()
    },
    onFrame(newest) {
      link.written()
      report('ready', GLASSES_MESSAGES.ready)
      if (newest) {
        try { opts.onFrameShown?.() } catch { /* Observer errors are isolated. */ }
      }
    },
  })

  const storage: GlassesStorage = {
    storageGet(key) {
      return queue.run('storage', STORAGE_TIMEOUT_MS, async () => {
        const value: unknown = await bridge.getLocalStorage(key)
        // The SDK documents '' for a missing key; null/undefined count as absent too.
        if (value === null || value === undefined) return ''
        if (typeof value !== 'string') throw new Error('Even app storage returned an unreadable value.')
        return value
      }, 'get')
    },
    storageSet(key, value) {
      // Defense in depth for the shared BLE link; storage.ts keeps values far smaller.
      if (value.length > MAX_BRIDGE_VALUE_CHARS) return Promise.resolve(false)
      return queue.run('storage', STORAGE_TIMEOUT_MS, async () => (await bridge.setLocalStorage(key, value)) === true, 'set', (ok, stored) => {
        // Timed out, then answered: only a write that stored can have replaced a newer value.
        if (disposed || !ok || stored !== true) return
        try { opts.onStorageLate?.(key, value) } catch { /* Observer errors are isolated. */ }
      })
    },
  }

  // Bridge storage lives on the phone and works without the page: hand it out
  // first, and give its reads a short head start so the first frame can show
  // the stored library instead of the first-run screen.
  let ready: unknown
  try { ready = opts.onBridgeReady?.(storage) } catch { ready = undefined }
  if (ready instanceof Promise) await settleWithin(ready, BRIDGE_READY_WAIT_MS)

  function emit(action: GlassesAction) {
    if (disposed || exiting) return
    try {
      Promise.resolve(opts.onAction(action)).catch(error => report('error', errorMessage(error)))
    } catch (error) { report('error', errorMessage(error)) }
  }

  function invert(): boolean {
    try { return opts.invertSwipe() === true } catch { return false }
  }

  const initial = snapshotOf(typeof opts.initialPage === 'function' ? opts.initialPage() : opts.initialPage)
  if (!isReaderPage(initial.body, G2_BODY_LINES)) initial.body = paginate(initial.body, bodyBox(7))[0]!.text
  initial.body = clampChars(initial.body, CREATE_CONTENT_LIMIT)

  try {
    const menuObject = validMenu(opts.menuItems)
    // Through the queue like every other bridge call, so it never overlaps the storage calls that
    // onBridgeReady started; later calls wait for it at most CREATE_HOLD_MS.
    const result = await queue.hold('screen', CREATE_HOLD_MS, () => bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [
        new TextContainerProperty({
          ...G2_LAYOUT.title,
          borderWidth: 0, paddingLength: G2_TEXT_PADDING,
          containerID: 1, containerName: 'title', isEventCapture: 0, textColor: 3,
          content: initial.title || ' ',
        }),
        new TextContainerProperty({
          ...G2_LAYOUT.body,
          borderWidth: 0, paddingLength: G2_TEXT_PADDING,
          containerID: 2, containerName: 'body', isEventCapture: 1, textColor: 4,
          content: initial.body || ' ',
        }),
        new TextContainerProperty({
          ...G2_LAYOUT.footer,
          borderWidth: 0, paddingLength: G2_TEXT_PADDING,
          containerID: 3, containerName: 'footer', isEventCapture: 0, textColor: 3,
          content: initial.footer || ' ',
        }),
      ],
      ...(menuObject ? { menuObject } : {}),
    })), 'create')
    // Do not retry: the host rejects a second create anyway.
    if (result !== 0) throw new Error(`G2 could not create the reader screen (code ${result}).`)
    display.created(initial)
    lastWriteAt = clock()

    unsubscribeEvents = bridge.onEvenHubEvent(event => {
      if (disposed) return
      try { opts.onRawEvent?.(describeEvent(event)) } catch { /* Diagnostics only. */ }
      const mapped = mapEvent(event, invert())
      if (mapped === null) return
      if (mapped === 'exitApp') { exitApp(); return }
      if (mapped === 'foreground' || mapped === 'background') {
        try { opts.onLifecycle?.(mapped) } catch (error) { report('error', errorMessage(error)) }
        return
      }
      if (exiting || !filter.accept(mapped, lastWriteAt)) return
      emit(mapped)
    })

    unsubscribeDevice = bridge.onDeviceStatusChanged(status => {
      if (disposed) return
      if (status.connectType === DeviceConnectType.Disconnected || status.connectType === DeviceConnectType.ConnectionFailed) {
        display.invalidate()
        link.disconnected()
        report('disconnected', GLASSES_MESSAGES.disconnected)
      } else if (status.connectType === DeviceConnectType.Connecting) {
        display.invalidate()
        link.disconnected() // A reconnect cycle may skip Disconnected; the next Connected redraws.
      } else if (status.connectType === DeviceConnectType.Connected) {
        display.invalidate()
        const redraw = link.connected()
        report('ready', GLASSES_MESSAGES.ready)
        if (redraw) {
          try { opts.onReconnect?.() } catch { /* Observer errors are isolated. */ }
        }
      }
    })
    window.addEventListener('pagehide', exitApp)
    report('ready', GLASSES_MESSAGES.ready)
  } catch (error) {
    report('error', errorMessage(error))
    unsubscribeEvents()
    unsubscribeDevice()
    unsubscribeLaunch()
    throw error
  }

  return {
    render(page) {
      return display.render(snapshotOf(page))
    },
    exit() {
      // From now on (the exit may still wait in the queue), a late screen answer never draws over the dialog.
      display.exitRequested()
      return queue.run('screen', SCREEN_TIMEOUT_MS, async () => {
        const accepted = await bridge.shutDownPageContainer(1)
        if (!accepted) {
          display.exitFailed() // No dialog opened (a timeout keeps the guard: the dialog may still open).
          throw new Error('G2 could not open the exit menu. Double-tap to retry.')
        }
        // Mode 1 shows the OS exit dialog. Only a following SYSTEM_EXIT (or
        // pagehide) disposes: the user can cancel the dialog. Resend the whole
        // frame next time in case the dialog disturbed the containers.
        display.invalidate()
      }, 'exit')
    },
    storageGet: storage.storageGet,
    storageSet: storage.storageSet,
    resetGestures() {
      filter.reset()
    },
    invalidate() {
      display.invalidate()
    },
    dispose,
  }
}
