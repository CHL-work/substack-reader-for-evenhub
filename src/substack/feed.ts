/**
 * RSS fallback (SPEC section 3.10): relay /v1/feed XML -> parseFeed, or the
 * optional rss2json JSON -> parseRss2Json. The XML goes into an inert
 * DOMParser document and only strings come out: no parsed node is ever
 * adopted, imported or appended into the live DOM, and the item HTML is
 * returned as a string for html.ts (kept in memory only, never stored).
 */
import { ApiError } from './api'
import { isPaywalledAudience, type PostSummary } from './types'
import { SLUG_RE } from './urls'

export interface FeedResult {
  /** Feed order (newest first), deduped by slug; ids are synthetic (negative). */
  posts: PostSummary[]
  /** slug -> item HTML (`content:encoded` / rss2json `content`). */
  bodies: Map<string, string>
  /** Channel title, or null. */
  title: string | null
}

/** Feed items carry no audience; a "Read more" tail marks a paid preview. */
export const FEED_PAID_AUDIENCE = 'only_paid'
export const FEED_FREE_AUDIENCE = 'everyone'
export const FEED_MAX_ITEMS = 100

const NS_DC = 'http://purl.org/dc/elements/1.1/'
const NS_CONTENT = 'http://purl.org/rss/1.0/modules/content/'
const NS_ITUNES = 'http://www.itunes.com/dtds/podcast-1.0.dtd'

/** Substack's paid-preview tail: <p><a href="{link}">Read more</a></p> at the very end (whitespace-padded). */
const READ_MORE_TAIL_RE = /<p(?:\s[^>]*)?>\s*<a\s+(?:[^>]*?\s)?href\s*=\s*(["'])([^"']*)\1[^>]*>\s*Read more\s*<\/a>\s*<\/p>\s*$/i
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '\u{2026}', mdash: '\u{2014}', ndash: '\u{2013}',
  lsquo: '\u{2018}', rsquo: '\u{2019}', ldquo: '\u{201c}', rdquo: '\u{201d}',
}

interface RawItem {
  title: string
  link: string
  pubDate: string
  authors: string[]
  description: string
  html: string
  audio: boolean
  durationSec: number | null
}

function invalidFeed(): ApiError {
  return new ApiError('UPSTREAM_INVALID', 'The feed could not be read.')
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? match
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match
    return String.fromCodePoint(cp)
  })
}

/**
 * Plain single-line text from a feed string (Substack escapes some text
 * inside CDATA): entities decoded, control characters and whitespace runs
 * collapsed to one space, trimmed and capped.
 */
