/**
 * Phone UI state and handlers (SPEC section 5), following LIHKG main.ts:
 * one delegated click, submit and change listener; `run()` with busy, error,
 * retry and a generation counter (navigating away abandons the phone fetch);
 * drafts, focus and <details> state survive redraws. Phone state is separate
 * from the glasses: edits only call controller.configurationChanged(), and
 * phone fetches never block paging through pages already on the glasses.
 */
import { toViewError, type Controller } from '../app/controller'
import { LIMITS, defaultSettings, type HomeItemId, type PostRef } from '../app/types'
import type { GlassesAction, GlassesStatus } from '../events'
import {
  addPublication, addSaved, clearReading, isSaved, normalizeSettings, refKey, rehostPublication,
  removePublication, removeSaved, reorderItem, type AddResult, type Store,
} from '../storage'
import { appendPosts, type ArchiveResult, type RelayApi } from '../substack/api'
import { parseFeed, type FeedResult } from '../substack/feed'
import { ARCHIVE_PAGE_SIZE, type PostSummary, type PubMeta } from '../substack/types'
import { INVALID_REASONS, parseMany, wwwAlternative, type ParsedInput } from '../substack/urls'
import {
  NO_BRIDGE_MESSAGE, PHONE_PANELS, renderEventLog, renderGlassesLive, renderMirrorFrame, renderPhone, renderStatusInner,
  type AddCard, type BrowseState, type GlassesLink, type PhoneError, type PhoneModel, type PhonePanel,
} from './view'

export type PhoneApi = Pick<RelayApi, 'getArchive' | 'getPost' | 'getProfile' | 'searchPublications' | 'getHealth' | 'getFeedXml'>

export interface PhoneDeps {
  root: HTMLElement
  store: Store
  controller: Controller
  api: PhoneApi
  appName: string
  version: string
  relayOrigin: string | null
  now(): number
}

export interface PhoneApp {
  /** Rebuild the whole phone UI now. */
  draw(): void
  /** controller onPhoneUpdate: the glasses frame or glasses-side state changed. */
  glassesChanged(): void
  setGlassesStatus(status: GlassesStatus): void
  /** No Even app bridge after the startup grace period (keeps waiting in the background). */
  setNoBridge(): void
  /** Diagnostics ring buffer (envelope, type, source only). */
  logEvent(summary: string): void
  /** store onSaved. */
  saved(ok: boolean): void
  /** Exposed on #app[data-phase] for diagnostics and CI ('boot', 'phone', 'glasses', 'nobridge'). */
  setPhase(phase: string): void
  /**
   * The stored library is still being read from bridge storage: lists show
   * "Loading your library" and edits are refused, so an empty list never
   * invites an edit that would race the bridge copy. `notice` is shown when
   * the gate is lifted (e.g. because the library could not be read).
   */
  setLibraryLoading(loading: boolean, notice?: string): void
}

interface RunContext {
  signal: AbortSignal
  live(): boolean
}

type RunAction = (ctx: RunContext) => Promise<void>

const MAX_EVENTS = 30
/** Characters of a skipped share-text line used as its card label. */
const SKIPPED_LABEL_CHARS = 60
/** Buttons that change publications, saved posts, settings or progress (refused while the library loads). */
const LIBRARY_ACTIONS = new Set([
  'follow', 'follow-selected', 'save-post', 'toggle-save', 'pub-up', 'pub-down', 'pub-remove', 'pub-latest',
  'saved-up', 'saved-down', 'saved-remove', 'set', 'home-item', 'home-up', 'home-down', 'latest-max',
  'clear-reading', 'reset-settings', 'clear-reading-confirm', 'reset-settings-confirm', 'browse',
])
const LIBRARY_LOADING = `Loading your library${String.fromCharCode(0x2026)}`
const COPY_BLOCKED = 'Copying is not allowed here. Press and hold the link below to copy it.'
const FEED_FALLBACK_CODES = new Set(['UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE'])
const SUMMARY_FIELDS = [
  'id', 'publicationId', 'slug', 'title', 'subtitle', 'postDate', 'audience', 'isPaywalled',
  'type', 'wordcount', 'canonicalUrl', 'authors', 'podcastDurationSec',
] as const

