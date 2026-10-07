/**
 * Persistence: two JSON documents (prefs, progress), each kept under
 * MAX_KEY_CHARS. Bridge storage is the source of truth once the glasses are
 * connected; window.localStorage is a mirror (and the only backend in a plain
 * browser). The newest `savedAt` wins between the two. Every value read back
 * is normalized defensively; article text or HTML is never persisted (the
 * normalizers whitelist PostRef metadata fields only).
 */
import type { AppState, HomeItemId, Position, PostRef, PrefsDoc, ProgressDoc, Publication, Settings } from './app/types'
import { HOME_ITEM_IDS, LATEST_MAX_PUBLICATIONS_RANGE, LIMITS, defaultSettings, emptyState } from './app/types'
import { PUBLIC_HOST_RE } from './substack/types'

export interface KV {
  /** '' when the key is absent or unreadable. */
  get(key: string): Promise<string>
  /** true only when the value was stored. */
  set(key: string, value: string): Promise<boolean>
  /** Diagnostics label, e.g. 'bridge+localStorage'. */
  readonly name?: string
}

/** The subset of GlassesController used for storage (kept structural so tests need no SDK). */
export interface StorageBridge {
  storageGet(key: string): Promise<string>
  storageSet(key: string, value: string): Promise<boolean>
}

export const KEYS = { prefs: 'sr:prefs:v1', progress: 'sr:progress:v1' } as const
export type DocName = keyof typeof KEYS
const DOCS: readonly DocName[] = ['prefs', 'progress']

/** Per-key cap (bridge values must stay below 48k characters). */
export const MAX_KEY_CHARS = 48_000
/** Values read back above this are treated as corrupt. */
const MAX_READ_CHARS = 4 * MAX_KEY_CHARS
export const SAVE_DEBOUNCE_MS = 800

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const TITLE_MAX = 200
const NAME_MAX = 120
const VERSION_MAX = 32

// ---------------------------------------------------------------------------
// Defensive normalizers (LIHKG storage.ts helpers)

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, limit).trim() : ''
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function hostFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  return PUBLIC_HOST_RE.test(host) ? host : null
}

/** Substack ids are positive; the RSS fallback uses negative synthetic ids. Zero is never valid. */
function postIdFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : null
}

function wordcountFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function dateFrom(value: unknown): string {
  const raw = text(value, 40)
  return raw && Number.isFinite(Date.parse(raw)) ? raw : ''
}

function uniqueItems<T>(value: unknown, parse: (item: unknown) => T | null, key: (item: T) => string, limit: number): T[] {
  const result: T[] = []
  const seen = new Set<string>()
  if (!Array.isArray(value)) return result
  for (const raw of value) {
    const item = parse(raw)
    if (item === null) continue
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}

/** Stable identity of a post pointer: the Substack id, or host/slug for synthetic (feed) ids. */
export function refKey(ref: Pick<PostRef, 'postId' | 'host' | 'slug'>): string {
  return ref.postId > 0 ? `#${ref.postId}` : `${ref.host}/${ref.slug}`
}

export function normalizePublication(input: unknown): Publication | null {
  const item = record(input)
  const host = hostFrom(item.host)
  if (!host) return null
  const id = typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0 ? item.id : null
  return { id, name: text(item.name, NAME_MAX) || host, host, addedAt: timestamp(item.addedAt), inLatest: bool(item.inLatest, true) }
}

/** Only metadata fields survive; anything else on the input (e.g. bodyHtml) is dropped. */
export function normalizePostRef(input: unknown): PostRef | null {
  const item = record(input)
  const postId = postIdFrom(item.postId)
  const host = hostFrom(item.host)
  if (postId === null || !host) return null
  const slug = typeof item.slug === 'string' && SLUG_RE.test(item.slug) ? item.slug : ''
  if (!slug && postId < 0) return null // A synthetic id can only be fetched by slug.
  return {
    postId,
    host,
    slug,
    title: text(item.title, TITLE_MAX) || 'Untitled',
    pubName: text(item.pubName, NAME_MAX) || host,
    postDate: dateFrom(item.postDate),
    isPaywalled: bool(item.isPaywalled, false),
    wordcount: wordcountFrom(item.wordcount),
    addedAt: timestamp(item.addedAt),
  }
}

export function normalizePosition(input: unknown): Position | null {
  const item = record(input)
  const postId = postIdFrom(item.postId)
  const { offset, page, pages, fraction } = item
  if (postId === null) return null
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null
  if (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 1) return null
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0 || page > pages) return null
  const share = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : page / pages
  return { postId, offset, fraction: share, page, pages, version: text(item.version, VERSION_MAX), updatedAt: timestamp(item.updatedAt) }
}