function plain(value: string, limit: number): string {
  return decodeEntities(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/** Like plain(), after dropping tags (rss2json descriptions may carry HTML). */
function plainFromHtml(value: string, limit: number): string {
  return plain(value.replace(/<[^>]*>/g, ' '), limit)
}

/** cyrb53: a deterministic 53-bit string hash (always a safe integer). */
function hash53(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** Feed items have no Substack id: a stable negative id from `host/slug`. */
export function syntheticPostId(host: string, slug: string): number {
  return -(hash53(`${host.trim().toLowerCase()}/${slug}`) || 1)
}

/** `/p/<slug>` of an http(s) item link, or null. */
export function slugFromLink(link: string): string | null {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const match = /^\/p\/([^/]+)\/?$/.exec(url.pathname)
  return match && SLUG_RE.test(match[1]!) ? match[1]! : null
}

function samePost(href: string, link: string): boolean {
  const a = href.trim().replace(/&amp;/g, '&')
  const b = link.trim()
  if (a === b) return true
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.hostname === y.hostname && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '')
  } catch {
    return false
  }
}

/** True when `html` ends with Substack's paid-preview "Read more" paragraph pointing at `link`. */
export function hasReadMoreTail(html: string, link: string): boolean {
  const match = READ_MORE_TAIL_RE.exec(html)
  return match !== null && samePost(match[2]!, link)
}

/** RFC 822 (RSS) or `YYYY-MM-DD HH:MM:SS` UTC (rss2json) -> ISO 8601, or ''. */
function isoDate(value: string): string {
  const text = value.trim()
  const utc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(text)
  const time = utc ? Date.parse(`${utc[1]}T${utc[2]}Z`) : Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

/** itunes:duration as seconds: `SSSS`, `MM:SS` or `HH:MM:SS`. */
function durationSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  if (typeof value !== 'string' || !/^\d{1,7}(?::\d{1,2}){0,2}$/.test(value.trim())) return null
  return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function buildResult(items: RawItem[], host: string, title: string | null): FeedResult {
  const cleanHost = host.trim().toLowerCase()
  const posts: PostSummary[] = []
  const bodies = new Map<string, string>()
  for (const item of items) {
    const slug = slugFromLink(item.link)
    if (!slug || bodies.has(slug)) continue
    const audience = hasReadMoreTail(item.html, item.link) ? FEED_PAID_AUDIENCE : FEED_FREE_AUDIENCE
    const link = item.link.trim()
    posts.push({
      id: syntheticPostId(cleanHost, slug),
      publicationId: null,
      slug,
      title: plain(item.title, 500) || 'Untitled post',
      subtitle: plainFromHtml(item.description, 1000) || null,
      postDate: isoDate(item.pubDate),
      audience,
      isPaywalled: isPaywalledAudience(audience),
      type: item.audio ? 'podcast' : 'newsletter',
      wordcount: null,
      canonicalUrl: /^https:\/\//i.test(link) ? link : `https://${cleanHost}/p/${slug}`,
      authors: item.authors.map(name => plain(name, 200)).filter(Boolean).slice(0, 5),
      podcastDurationSec: item.audio ? item.durationSec : null,
    })
    bodies.set(slug, item.html)
    if (posts.length >= FEED_MAX_ITEMS) break
  }
  return { posts, bodies, title }
}

/** Element children of `parent` named `localName`: unprefixed when `ns` is null, else in namespace `ns`. */
function childElements(parent: Element, localName: string, ns: string | null): Element[] {
  const out: Element[] = []
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.localName !== localName) continue
    if (ns === null ? !node.prefix : node.namespaceURI === ns) out.push(node)
  }
  return out
}

function childText(parent: Element, localName: string, ns: string | null): string {
  return childElements(parent, localName, ns)[0]?.textContent ?? ''
}

/** Parse Substack RSS (`/feed`) into post summaries and in-memory bodies. Throws ApiError UPSTREAM_INVALID. */
export function parseFeed(xml: string, host: string): FeedResult {
  if (typeof xml !== 'string' || !xml.trim()) throw invalidFeed()
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw invalidFeed()
  const root = doc.documentElement
  const channel = root && root.localName === 'rss' ? childElements(root, 'channel', null)[0] : undefined
  if (!channel) throw invalidFeed()
  const items = childElements(channel, 'item', null).map((item): RawItem => {
    const enclosure = childElements(item, 'enclosure', null)[0]
    return {
      title: childText(item, 'title', null),
      link: childText(item, 'link', null),
      pubDate: childText(item, 'pubDate', null),
      authors: childElements(item, 'creator', NS_DC).map(node => node.textContent ?? ''),
      description: childText(item, 'description', null),
      html: childText(item, 'encoded', NS_CONTENT),
      audio: /^audio\//i.test(enclosure?.getAttribute('type') ?? ''),
      durationSec: durationSeconds(childText(item, 'duration', NS_ITUNES)),
    }
  })
  return buildResult(items, host, plain(childText(channel, 'title', null), 200) || null)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Parse an rss2json response ({status, feed, items:[{title, pubDate, link,
 * author, description, content, enclosure}]}) like parseFeed. Pure (no
 * DOMParser). Throws ApiError UPSTREAM_ERROR / UPSTREAM_INVALID.
 */
export function parseRss2Json(json: unknown, host: string): FeedResult {
  const root = record(json)
  if (root.status !== undefined && root.status !== 'ok') {
    throw new ApiError('UPSTREAM_ERROR', plain(str(root.message), 300) || 'The feed service reported an error.')
  }
  if (!Array.isArray(root.items)) throw invalidFeed()
  const items = root.items.map((value): RawItem => {
    const item = record(value)
    const enclosure = record(item.enclosure)
    const author = str(item.author)
    return {
      title: str(item.title),
      link: str(item.link),
      pubDate: str(item.pubDate),
      authors: author ? [author] : [],
      description: str(item.description),
      html: str(item.content),
      audio: /^audio\//i.test(str(enclosure.type)),
      durationSec: durationSeconds(enclosure.duration),
    }
  })
  return buildResult(items, host, plain(str(record(root.feed).title), 200) || null)
}
