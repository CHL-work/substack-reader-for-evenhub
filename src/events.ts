/**
 * Pure G2 event mapping, the bridge call queue and the display state, kept
 * apart from glasses.ts so Node unit tests never load the SDK runtime (its
 * obfuscated bundle installs timer and window hooks at import time). Only a
 * type is imported from the SDK; esbuild/tsc erase it.
 */
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'

/**
 * Numeric values of the SDK's `OsEventTypeList` (0.0.16), copied here so this
 * module has no runtime dependency on the SDK. Values 9/10 need SDK 0.0.14+.
 */
export const OsEvent = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  IMU_DATA_REPORT: 8,
  LONG_PRESS: 9,
  LONG_PRESS_RELEASE: 10,
} as const

export type GlassesAction =
  | 'next'            // SCROLL_BOTTOM (SCROLL_TOP when invertSwipe)
  | 'previous'        // SCROLL_TOP (SCROLL_BOTTOM when invertSwipe)
  | 'select'          // CLICK (eventType missing inside an existing sys/text/list envelope)
  | 'back'            // DOUBLE_CLICK
  | 'hold'            // LONG_PRESS
  | `menu:${number}`  // menuItemClickEvent.itemID
/** FOREGROUND_ENTER / FOREGROUND_EXIT. The OS menu overlay also emits these. */
export type LifecycleSignal = 'foreground' | 'background'
export type MappedEvent = GlassesAction | LifecycleSignal | 'exitApp'
export type LaunchSource = 'appMenu' | 'glassesMenu'

export interface GlassesPage {
  title: string
  /** One page from paginate(); rendering never silently drops text. */
  body: string
  footer: string
}
export interface GlassesStatus {
  state: 'connecting' | 'ready' | 'disconnected' | 'error' | 'closed'
  message: string
}

type Envelope = { eventType?: unknown } | null | undefined

const TYPE_NAMES = [
  'CLICK', 'SCROLL_TOP', 'SCROLL_BOTTOM', 'DOUBLE_CLICK', 'FOREGROUND_ENTER', 'FOREGROUND_EXIT',
  'ABNORMAL_EXIT', 'SYSTEM_EXIT', 'IMU_DATA_REPORT', 'LONG_PRESS', 'LONG_PRESS_RELEASE',
] as const

/** Accept the numeric ordinal or the SDK's string spellings (`SCROLL_TOP_EVENT`, `SCROLL_TOP`). */
function normalizeType(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (/^\d{1,2}$/.test(trimmed)) return Number(trimmed)
    const name = trimmed.toUpperCase().replace(/_EVENT$/, '')
    const index = (TYPE_NAMES as readonly string[]).indexOf(name === 'IMU_DATA' ? 'IMU_DATA_REPORT' : name)
    return index >= 0 ? index : null
  }
  return null
}

/**
 * CLICK is zero, the protobuf default, so it may be omitted on the wire, but
 * only inside an envelope. A missing envelope is never a click.
 */
function eventTypeOf(envelope: Envelope): number | null {
  if (!envelope || typeof envelope !== 'object') return null
  const raw = envelope.eventType
  return raw === undefined || raw === null ? OsEvent.CLICK : normalizeType(raw)
}

function menuItemId(event: EvenHubEvent): number | null {
  const raw: unknown = event.menuItemClickEvent?.itemID
  const id = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : raw
  return typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 0xffffffff ? id : null
}

/**
 * Map one SDK event to an app action. All three envelopes are inspected
 * because routing differs between hardware, ring and simulator. Explicit
 * types are resolved before the zero-valued click.
 */
export function mapEvent(e: EvenHubEvent, invert: boolean): MappedEvent | null {
  if (!e || typeof e !== 'object') return null
  const types = [eventTypeOf(e.sysEvent), eventTypeOf(e.textEvent), eventTypeOf(e.listEvent)]
  const has = (type: number) => types.includes(type)

  if (has(OsEvent.SYSTEM_EXIT) || has(OsEvent.ABNORMAL_EXIT)) return 'exitApp'
  const menu = menuItemId(e)
  if (menu !== null) return `menu:${menu}`
  if (has(OsEvent.DOUBLE_CLICK)) return 'back'
  if (has(OsEvent.LONG_PRESS)) return 'hold'
  if (has(OsEvent.SCROLL_TOP)) return invert ? 'next' : 'previous'
  if (has(OsEvent.SCROLL_BOTTOM)) return invert ? 'previous' : 'next'
  if (has(OsEvent.FOREGROUND_ENTER)) return 'foreground'
  if (has(OsEvent.FOREGROUND_EXIT)) return 'background'
  if (has(OsEvent.LONG_PRESS_RELEASE) || has(OsEvent.IMU_DATA_REPORT)) return null
  if (has(OsEvent.CLICK)) return 'select'
  return null
}

