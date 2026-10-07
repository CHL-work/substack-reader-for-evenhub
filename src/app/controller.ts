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
  addSaved, markRead, normalizePostRef, positionOf, recordHistory, recordPosition, refKey,
  rehostPost, rehostPublication, setLastOpen, type Store,
} from '../storage'
import { ARCHIVE_PAGE_SIZE, type ArchivePage, type PostDetail, type PostSummary, type PubMeta } from '../substack/types'
import {
  EMPTY_TEXT, TEXT, canContinue, clampIndex, fitBody, frameFor, homeEntries, isFirstRun, isRetryable,
  latestPublications, postsRowCount, type HomeEntry, type PostsView, type ReaderView,
} from './frames'
import type { Article, GlassesView, LinesPerPage, Position, PostRef, PostSource, Settings, ViewError } from './types'

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
  /** Resolves after the glasses accepted the frame. */
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
  /** Resend the whole current frame (glasses reconnected, or the phone asks). */
  redraw(): Promise<void>
}

type HomeView = Extract<GlassesView, { kind: 'home' }>
type PublicationsView = Extract<GlassesView, { kind: 'publications' }>
interface PostsState extends PostsView {
  /** The pending or failed load is "Load older posts" (the list stays usable on cancel/error). */
  older?: boolean
}
interface ReaderState extends ReaderView {
  /** Lines per page the pages were computed for. */
  lines: LinesPerPage
}
type View = HomeView | PublicationsView | PostsState | ReaderState

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

  function computeFrame(): GlassesPage {
    const view = top()
    if (view.kind === 'home') syncHome(view)
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

  /** Render the top of the stack; a shown reader page records the position afterwards. */
  function draw(): Promise<void> {
    const page = computeFrame()
    frame = page
    notifyPhone()
    const view = top()
    const shown = view.kind === 'reader' && view.state === 'ready' ? positionShown(view) : null
    let rendered: Promise<void>
    try {
      rendered = Promise.resolve(deps.render(page))
    } catch (error) {
      rendered = Promise.reject(error)
    }
    return rendered.then(() => {
      if (shown) afterReaderRender(shown)
    }, () => undefined /* The glasses wrapper reports write failures. */)
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
    latestCache = null
  }

  // -------------------------------------------------------------------------
  // Lists

  async function fetchArchive(host: string, offset: number, name: string, signal: AbortSignal): Promise<{ items: PostRef[]; nextOffset: number | null; host: string }> {
    try {
      const result = await deps.api.getArchive(host, { offset, limit: ARCHIVE_PAGE_SIZE }, signal)
      const resolved = result.host || host
      const pubName = result.page.publication?.name || name || resolved
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

  async function loadPosts(view: PostsState, mode: 'initial' | 'older' | 'refresh'): Promise<void> {
    const { gen, signal } = begin()
    const keep = mode === 'refresh' ? selectedKey(view) : null
    view.older = mode === 'older'
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
        if (result.host !== source.host) {
          rehost(source.host, result.host)
          view.source = { ...source, host: result.host }
        }
        if (mode === 'older') {
          const known = new Set(view.items.map(refKey))
          const fresh = result.items.filter(item => !known.has(refKey(item)))
          const first = view.items.length
          view.items = [...view.items, ...fresh]
          view.nextOffset = result.nextOffset
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
      view.older = false
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
    }
    transient = { body: TEXT.noMorePosts, footer: TEXT.backFooter }
    return draw()
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
        push({ kind: 'publications', sel: 0 })
        return draw()
      case 'latest':
      case 'saved':
      case 'history':
        return openPosts(entry.id)
    }
  }

  async function onPublications(view: PublicationsView, action: GlassesAction): Promise<void> {
    if (action === 'back' || action === 'hold') {
      pop()
      return draw()
    }
    const publications = state.publications
    if (action === 'next' || action === 'previous') {
      const sel = move(view.sel, action, publications.length)
      if (sel === view.sel) return
      view.sel = sel
      return draw()
    }
    if (action !== 'select') return
    const publication = publications[clampIndex(view.sel, publications.length)]
    if (publication) return openPosts({ host: publication.host, name: publication.name })
  }

  async function onPosts(view: PostsState, action: GlassesAction): Promise<void> {
    if (action === 'back' || action === 'hold') {
      cancel()
      if (view.state !== 'ready' && view.older && view.items.length) {
        // A failed or cancelled "Load older" returns to the loaded list.
        view.state = 'ready'
        view.error = null
        view.older = false
        return draw()
      }
      pop()
      return draw()
    }
    if (view.state === 'loading') return
    if (view.state === 'error') {
      if (action === 'select' && isRetryable(view.error)) return loadPosts(view, view.older ? 'older' : 'initial')
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
        return hint(result === 'added' ? 'Saved for later' : result === 'exists' ? 'Already saved' : result === 'full' ? 'Saved list is full' : TEXT.notAvailable)
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
          return loadPosts(view, view.state === 'error' && view.older ? 'older' : 'refresh')
        }
        if (view.kind === 'reader' && view.state === 'error' && isRetryable(view.error)) return loadReader(view, false)
        try { deps.invalidate?.() } catch { /* Optional dependency. */ }
        return draw()
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
      interacted = true
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
      if (since !== null && deps.now() - since > FOREGROUND_REDRAW_MS) {
        try { deps.invalidate?.() } catch { /* Optional dependency. */ }
        void draw()
      }
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
      else if (view.kind === 'publications') view.sel = clampIndex(view.sel, state.publications.length)
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
      if (view.kind === 'posts' && view.state === 'error') return loadPosts(view, view.older ? 'older' : 'initial')
      if (view.kind === 'reader' && view.state === 'error' && isRetryable(view.error)) return loadReader(view, false)
      return Promise.resolve()
    },
    redraw() {
      try { deps.invalidate?.() } catch { /* Optional dependency. */ }
      return draw()
    },
  }
}