function abortedError(): { code: string; message: string } {
  return { code: 'ABORTED', message: 'The request was cancelled.' }
}

function codeOf(error: unknown): string {
  return toViewError(error).code
}

/** PostSummary fields only (drops bodyHtml so post HTML is never kept by the phone UI). */
function summaryOf(post: PostSummary): PostSummary {
  const out: Record<string, unknown> = {}
  for (const key of SUMMARY_FIELDS) out[key] = post[key]
  return out as unknown as PostSummary
}

function labelOf(parsed: ParsedInput): string {
  switch (parsed.kind) {
    case 'publication': return parsed.host
    case 'post': return `${parsed.host}/p/${parsed.slug}`
    case 'postId': return `Post ${parsed.id}`
    case 'handle': return `@${parsed.handle}`
    case 'search': return `Search: ${parsed.query}`
    // Share text next to a link: the card is titled with the skipped line itself.
    case 'invalid': return parsed.skipped === undefined ? 'Not added' : Array.from(parsed.skipped).slice(0, SKIPPED_LABEL_CHARS).join('')
  }
}

/** `count` is the list length after the attempt: below the limit, 'full' means the storage space ran out. */
function followText(result: AddResult, name: string, count: number): { text: string; tone: 'ok' | 'info' } {
  switch (result) {
    case 'added': return { text: `Following ${name}. It is on the glasses now.`, tone: 'ok' }
    case 'exists': return { text: `Already following ${name}.`, tone: 'info' }
    case 'full': return count >= LIMITS.publications
      ? { text: `Your list is full (${LIMITS.publications} publications). Remove one first.`, tone: 'info' }
      : { text: 'Storage is full. Remove a publication or saved post first.', tone: 'info' }
    case 'invalid': return { text: 'That publication address could not be used.', tone: 'info' }
  }
}

function clock(time: number): string {
  const date = new Date(time)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function isPanel(value: string | undefined): value is PhonePanel {
  return typeof value === 'string' && (PHONE_PANELS as readonly string[]).includes(value)
}

function isHomeItem(value: string | undefined): value is HomeItemId {
  return value === 'latest' || value === 'publications' || value === 'saved' || value === 'history'
}

/** Stable identity of a focusable control across redraws. */
function focusKey(element: Element | null): string | null {
  if (!(element instanceof HTMLElement)) return null
  if (element.id) return `#${element.id}`
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
    const data = Object.entries(element.dataset).map(([key, value]) => `${key}=${value ?? ''}`).sort().join('&')
    return data ? `${element.tagName}?${data}${element instanceof HTMLInputElement ? `&value=${element.value}` : ''}` : null
  }
  return null
}