function sourceOf(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return ''
  const source = (envelope as { eventSource?: unknown }).eventSource
  return typeof source === 'number' || typeof source === 'string' ? `@${String(source).slice(0, 8)}` : ''
}

function typeLabel(envelope: Envelope): string {
  if (!envelope || typeof envelope !== 'object') return '?'
  const raw = envelope.eventType
  if (raw === undefined || raw === null) return 'CLICK(omitted)'
  const type = normalizeType(raw)
  return type !== null && type >= 0 && type < TYPE_NAMES.length ? TYPE_NAMES[type]! : `type ${String(raw).slice(0, 16)}`
}

/**
 * A short diagnostics line: envelope, event type and input source only.
 * Never includes text, IMU values or audio data.
 */
export function describeEvent(e: EvenHubEvent): string {
  if (!e || typeof e !== 'object') return 'invalid'
  const parts: string[] = []
  if (e.sysEvent) parts.push(`sys:${typeLabel(e.sysEvent)}${sourceOf(e.sysEvent)}`)
  if (e.textEvent) parts.push(`text:${typeLabel(e.textEvent)}`)
  if (e.listEvent) {
    const index = e.listEvent.currentSelectItemIndex
    parts.push(`list:${typeLabel(e.listEvent)}#${typeof index === 'number' ? index : 0}`)
  }
  if (e.menuItemClickEvent) parts.push(`menu:${menuItemId(e) ?? '?'}`)
  if (e.audioEvent) parts.push('audio')
  return parts.length ? parts.join(' ') : 'empty'
}

// ---------------------------------------------------------------------------
// Bridge call queue

/**
 * Bound for one native screen call: one textContainerUpgrade (a frame makes up to 3, each bounded on
 * its own, so a slow but working link never times out a whole frame) or shutDownPageContainer.
 */
export const SCREEN_TIMEOUT_MS = 5000
/** Bound for one bridge storage call (getLocalStorage / setLocalStorage). */
export const STORAGE_TIMEOUT_MS = 4000
/** A refused container update is tried once more after this pause (transient refusals on a busy link). */
export const UPGRADE_RETRY_MS = 150

/**
 * A render that a newer render replaced before it reached the glasses. The
 * frame was never shown; callers must not retry it (the newer one is queued).
 * Callers test `error.name === 'SupersededRenderError'`, not the class.
 */
export class SupersededRenderError extends Error {
  constructor() {
    super('A newer G2 frame replaced this one before it was shown.')
    this.name = 'SupersededRenderError'
  }
}

/** A bridge call that did not answer within its bound. The queue moves on. */
export class BridgeTimeoutError extends Error {
  constructor(what: string) {
    super(what === 'storage' ? 'The Even app did not answer a storage request in time.' : 'G2 did not answer in time.')
    this.name = 'BridgeTimeoutError'
  }
}

export type BridgeCallKind = 'screen' | 'storage'
/**
 * What a call does, passed back to onScreenError and onLate: 'render', 'upgrade' (one container
 * update inside a render), 'exit', 'create', 'get', 'set'. Defaults to the call's kind.
 */
export type BridgeCallLabel = string
/** `live()` turns false once the call timed out (or the reader closed): stop issuing bridge calls. */
export type BridgeOperation<T> = (live: () => boolean) => Promise<T>
/** setTimeout-like; returns a cancel function. Tests inject a fake clock. */
export type Schedule = (callback: () => void, ms: number) => () => void

export interface BridgeQueueOptions {
  /** True once the reader is disposed: calls not yet started reject without reaching the bridge. */
  closed(): boolean
  /** A screen call (render or exit) failed or timed out. Never called for superseded renders. */
  onScreenError?(error: unknown, label: BridgeCallLabel): void
  /** A call that already timed out settled afterwards: its native effect may have landed late. */
  onLate?(kind: BridgeCallKind, label: BridgeCallLabel): void
  schedule?: Schedule
}

