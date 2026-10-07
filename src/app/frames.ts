/**
 * Pure: application state -> one glasses frame { title, body, footer }.
 * Every body is fitted to the 7-line event-capture container, and every
 * list line is pixel-truncated, so no frame can make the firmware scroll.
 * Glyphs used: U+00B7 middle dot, U+00D7 multiplication sign, U+2026
 * ellipsis, U+00A0 NBSP (all present in the G2 font).
 */
import type { GlassesPage } from '../events'
import { APP_NAME } from '../config'
import { bodyBox, isReaderPage, menuWindow, normalizeReaderText, paginate, truncateGlassesLabel } from '../pagination'
import { isRead, positionOf } from '../storage'
import { minutesFor, pctString, relativeDate } from './format'
import type { AppState, GlassesView, HomeItemId, PostRef, PostSource, Publication, ViewError } from './types'

export type PostsView = Extract<GlassesView, { kind: 'posts' }>
export type ReaderView = Extract<GlassesView, { kind: 'reader' }>

const DOT = ' \u00b7 '
const TIMES = '\u00d7'
const ELLIPSIS = '\u2026'
/** Indentation of unselected rows and list meta lines (ASCII spaces would be skipped). */
export const INDENT = '\u00a0\u00a0\u00a0'
export const CURSOR = '> '

export const HOME_PER_SCREEN = 4
export const POSTS_PER_SCREEN = 3
/** Error code for a post whose converted text is empty (client-side, never from the relay). */
export const EMPTY_TEXT = 'EMPTY_TEXT'

export const TEXT = {
  loading: `Loading${ELLIPSIS}`,
  loadOlder: `Load older posts${ELLIPSIS}`,
  homeFooter: `Tap open${DOT}2${TIMES}tap exit`,
  exitFooter: `2${TIMES}tap exit`,
  backFooter: `2${TIMES}tap back`,
  cancelFooter: `2${TIMES}tap cancel`,
  retryFooter: `Tap retry${DOT}2${TIMES}tap back`,
  firstRun: `No publications yet.\n\nOn your phone, open ${APP_NAME}\nin the Even app and add a publication.`,
  notConfigured: 'This build has no reader service.\nSee the phone for details.',
  noPublications: 'No publications yet.\nAdd one on your phone.',
  noLatest: 'No publications in Latest.\nTurn one on in the phone app.',
  noSaved: 'Nothing saved yet.\nSave posts on your phone.',
  noHistory: 'Nothing read yet.',
  noPosts: 'No posts yet.',
  noMorePosts: 'No more posts.',
  notAvailable: 'Not available here',
  endFree: `End of post.\n\nTap: next post\nSwipe up: previous page\n2${TIMES}tap: back to list`,
  endPaid: `The free preview ends here.\nThe rest is for paid subscribers.\nRead it in the Substack app.\n\nTap: next post${DOT}2${TIMES}tap: back`,
} as const

/** One page of the 7-line body: unchanged when it fits, else the first paginated page. */
export function fitBody(body: string): string {
  return isReaderPage(body, 7) ? normalizeReaderText(body) : paginate(body, bodyBox(7))[0]!.text
}

/** LIHKG menuBody: 4 single-line items per screen, a blank line between them. */
export function menuBody(labels: readonly string[], selection: number, perScreen = HOME_PER_SCREEN): string {
  const { first, last } = menuWindow(labels.length, selection, perScreen)
  const lines: string[] = []
  for (let index = first; index <= last; index += 1) {
    lines.push(truncateGlassesLabel(`${index === selection ? CURSOR : INDENT}${labels[index]}`))
  }
  return lines.join('\n\n')
}

export function messageFrame(title: string, body: string, footer: string): GlassesPage {
  return { title, body: fitBody(body), footer }
}

export function loadingFrame(title: string): GlassesPage {
  return messageFrame(title, TEXT.loading, TEXT.cancelFooter)
}

