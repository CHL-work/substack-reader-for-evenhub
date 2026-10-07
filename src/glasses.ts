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
import { OsEvent, describeEvent, mapEvent } from './events'
import type { GlassesAction, GlassesPage, GlassesStatus, LaunchSource, LifecycleSignal } from './events'
import { G2_BODY_LINES, G2_LAYOUT, G2_TEXT_PADDING, bodyBox, isReaderPage, normalizeReaderText, paginate, truncateGlassesLabel } from './pagination'

export { OsEvent, describeEvent, mapEvent } from './events'
export type { GlassesAction, GlassesPage, GlassesStatus, LaunchSource, LifecycleSignal, MappedEvent } from './events'

export interface GlassesMenuItem { itemID: number; itemName: string }

export interface GlassesOptions {
  /** First frame, sent with createStartUpPageContainer (no black screen). */
  initialPage: GlassesPage
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
}

export interface GlassesController {
  /** Resolves after the native write succeeded (rejects if the bridge refused it). */
  render(page: GlassesPage): Promise<void>
  /** shutDownPageContainer(1): the OS exit dialog; cancelling keeps the app usable. */
  exit(): Promise<void>
  /** bridge.getLocalStorage through the same serialized queue. '' means absent. */
  storageGet(key: string): Promise<string>
  /** bridge.setLocalStorage through the same serialized queue. */
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
  let queue: Promise<unknown> = Promise.resolve()
  let unsubscribeEvents = () => undefined as void
  let unsubscribeDevice = () => undefined as void
  let last: GlassesPage | null = null
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

  // Store a fulfilled recovery tail while returning the original rejection to
  // the caller. A failed native call must never block later page turns.
  function enqueue<T>(operation: () => Promise<T>, screen: boolean): Promise<T> {
    const pending = queue.then(async () => {
      if (disposed) throw new Error('The G2 reader is closed.')
      return operation()
    })
    queue = pending.catch(error => {
      if (!screen) return
      last = null // The next render refreshes every field after a partial update.
      if (!disposed) report('error', errorMessage(error))
    })
    return pending
  }

  function emit(action: GlassesAction) {
    if (disposed || exiting) return
    try {
      Promise.resolve(opts.onAction(action)).catch(error => report('error', errorMessage(error)))
    } catch (error) { report('error', errorMessage(error)) }
  }

  function invert(): boolean {
    try { return opts.invertSwipe() === true } catch { return false }
  }

  const initial = snapshotOf(opts.initialPage)
  if (!isReaderPage(initial.body, G2_BODY_LINES)) initial.body = paginate(initial.body, bodyBox(7))[0]!.text
  initial.body = clampChars(initial.body, CREATE_CONTENT_LIMIT)

  try {
    const menuObject = validMenu(opts.menuItems)
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
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
    }))
    // Do not retry: the host rejects a second create anyway.
    if (result !== 0) throw new Error(`G2 could not create the reader screen (code ${result}).`)
    last = initial
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
        last = null
        report('disconnected', GLASSES_MESSAGES.disconnected)
      } else if (status.connectType === DeviceConnectType.Connected) {
        last = null
        report('ready', GLASSES_MESSAGES.ready)
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
      const snapshot = snapshotOf(page)
      return enqueue(async () => {
        if (!isReaderPage(snapshot.body, G2_BODY_LINES)) {
          throw new RangeError('Reader body exceeds one G2 page. Paginate the text before rendering.')
        }
        for (const [field, containerID] of [['body', 2], ['title', 1], ['footer', 3]] as const) {
          if (disposed) return
          if (last?.[field] === snapshot[field]) continue
          // Never send textColor on upgrades, so the created brightness is kept.
          const accepted = await bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID,
            containerName: field,
            content: snapshot[field] || ' ',
          }))
          if (!accepted) throw new Error(`G2 rejected the ${field} update. Try the page again.`)
          lastWriteAt = clock()
        }
        if (disposed) return
        last = snapshot
        report('ready', GLASSES_MESSAGES.ready)
      }, true)
    },
    exit() {
      return enqueue(async () => {
        const accepted = await bridge.shutDownPageContainer(1)
        if (!accepted) throw new Error('G2 could not open the exit menu. Double-tap to retry.')
        // Mode 1 shows the OS exit dialog. Only a following SYSTEM_EXIT (or
        // pagehide) disposes: the user can cancel the dialog. Resend the whole
        // frame next time in case the dialog disturbed the containers.
        last = null
      }, true)
    },
    storageGet(key) {
      return enqueue(async () => {
        const value: unknown = await bridge.getLocalStorage(key)
        return typeof value === 'string' ? value : ''
      }, false)
    },
    storageSet(key, value) {
      // Defense in depth for the shared BLE link; storage.ts keeps values far smaller.
      if (value.length > MAX_BRIDGE_VALUE_CHARS) return Promise.resolve(false)
      return enqueue(async () => (await bridge.setLocalStorage(key, value)) === true, false)
    },
    resetGestures() {
      filter.reset()
    },
    invalidate() {
      last = null
    },
    dispose,
  }
}