export interface BridgeQueue {
  /**
   * Run one bridge call after every earlier one settled (or timed out), bounded by `ms`
   * (Infinity: no bound for the whole call; each native call inside it is bounded with `call`).
   */
  run<T>(kind: BridgeCallKind, ms: number, operation: BridgeOperation<T>, label?: BridgeCallLabel): Promise<T>
  /**
   * One native call inside a running operation (it does not wait for the queue), bounded by `ms` on
   * its own. A timeout rejects with BridgeTimeoutError; a late answer is reported through onLate.
   */
  call<T>(kind: BridgeCallKind, ms: number, native: () => Promise<T>, label?: BridgeCallLabel): Promise<T>
  /**
   * A call that must not overlap any other but may take longer than `ms` (createStartUpPageContainer):
   * later calls wait for it at most `ms`, while the returned promise follows its answer, unbounded.
   */
  hold<T>(kind: BridgeCallKind, ms: number, native: () => Promise<T>, label?: BridgeCallLabel): Promise<T>
  /**
   * A screen call where at most one waits: a render requested while another
   * is queued and not started replaces it, and the replaced promise rejects
   * with SupersededRenderError. So anything queued after it (exit, storage)
   * waits for at most one render.
   */
  render(ms: number, operation: BridgeOperation<void>): Promise<void>
  /** A render is queued and has not started. */
  renderPending(): boolean
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

/**
 * The single serialized chain for every bridge call (SPEC 3.1 item 7), with a
 * per-call timeout: the SDK has none, and one call that never settles would
 * otherwise freeze page turns, the exit dialog and storage for good.
 */
export function createBridgeQueue(options: BridgeQueueOptions): BridgeQueue {
  const schedule = options.schedule ?? defaultSchedule
  let tail: Promise<unknown> = Promise.resolve()
  let waiting: { operation: BridgeOperation<void>; resolve(): void; reject(error: unknown): void } | null = null

  function late(kind: BridgeCallKind, label: BridgeCallLabel) {
    try { options.onLate?.(kind, label) } catch { /* Observer errors are isolated. */ }
  }

  function bounded<T>(kind: BridgeCallKind, ms: number, operation: BridgeOperation<T>, label: BridgeCallLabel): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timedOut = false
      const cancel = Number.isFinite(ms) ? schedule(() => {
        if (settled) return
        settled = true
        timedOut = true
        reject(new BridgeTimeoutError(kind))
      }, ms) : () => undefined
      let native: Promise<T>
      try {
        native = Promise.resolve(operation(() => !timedOut && !options.closed()))
      } catch (error) {
        native = Promise.reject(error)
      }
      const finish = (ok: boolean, value: unknown) => {
        if (settled) {
          if (timedOut) late(kind, label)
          return
        }
        settled = true
        cancel()
        if (ok) resolve(value as T)
        else reject(value)
      }
      native.then(value => finish(true, value), error => finish(false, error))
    })
  }

  function run<T>(kind: BridgeCallKind, ms: number, operation: BridgeOperation<T>, label: BridgeCallLabel = kind): Promise<T> {
    const result = tail.then(() => {
      if (options.closed()) throw new Error('The G2 reader is closed.')
      return bounded(kind, ms, operation, label)
    })
    // Keep a fulfilled tail while the caller gets the rejection: a failed or
    // hung call must never block later page turns.
    tail = result.catch(error => {
      if (kind !== 'screen' || error instanceof SupersededRenderError) return
      try { options.onScreenError?.(error, label) } catch { /* Observer errors are isolated. */ }
    })
    return result
  }

  function call<T>(kind: BridgeCallKind, ms: number, native: () => Promise<T>, label: BridgeCallLabel = kind): Promise<T> {
    return bounded(kind, ms, () => native(), label)
  }

  function hold<T>(kind: BridgeCallKind, ms: number, native: () => Promise<T>, label: BridgeCallLabel = kind): Promise<T> {
    let answer!: Promise<T>
    const turn = run(kind, Infinity, () => {
      try {
        answer = Promise.resolve(native())
      } catch (error) {
        answer = Promise.reject(error)
      }
      // The queue moves on once the call answered or after `ms`; the caller still gets its answer.
      return new Promise<void>(resolve => {
        const cancel = schedule(resolve, ms)
        const done = () => { cancel(); resolve() }
        answer.then(done, done)
      })
    }, label)
    return turn.then(() => answer)
  }

  function render(ms: number, operation: BridgeOperation<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (waiting) {
        const replaced = waiting
        replaced.reject(new SupersededRenderError())
        replaced.operation = operation
        replaced.resolve = resolve
        replaced.reject = reject
        return
      }
      const slot = { operation, resolve, reject }
      waiting = slot
      const release = () => { if (waiting === slot) waiting = null }
      run('screen', ms, live => {
        release()
        return slot.operation(live)
      }, 'render').then(() => {
        release()
        slot.resolve()
      }, error => {
        release()
        slot.reject(error)
      })
    })
  }

  return { run, call, hold, render, renderPending: () => waiting !== null }
}

// ---------------------------------------------------------------------------
// What the glasses show, field by field

export type FrameField = keyof GlassesPage
/** Write order: the body first (what the wearer reads), then title and footer. */
const FRAME_FIELDS: readonly FrameField[] = ['body', 'title', 'footer']