/** Glasses wording per error code (details go to the phone). */
export function errorBody(error: Pick<ViewError, 'code' | 'retryAfterSeconds'>): string {
  switch (error.code) {
    case 'NOT_CONFIGURED':
      return 'This build has no reader service.'
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return "Can't reach the reader service.\nCheck the phone's connection."
    case 'UPSTREAM_BLOCKED':
      return 'Substack refused the reader service.\nTry again later.'
    case 'RATE_LIMITED':
    case 'UPSTREAM_RATE_LIMITED': {
      const seconds = error.retryAfterSeconds
      const wait = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60
      return `Busy. Try again in ${wait} s.`
    }
    case 'POST_NOT_FOUND':
    case 'PUBLICATION_NOT_FOUND':
    case 'PROFILE_NOT_FOUND':
      return 'Not found on Substack.'
    case 'HOST_NOT_SUBSTACK':
      return 'That site is not a Substack publication.'
    case EMPTY_TEXT:
      return 'No readable text in this post.'
    default:
      return 'Substack had a problem.\nTry again.'
  }
}

/** True when tapping can retry the failed step. */
export function isRetryable(error: Pick<ViewError, 'code'> | null | undefined): boolean {
  return !!error && error.code !== EMPTY_TEXT && error.code !== 'NOT_CONFIGURED'
}

export function errorFrame(title: string, error: ViewError | null | undefined): GlassesPage {
  const value = error ?? { code: 'UNKNOWN', message: '' }
  return messageFrame(title, errorBody(value), isRetryable(value) ? TEXT.retryFooter : TEXT.backFooter)
}

// ---------------------------------------------------------------------------
// Home and publications

export interface HomeEntry {
  id: 'continue' | HomeItemId
  label: string
}

/** lastOpen exists and was not finished (an end-card position means finished). */
export function canContinue(state: AppState): boolean {
  const last = state.lastOpen
  if (!last) return false
  const position = positionOf(state, last.postId)
  return !position || position.page < position.pages
}

/** No publications and nothing saved: the glasses explain the phone setup. */
export function isFirstRun(state: AppState): boolean {
  return state.publications.length === 0 && state.saved.length === 0
}

export function homeEntries(state: AppState): HomeEntry[] {
  const entries: HomeEntry[] = []
  if (canContinue(state) && state.lastOpen) entries.push({ id: 'continue', label: `Continue: ${state.lastOpen.title}` })
  for (const id of state.settings.homeItems) {
    const label = id === 'latest' ? 'Latest'
      : id === 'publications' ? `Publications (${state.publications.length})`
        : id === 'saved' ? `Saved (${state.saved.length})`
          : 'History'
    entries.push({ id, label })
  }
  return entries
}

export function homeFrame(state: AppState, selection: number): GlassesPage {
  const labels = homeEntries(state).map(entry => entry.label)
  return { title: APP_NAME, body: fitBody(menuBody(labels, clampIndex(selection, labels.length))), footer: TEXT.homeFooter }
}

export function firstRunFrame(): GlassesPage {
  return messageFrame(APP_NAME, TEXT.firstRun, TEXT.exitFooter)
}

export function notConfiguredFrame(): GlassesPage {
  return messageFrame(APP_NAME, TEXT.notConfigured, TEXT.exitFooter)
}

export function publicationsFrame(state: AppState, selection: number): GlassesPage {
  const publications = state.publications
  if (!publications.length) return messageFrame('Publications', TEXT.noPublications, TEXT.backFooter)
  const sel = clampIndex(selection, publications.length)
  return {
    title: 'Publications',
    body: fitBody(menuBody(publications.map(item => item.name), sel)),
    footer: `${sel + 1}/${publications.length}${DOT}Tap open${DOT}2${TIMES}tap back`,
  }
}

/** Publications that feed Latest, in list order, capped by the setting. */
export function latestPublications(state: AppState): Publication[] {
  return state.publications.filter(item => item.inLatest).slice(0, state.settings.latestMaxPublications)
}

// ---------------------------------------------------------------------------
// Posts lists

export function sourceTitle(source: PostSource): string {
  if (source === 'latest') return 'Latest'
  if (source === 'saved') return 'Saved'
  if (source === 'history') return 'History'
  return source.name || source.host
}

/** Rows of a posts list: every item plus the "Load older posts..." row while an offset is known. */
export function postsRowCount(view: Pick<PostsView, 'items' | 'nextOffset'>): number {
  return view.items.length + (view.nextOffset !== null ? 1 : 0)
}

