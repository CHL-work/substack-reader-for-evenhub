/**
 * Glasses navigation state machine (SPEC sections 3.11 and 4). Everything
 * external is injected, so Node tests drive it with a fake renderer, a fake
 * relay client and a stub converter; no timers are used here (the store owns
 * the only debounce, through its injected scheduler).
 *
 * Rules kept from LIHKG main.ts:
 * - A generation counter: every async step captures it and drops its result
 *   when it changed (back, cancel, another open). In-flight fetches are aborted.
 * - The Loading frame is rendered before any await.
 * - Frames are pure functions of state (frames.ts); phone edits never replace
 *   what the glasses are reading.
 */
import type { GlassesAction, GlassesPage, LaunchSource, LifecycleSignal } from '../events'
import { PAGINATION_VERSION, bodyBox, pageIndexForOffset, paginate, type TextPage } from '../pagination'
import {
  addSaved, markRead, normalizePostRef, normalizePublication, positionOf, recordHistory, recordPosition, refKey,
  rehostPost, rehostPublication, setLastOpen, type Store,
} from '../storage'
import { ARCHIVE_PAGE_SIZE, type ArchivePage, type PostDetail, type PostSummary, type PubMeta } from '../substack/types'
import {
  EMPTY_TEXT, TEXT, canContinue, clampIndex, errorBody, fitBody, frameFor, homeEntries, isFirstRun, isRetryable,
  latestPublications, postsRowCount, type HomeEntry, type PostsView, type ReaderView,
} from './frames'
import { LIMITS, type Article, type GlassesView, type LinesPerPage, type Position, type PostRef, type PostSource, type Publication, type Settings, type ViewError } from './types'

/** The relay-client subset the glasses need (src/substack/api.ts satisfies it). */
export interface ReaderApi {
  getArchive(host: string, options: { offset?: number; limit?: number }, signal?: AbortSignal): Promise<{ page: ArchivePage; host: string }>
  getPost(ref: { host: string; slug: string } | { id: number }, signal?: AbortSignal): Promise<{ post: PostDetail; publication: PubMeta | null; host: string }>
}

/** RSS fallback result: posts plus their HTML bodies keyed by slug (src/substack/feed.ts parseFeed). */
export interface FeedResult {
  posts: PostSummary[]
  bodies: Map<string, string>
}

export interface ControllerDeps {
  /**
   * Resolves after the glasses accepted the frame. Rejects with an Error named
   * 'SupersededRenderError' when a newer frame replaced it before it was written
   * (not shown, nothing to retry), and with any other Error when the write failed.
   */
  render(page: GlassesPage): Promise<void>
  /** shutDownPageContainer(1) (root double-tap). */
  exit(): Promise<void>
  api: ReaderApi
  /** Optional fallback when the archive is blocked: e.g. host => api.getFeedXml then parseFeed. */
  getFeed?(host: string, signal?: AbortSignal): Promise<FeedResult>
  store: Store
  /** src/substack/article.ts buildArticle (with the production converter options). */
  buildArticle(post: PostDetail, publication: PubMeta | null, settings: Settings): Article
  now(): number
  /** Default true. When false the root shows the "no reader service" frame. */
  relayConfigured?(): boolean
  /** Redraw the phone (mirror, now reading, alerts). */
  onPhoneUpdate?(): void
  /** GlassesController.resetGestures: called on every glasses view change. */
  resetGestures?(): void
  /** GlassesController.invalidate: called before a forced full redraw. */
  invalidate?(): void
}

export interface Controller {
  /** Draw the first frame, or resume lastOpen when launched from the glasses menu. */
  start(launch?: LaunchSource): Promise<void>
  /** bridge.onLaunchSource; may arrive before or after start(). */
  onLaunchSource(source: LaunchSource): void
  onAction(action: GlassesAction): Promise<void>
  onLifecycle(signal: LifecycleSignal): void
  /** The phone edited publications, saved posts or settings. Never interrupts the reader. */
  configurationChanged(): void
  /** The frame last sent (or about to be sent) to the glasses, for the phone mirror. */
  current(): GlassesPage
  view(): GlassesView
  depth(): number
  /** A glasses load is in flight. */
  isBusy(): boolean
  /** The error currently shown on the glasses (details for the phone alert), or null. */
  lastError(): ViewError | null
  /** Phone "Retry": re-run the failed glasses step. */
  retry(): Promise<void>
  /**
   * Resend the whole current frame (glasses reconnected, or the phone asks). A no-op before
   * start(): the glasses keep the startup frame (for example "Loading your library"), which the
   * app re-sends itself.
   */
  redraw(): Promise<void>
  /**
   * The glasses now show the newest frame rendered, although its render rejected (a timed-out
   * write that landed late, or the glasses' own recovery write): ends the redraw state and
   * records the reader page. Optional for the glasses wrapper; a no-op unless a draw failed.
   */
  frameShown(): void
}