export interface DisplayOptions {
  queue: BridgeQueue
  /** One container update (textContainerUpgrade); true when the glasses accepted it. */
  upgrade(field: FrameField, content: string): Promise<boolean>
  /** Runs first inside the queued write; throw to refuse the frame (the overflow guard). */
  check?(page: GlassesPage): void
  /** A container update was accepted. */
  onWrite?(): void
  /**
   * A whole frame was accepted. `newest`: it is the newest frame asked for, so the display now
   * shows what was last drawn (also when that render had already failed and a late recovery wrote it).
   */
  onFrame?(newest: boolean): void
  /** Timer for the pause before a refused update is retried; tests inject a fake clock. */
  schedule?: Schedule
}

export interface Display {
  /** The page was created showing `page` (createStartUpPageContainer). */
  created(page: GlassesPage): void
  /**
   * Queue a frame (coalesced: see BridgeQueue.render). Only fields that differ from what the
   * glasses are known to show are sent; each update is bounded by SCREEN_TIMEOUT_MS on its own.
   */
  render(page: GlassesPage): Promise<void>
  /**
   * What the glasses show is unknown (reconnect, exit dialog, forced redraw): the next frame
   * resends every field, and a write in flight records only updates it sends after this call.
   */
  invalidate(): void
  /**
   * A screen call that timed out landed after all and may have overwritten a newer field. Forget
   * the display and send the newest frame again, once per frame. A late exit dialog is never drawn
   * over: the next frame the controller asks for resends every field.
   */
  late(label: BridgeCallLabel): void
  /** Fields known to be on the display (diagnostics and tests). */
  shown(): Partial<GlassesPage>
}

export function createDisplay(options: DisplayOptions): Display {
  const { queue } = options
  const schedule = options.schedule ?? defaultSchedule
  /** Fields known to be on the display; a field being written is absent until it was accepted. */
  let known: Partial<GlassesPage> = {}
  /** Bumped by every invalidation, so a write in flight cannot record a field over it. */
  let epoch = 0
  /** The newest frame asked for (sent again when a timed-out write lands late). */
  let wanted: GlassesPage | null = null
  /** The frame a late answer already re-sent: one late redraw per frame, so a slow link cannot loop. */
  let lateRetried: GlassesPage | null = null

  function invalidate() {
    epoch += 1
    known = {}
  }

  function abandoned(live: () => boolean) {
    if (!live()) throw new Error('The G2 reader is closed.')
  }

  function upgrade(field: FrameField, content: string): Promise<boolean> {
    return queue.call('screen', SCREEN_TIMEOUT_MS, async () => (await options.upgrade(field, content)) === true, 'upgrade')
  }

  async function write(page: GlassesPage, live: () => boolean): Promise<void> {
    options.check?.(page)
    for (const field of FRAME_FIELDS) {
      abandoned(live)
      if (known[field] === page[field]) continue
      const before = epoch
      delete known[field] // Unknown until the glasses accept it.
      let accepted = await upgrade(field, page[field])
      if (!accepted) {
        // One retry absorbs a transient refusal; a second one fails the frame (the controller redraws it).
        await new Promise<void>(resolve => { schedule(resolve, UPGRADE_RETRY_MS) })
        abandoned(live)
        accepted = await upgrade(field, page[field])
      }
      if (!accepted) throw new Error(`G2 rejected the ${field} update. Try the page again.`)
      // Recorded only when nothing invalidated the display while it was sent.
      if (before === epoch) known[field] = page[field]
      try { options.onWrite?.() } catch { /* Observer errors are isolated. */ }
    }
    abandoned(live)
    try { options.onFrame?.(page === wanted) } catch { /* Observer errors are isolated. */ }
  }

  function render(page: GlassesPage): Promise<void> {
    wanted = page
    return queue.render(Infinity, live => write(page, live))
  }

  return {
    created(page) {
      invalidate()
      known = { ...page }
      wanted = page
    },
    render,
    invalidate,
    late(label) {
      invalidate()
      if (label === 'exit' || !wanted || queue.renderPending() || lateRetried === wanted) return
      lateRetried = wanted
      render(wanted).catch(() => undefined)
    },
    shown: () => ({ ...known }),
  }
}

/**
 * When the glasses need a full redraw after the link comes back: after a
 * disconnect, or after a screen write failed. Decided from device events, not
 * from the reported status, because a render while disconnected may report
 * 'error' or even 'ready' in between, and a repeated 'ready' is de-duplicated.
 */
export interface LinkTracker {
  disconnected(): void
  writeFailed(): void
  /** A frame was fully written (clears a failed write, not a disconnect). */
  written(): void
  /** The device reports Connected: true when what it shows is unknown. */
  connected(): boolean
}

export function createLinkTracker(): LinkTracker {
  let lost = false
  let failed = false
  return {
    disconnected() { lost = true },
    writeFailed() { failed = true },
    written() { failed = false },
    connected() {
      const stale = lost || failed
      lost = false
      failed = false
      return stale
    },
  }
}