function isHomeItemId(value: unknown): value is HomeItemId {
  return typeof value === 'string' && (HOME_ITEM_IDS as readonly string[]).includes(value)
}

export function normalizeSettings(input: unknown): Settings {
  const value = record(input)
  const defaults = defaultSettings()
  const lines = value.linesPerPage
  const max = value.latestMaxPublications
  const homeItems = Array.isArray(value.homeItems) ? [...new Set(value.homeItems.filter(isHomeItemId))] : []
  return {
    linesPerPage: lines === 5 || lines === 6 || lines === 7 ? lines : defaults.linesPerPage,
    tapInReader: value.tapInReader === 'next' || value.tapInReader === 'none' ? value.tapInReader : defaults.tapInReader,
    invertSwipe: bool(value.invertSwipe, defaults.invertSwipe),
    bareImages: value.bareImages === 'drop' || value.bareImages === 'placeholder' ? value.bareImages : defaults.bareImages,
    footnotes: value.footnotes === 'end' || value.footnotes === 'inline' || value.footnotes === 'omit' ? value.footnotes : defaults.footnotes,
    uppercaseHeadings: bool(value.uppercaseHeadings, defaults.uppercaseHeadings),
    stripEmoji: bool(value.stripEmoji, defaults.stripEmoji),
    homeItems: homeItems.length ? homeItems : defaults.homeItems,
    latestMaxPublications: typeof max === 'number' && Number.isInteger(max)
      && max >= LATEST_MAX_PUBLICATIONS_RANGE.min && max <= LATEST_MAX_PUBLICATIONS_RANGE.max ? max : defaults.latestMaxPublications,
  }
}

export function normalizePrefs(input: unknown): PrefsDoc {
  const value = record(input)
  return {
    schemaVersion: 1,
    savedAt: timestamp(value.savedAt),
    publications: uniqueItems(value.publications, normalizePublication, item => item.host, LIMITS.publications),
    saved: uniqueItems(value.saved, normalizePostRef, refKey, LIMITS.saved),
    settings: normalizeSettings(value.settings),
  }
}

export function normalizeProgress(input: unknown): ProgressDoc {
  const value = record(input)
  // Most recent first; the sort is stable, so equal timestamps keep their order.
  const positions = uniqueItems(
    Array.isArray(value.positions)
      ? value.positions.map(normalizePosition).filter((item): item is Position => item !== null).sort((a, b) => b.updatedAt - a.updatedAt)
      : [],
    item => item as Position, item => String(item.postId), LIMITS.positions)
  return {
    schemaVersion: 1,
    savedAt: timestamp(value.savedAt),
    positions,
    history: uniqueItems(value.history, normalizePostRef, refKey, LIMITS.history),
    read: uniqueItems(value.read, postIdFrom, String, LIMITS.read),
    lastOpen: value.lastOpen === null || value.lastOpen === undefined ? null : normalizePostRef(value.lastOpen),
  }
}