type HomeView = Extract<GlassesView, { kind: 'home' }>
type PublicationsView = Extract<GlassesView, { kind: 'publications' }>
interface PublicationsState extends PublicationsView {
  /** Host of the selected publication: phone edits move the cursor with it, not with its index. */
  selHost: string | null
}
type LoadMode = 'initial' | 'older' | 'refresh'
interface PostsState extends PostsView {
  /**
   * The pending or failed load; cleared on success. 'older' and 'refresh' run on a list that
   * was already loaded, so cancel or back after an error returns to it, and retry keeps the mode.
   */
  pendingMode?: LoadMode
}
interface ReaderState extends ReaderView {
  /** Lines per page the pages were computed for. */
  lines: LinesPerPage
}
type View = HomeView | PublicationsState | PostsState | ReaderState
type ArchiveSource = Extract<PostSource, { host: string }>
/** One draw: the reader position it shows, `done` once the glasses showed it. */
interface Drawn {
  seq: number
  shown: Omit<Position, 'updatedAt'> | null
  done: boolean
}

interface PostEntry {
  post: PostDetail
  publication: PubMeta | null
  host: string
  article?: Article
  articleKey?: string
}

export const LATEST_TTL_MS = 5 * 60_000
export const LATEST_MAX_POSTS = 50
export const LATEST_CONCURRENCY = 2
export const POST_CACHE_SIZE = 10
export const FOREGROUND_REDRAW_MS = 30_000
const FEED_CACHE_SIZE = 60
const FEED_FALLBACK_CODES = new Set(['UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE'])

/** Duck-typed ApiError (code, message, retryAfterSeconds) -> ViewError. */
export function toViewError(error: unknown): ViewError {
  const value = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
  const code = typeof value.code === 'string' && value.code ? value.code : 'UNKNOWN'
  const message = typeof value.message === 'string' && value.message ? value.message : 'Something went wrong.'
  const retry = value.retryAfterSeconds
  return typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? { code, message, retryAfterSeconds: retry } : { code, message }
}

/** A render the glasses wrapper dropped because a newer frame replaced it (matched by name, not class). */
export function isSupersededRender(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'SupersededRenderError'
}

/** `${articleVersion}.${PAGINATION_VERSION}.${lines}` (Position.version). */
export function positionVersion(articleVersion: string, lines: number): string {
  return `${articleVersion}.${PAGINATION_VERSION}.${lines}`
}

/** Offsets stay valid when only the lines-per-page segment differs. */
export function sameText(stored: string, current: string): boolean {
  const a = stored.lastIndexOf('.')
  const b = current.lastIndexOf('.')
  return a > 0 && b > 0 && stored.slice(0, a) === current.slice(0, b)
}

/**
 * Page to open: by character offset when the text is unchanged, else by
 * fraction. A finished post (end card) starts again from the first page.
 */
export function resumePage(position: Position | null, pages: readonly TextPage[], version: string): number {
  if (!position || !pages.length || position.page >= position.pages) return 0
  const index = sameText(position.version, version)
    ? pageIndexForOffset(pages, position.offset)
    : Math.round(position.fraction * pages.length)
  return clampIndex(index, pages.length)
}

function settingsKey(settings: Settings): string {
  return `${settings.bareImages}|${settings.footnotes}|${settings.uppercaseHeadings}|${settings.stripEmoji}`
}

function dateValue(ref: PostRef): number {
  const time = Date.parse(ref.postDate)
  return Number.isFinite(time) ? time : 0
}

function isLocal(source: PostSource): source is 'saved' | 'history' {
  return source === 'saved' || source === 'history'
}

type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown }

