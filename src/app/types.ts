/**
 * App-level state shared by storage, controller, frames and the phone UI.
 * Type-only imports keep this module free of runtime dependencies.
 */
import type { TextPage } from '../pagination'

export type HomeItemId = 'latest' | 'publications' | 'saved' | 'history'
/** Every Home item the phone may enable, in default display order. */
export const HOME_ITEM_IDS: readonly HomeItemId[] = ['latest', 'publications', 'saved', 'history']

export type LinesPerPage = 5 | 6 | 7

export interface Settings {
  linesPerPage: LinesPerPage               // default 7
  tapInReader: 'next' | 'none'             // default 'next'
  invertSwipe: boolean                     // default false
  bareImages: 'drop' | 'placeholder'       // default 'drop' (captioned images are always shown)
  footnotes: 'end' | 'inline' | 'omit'     // default 'end'
  uppercaseHeadings: boolean               // default true
  stripEmoji: boolean                      // default false
  homeItems: HomeItemId[]                  // default ['latest', 'publications', 'saved']; unique, non-empty
  latestMaxPublications: number            // default 10, integer 1..20
}

export const LATEST_MAX_PUBLICATIONS_RANGE = { min: 1, max: 20 } as const

/** A fresh, mutable copy of the defaults (never share the homeItems array). */
export function defaultSettings(): Settings {
  return {
    linesPerPage: 7,
    tapInReader: 'next',
    invertSwipe: false,
    bareImages: 'drop',
    footnotes: 'end',
    uppercaseHeadings: true,
    stripEmoji: false,
    homeItems: ['latest', 'publications', 'saved'],
    latestMaxPublications: 10,
  }
}

/** Frozen defaults for comparisons and display. Use defaultSettings() to get a mutable copy. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  ...defaultSettings(),
  homeItems: Object.freeze(defaultSettings().homeItems) as HomeItemId[],
})

/** A followed publication (ordered list on the phone). */
export interface Publication {
  id: number | null
  name: string
  host: string
  addedAt: number
  /** Included in the merged Latest list. */
  inLatest: boolean
}

/** A post pointer kept in Saved, History and lastOpen. Never holds article text. */
export interface PostRef {
  /** Substack post id; negative synthetic ids come from the RSS fallback. */
  postId: number
  host: string
  slug: string
  title: string
  pubName: string
  postDate: string
  isPaywalled: boolean
  wordcount: number | null
  addedAt: number
}

/** Reading position of one post. */
export interface Position {
  postId: number
  /** UTF-16 offset into the normalized article text (TextPage.start of the shown page). */
  offset: number
  /** 0..1, used when `version` no longer matches. */
  fraction: number
  page: number
  pages: number
  /** `${CONVERTER_VERSION}.${PAGINATION_VERSION}.${linesPerPage}` */
  version: string
  updatedAt: number
}

/**
 * The converted article kept in memory only (a 10-entry LRU in the
 * controller). Structurally identical to src/substack/article.ts `Article`.
 */
export interface Article {
  postId: number
  title: string
  pubName: string
  text: string
  wordCount: number
  paywalled: boolean
  isPodcast: boolean
  version: string
}

/** Storage limits (SPEC section 3.5). */
export const LIMITS = {
  publications: 100,
  saved: 100,
  positions: 150,
  history: 50,
  read: 500,
} as const

export const SCHEMA_VERSION = 1

/** Serialized under KEYS.prefs ('sr:prefs:v1'). */
export interface PrefsDoc {
  schemaVersion: 1
  savedAt: number
  publications: Publication[]
  saved: PostRef[]
  settings: Settings
}

/** Serialized under KEYS.progress ('sr:progress:v1'). */
export interface ProgressDoc {
  schemaVersion: 1
  savedAt: number
  /** Most recently updated first (LRU eviction from the end). */
  positions: Position[]
  /** Most recently opened first. */
  history: PostRef[]
  /** Post ids, most recent first. */
  read: number[]
  lastOpen: PostRef | null
}

/** In-memory application state (the union of both documents, minus envelope fields). */
export interface AppState {
  publications: Publication[]
  saved: PostRef[]
  settings: Settings
  positions: Position[]
  history: PostRef[]
  read: number[]
  lastOpen: PostRef | null
}

export function emptyState(): AppState {
  return { publications: [], saved: [], settings: defaultSettings(), positions: [], history: [], read: [], lastOpen: null }
}

export type LoadState = 'loading' | 'ready' | 'error'

/** Error shown on the glasses (frames map `code`) and detailed on the phone. */
export interface ViewError {
  code: string
  message: string
  retryAfterSeconds?: number
}

export type PostSource = 'latest' | 'saved' | 'history' | { host: string; name?: string }

export type GlassesView =
  | { kind: 'home'; sel: number }
  | { kind: 'publications'; sel: number }
  | {
      kind: 'posts'
      source: PostSource
      sel: number
      items: PostRef[]
      /** Archive offset for "Load older posts..."; null when there is no such row. */
      nextOffset: number | null
      state: LoadState
      error?: ViewError | null
      /** Latest only: publications whose archive failed to load. */
      failed?: number
    }
  | {
      kind: 'reader'
      ref: PostRef
      pages: TextPage[]
      /** pages.length means the end card. */
      page: number
      article?: Article
      state: LoadState
      error?: ViewError | null
    }

export type GlassesViewKind = GlassesView['kind']
