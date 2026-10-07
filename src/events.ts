/**
 * Pure G2 event mapping, kept apart from glasses.ts so Node unit tests never
 * load the SDK runtime (its obfuscated bundle installs timer and window hooks
 * at import time). Only a type is imported from the SDK; esbuild/tsc erase it.
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