/** Parse a stored value; null when absent, oversized or corrupt. */
export function parseStored(raw: string): unknown {
  if (!raw || raw.length > MAX_READ_CHARS) return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

/** savedAt of a stored document, or -1 when absent/corrupt (so any valid copy beats it). */
export function savedAtOf(raw: string): number {
  const parsed = parseStored(raw)
  if (parsed === null) return -1
  const value = record(parsed).savedAt
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

// ---------------------------------------------------------------------------
// Serialization with caps

export function serializePrefs(state: AppState, savedAt: number): string | null {
  const doc = normalizePrefs({ ...state, savedAt })
  const raw = JSON.stringify(doc)
  return raw.length <= MAX_KEY_CHARS ? raw : null
}

function progressJson(doc: ProgressDoc): string {
  return JSON.stringify(doc)
}

/**
 * Serialize progress, evicting the oldest positions, then history, then read
 * ids until it fits MAX_KEY_CHARS. Evictions are applied to `state` so memory
 * matches what is persisted. null when even an empty history cannot fit.
 */
export function serializeProgress(state: AppState, savedAt: number): string | null {
  const doc = normalizeProgress({ ...state, savedAt })
  let raw = progressJson(doc)
  let evicted = false
  for (const field of ['positions', 'history', 'read'] as const) {
    const list: unknown[] = doc[field]
    while (raw.length > MAX_KEY_CHARS && list.length) {
      // Drop enough items from the old end to cover the excess, then measure exactly.
      let excess = raw.length - MAX_KEY_CHARS
      while (excess > 0 && list.length) excess -= JSON.stringify(list.pop()).length + 1
      evicted = true
      raw = progressJson(doc)
    }
  }
  if (evicted) {
    state.positions = doc.positions
    state.history = doc.history
    state.read = doc.read
  }
  return raw.length <= MAX_KEY_CHARS ? raw : null
}

// ---------------------------------------------------------------------------
// Key-value backends

async function safeGet(kv: KV, key: string): Promise<string> {
  try {
    const value: unknown = await kv.get(key)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

async function safeSet(kv: KV, key: string, value: string): Promise<boolean> {
  try { return (await kv.set(key, value)) === true } catch { return false }
}

/** window.localStorage; every access is guarded (blocked storage, quota, missing window). */
export function browserKV(): KV {
  const storage = (): Storage | null => {
    try { return typeof window === 'undefined' ? null : window.localStorage ?? null } catch { return null }
  }
  return {
    name: 'localStorage',
    async get(key) {
      try { return storage()?.getItem(key) ?? '' } catch { return '' }
    },
    async set(key, value) {
      try {
        const target = storage()
        if (!target) return false
        target.setItem(key, value)
        return true
      } catch {
        return false
      }
    },
  }
}

/** Bridge storage via the glasses queue. '' means absent; values are kept below MAX_KEY_CHARS. */
export function bridgeKV(bridge: StorageBridge): KV {
  return {
    name: 'bridge',
    async get(key) {
      try {
        const value: unknown = await bridge.storageGet(key)
        return typeof value === 'string' ? value : ''
      } catch {
        return ''
      }
    },
    async set(key, value) {
      if (value.length > MAX_KEY_CHARS) return false
      try { return (await bridge.storageSet(key, value)) === true } catch { return false }
    },
  }
}

/**
 * Read both backends and return the copy with the newest savedAt (primary on
 * ties); write both. The result of a write is the primary's (the source of
 * truth), or the mirror's when there is no primary.
 */
export function mirroredKV(primary: KV | null, mirror: KV): KV {
  return {
    name: primary ? `${primary.name ?? 'primary'}+${mirror.name ?? 'mirror'}` : mirror.name ?? 'mirror',
    async get(key) {
      const [first, second] = await Promise.all([primary ? safeGet(primary, key) : Promise.resolve(''), safeGet(mirror, key)])
      if (!first) return second
      if (!second) return first
      return savedAtOf(second) > savedAtOf(first) ? second : first
    },
    async set(key, value) {
      const [first, second] = await Promise.all([primary ? safeSet(primary, key, value) : Promise.resolve(false), safeSet(mirror, key, value)])
      return primary ? first : second
    },
  }
}

// ---------------------------------------------------------------------------
// Store

export interface StoreOptions {
  now?: () => number
  /** Debounce scheduler; returns a cancel function. Tests inject a fake. */
  schedule?: (callback: () => void, ms: number) => () => void
  debounceMs?: number
  /** Called after every write attempt that had something to write. */
  onSaved?: (ok: boolean) => void
}

export interface Store {
  /** Mutable in place; the object identity never changes (arrays may be replaced). */
  readonly state: AppState
  /** Read both documents; corrupt or missing values fall back to defaults. */
  load(kv: KV): Promise<void>
  /** Mark a document (default both) dirty and write it after SAVE_DEBOUNCE_MS. */
  save(which?: DocName): void
  /** Write dirty documents now. Resolves false if any write failed or did not fit. */
  flush(): Promise<boolean>
  /**
   * After the glasses connect: re-read through `kv`, adopt any document newer
   * than memory, make `kv` the backend and persist both documents to it.
   * Resolves true when memory changed (redraw the phone).
   */
  attachBridge(kv: KV): Promise<boolean>
  /** Result of the most recent write attempt (true before any). */
  lastSaveOk(): boolean
  /** Name of the backend in use, or 'none' before load(). */
  backend(): string
  /** Serialized sizes (characters) of the last written or loaded documents. */
  sizes(): { prefs: number; progress: number }
  /** True while a debounced write is scheduled or documents are dirty. */
  pending(): boolean
}

export function createStore(options: StoreOptions = {}): Store {
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  })
  const delay = options.debounceMs ?? SAVE_DEBOUNCE_MS
  const state = emptyState()
  const savedAt: Record<DocName, number> = { prefs: 0, progress: 0 }
  const changedAt: Record<DocName, number> = { prefs: 0, progress: 0 }
  const dirty: Record<DocName, boolean> = { prefs: false, progress: false }
  const size: Record<DocName, number> = { prefs: 0, progress: 0 }
  let kv: KV | null = null
  let cancel: (() => void) | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let ok = true

  function applyPrefs(doc: PrefsDoc) {
    state.publications = doc.publications
    state.saved = doc.saved
    state.settings = doc.settings
    savedAt.prefs = doc.savedAt
  }

  function applyProgress(doc: ProgressDoc) {
    state.positions = doc.positions
    state.history = doc.history
    state.read = doc.read
    state.lastOpen = doc.lastOpen
    savedAt.progress = doc.savedAt
  }

  async function readDocs(source: KV): Promise<Record<DocName, { raw: string; value: unknown }>> {
    const prefs = await safeGet(source, KEYS.prefs)
    const progress = await safeGet(source, KEYS.progress)
    return { prefs: { raw: prefs, value: parseStored(prefs) }, progress: { raw: progress, value: parseStored(progress) } }
  }

  /** Memory's effective timestamp: unsaved edits count as newer than the last save. */
  function localStamp(name: DocName): number {
    return dirty[name] ? Math.max(savedAt[name], changedAt[name]) : savedAt[name]
  }

  function serialize(name: DocName, stamp: number): string | null {
    return name === 'prefs' ? serializePrefs(state, stamp) : serializeProgress(state, stamp)
  }

  async function writeDirty(): Promise<boolean> {
    const names = DOCS.filter(name => dirty[name])
    if (!names.length) return true
    const target = kv
    if (!target) return false
    let success = true
    for (const name of names) {
      dirty[name] = false
      const stamp = Math.max(now(), savedAt[name] + 1)
      const raw = serialize(name, stamp)
      if (raw === null) {
        success = false // Too large even after eviction; retrying cannot help.
        continue
      }
      size[name] = raw.length
      if (await safeSet(target, KEYS[name], raw)) {
        savedAt[name] = stamp
      } else {
        dirty[name] = true
        success = false
      }
    }
    ok = success
    try { options.onSaved?.(success) } catch { /* Observer errors are isolated. */ }
    return success
  }

  function flush(): Promise<boolean> {
    if (cancel) {
      cancel()
      cancel = null
    }
    const run = chain.then(writeDirty)
    chain = run.catch(() => undefined)
    return run
  }

  return {
    state,
    async load(source) {
      kv = source
      const docs = await readDocs(source)
      applyPrefs(normalizePrefs(docs.prefs.value))
      applyProgress(normalizeProgress(docs.progress.value))
      size.prefs = docs.prefs.raw.length
      size.progress = docs.progress.raw.length
      dirty.prefs = false
      dirty.progress = false
    },
    save(which) {
      const stamp = now()
      for (const name of which ? [which] : DOCS) {
        dirty[name] = true
        changedAt[name] = stamp
      }
      if (cancel) cancel()
      cancel = schedule(() => {
        cancel = null
        void flush()
      }, delay)
    },
    flush,
    async attachBridge(source) {
      await chain
      const docs = await readDocs(source)
      let changed = false
      if (docs.prefs.value !== null) {
        const remote = normalizePrefs(docs.prefs.value)
        if (remote.savedAt > localStamp('prefs')) {
          applyPrefs(remote)
          changed = true
        }
      }
      if (docs.progress.value !== null) {
        const remote = normalizeProgress(docs.progress.value)
        if (remote.savedAt > localStamp('progress')) {
          applyProgress(remote)
          changed = true
        }
      }
      kv = source
      const stamp = now()
      for (const name of DOCS) {
        dirty[name] = true
        changedAt[name] = Math.max(changedAt[name], stamp)
      }
      await flush()
      return changed
    },
    lastSaveOk: () => ok,
    backend: () => (kv ? kv.name ?? 'custom' : 'none'),
    sizes: () => ({ prefs: size.prefs, progress: size.progress }),
    pending: () => cancel !== null || dirty.prefs || dirty.progress,
  }
}

// ---------------------------------------------------------------------------
// State mutations shared by the controller and the phone UI.
// Callers persist with store.save('prefs' | 'progress') afterwards.

export function positionOf(state: AppState, postId: number): Position | null {
  return state.positions.find(item => item.postId === postId) ?? null
}

/** Upsert as the most recent position (LRU at the end). */
export function recordPosition(state: AppState, position: Position): void {
  const valid = normalizePosition(position)
  if (!valid) return
  state.positions = [valid, ...state.positions.filter(item => item.postId !== valid.postId)].slice(0, LIMITS.positions)
}

export function isRead(state: AppState, postId: number): boolean {
  return state.read.includes(postId)
}

/** Most recent first. Returns false when it was already the most recent read id. */
export function markRead(state: AppState, postId: number): boolean {
  if (postIdFrom(postId) === null || state.read[0] === postId) return false
  state.read = [postId, ...state.read.filter(id => id !== postId)].slice(0, LIMITS.read)
  return true
}

/** Most recently opened first. */
export function recordHistory(state: AppState, ref: PostRef): void {
  const valid = normalizePostRef(ref)
  if (!valid) return
  const key = refKey(valid)
  state.history = [valid, ...state.history.filter(item => refKey(item) !== key)].slice(0, LIMITS.history)
}

export function setLastOpen(state: AppState, ref: PostRef | null): void {
  state.lastOpen = ref === null ? null : normalizePostRef(ref)
}

export function isSaved(state: AppState, ref: Pick<PostRef, 'postId' | 'host' | 'slug'>): boolean {
  const key = refKey(ref)
  return state.saved.some(item => refKey(item) === key)
}

export type AddResult = 'added' | 'exists' | 'full' | 'invalid'

/** Append to Saved (ordered list; new items go last). */
export function addSaved(state: AppState, ref: PostRef): AddResult {
  const valid = normalizePostRef(ref)
  if (!valid) return 'invalid'
  if (isSaved(state, valid)) return 'exists'
  if (state.saved.length >= LIMITS.saved) return 'full'
  state.saved.push(valid)
  return 'added'
}

export function removeSaved(state: AppState, ref: Pick<PostRef, 'postId' | 'host' | 'slug'>): boolean {
  const key = refKey(ref)
  const index = state.saved.findIndex(item => refKey(item) === key)
  if (index < 0) return false
  state.saved.splice(index, 1)
  return true
}

/** Append to the ordered publication list (deduped by host). */
export function addPublication(state: AppState, publication: Publication): AddResult {
  const valid = normalizePublication(publication)
  if (!valid) return 'invalid'
  if (state.publications.some(item => item.host === valid.host)) return 'exists'
  if (state.publications.length >= LIMITS.publications) return 'full'
  state.publications.push(valid)
  return 'added'
}

export function removePublication(state: AppState, host: string): boolean {
  const index = state.publications.findIndex(item => item.host === host)
  if (index < 0) return false
  state.publications.splice(index, 1)
  return true
}

/**
 * A publication moved (e.g. to its custom domain). Keeps its slot; if the
 * new host is already followed, the old entry is dropped instead.
 */
export function rehostPublication(state: AppState, from: string, to: string): boolean {
  const target = hostFrom(to)
  const index = state.publications.findIndex(item => item.host === from)
  if (!target || index < 0 || target === from) return false
  if (state.publications.some(item => item.host === target)) state.publications.splice(index, 1)
  else state.publications[index] = { ...state.publications[index]!, host: target }
  return true
}

/** A post resolved on another host: update every stored pointer to it. */
export function rehostPost(state: AppState, postId: number, host: string): boolean {
  const target = hostFrom(host)
  if (!target || postId <= 0) return false
  let changed = false
  const fix = (ref: PostRef): PostRef => {
    if (ref.postId !== postId || ref.host === target) return ref
    changed = true
    return { ...ref, host: target }
  }
  state.saved = state.saved.map(fix)
  state.history = state.history.map(fix)
  if (state.lastOpen) state.lastOpen = fix(state.lastOpen)
  return changed
}

/** Settings "Clear reading history and positions". */
export function clearReading(state: AppState): void {
  state.positions = []
  state.history = []
  state.read = []
  state.lastOpen = null
}

/** Move to a final array index. Never clamp, wrap, drop items, or reorder other peers. */
export function reorderItem<T>(items: T[], from: number, to: number): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false
  const [item] = items.splice(from, 1)
  items.splice(to, 0, item as T)
  return true
}
