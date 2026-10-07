/**
 * Persistence: two JSON documents (prefs, progress), each kept under
 * MAX_KEY_CHARS. Bridge storage is the source of truth once the Even app
 * bridge exists; window.localStorage is a mirror (and the only backend in a
 * plain browser). When the bridge attaches, its documents are merged with
 * memory item by item (never replaced wholesale), and a bridge key that could
 * not be read is never written. Every value read back is normalized
 * defensively; article text or HTML is never persisted (the normalizers
 * whitelist PostRef metadata fields only).
 */
import type { AppState, HomeItemId, Position, PostRef, PrefsDoc, ProgressDoc, Publication, Settings } from './app/types'
import { HOME_ITEM_IDS, LATEST_MAX_PUBLICATIONS_RANGE, LIMITS, defaultSettings, emptyState } from './app/types'
import { PUBLIC_HOST_RE } from './substack/types'

export interface KV {
  /**
   * '' when the key is absent. A backend that can fail (bridge storage)
   * rejects instead, so a failed read is never mistaken for an absent key.
   */
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

/** The prefs document as stored; null when it does not fit MAX_KEY_CHARS (it is never truncated). */
export function serializePrefs(state: AppState, savedAt: number): string | null {
  const doc = normalizePrefs({ ...state, savedAt })
  const raw = JSON.stringify(doc)
  return raw.length <= MAX_KEY_CHARS ? raw : null
}

/** True when the prefs document still fits with the largest possible savedAt. */
export function prefsFit(state: AppState): boolean {
  return serializePrefs(state, Number.MAX_SAFE_INTEGER) !== null
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

/** null/undefined/'' mean absent (''); any other non-string is a failed read. */
function checkedValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') throw new Error('Storage returned an unreadable value.')
  return value
}

/** A read that must not be mistaken for an absent key: rejects on failure or a non-string value. */
async function strictGet(kv: KV, key: string): Promise<string> {
  return checkedValue(await kv.get(key))
}

/**
 * Bridge storage via the glasses queue. '' means absent; a failed, timed-out
 * or garbled read rejects (never ''). Values are kept below MAX_KEY_CHARS.
 */
export function bridgeKV(bridge: StorageBridge): KV {
  return {
    name: 'bridge',
    async get(key) {
      return checkedValue(await bridge.storageGet(key))
    },
    async set(key, value) {
      if (value.length > MAX_KEY_CHARS) return false
      try { return (await bridge.storageSet(key, value)) === true } catch { return false }
    },
  }
}

/**
 * Read both backends and return the copy with the newest savedAt (primary on
 * ties); write both. A primary read failure rejects (the mirror's never
 * does). The result of a write is the primary's (the source of truth), or the
 * mirror's when there is no primary.
 */
export function mirroredKV(primary: KV | null, mirror: KV): KV {
  return {
    name: primary ? `${primary.name ?? 'primary'}+${mirror.name ?? 'mirror'}` : mirror.name ?? 'mirror',
    async get(key) {
      const [first, second] = await Promise.all([primary ? strictGet(primary, key) : Promise.resolve(''), safeGet(mirror, key)])
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
// Merging two copies of a document (bridge attach)

/** `newer` in its own order, then the items only `older` has; an item sharing any key with a kept one is skipped. */
function unionBy<T>(newer: readonly T[], older: readonly T[], keys: (item: T) => readonly string[], limit: number): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of [...newer, ...older]) {
    if (result.length >= limit) break
    const ids = keys(item)
    if (ids.some(id => seen.has(id))) continue
    for (const id of ids) seen.add(id)
    result.push(item)
  }
  return result
}

function publicationKeys(item: Publication): string[] {
  return item.id === null ? [`host:${item.host}`] : [`host:${item.host}`, `id:${item.id}`]
}

function isDefaultSettings(settings: Settings): boolean {
  return JSON.stringify(normalizeSettings(settings)) === JSON.stringify(normalizeSettings(defaultSettings()))
}

/**
 * Merge two prefs copies. Publications and saved posts are united (the newer
 * copy's order, then what only the older copy has), so a near-empty copy can
 * never wipe a library. Settings come from the newer copy unless it still has
 * the defaults. The cost: an item removed in only one copy can come back.
 */
export function mergePrefs(newer: PrefsDoc, older: PrefsDoc): PrefsDoc {
  return normalizePrefs({
    savedAt: Math.max(newer.savedAt, older.savedAt),
    publications: unionBy(newer.publications, older.publications, publicationKeys, LIMITS.publications),
    saved: unionBy(newer.saved, older.saved, item => [refKey(item)], LIMITS.saved),
    settings: isDefaultSettings(newer.settings) ? older.settings : newer.settings,
  })
}

/**
 * Merge two progress copies: each post keeps the position with the larger
 * updatedAt; history and read ids are united (newer order first); lastOpen
 * comes from the newer copy when it has one.
 */
export function mergeProgress(newer: ProgressDoc, older: ProgressDoc): ProgressDoc {
  const positions = new Map<number, Position>()
  for (const item of [...newer.positions, ...older.positions]) {
    const known = positions.get(item.postId)
    if (!known || item.updatedAt > known.updatedAt) positions.set(item.postId, item)
  }
  return normalizeProgress({
    savedAt: Math.max(newer.savedAt, older.savedAt),
    positions: [...positions.values()], // normalizeProgress sorts by updatedAt and caps.
    history: unionBy(newer.history, older.history, item => [refKey(item)], LIMITS.history),
    read: unionBy(newer.read, older.read, id => [String(id)], LIMITS.read),
    lastOpen: newer.lastOpen ?? older.lastOpen,
  })
}

/** Same stored content, ignoring savedAt. Both sides must be normalized documents. */
function sameContent(a: PrefsDoc | ProgressDoc, b: PrefsDoc | ProgressDoc): boolean {
  return JSON.stringify({ ...a, savedAt: 0 }) === JSON.stringify({ ...b, savedAt: 0 })
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
   * The Even app bridge exists: read both documents from `bridge` (the source
   * of truth) and merge them into memory item by item (mergePrefs,
   * mergeProgress; memory still holding the pristine defaults simply adopts
   * the bridge copy). Then bridge + the loaded backend (as a mirror) become
   * the backend, and only documents the bridge lacks are written to it.
   * `onApplied(changed)` runs right after the merge, before any write.
   * Rejects when a bridge read failed or timed out, changing nothing (no
   * write, backend unchanged): try again later. Resolves true when memory
   * changed. Once attached, further calls resolve false.
   */
  attachBridge(bridge: KV, onApplied?: (changed: boolean) => void): Promise<boolean>
  /** True once attachBridge succeeded. */
  attached(): boolean
  /** True when load() found neither document (first run, or the browser copy was lost). */
  loadedEmpty(): boolean
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
  let found = false
  let bridged = false
  let attaching: Promise<boolean> | null = null

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

  /** Memory as a normalized document. */
  function docOf(name: DocName): PrefsDoc | ProgressDoc {
    return name === 'prefs' ? normalizePrefs({ ...state, savedAt: savedAt.prefs }) : normalizeProgress({ ...state, savedAt: savedAt.progress })
  }

  function apply(name: DocName, doc: PrefsDoc | ProgressDoc) {
    if (name === 'prefs') applyPrefs(doc as PrefsDoc)
    else applyProgress(doc as ProgressDoc)
  }

  /** Wait until no write is in flight (writes queued meanwhile are waited for too). */
  async function idle(): Promise<void> {
    let current: Promise<unknown>
    do {
      current = chain
      await current
    } while (current !== chain)
  }

  async function attach(bridge: KV, onApplied?: (changed: boolean) => void): Promise<boolean> {
    await idle()
    // A failed read must never look like an absent key: strictGet rejects, and
    // then nothing below runs (no write, the backend stays as it was).
    const raws: Record<DocName, string> = { prefs: await strictGet(bridge, KEYS.prefs), progress: await strictGet(bridge, KEYS.progress) }
    await idle() // A debounced write may have started while the bridge answered.
    let changed = false
    const mirrorOnly: Array<[DocName, string]> = []
    for (const name of DOCS) {
      const parsed = parseStored(raws[name])
      const pristine = savedAt[name] === 0 && !dirty[name]
      if (parsed === null) {
        // Absent (or corrupt) on the bridge: give it memory, never the pristine defaults.
        if (!pristine) dirty[name] = true
        continue
      }
      const remote = name === 'prefs' ? normalizePrefs(parsed) : normalizeProgress(parsed)
      if (pristine) {
        apply(name, remote)
        changed = true
        size[name] = raws[name].length
        mirrorOnly.push([name, raws[name]])
        continue
      }
      const local = docOf(name)
      const localNewer = localStamp(name) >= remote.savedAt
      const [newer, older] = localNewer ? [local, remote] : [remote, local]
      const merged = name === 'prefs'
        ? mergePrefs(newer as PrefsDoc, older as PrefsDoc)
        : mergeProgress(newer as ProgressDoc, older as ProgressDoc)
      const memoryChanged = !sameContent(merged, local)
      if (memoryChanged) {
        apply(name, merged)
        changed = true
      }
      savedAt[name] = Math.max(savedAt[name], remote.savedAt)
      if (!sameContent(merged, remote)) {
        dirty[name] = true // The bridge lacks something: write the merged document to both.
      } else if (memoryChanged || dirty[name]) {
        dirty[name] = false // The bridge already has it all: refresh only the mirror.
        size[name] = raws[name].length
        mirrorOnly.push([name, raws[name]])
      }
    }
    const mirror = kv
    kv = mirror ? mirroredKV(bridge, mirror) : bridge
    bridged = true
    try { onApplied?.(changed) } catch { /* Observer errors are isolated. */ }
    if (mirror && mirrorOnly.length) {
      const refresh = chain.then(async () => {
        for (const [name, raw] of mirrorOnly) await safeSet(mirror, KEYS[name], raw)
      })
      chain = refresh.catch(() => undefined)
      await chain
    }
    if (dirty.prefs || dirty.progress) await flush()
    return changed
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
      found = docs.prefs.value !== null || docs.progress.value !== null
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
    attachBridge(bridge, onApplied) {
      if (bridged) return Promise.resolve(false)
      if (!attaching) {
        const run = attach(bridge, onApplied)
        attaching = run
        const done = () => { if (attaching === run) attaching = null }
        run.then(done, done)
      }
      return attaching
    },
    attached: () => bridged,
    loadedEmpty: () => !found,
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

/** 'full': the list is at its limit, or the prefs document would no longer fit MAX_KEY_CHARS. */
export type AddResult = 'added' | 'exists' | 'full' | 'invalid'

/** Append to Saved (ordered list; new items go last). Refused when the prefs document would not fit. */
export function addSaved(state: AppState, ref: PostRef): AddResult {
  const valid = normalizePostRef(ref)
  if (!valid) return 'invalid'
  if (isSaved(state, valid)) return 'exists'
  if (state.saved.length >= LIMITS.saved) return 'full'
  state.saved.push(valid)
  if (!prefsFit(state)) {
    state.saved.pop()
    return 'full'
  }
  return 'added'
}

export function removeSaved(state: AppState, ref: Pick<PostRef, 'postId' | 'host' | 'slug'>): boolean {
  const key = refKey(ref)
  const index = state.saved.findIndex(item => refKey(item) === key)
  if (index < 0) return false
  state.saved.splice(index, 1)
  return true
}

/**
 * Append to the ordered publication list, deduped by host and by Substack id
 * (one publication can answer on its subdomain and its custom domain).
 * Refused when the prefs document would not fit.
 */
export function addPublication(state: AppState, publication: Publication): AddResult {
  const valid = normalizePublication(publication)
  if (!valid) return 'invalid'
  if (state.publications.some(item => item.host === valid.host || (valid.id !== null && item.id === valid.id))) return 'exists'
  if (state.publications.length >= LIMITS.publications) return 'full'
  state.publications.push(valid)
  if (!prefsFit(state)) {
    state.publications.pop()
    return 'full'
  }
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