/** `Pub, 2d, 12 min, Paid, 34%` joined by middle dots (the publication is omitted inside its own list). */
export function postMeta(item: PostRef, source: PostSource, state: AppState, now: number): string {
  const parts: string[] = []
  if (typeof source === 'string' && item.pubName) parts.push(item.pubName)
  const age = relativeDate(item.postDate, now)
  if (age) parts.push(age)
  if (item.wordcount !== null && item.wordcount > 0) parts.push(`${minutesFor(item.wordcount)} min`)
  if (item.isPaywalled) parts.push('Paid')
  const position = positionOf(state, item.postId)
  if (position && position.page < position.pages) parts.push(pctString((position.page + 1) / position.pages))
  else if (isRead(state, item.postId)) parts.push('Read')
  return parts.join(DOT)
}

function emptyPostsBody(source: PostSource, state: AppState): string {
  if (source === 'saved') return TEXT.noSaved
  if (source === 'history') return TEXT.noHistory
  if (source === 'latest' && !latestPublications(state).length) return TEXT.noLatest
  return TEXT.noPosts
}

export function postsFrame(view: PostsView, state: AppState, now: number): GlassesPage {
  const title = sourceTitle(view.source)
  if (view.state === 'loading') return loadingFrame(title)
  if (view.state === 'error') return errorFrame(title, view.error)
  const rows = postsRowCount(view)
  if (!rows) return messageFrame(title, emptyPostsBody(view.source, state), TEXT.backFooter)
  const sel = clampIndex(view.sel, rows)
  const { first, last } = menuWindow(rows, sel, POSTS_PER_SCREEN)
  const lines: string[] = []
  for (let index = first; index <= last; index += 1) {
    const marker = index === sel ? CURSOR : INDENT
    const item = view.items[index]
    if (!item) {
      lines.push(truncateGlassesLabel(`${marker}${TEXT.loadOlder}`))
      continue
    }
    lines.push(truncateGlassesLabel(`${marker}${item.title}`))
    lines.push(truncateGlassesLabel(`${INDENT}${postMeta(item, view.source, state, now)}`))
  }
  const failed = view.failed ? `${DOT}${view.failed} failed` : ''
  const verb = sel >= view.items.length ? 'Tap load' : 'Tap read'
  return { title, body: fitBody(lines.join('\n')), footer: `${sel + 1}/${rows}${DOT}${verb}${DOT}2${TIMES}tap back${failed}` }
}

// ---------------------------------------------------------------------------
// Reader

export function readerTitle(view: Pick<ReaderView, 'ref' | 'article'>): string {
  const title = view.article?.title || view.ref.title
  const pub = view.article?.pubName || view.ref.pubName
  return pub ? `${pub}${DOT}${title}` : title
}

/** Words from the start of page `page` to the end, scaled from the article word count. */
export function remainingWords(view: Pick<ReaderView, 'pages' | 'page' | 'article'>): number | null {
  const article = view.article
  const page = view.pages[view.page]
  if (!article || !page || !article.text.length) return null
  return article.wordCount * Math.max(0, article.text.length - page.start) / article.text.length
}

export function readerFrame(view: ReaderView): GlassesPage {
  const title = readerTitle(view)
  if (view.state === 'loading') return loadingFrame(title)
  if (view.state === 'error') return errorFrame(title, view.error)
  const total = view.pages.length
  if (view.page >= total) {
    const paid = view.article ? view.article.paywalled : view.ref.isPaywalled
    return messageFrame(title, paid ? TEXT.endPaid : TEXT.endFree, `End${DOT}${total}/${total}`)
  }
  const page = view.pages[view.page]!
  const words = remainingWords(view)
  const left = words === null ? '' : `${DOT}~${minutesFor(words)} min left`
  return {
    title,
    body: fitBody(page.text),
    footer: `${view.page + 1}/${total}${DOT}${pctString((view.page + 1) / total)}${left}`,
  }
}

// ---------------------------------------------------------------------------

export interface FrameOptions {
  now: number
  relayConfigured: boolean
}

/** The frame for the top of the glasses stack. */
export function frameFor(view: GlassesView, state: AppState, options: FrameOptions): GlassesPage {
  switch (view.kind) {
    case 'home':
      if (!options.relayConfigured) return notConfiguredFrame()
      if (isFirstRun(state)) return firstRunFrame()
      return homeFrame(state, view.sel)
    case 'publications':
      return publicationsFrame(state, view.sel)
    case 'posts':
      return postsFrame(view, state, options.now)
    case 'reader':
      return readerFrame(view)
  }
}

export function clampIndex(value: number, count: number): number {
  if (count <= 0) return 0
  return Number.isInteger(value) ? Math.min(count - 1, Math.max(0, value)) : 0
}