/** Run `task` over `items` with at most `limit` in flight; never rejects. */
async function settleAll<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = { ok: true, value: await task(items[index]!) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export function createController(deps: ControllerDeps): Controller {
  const store = deps.store
  const state = store.state
  let stack: View[] = [{ kind: 'home', sel: 0 }]
  let generation = 0
  let abort: AbortController | null = null
  let frame: GlassesPage | null = null
  let transient: { body?: string; footer?: string } | null = null
  let started = false
  let interacted = false
  let launchSource: LaunchSource | null = null
  let hiddenAt: number | null = null
  let latestCache: { key: string; at: number; items: PostRef[]; failed: number } | null = null
  const postCache = new Map<string, PostEntry>()
  const feedCache = new Map<string, { summary: PostSummary; html: string; pubName: string }>()

  const top = (): View => stack[stack.length - 1]!

  function relayConfigured(): boolean {
    try { return deps.relayConfigured ? deps.relayConfigured() !== false : true } catch { return false }
  }

  function notifyPhone() {
    try { deps.onPhoneUpdate?.() } catch { /* Observer errors are isolated. */ }
  }

  function viewChanged() {
    try { deps.resetGestures?.() } catch { /* Optional dependency. */ }
  }

  function push(view: View) {
    stack.push(view)
    viewChanged()
  }

  function pop() {
    if (stack.length > 1) {
      stack.pop()
      viewChanged()
    }
  }

  function replaceTop(view: View) {
    stack[stack.length - 1] = view
    viewChanged()
  }

  /** Start a glasses load: abort the previous one and invalidate its results. */
  function begin(): { gen: number; signal: AbortSignal } {
    abort?.abort()
    abort = new AbortController()
    generation += 1
    return { gen: generation, signal: abort.signal }
  }

  function cancel() {
    abort?.abort()
    abort = null
    generation += 1
  }

  /**
   * Home's entries change while the cursor is elsewhere (Continue appears after a post is opened,
   * settings reorder items), so the cursor follows the selected entry's id, not its index.
   */
  let homeSelId: string | null = null
  function syncHome(view: HomeView): HomeEntry[] {
    const entries = homeEntries(state)
    const index = homeSelId === null ? -1 : entries.findIndex(entry => entry.id === homeSelId)
    view.sel = clampIndex(index >= 0 ? index : view.sel, entries.length)
    homeSelId = entries[view.sel]?.id ?? null
    return entries
  }

  /** Publications are edited on the phone while the cursor is on one: follow its host (like Home). */
  function syncPublications(view: PublicationsState): Publication[] {
    const publications = state.publications
    const index = view.selHost === null ? -1 : publications.findIndex(item => item.host === view.selHost)
    view.sel = clampIndex(index >= 0 ? index : view.sel, publications.length)
    view.selHost = publications[view.sel]?.host ?? null
    return publications
  }

  function computeFrame(): GlassesPage {
    const view = top()
    if (view.kind === 'home') syncHome(view)
    else if (view.kind === 'publications') syncPublications(view)
    let page = frameFor(view, state, { now: deps.now(), relayConfigured: relayConfigured() })
    if (transient) {
      page = {
        title: page.title,
        body: transient.body === undefined ? page.body : fitBody(transient.body),
        footer: transient.footer ?? page.footer,
      }
      transient = null
    }
    return page
  }

  /**
   * The latest frame failed to reach the glasses, so they show an older state than the model.
   * The next gesture that acts on the page or row shown then redraws the model instead of moving
   * past a page or row never shown (once per failed frame: see onAction).
   */
  let displayStale = false
  let drawSeq = 0
  /** drawSeq of the forced redraw a gesture on the stale display was turned into (0: none). */
  let offeredSeq = 0
  /** The latest draw. */
  let latest: Drawn | null = null

  /** The glasses showed `drawn` (its render resolved, or frameShown confirmed it). */
  function accepted(drawn: Drawn) {
    if (drawn.done) return
    drawn.done = true
    if (drawn.seq === drawSeq) displayStale = false
    if (drawn.shown) afterReaderRender(drawn.shown)
  }

  /** Render the top of the stack; a shown reader page records the position afterwards. */
  function draw(): Promise<void> {
    const page = computeFrame()
    frame = page
    notifyPhone()
    const view = top()
    drawSeq += 1
    const drawn: Drawn = { seq: drawSeq, shown: view.kind === 'reader' && view.state === 'ready' ? positionShown(view) : null, done: false }
    latest = drawn
    let rendered: Promise<void>
    try {
      rendered = Promise.resolve(deps.render(page))
    } catch (error) {
      rendered = Promise.reject(error)
    }
    return rendered.then(() => accepted(drawn), error => {
      // The glasses wrapper reports write failures; a superseded frame was replaced by a newer one.
      if (drawn.seq === drawSeq && !drawn.done && !isSupersededRender(error)) displayStale = true
    })
  }

  /** Gestures whose effect depends on the page or row on the display (Save for later on a list row). */
  function actsOnShown(action: GlassesAction): boolean {
    return action === 'next' || action === 'previous' || action === 'select' || (action === 'menu:2' && top().kind === 'posts')
  }

  /** Resend the whole current frame. */
  function forceRedraw(): Promise<void> {
    try { deps.invalidate?.() } catch { /* Optional dependency. */ }
    return draw()
  }

  function hint(footer: string): Promise<void> {
    transient = { footer }
    return draw()
  }

  /** The position of the page being drawn (captured now; pages may be recomputed before the write lands). */
  function positionShown(view: ReaderState): Omit<Position, 'updatedAt'> | null {
    const article = view.article
    const total = view.pages.length
    if (!article || !total) return null
    const page = Math.min(Math.max(0, view.page), total)
    const atEnd = page >= total
    return {
      postId: view.ref.postId,
      offset: atEnd ? view.pages[total - 1]!.end : view.pages[page]!.start,
      fraction: atEnd ? 1 : page / total,
      page,
      pages: total,
      version: positionVersion(article.version, view.lines),
    }
  }

  /** Saved after each successful render of a reader page (store debounces the write). */
  function afterReaderRender(shown: Omit<Position, 'updatedAt'>) {
    recordPosition(state, { ...shown, updatedAt: deps.now() })
    if (shown.page >= shown.pages) markRead(state, shown.postId)
    store.save('progress')
  }

  function move(selection: number, action: 'next' | 'previous', count: number): number {
    return clampIndex(selection + (action === 'next' ? 1 : -1), count)
  }

  function localItems(source: 'saved' | 'history'): PostRef[] {
    return source === 'saved' ? [...state.saved] : [...state.history]
  }

  function selectKey(view: PostsState, key: string | null) {
    const index = key === null ? -1 : view.items.findIndex(item => refKey(item) === key)
    view.sel = index >= 0 ? index : clampIndex(view.sel, postsRowCount(view))
  }

  function selectedKey(view: PostsState): string | null {
    const item = view.items[view.sel]
    return item ? refKey(item) : null
  }

  function rehost(from: string, to: string) {
    if (from === to) return
    if (rehostPublication(state, from, to)) {
      store.save('prefs')
      notifyPhone()
    }
    for (const view of stack) if (view.kind === 'publications' && view.selHost === from) view.selHost = to
    latestCache = null
  }

  /**
   * A publication added while the relay could not name it stores its host as the name;
   * adopt the name a later archive page reports (a real name is never replaced).
   */
  function backfillName(host: string, resolved: string, name: string) {
    const index = state.publications.findIndex(item => item.host === host || item.host === resolved)
    const current = state.publications[index]
    if (!current || (current.name !== current.host && current.name !== host && current.name !== resolved)) return
    const updated = normalizePublication({ ...current, name })
    if (!updated || updated.name === current.name) return
    state.publications[index] = updated
    store.save('prefs')
    notifyPhone()
  }

  /** The archive answered for another host (e.g. the custom domain): follow it in the list and in storage. */
  function adoptHost(view: PostsState, source: ArchiveSource, host: string) {
    if (host === source.host) return
    rehost(source.host, host)
    view.source = { ...source, host }
  }

  /** Append an older archive page, skipping posts already listed; returns the new posts. */
  function appendPage(view: PostsState, page: { items: PostRef[]; nextOffset: number | null }): PostRef[] {
    const known = new Set(view.items.map(refKey))
    const fresh = page.items.filter(item => !known.has(refKey(item)))
    view.items = [...view.items, ...fresh]
    view.nextOffset = page.nextOffset
    return fresh
  }

  // -------------------------------------------------------------------------
  // Lists

  async function fetchArchive(host: string, offset: number, name: string, signal: AbortSignal): Promise<{ items: PostRef[]; nextOffset: number | null; host: string }> {
    try {
      const result = await deps.api.getArchive(host, { offset, limit: ARCHIVE_PAGE_SIZE }, signal)
      const resolved = result.host || host
      const archiveName = result.page.publication?.name
      if (archiveName) backfillName(host, resolved, archiveName)
      const pubName = archiveName || name || resolved
      const addedAt = deps.now()
      const items: PostRef[] = []
      for (const post of result.page.posts) {
        const ref = normalizePostRef({ ...summaryRef(post), host: resolved, pubName, addedAt })
        if (ref) items.push(ref)
      }
      // Only an empty page ends the archive (Substack may return fewer than `limit`).
      return { items, nextOffset: result.page.posts.length ? result.page.nextOffset : null, host: resolved }
    } catch (error) {
      if (offset !== 0 || !deps.getFeed || !FEED_FALLBACK_CODES.has(toViewError(error).code)) throw error
      let feed: FeedResult
      try {
        feed = await deps.getFeed(host, signal)
      } catch {
        throw error // The archive error explains more than the fallback's.
      }
      const pubName = name || host
      const addedAt = deps.now()
      const items: PostRef[] = []
      for (const post of feed.posts) {
        const ref = normalizePostRef({ ...summaryRef(post), host, pubName, addedAt })
        if (!ref) continue
        const html = feed.bodies.get(post.slug)
        if (html !== undefined) {
          feedCache.delete(`${host}/${post.slug}`)
          feedCache.set(`${host}/${post.slug}`, { summary: post, html, pubName })
          while (feedCache.size > FEED_CACHE_SIZE) feedCache.delete(feedCache.keys().next().value!)
        }
        items.push(ref)
      }
      return { items, nextOffset: null, host }
    }
  }

  function summaryRef(post: PostSummary) {
    return {
      postId: post.id,
      slug: post.slug,
      title: post.title,
      postDate: post.postDate,
      isPaywalled: post.isPaywalled,
      wordcount: post.wordcount,
    }
  }

  /** Followed publications in Latest, 2 at a time, merged newest first; partial failures allowed. */
  async function loadLatest(force: boolean, signal: AbortSignal): Promise<{ items: PostRef[]; failed: number }> {
    const publications = latestPublications(state)
    if (!publications.length) return { items: [], failed: 0 }
    const key = publications.map(item => item.host).join(' ')
    if (!force && latestCache && latestCache.key === key && deps.now() - latestCache.at < LATEST_TTL_MS) {
      return { items: [...latestCache.items], failed: latestCache.failed }
    }
    const results = await settleAll(publications, LATEST_CONCURRENCY, publication => {
      if (signal.aborted) return Promise.reject(new Error('Cancelled.'))
      return fetchArchive(publication.host, 0, publication.name, signal)
    })
    // Back or another open aborted the load: its fetches "failed" by cancellation, so cache nothing.
    if (signal.aborted) throw Object.assign(new Error('The request was cancelled.'), { code: 'ABORTED' })
    const merged: PostRef[] = []
    let failed = 0
    let firstError: unknown = null
    results.forEach((result, index) => {
      if (result.ok) {
        merged.push(...result.value.items)
        rehost(publications[index]!.host, result.value.host)
      } else {
        failed += 1
        if (firstError === null) firstError = result.error
      }
    })
    if (failed === publications.length) throw firstError
    merged.sort((a, b) => dateValue(b) - dateValue(a))
    const seen = new Set<string>()
    const items = merged.filter(item => {
      const id = refKey(item)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    }).slice(0, LATEST_MAX_POSTS)
    latestCache = { key, at: deps.now(), items, failed }
    return { items: [...items], failed }
  }

  async function loadPosts(view: PostsState, mode: LoadMode): Promise<void> {
    const { gen, signal } = begin()
    const keep = mode === 'refresh' ? selectedKey(view) : null
    view.pendingMode = mode
    view.state = 'loading'
    view.error = null
    void draw()
    try {
      const source = view.source
      if (source === 'latest') {
        const result = await loadLatest(mode === 'refresh', signal)
        if (gen !== generation) return
        view.items = result.items
        view.failed = result.failed
        view.nextOffset = null
        selectKey(view, keep)
      } else if (typeof source === 'object') {
        const offset = mode === 'older' ? view.nextOffset ?? view.items.length : 0
        const result = await fetchArchive(source.host, offset, source.name ?? '', signal)
        if (gen !== generation) return
        adoptHost(view, source, result.host)
        if (mode === 'older') {
          const first = view.items.length
          const fresh = appendPage(view, result)
          view.sel = fresh.length ? first : clampIndex(view.sel, postsRowCount(view))
        } else {
          view.items = result.items
          view.nextOffset = result.nextOffset
          selectKey(view, keep)
        }
      } else {
        view.items = localItems(source)
        view.nextOffset = null
        selectKey(view, keep)
      }
      view.state = 'ready'
      view.pendingMode = undefined
    } catch (error) {
      if (gen !== generation) return
      view.state = 'error'
      view.error = toViewError(error)
    }
    return draw()
  }

  function openPosts(source: PostSource): Promise<void> {
    const view: PostsState = { kind: 'posts', source, sel: 0, items: [], nextOffset: null, state: 'loading', error: null }
    push(view)
    if (isLocal(source)) {
      view.items = localItems(source)
      view.state = 'ready'
      return draw()
    }
    return loadPosts(view, 'initial')
  }

  // -------------------------------------------------------------------------
  // Reader

  async function fetchPost(ref: PostRef, signal: AbortSignal): Promise<PostEntry> {
    const key = refKey(ref)
    const cached = postCache.get(key)
    if (cached) {
      postCache.delete(key)
      postCache.set(key, cached)
      return cached
    }
    let entry: PostEntry
    const feed = ref.slug ? feedCache.get(`${ref.host}/${ref.slug}`) : undefined
    if (feed) {
      entry = {
        post: { ...feed.summary, bodyHtml: feed.html, truncated: feed.summary.isPaywalled },
        publication: { id: null, name: feed.pubName, subdomain: null, customDomain: null, host: ref.host },
        host: ref.host,
      }
    } else {
      const result = await deps.api.getPost(ref.slug ? { host: ref.host, slug: ref.slug } : { id: ref.postId }, signal)
      entry = { post: result.post, publication: result.publication, host: result.host || ref.host }
    }
    postCache.set(key, entry)
    while (postCache.size > POST_CACHE_SIZE) postCache.delete(postCache.keys().next().value!)
    return entry
  }

  /** Converted text is cached per entry while the text-affecting settings are unchanged. */
  function articleFor(entry: PostEntry): Article {
    const key = settingsKey(state.settings)
    if (entry.article && entry.articleKey === key) return entry.article
    const article = deps.buildArticle(entry.post, entry.publication, state.settings)
    entry.article = article
    entry.articleKey = key
    return article
  }

  function refreshedRef(ref: PostRef, entry: PostEntry): PostRef {
    const post = entry.post
    return normalizePostRef({
      ...ref,
      host: entry.host || ref.host,
      slug: ref.slug || post.slug,
      title: post.title || ref.title,
      pubName: entry.publication?.name || ref.pubName,
      postDate: post.postDate || ref.postDate,
      isPaywalled: post.isPaywalled,
      wordcount: post.wordcount ?? ref.wordcount,
    }) ?? ref
  }

  async function loadReader(view: ReaderState, restart: boolean): Promise<void> {
    const { gen, signal } = begin()
    view.state = 'loading'
    view.error = null
    void draw()
    try {
      const entry = await fetchPost(view.ref, signal)
      if (gen !== generation) return
      const article = articleFor(entry)
      const ref = refreshedRef(view.ref, entry)
      if (ref.host !== view.ref.host) {
        rehost(view.ref.host, ref.host)
        if (rehostPost(state, ref.postId, ref.host)) store.save('prefs')
      }
      view.ref = ref
      view.article = article
      if (!article.text.trim()) {
        view.state = 'error'
        view.error = { code: EMPTY_TEXT, message: 'No readable text in this post.' }
        return draw()
      }
      view.lines = state.settings.linesPerPage
      view.pages = paginate(article.text, bodyBox(view.lines))
      view.page = restart ? 0 : resumePage(positionOf(state, ref.postId), view.pages, positionVersion(article.version, view.lines))
      view.state = 'ready'
      // Once per article open (page turns only touch positions).
      setLastOpen(state, ref)
      recordHistory(state, ref)
      store.save('progress')
      const below = stack[stack.length - 2]
      if (below?.kind === 'posts') {
        const key = refKey(ref)
        below.items = below.items.map(item => refKey(item) === key ? ref : item)
      }
    } catch (error) {
      if (gen !== generation) return
      view.state = 'error'
      view.error = toViewError(error)
    }
    return draw()
  }

  function openReader(ref: PostRef, options: { replace?: boolean; restart?: boolean } = {}): Promise<void> {
    void store.flush() // Article switch: persist the previous position now.
    const view: ReaderState = { kind: 'reader', ref, pages: [], page: 0, state: 'loading', error: null, lines: state.settings.linesPerPage }
    if (options.replace) replaceTop(view)
    else push(view)
    return loadReader(view, options.restart === true)
  }

  function leaveReader(view: ReaderState): Promise<void> {
    cancel()
    void store.flush()
    pop()
    const below = top()
    if (below.kind === 'posts') {
      if (isLocal(below.source) && below.state === 'ready') below.items = localItems(below.source)
      selectKey(below, refKey(view.ref))
    }
    return draw()
  }

  function nextPost(view: ReaderState): Promise<void> {
    const list = stack[stack.length - 2]
    if (list?.kind === 'posts') {
      const index = list.items.findIndex(item => refKey(item) === refKey(view.ref))
      const next = index >= 0 ? list.items[index + 1] : undefined
      if (next) {
        list.sel = index + 1
        return openReader(next, { replace: true })
      }
      // The last loaded post of a list with a "Load older posts" row: the next post is on the next page.
      const source = list.source
      if (index >= 0 && list.state === 'ready' && list.nextOffset !== null && typeof source === 'object') {
        return nextFromArchive(view, list, source, list.nextOffset)
      }
    }
    transient = { body: TEXT.noMorePosts, footer: TEXT.backFooter }
    return draw()
  }

  /** Load the list's next archive page (like "Load older posts"), then open its first new post. */
  async function nextFromArchive(view: ReaderState, list: PostsState, source: ArchiveSource, offset: number): Promise<void> {
    const { gen, signal } = begin()
    view.state = 'loading' // Loading frame; back cancels and returns to the list (leaveReader).
    view.error = null
    void draw()
    try {
      const result = await fetchArchive(source.host, offset, source.name ?? '', signal)
      if (gen !== generation) return
      adoptHost(list, source, result.host)
      const first = list.items.length
      const next = appendPage(list, result)[0]
      if (next) {
        list.sel = first
        return openReader(next, { replace: true })
      }
      readerReady(view)
      transient = { body: TEXT.noMorePosts, footer: TEXT.backFooter }
    } catch (error) {
      if (gen !== generation) return
      readerReady(view)
      // One frame on the reader; on the end card a tap runs nextPost again.
      const failure = toViewError(error)
      const retry = view.page >= view.pages.length && isRetryable(failure)
      transient = { body: errorBody(failure), footer: retry ? TEXT.retryFooter : TEXT.backFooter }
    }
    return draw()
  }

  /** Back to the page shown before nextFromArchive (a density change while loading applies now). */
  function readerReady(view: ReaderState) {
    view.state = 'ready'
    if (view.lines !== state.settings.linesPerPage) repaginate(view)
  }

  function repaginate(view: ReaderState) {
    const article = view.article
    if (!article) return
    const atEnd = view.page >= view.pages.length
    const offset = atEnd ? 0 : view.pages[view.page]?.start ?? 0
    view.lines = state.settings.linesPerPage
    view.pages = paginate(article.text, bodyBox(view.lines))
    view.page = atEnd ? view.pages.length : pageIndexForOffset(view.pages, offset)
  }

  function canResume(): boolean {
    return relayConfigured() && canContinue(state)
  }

  let resumed = false
  function resume(): Promise<void> {
    resumed = true
    const ref = state.lastOpen
    return ref ? openReader(ref) : draw()
  }

  // -------------------------------------------------------------------------
  // Gestures

  function exitApp(): Promise<void> {
    void store.flush() // The OS dialog may end the WebView.
    return deps.exit().catch(() => undefined /* The glasses status shows the failure; double-tap again. */)
  }

  async function onHome(view: HomeView, action: GlassesAction): Promise<void> {
    if (action === 'back') return exitApp()
    if (!relayConfigured() || isFirstRun(state)) return
    const entries = syncHome(view)
    if (action === 'next' || action === 'previous') {
      const sel = move(view.sel, action, entries.length)
      if (sel === view.sel) return
      view.sel = sel
      homeSelId = entries[sel]?.id ?? null
      return draw()
    }
    if (action !== 'select') return
    const entry = entries[clampIndex(view.sel, entries.length)]
    if (!entry) return
    switch (entry.id) {
      case 'continue':
        return state.lastOpen ? openReader(state.lastOpen) : draw()
      case 'publications':
        push({ kind: 'publications', sel: 0, selHost: null })
        return draw()
      case 'latest':
      case 'saved':
      case 'history':
        return openPosts(entry.id)
    }
  }

  async function onPublications(view: PublicationsState, action: GlassesAction): Promise<void> {
    if (action === 'back' || action === 'hold') {
      pop()
      return draw()
    }
    const publications = syncPublications(view)
    if (action === 'next' || action === 'previous') {
      const sel = move(view.sel, action, publications.length)
      if (sel === view.sel) return
      view.sel = sel
      view.selHost = publications[sel]?.host ?? null
      return draw()
    }
    if (action !== 'select') return
    const publication = publications[view.sel]
    if (publication) return openPosts({ host: publication.host, name: publication.name })
  }

  async function onPosts(view: PostsState, action: GlassesAction): Promise<void> {
    if (action === 'back' || action === 'hold') {
      cancel()
      if (view.state !== 'ready' && (view.pendingMode === 'older' || view.pendingMode === 'refresh')) {
        // A failed or cancelled "Load older" or Refresh returns to the list that was loaded.
        view.state = 'ready'
        view.error = null
        view.pendingMode = undefined
        return draw()
      }
      pop()
      return draw()
    }
    if (view.state === 'loading') return
    if (view.state === 'error') {
      if (action === 'select' && isRetryable(view.error)) return loadPosts(view, view.pendingMode ?? 'initial')
      return
    }
    const rows = postsRowCount(view)
    if (action === 'next' || action === 'previous') {
      const sel = move(view.sel, action, rows)
      if (sel === view.sel) return
      view.sel = sel
      return draw()
    }
    if (action !== 'select') return
    const item = view.items[view.sel]
    if (item) return openReader(item)
    if (view.nextOffset !== null && view.sel === view.items.length) return loadPosts(view, 'older')
  }

  async function onReader(view: ReaderState, action: GlassesAction): Promise<void> {
    if (action === 'back' || action === 'hold') return leaveReader(view)
    if (view.state === 'loading') return
    if (view.state === 'error') {
      if (action === 'select' && isRetryable(view.error)) return loadReader(view, false)
      return
    }
    const total = view.pages.length
    if (action === 'next') {
      if (view.page >= total) return
      view.page += 1
      return draw()
    }
    if (action === 'previous') {
      if (view.page <= 0) return
      view.page = Math.min(view.page, total) - 1
      return draw()
    }
    if (action !== 'select') return
    if (view.page >= total) return nextPost(view)
    if (state.settings.tapInReader !== 'next') return
    view.page += 1
    return draw()
  }

  /** Contextual menu: 1 Home, 2 Save for later, 3 Next post, 4 Restart post, 5 Refresh. */
  async function onMenu(id: number): Promise<void> {
    const view = top()
    switch (id) {
      case 1: {
        if (stack.length === 1) return
        cancel()
        if (view.kind === 'reader') void store.flush()
        stack = [stack[0]!]
        viewChanged()
        return draw()
      }
      case 2: {
        const ref = view.kind === 'reader' ? view.ref
          : view.kind === 'posts' && view.state === 'ready' ? view.items[view.sel] : undefined
        if (!ref) return hint(TEXT.notAvailable)
        const result = addSaved(state, ref)
        if (result === 'added') {
          store.save('prefs')
          notifyPhone()
        }
        // 'full' below the count limit means the prefs document has no room left (storage).
        const full = state.saved.length >= LIMITS.saved ? 'Saved list is full' : 'Storage is full'
        return hint(result === 'added' ? 'Saved for later' : result === 'exists' ? 'Already saved' : result === 'full' ? full : TEXT.notAvailable)
      }
      case 3:
        if (view.kind === 'reader' && view.state === 'ready') return nextPost(view)
        return hint(TEXT.notAvailable)
      case 4:
        if (view.kind === 'reader' && view.state === 'ready') {
          view.page = 0
          return draw()
        }
        return hint(TEXT.notAvailable)
      case 5:
        if (view.kind === 'posts') {
          if (isLocal(view.source)) {
            const key = selectedKey(view)
            view.items = localItems(view.source)
            view.state = 'ready'
            view.error = null
            selectKey(view, key)
            return draw()
          }
          // A loaded list reloads; otherwise the pending or failed step runs again.
          return loadPosts(view, view.state === 'ready' ? 'refresh' : view.pendingMode ?? 'initial')
        }
        if (view.kind === 'reader' && view.state === 'error' && isRetryable(view.error)) return loadReader(view, false)
        return forceRedraw()
      default:
        return hint(TEXT.notAvailable)
    }
  }

  return {
    start(launch) {
      if (launch) launchSource = launch
      started = true
      if (launchSource === 'glassesMenu' && !resumed && !interacted && stack.length === 1 && canResume()) return resume()
      return draw()
    },
    onLaunchSource(source) {
      launchSource = source
      if (!started || resumed || interacted || source !== 'glassesMenu' || stack.length !== 1 || !canResume()) return
      void resume()
    },
    async onAction(action) {
      // Before start() the glasses show the startup frame (for example "Loading your library"):
      // only the root double-tap (the exit dialog) is honoured, and redraw() and the foreground
      // redraw wait too, so only configurationChanged (the library arrived) draws over that frame.
      if (!started) return action === 'back' ? exitApp() : undefined
      interacted = true
      // The wearer acted on an older frame than the model: show the model first, at most once per
      // failed frame (when that redraw fails too, the next gesture runs). Back, hold and the other
      // menu items navigate or act on the whole view, so they always run: glasses that keep
      // refusing frames never trap the wearer below the root or away from the exit dialog.
      if (displayStale && offeredSeq !== drawSeq && actsOnShown(action)) {
        const redraw = forceRedraw()
        offeredSeq = drawSeq
        return redraw
      }
      if (action.startsWith('menu:')) return onMenu(Number(action.slice(5)))
      const view = top()
      switch (view.kind) {
        case 'home': return onHome(view, action)
        case 'publications': return onPublications(view, action)
        case 'posts': return onPosts(view, action)
        case 'reader': return onReader(view, action)
      }
    },
    onLifecycle(signal) {
      if (signal === 'background') {
        if (hiddenAt === null) hiddenAt = deps.now()
        void store.flush()
        return
      }
      const since = hiddenAt
      hiddenAt = null
      // Before start() the glasses keep the startup frame, which the app (not the model) owns.
      if (started && since !== null && deps.now() - since > FOREGROUND_REDRAW_MS) void forceRedraw()
    },
    configurationChanged() {
      for (const view of stack) {
        if (view.kind === 'posts' && view.state === 'ready' && isLocal(view.source)) {
          const key = selectedKey(view)
          view.items = localItems(view.source)
          selectKey(view, key)
        }
      }
      const view = top()
      if (view.kind === 'home') syncHome(view)
      else if (view.kind === 'publications') syncPublications(view)
      else if (view.kind === 'reader' && view.state === 'ready' && view.lines !== state.settings.linesPerPage) repaginate(view)
      void draw()
    },
    current() {
      return frame ?? frameFor(top(), state, { now: deps.now(), relayConfigured: relayConfigured() })
    },
    view: () => top(),
    depth: () => stack.length,
    isBusy() {
      const view = top()
      return (view.kind === 'posts' || view.kind === 'reader') && view.state === 'loading'
    },
    lastError() {
      const view = top()
      return (view.kind === 'posts' || view.kind === 'reader') && view.state === 'error' ? view.error ?? null : null
    },
    retry() {
      const view = top()
      if (view.kind === 'posts' && view.state === 'error') return loadPosts(view, view.pendingMode ?? 'initial')
      if (view.kind === 'reader' && view.state === 'error' && isRetryable(view.error)) return loadReader(view, false)
      return Promise.resolve()
    },
    redraw: () => (started ? forceRedraw() : Promise.resolve()),
    frameShown() {
      if (displayStale && latest) accepted(latest)
    },
  }
}
