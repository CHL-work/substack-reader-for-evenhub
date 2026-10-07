import { getAdvW } from '@evenrealities/pretext'
import type { Article, Settings } from '../app/types'
import { CONVERTER_VERSION, htmlToReaderText, normalizeChars, type HtmlToReaderTextOptions, type ReaderTextResult } from './html'
import { isPaywalledAudience, type PostDetail, type PubMeta } from './types'

/**
 * PostDetail -> the in-memory Article read on the glasses (SPEC section 3.9):
 * a header block (title, subtitle, byline line, paid/podcast notes), a blank
 * line, then the converted body. Never persisted (article text is not stored).
 */
export type { Article } from '../app/types'

export type Converter = (html: string | null | undefined, opts?: HtmlToReaderTextOptions) => ReaderTextResult

export const WORDS_PER_MINUTE = 230
export const PAID_PREVIEW_HEADER = '[Paid post \u00B7 free preview only]'
export const PODCAST_HEADER = '[Podcast episode \u00B7 audio is not available on glasses]'
export const EMPTY_BODY_NOTE = '[This post has no text to show.]'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const coverage = new Map<number, boolean>()

/** True when the firmware fonts have a glyph for `cp` (pretext metrics, memoized). */
export function isCovered(cp: number): boolean {
  let covered = coverage.get(cp)
  if (covered === undefined) {
    covered = getAdvW(cp) > 0
    coverage.set(cp, covered)
  }
  return covered
}

/** `max(1, round(words / 230))`. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round((Number.isFinite(words) ? Math.max(0, words) : 0) / WORDS_PER_MINUTE))
}

/** 'Mar 5, 2026' in the phone's local time zone; '' for an unparsable date. */
export function formatPostDate(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

/**
 * Identifies the converter plus every setting that changes the article text,
 * so a stored offset is only reused for the same text (Position.version is
 * `${article.version}.${PAGINATION_VERSION}.${linesPerPage}`).
 */
export function articleVersion(settings: Settings): string {
  return `${CONVERTER_VERSION}-${settings.footnotes}-${settings.bareImages}-${settings.uppercaseHeadings ? 1 : 0}${settings.stripEmoji ? 1 : 0}`
}

/** True when the shown body may be only a preview (C11: any audience other than 'everyone'). */
export function isGated(post: PostDetail): boolean {
  return post.isPaywalled || post.truncated || isPaywalledAudience(post.audience)
}

/** Options for htmlToReaderText from the post and the reader settings. */
export function converterOptions(post: PostDetail, settings: Settings): HtmlToReaderTextOptions {
  return {
    audience: isGated(post) ? (isPaywalledAudience(post.audience) ? post.audience : 'only_paid') : 'everyone',
    expectedWordCount: post.wordcount,
    footnoteMode: settings.footnotes,
    bareImages: settings.bareImages,
    uppercaseHeadingMax: settings.uppercaseHeadings ? 60 : 0,
    isCovered,
    stripEmoji: settings.stripEmoji,
  }
}

/** One display line: glyph-normalized, whitespace collapsed. */
function line(value: string | null | undefined, settings: Settings): string {
  return normalizeChars(value ?? '', isCovered, settings.stripEmoji).replace(/\s+/g, ' ').trim()
}

/**
 * The header block (no trailing newline). The title wraps freely and is not
 * upper-cased. `words` is Substack's full-post count when known.
 */
export function articleHeader(post: PostDetail, settings: Settings, words: number, paywalled: boolean): string {
  const lines = [line(post.title, settings) || 'Untitled']
  const subtitle = line(post.subtitle, settings)
  if (subtitle) lines.push(subtitle)
  const authors = post.authors.map(name => line(name, settings)).filter(Boolean)
  lines.push([
    authors.length ? `By ${authors.join(', ')}` : '',
    formatPostDate(post.postDate),
    `${readingMinutes(words)} min read`,
  ].filter(Boolean).join(' \u00B7 '))
  if (paywalled) lines.push(PAID_PREVIEW_HEADER)
  if (post.type === 'podcast') lines.push(PODCAST_HEADER)
  return lines.join('\n')
}

export function buildArticle(post: PostDetail, pub: PubMeta | null, settings: Settings, convert: Converter = htmlToReaderText): Article {
  const result = convert(post.bodyHtml, converterOptions(post, settings))
  const paywalled = result.paywalled || isGated(post)
  const words = post.wordcount !== null && post.wordcount > 0 ? post.wordcount : result.wordCount
  const body = result.text.trim() || EMPTY_BODY_NOTE
  return {
    postId: post.id,
    title: line(post.title, settings) || 'Untitled',
    pubName: line(pub?.name, settings) || pub?.host || '',
    text: `${articleHeader(post, settings, words, paywalled)}\n\n${body}`,
    wordCount: result.wordCount,
    paywalled,
    isPodcast: post.type === 'podcast',
    version: articleVersion(settings),
  }
}