export function createPhoneApp(deps: PhoneDeps): PhoneApp {
  const { root, store, controller, api } = deps
  const state = store.state

  let panel: PhonePanel = 'home'
  let link: { state: GlassesLink; message: string } = { state: 'connecting', message: `Connecting to G2${String.fromCharCode(0x2026)}` }
  let busy = false
  let busyLabel = ''
  let generation = 0
  let runAbort: AbortController | null = null
  let error: PhoneError | null = null
  let retry: { label: string; action: RunAction } | null = null
  let notice = ''
  let copyFallback = ''
  let addCards: AddCard[] = []
  let nextCardId = 1
  let browse: BrowseState | null = null
  let health: PhoneModel['health'] = null
  const events: string[] = []
  let lastErrorCode = ''
  let lastGlassesError: object | null = null
  let confirm: PhoneModel['confirm'] = null
  let drawQueued = false
  let libraryLoading = false
  const drafts = new Map<string, { value: string; start: number | null; end: number | null }>()

  // -------------------------------------------------------------------------
  // Rendering

  function model(): PhoneModel {
    const view = controller.view()
    return {
      panel,
      appName: deps.appName,
      version: deps.version,
      relayOrigin: deps.relayOrigin,
      link,
      busy,
      busyLabel,
      error,
      notice,
      copyFallback,
      saveOk: store.lastSaveOk(),
      state,
      glasses: {
        frame: controller.current(),
        depth: controller.depth(),
        reading: view.kind === 'reader' ? view.ref : null,
        error: controller.lastError(),
        busy: controller.isBusy(),
      },
      addCards,
      browse,
      health,
      events,
      storage: { backend: store.backend(), sizes: store.sizes() },
      lastErrorCode,
      confirm,
      libraryLoading,
    }
  }

  /** Rebuild the UI, keeping drafts (also across panel switches), open <details> and focus. */
  function draw() {
    drawQueued = false
    const active = document.activeElement
    const focused = active && root.contains(active) ? focusKey(active) : null
    for (const field of root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('[data-draft][id]')) {
      drafts.set(field.id, { value: field.value, start: field.selectionStart, end: field.selectionEnd })
    }
    const openDetails = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[id]'), item => item.open ? item.id : '').filter(Boolean))
    root.innerHTML = renderPhone(model())
    for (const field of root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('[data-draft][id]')) {
      const draft = drafts.get(field.id)
      if (draft) field.value = draft.value
    }
    for (const id of openDetails) {
      const details = root.querySelector<HTMLDetailsElement>(`details#${CSS.escape(id)}`)
      if (details) details.open = true
    }
    if (focused) {
      const target = Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea')).find(element => focusKey(element) === focused)
      if (target && !(target as HTMLButtonElement).disabled) {
        target.focus({ preventScroll: true })
        const draft = target.id ? drafts.get(target.id) : undefined
        if (draft && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
          try { target.setSelectionRange(draft.start, draft.end) } catch { /* Not a text field. */ }
        }
      }
    }
  }

  function requestDraw() {
    if (drawQueued) return
    drawQueued = true
    queueMicrotask(() => {
      if (drawQueued) draw()
    })
  }

  /** Update only the glasses-driven regions (keeps an in-progress text input untouched). */
  function updateLive() {
    const current = model()
    const live = root.querySelector('#glasses-live')
    if (live) live.innerHTML = renderGlassesLive(current)
    const mirror = root.querySelector('#mirror')
    if (mirror) mirror.innerHTML = renderMirrorFrame(current)
    const back = root.querySelector<HTMLButtonElement>('[data-remote="back"]')
    if (back) back.disabled = current.glasses.depth <= 1
  }

  function updateStatus() {
    const status = root.querySelector<HTMLElement>('[data-testid="glasses-status"]')
    if (!status) return
    status.dataset.state = link.state
    status.innerHTML = renderStatusInner({ link })
  }

  function textInputFocused(): boolean {
    const active = document.activeElement
    return !!active && root.contains(active) && (active instanceof HTMLTextAreaElement
      || (active instanceof HTMLInputElement && active.type !== 'checkbox' && active.type !== 'radio'))
  }

  // -------------------------------------------------------------------------
  // Async work

  function recordError(code: string) {
    if (code && code !== 'ABORTED') lastErrorCode = `${code} at ${clock(deps.now())}`
  }

  function describe(err: unknown): PhoneError {
    const view = toViewError(err)
    const upstream = err !== null && typeof err === 'object' ? (err as { upstream?: unknown }).upstream : undefined
    const details: string[] = []
    if (upstream && typeof upstream === 'object') {
      const u = upstream as { status?: unknown; contentType?: unknown; challenge?: unknown }
      if (typeof u.status === 'number' && u.status > 0) {
        details.push(`Substack answered HTTP ${u.status}${typeof u.contentType === 'string' ? ` (${u.contentType})` : ''}${u.challenge === true ? ' with a challenge page' : ''}.`)
      }
    }
    if (view.retryAfterSeconds) details.push(`Try again in ${Math.ceil(view.retryAfterSeconds)} s.`)
    return { code: view.code, message: view.message, detail: details.join(' '), retry: true }
  }

  async function run(label: string, action: RunAction, retryable = true): Promise<void> {
    if (busy) return
    const gen = generation
    const abort = new AbortController()
    runAbort = abort
    busy = true
    busyLabel = label
    error = null
    retry = null
    draw()
    const ctx: RunContext = { signal: abort.signal, live: () => gen === generation }
    try {
      await action(ctx)
    } catch (err) {
      if (ctx.live()) {
        const described = describe(err)
        if (described.code !== 'ABORTED') {
          recordError(described.code)
          error = { ...described, retry: retryable }
          retry = retryable ? { label, action } : null
        }
      }
    } finally {
      if (ctx.live()) {
        busy = false
        busyLabel = ''
        runAbort = null
        draw()
      }
    }
  }

  /** Drop the phone fetch in flight (its results are ignored when they arrive). */
  function abandon() {
    if (!busy) return
    generation += 1
    runAbort?.abort()
    runAbort = null
    busy = false
    busyLabel = ''
    addCards = addCards.map(card => card.kind === 'pending'
      ? { id: card.id, kind: 'message', label: card.label, text: 'Not checked (stopped).', tone: 'info' }
      : card)
  }

  function setPanel(next: PhonePanel) {
    abandon()
    panel = next
    copyFallback = ''
    notice = ''
    error = null
    retry = null
    confirm = null
    draw()
    if (typeof window !== 'undefined') window.scrollTo(0, 0)
  }

  /** A persisted document changed: debounce-save it and let the glasses refresh lists. */
  function changed(doc: 'prefs' | 'progress') {
    store.save(doc)
    controller.configurationChanged()
  }

  async function copyText(text: string, success: string) {
    copyFallback = ''
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
      await navigator.clipboard.writeText(text)
      notice = success
    } catch {
      copyFallback = text
      notice = COPY_BLOCKED
    }
    draw()
  }

  // -------------------------------------------------------------------------
  // Publications: add flow

  /**
   * C4: an apex custom domain often only serves Substack on www. On
   * HOST_NOT_SUBSTACK, try the www host once; if that fails too, its error
   * (more specific, e.g. post not found) is reported.
   */
  async function withWwwRetry<T>(host: string, ctx: RunContext, call: (host: string) => Promise<T>): Promise<T> {
    try {
      return await call(host)
    } catch (err) {
      const alternative = codeOf(err) === 'HOST_NOT_SUBSTACK' ? wwwAlternative(host) : null
      if (!alternative || !ctx.live()) throw err
      return call(alternative)
    }
  }

  /** One feed attempt after an upstream refusal; retain the API error if RSS cannot help. */
  async function feedAfterError(host: string, ctx: RunContext, original: unknown): Promise<FeedResult> {
    if (!ctx.live() || ctx.signal.aborted) throw abortedError()
    if (!FEED_FALLBACK_CODES.has(codeOf(original))) throw original
    try {
      const xml = await api.getFeedXml(host, ctx.signal)
      if (!ctx.live() || ctx.signal.aborted) throw abortedError()
      return parseFeed(xml, host)
    } catch {
      if (!ctx.live() || ctx.signal.aborted) throw abortedError()
      throw original
    }
  }

  function feedPublication(host: string, feed: FeedResult): PubMeta {
    return { id: null, name: feed.title || host, subdomain: null, customDomain: null, host }
  }

  /** RSS has only recent posts, so it can replace the first page but never an older page. */
  async function archiveWithFeed(host: string, offset: number, ctx: RunContext, source?: 'sitemap'): Promise<ArchiveResult> {
    try {
      return await api.getArchive(host, { offset, limit: ARCHIVE_PAGE_SIZE, ...(source ? { source } : {}) }, ctx.signal)
    } catch (err) {
      if (offset !== 0) throw err
      const feed = await feedAfterError(host, ctx, err)
      return { host, page: { publication: feedPublication(host, feed), posts: feed.posts, nextOffset: null } }
    }
  }

  /** A pasted post URL can be resolved from recent RSS items; the phone retains only its summary. */
  async function postWithFeed(host: string, slug: string, ctx: RunContext): Promise<{ post: PostSummary; publication: PubMeta | null; host: string }> {
    try {
      return await api.getPost({ host, slug }, ctx.signal)
    } catch (err) {
      const feed = await feedAfterError(host, ctx, err)
      const post = feed.posts.find(item => item.slug === slug)
      if (!post) throw err
      return { post, publication: feedPublication(host, feed), host }
    }
  }

  /** The publication's name when the archive could not tell (no post byline names it). */
  async function nameFromPost(postId: number, host: string, ctx: RunContext): Promise<string | null> {
    try {
      const detail = await api.getPost({ id: postId }, ctx.signal)
      const pub = detail.publication
      return pub && pub.host === host && pub.name ? pub.name : null
    } catch {
      return null // Cosmetic: the host is shown instead.
    }
  }

  async function followHost(host: string, ctx: RunContext): Promise<{ text: string; tone: 'ok' | 'info' }> {
    // A full page: the relay finds the publication through post bylines, and one post may have none.
    const result = await withWwwRetry(host, ctx, target => archiveWithFeed(target, 0, ctx))
    if (!ctx.live()) throw abortedError()
    const pub = result.page.publication
    const first = result.page.posts[0]
    let name = pub?.name || ''
    if (!name && first) {
      name = await nameFromPost(first.id, result.host, ctx) ?? ''
      if (!ctx.live()) throw abortedError()
    }
    if (!name) name = result.host
    const id = pub?.id ?? first?.publicationId ?? null
    const outcome = addPublication(state, { id, name, host: result.host, addedAt: deps.now(), inLatest: true })
    if (outcome === 'added') changed('prefs')
    return followText(outcome, name, state.publications.length)
  }

  async function processInput(parsed: ParsedInput, id: number, ctx: RunContext): Promise<AddCard> {
    const label = labelOf(parsed)
    try {
      switch (parsed.kind) {
        case 'invalid':
          // A skipped share-text line is information, not a failed add.
          if (parsed.skipped !== undefined) return { id, kind: 'message', label, text: INVALID_REASONS.shareText, tone: 'info' }
          return { id, kind: 'invalid', label, text: parsed.reason }
        case 'publication':
          return { id, kind: 'message', label, ...await followHost(parsed.host, ctx) }
        case 'post':
        case 'postId': {
          const result = parsed.kind === 'post'
            ? await withWwwRetry(parsed.host, ctx, host => postWithFeed(host, parsed.slug, ctx))
            : await api.getPost({ id: parsed.id }, ctx.signal)
          return { id, kind: 'post', label, post: summaryOf(result.post), publication: result.publication, host: result.host }
        }
        case 'handle':
          return { id, kind: 'profile', label, profile: await api.getProfile(parsed.handle, ctx.signal), picks: [] }
        case 'search':
          return { id, kind: 'search', label, query: parsed.query, results: await api.searchPublications(parsed.query, ctx.signal) }
      }
    } catch (err) {
      const described = describe(err)
      if (!ctx.live() || described.code === 'ABORTED') throw err
      recordError(described.code)
      const text = described.detail ? `${described.message} ${described.detail}` : described.message
      return { id, kind: 'error', label, text, code: described.code, parsed }
    }
  }

  function replaceCard(card: AddCard) {
    addCards = addCards.map(item => item.id === card.id ? card : item)
  }

  function addAll(parsed: ParsedInput[]) {
    addCards = parsed.map(item => ({ id: nextCardId++, kind: 'pending' as const, label: labelOf(item) }))
    const ids = addCards.map(card => card.id)
    const label = parsed.length === 1 ? 'Checking' : `Checking ${parsed.length} entries`
    void run(label, async ctx => {
      // One at a time, in order (SPEC section 5).
      for (let index = 0; index < parsed.length; index += 1) {
        if (!ctx.live()) return
        const card = await processInput(parsed[index]!, ids[index]!, ctx)
        if (!ctx.live()) return
        replaceCard(card)
        draw()
      }
    }, false)
  }

  function retryCard(id: number) {
    const card = addCards.find(item => item.id === id)
    if (!card || card.kind !== 'error') return
    replaceCard({ id, kind: 'pending', label: card.label })
    void run('Checking', async ctx => {
      const next = await processInput(card.parsed, id, ctx)
      if (ctx.live()) replaceCard(next)
    }, false)
  }

  function cardPublications(card: AddCard): PubMeta[] {
    if (card.kind === 'search') return card.results
    if (card.kind === 'profile') return [...(card.profile.primaryPublication ? [card.profile.primaryPublication] : []), ...card.profile.subscriptions]
    if (card.kind === 'post') return card.publication ? [card.publication] : []
    return []
  }

  function followPub(pub: PubMeta): AddResult {
    return addPublication(state, { id: pub.id, name: pub.name, host: pub.host, addedAt: deps.now(), inLatest: true })
  }

  function follow(cardId: number, host: string) {
    const card = addCards.find(item => item.id === cardId)
    if (!card) return
    let pub = cardPublications(card).find(item => item.host === host)
    if (!pub && card.kind === 'post' && card.host === host) {
      pub = { id: card.post.publicationId, name: card.host, subdomain: null, customDomain: null, host: card.host }
    }
    if (!pub) return
    const outcome = followPub(pub)
    if (outcome === 'added') changed('prefs')
    notice = followText(outcome, pub.name, state.publications.length).text
    draw()
  }

  function followSelected(cardId: number) {
    const card = addCards.find(item => item.id === cardId)
    if (!card || card.kind !== 'profile') return
    let added = 0
    let full = false
    for (const pub of cardPublications(card)) {
      if (!card.picks.includes(pub.host)) continue
      const outcome = followPub(pub)
      if (outcome === 'added') added += 1
      if (outcome === 'full') full = true
    }
    replaceCard({ ...card, picks: [] })
    if (added) changed('prefs')
    const fullText = !full ? ''
      : state.publications.length >= LIMITS.publications ? ` Your list is full (${LIMITS.publications} publications).`
        : ' Storage is full. Remove a publication or saved post first.'
    notice = `Following ${added} new publication${added === 1 ? '' : 's'}.${fullText}`
    draw()
  }

  function pickAll(cardId: number) {
    const card = addCards.find(item => item.id === cardId)
    if (!card || card.kind !== 'profile') return
    const hosts = cardPublications(card).map(pub => pub.host).filter(host => !state.publications.some(item => item.host === host))
    replaceCard({ ...card, picks: [...new Set(hosts)] })
    draw()
  }

  /** Checkbox change: update the model and the button in place (no redraw under the user's finger). */
  function pick(cardId: number, host: string, checked: boolean) {
    const card = addCards.find(item => item.id === cardId)
    if (!card || card.kind !== 'profile') return
    const picks = card.picks.filter(item => item !== host)
    if (checked) picks.push(host)
    replaceCard({ ...card, picks })
    const count = picks.filter(item => !state.publications.some(pub => pub.host === item)).length
    const button = root.querySelector<HTMLButtonElement>(`[data-action="follow-selected"][data-card="${cardId}"]`)
    if (button) {
      button.textContent = `Follow selected (${count})`
      button.disabled = count === 0
    }
  }

  function refFor(post: PostSummary, host: string, pubName: string): PostRef {
    return {
      postId: post.id,
      host,
      slug: post.slug,
      title: post.title,
      pubName: pubName || host,
      postDate: post.postDate,
      isPaywalled: post.isPaywalled,
      wordcount: post.wordcount,
      addedAt: deps.now(),
    }
  }

  /** Save or unsave a post for the glasses. */
  function toggleSaved(ref: PostRef) {
    if (isSaved(state, ref)) {
      removeSaved(state, ref)
      notice = 'Removed from Saved.'
    } else {
      const outcome = addSaved(state, ref)
      const full = state.saved.length >= LIMITS.saved
        ? `Saved is full (${LIMITS.saved} posts). Remove one first.`
        : 'Storage is full. Remove some saved posts first.'
      notice = outcome === 'added' ? 'Saved. Open Saved on the glasses to read it.'
        : outcome === 'full' ? full
          : outcome === 'exists' ? 'Already saved.' : 'That post could not be saved.'
      if (outcome !== 'added') {
        draw()
        return
      }
    }
    changed('prefs')
    draw()
  }

  // -------------------------------------------------------------------------
  // Browse

  async function loadBrowse(more: boolean, ctx: RunContext): Promise<void> {
    const current = browse
    if (!current) return
    const offset = more ? current.nextOffset ?? current.posts.length : 0
    const result = await archiveWithFeed(current.host, offset, ctx, more ? current.source : undefined)
    if (!ctx.live() || browse !== current) return
    if (result.host !== current.host) {
      if (rehostPublication(state, current.host, result.host)) changed('prefs')
      current.host = result.host
    }
    const fresh = result.page.posts.map(summaryOf)
    current.posts = more ? appendPosts(current.posts, fresh) : fresh
    current.nextOffset = result.page.posts.length ? result.page.nextOffset : null
    current.source = more ? result.page.source ?? current.source : result.page.source
    if (result.page.publication?.name && !current.name) current.name = result.page.publication.name
    current.loaded = true
  }

  function openBrowse(host: string) {
    const pub = state.publications.find(item => item.host === host)
    if (!pub) return
    setPanel('browse')
    browse = { host: pub.host, name: pub.name, posts: [], nextOffset: null, loaded: false }
    draw()
    void run('Loading posts', ctx => loadBrowse(false, ctx))
  }

  // -------------------------------------------------------------------------
  // Settings

  function setSetting(key: string, raw: string) {
    if (!(key in state.settings) || key === 'homeItems') return
    const value: unknown = raw === 'true' ? true : raw === 'false' ? false : /^\d{1,2}$/.test(raw) ? Number(raw) : raw
    const next = normalizeSettings({ ...state.settings, [key]: value })
    if (JSON.stringify(next) === JSON.stringify(state.settings)) return
    state.settings = next
    changed('prefs')
    draw()
  }

  function updateHomeItems(items: HomeItemId[]) {
    const next = normalizeSettings({ ...state.settings, homeItems: items })
    if (next.homeItems.join() === state.settings.homeItems.join()) return
    state.settings = next
    changed('prefs')
    draw()
  }

  function moveIn<T>(list: T[], index: number, delta: number): boolean {
    return index >= 0 && reorderItem(list, index, index + delta)
  }

  // -------------------------------------------------------------------------
  // Events

  function remote(name: string | undefined) {
    if (name !== 'previous' && name !== 'next' && name !== 'select' && name !== 'back') return
    // Back on the glasses Home opens the exit dialog; the phone never triggers that.
    if (name === 'back' && controller.depth() <= 1) return
    const action: GlassesAction = name
    void controller.onAction(action).catch(() => undefined)
  }

  function onButton(button: HTMLButtonElement) {
    const data = button.dataset
    if (isPanel(data.panel)) {
      setPanel(data.panel)
      return
    }
    const host = data.host ?? ''
    const cardId = Number(data.card)
    if (libraryLoading && data.action && LIBRARY_ACTIONS.has(data.action)) {
      notice = LIBRARY_LOADING
      draw()
      return
    }
    switch (data.action) {
      case 'remote': return remote(data.remote)
      case 'glasses-retry': void controller.retry().catch(() => undefined); return
      case 'glasses-home': void controller.onAction('menu:1').catch(() => undefined); return
      case 'redraw-glasses': void controller.redraw().catch(() => undefined); return
      case 'retry':
        if (retry) void run(retry.label, retry.action)
        return
      case 'dismiss-error':
        error = null
        retry = null
        draw()
        return
      case 'copy-link': {
        const url = data.url ?? ''
        if (/^https:\/\/[^\s]+$/i.test(url)) void copyText(url, 'Link copied.')
        return
      }
      case 'clear-results':
        addCards = addCards.filter(card => card.kind === 'pending')
        draw()
        return
      case 'retry-card': return retryCard(cardId)
      case 'follow': return follow(cardId, host)
      case 'follow-selected': return followSelected(cardId)
      case 'pick-all': return pickAll(cardId)
      case 'save-post': {
        const card = addCards.find(item => item.id === cardId)
        if (card?.kind === 'post') toggleSaved(refFor(card.post, card.host, card.publication?.name ?? ''))
        return
      }
      case 'browse': return openBrowse(host)
      case 'browse-more':
        if (browse?.nextOffset !== null && browse?.loaded) void run('Loading older posts', ctx => loadBrowse(true, ctx))
        return
      case 'toggle-save': {
        const post = browse?.posts.find(item => String(item.id) === data.postId)
        if (browse && post) toggleSaved(refFor(post, browse.host, browse.name))
        return
      }
      case 'pub-up':
      case 'pub-down': {
        const index = state.publications.findIndex(item => item.host === host)
        if (moveIn(state.publications, index, data.action === 'pub-up' ? -1 : 1)) changed('prefs')
        draw()
        return
      }
      case 'pub-remove': {
        const pub = state.publications.find(item => item.host === host)
        if (pub && removePublication(state, host)) {
          notice = `Removed ${pub.name}.`
          changed('prefs')
        }
        draw()
        return
      }
      case 'pub-latest': {
        const index = state.publications.findIndex(item => item.host === host)
        const pub = state.publications[index]
        if (pub) {
          state.publications[index] = { ...pub, inLatest: !pub.inLatest }
          changed('prefs')
        }
        draw()
        return
      }
      case 'saved-up':
      case 'saved-down': {
        const index = state.saved.findIndex(item => refKey(item) === data.key)
        if (moveIn(state.saved, index, data.action === 'saved-up' ? -1 : 1)) changed('prefs')
        draw()
        return
      }
      case 'saved-remove': {
        const ref = state.saved.find(item => refKey(item) === data.key)
        if (ref && removeSaved(state, ref)) {
          notice = 'Removed from Saved.'
          changed('prefs')
        }
        draw()
        return
      }
      case 'set': return setSetting(data.key ?? '', data.value ?? '')
      case 'home-item': {
        const item = data.item
        if (!isHomeItem(item)) return
        const items = state.settings.homeItems
        return updateHomeItems(items.includes(item) ? items.filter(id => id !== item) : [...items, item])
      }
      case 'home-up':
      case 'home-down': {
        const items = [...state.settings.homeItems]
        const index = items.findIndex(id => id === data.item)
        if (moveIn(items, index, data.action === 'home-up' ? -1 : 1)) updateHomeItems(items)
        return
      }
      case 'latest-max': {
        const delta = Number(data.delta)
        if (delta === 1 || delta === -1) setSetting('latestMaxPublications', String(state.settings.latestMaxPublications + delta))
        return
      }
      case 'clear-reading':
      case 'reset-settings':
        confirm = data.action
        draw()
        return
      case 'confirm-cancel':
        confirm = null
        draw()
        return
      case 'clear-reading-confirm':
        confirm = null
        clearReading(state)
        notice = 'Reading history and positions cleared.'
        changed('progress')
        draw()
        return
      case 'reset-settings-confirm':
        confirm = null
        state.settings = defaultSettings()
        notice = 'Settings reset to defaults.'
        changed('prefs')
        draw()
        return
      case 'check-relay':
        void run('Checking the reader service', async ctx => {
          const result = await api.getHealth(true, ctx.signal)
          if (ctx.live()) health = result
        })
        return
      case 'clear-events':
        events.length = 0
        draw()
        return
      default:
        return
    }
  }

  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!(target instanceof HTMLButtonElement) || !root.contains(target) || target.disabled) return
    if (target.type === 'submit' && target.form) return
    event.preventDefault()
    onButton(target)
  })

  root.addEventListener('submit', event => {
    event.preventDefault()
    const form = event.target
    if (!(form instanceof HTMLFormElement) || form.id !== 'add-form') return
    const input = form.querySelector<HTMLTextAreaElement>('#add-input')
    if (!input || busy) return
    if (libraryLoading) {
      notice = LIBRARY_LOADING
      draw()
      return
    }
    const parsed = parseMany(input.value)
    if (!parsed.length) {
      notice = 'Paste a link, a domain, an @handle, or a name to search.'
      draw()
      return
    }
    input.value = ''
    drafts.delete(input.id)
    notice = ''
    addAll(parsed)
  })

  root.addEventListener('change', event => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox' || !input.dataset.pick) return
    pick(Number(input.dataset.pick), input.value, input.checked)
  })

  return {
    draw,
    glassesChanged() {
      const current = controller.lastError()
      if (current && current !== lastGlassesError) recordError(current.code)
      lastGlassesError = current
      if (textInputFocused()) updateLive()
      else requestDraw()
    },
    setGlassesStatus(status) {
      link = { state: status.state, message: status.message }
      updateStatus()
    },
    setNoBridge() {
      if (link.state !== 'connecting') return
      link = { state: 'nobridge', message: NO_BRIDGE_MESSAGE }
      updateStatus()
    },
    logEvent(summary) {
      events.unshift(`${clock(deps.now())} ${summary}`)
      if (events.length > MAX_EVENTS) events.length = MAX_EVENTS
      const log = root.querySelector('#event-log')
      if (log) log.innerHTML = renderEventLog(events)
    },
    saved(ok) {
      if (!ok || panel === 'diagnostics') requestDraw()
      else if (root.querySelector('[data-testid="save-failed"]')) requestDraw()
    },
    setPhase(phase) {
      root.dataset.phase = phase
    },
    setLibraryLoading(loading, message) {
      if (libraryLoading === loading) return
      libraryLoading = loading
      if (!loading && notice === LIBRARY_LOADING) notice = ''
      if (!loading && message) notice = message
      requestDraw()
    },
  }
}
