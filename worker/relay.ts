/**
 * Reader for Substack relay, protocol 1 (SPEC section 6, corrections C1-C4, C11).
 *
 * A stateless, GET-only proxy for public Substack JSON and RSS. One ESM module whose
 * default export `{ fetch(request, env, ctx) }` runs unchanged on Cloudflare Workers,
 * OpenAI Sites and in Node tests: `env.RL` and `globalThis.caches` are optional.
 *
 * Security rules (never relax them): callers never supply URLs; every upstream host is
 * allowlisted (a single-label *.substack.com host, substack.com for three fixed
 * templates only, or a verified custom domain) on the first request and on every
 * redirect; every upstream response must carry Substack's fingerprint header; honest
 * User-Agent, no cookies, no request logging, nothing stored except a short edge cache;
 * nothing the relay returns can run on its origin (sandbox CSP, the feed as text/plain).
 */
import { version } from '../package.json'
import {
  ARCHIVE_PAGE_SIZE,
  PUBLIC_HOST_RE,
  RELAY_MAX_ARCHIVE_LIMIT,
  RELAY_MAX_ARCHIVE_OFFSET,
  RELAY_PROTOCOL,
  SUBSTACK_SUBDOMAIN_HOST_RE,
  hostOfPublication,
  isPaywalledAudience,
  type ArchivePage,
  type HealthProbe,
  type HealthResponse,
  type PostDetail,
  type PostResponse,
  type PostSummary,
  type Profile,
  type PubMeta,
  type RelayError,
  type RelayErrorCode,
  type RelayUpstreamInfo,
  type SearchResponse,
  type UpstreamContentType,
} from '../src/substack/types'
import { landingPage, privacyPage } from './landing'
import { parsePublicPost, parseSitemapSlugs } from './public-pages'

/* ------------------------------------------------------------------ runtime contracts */

/** Cloudflare rate-limit binding (wrangler.toml [[ratelimits]] name = "RL"). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  RL?: RateLimitBinding
  /** Strict budget for costly work: custom-domain mapping proofs and health probes (wrangler.toml RL_STRICT). */
  RL_STRICT?: RateLimitBinding
  /** Optional deploy revision (e.g. a git sha) reported by /v1/health. */
  REVISION?: string
  /** Set to "0" to keep automatic archive failures available for the client's RSS recovery. */
  PUBLIC_ARCHIVE_FALLBACK?: string
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void
}

/** The subset of the Workers Cache API the relay uses (caches.default). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

export interface RelayOptions {
  /** Clock for rate limits, verdict expiry, fetchedAt and probe timings. */
  now?: () => number
  /** Upstream fetch; defaults to globalThis.fetch looked up on every call. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Edge cache; undefined = caches.default when present, null = no cache. */
  cache?: CacheLike | null
  /** Per upstream call (all redirect hops and the body), default 10 s. */
  timeoutMs?: number
  /** Local token bucket size per client key and route, default 60 per minute. */
  rateLimitPerMinute?: number
  /** Local bucket for mapping proofs and health probes per client key, default 10 per minute. */
  strictRateLimitPerMinute?: number
}

export interface Relay {
  fetch(request: Request, env?: Env, ctx?: Ctx): Promise<Response>
}

/* ------------------------------------------------------------------ constants */

/** C2: exactly `SubstackReaderForEvenHub/<version>`; a URL in the UA empties Substack search results. */
export const USER_AGENT = `SubstackReaderForEvenHub/${version}`
export const SERVICE = 'substack-reader-relay' as const
export const CUSTOM_DOMAIN_TARGET = 'target.substack-custom-domains.com.'
export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
/**
 * Synthetic cache key path under the relay's own request origin (S4: one deployment never reads
 * another's entries); bump the protocol segment when trimmed shapes change.
 */
export const CACHE_PATH = `/__relay-cache/p${RELAY_PROTOCOL}`
/** S1: every non-HTML response is inert if a browser ever renders it; fetch() callers ignore it. */
export const SANDBOX_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'"

const MIB = 1024 * 1024
const ARCHIVE_CAP = MIB
const POST_CAP = 4 * MIB
const PROFILE_CAP = MIB
const SEARCH_CAP = 2 * MIB
const FEED_CAP = 4 * MIB
const PUBLIC_ARCHIVE_PAGE_SIZE = 4
const DOH_CAP = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const MAX_RETRY_AFTER = 86_400
const MINUTE_MS = 60_000
const RATE_LIMIT_PER_MINUTE = 60
const STRICT_RATE_LIMIT_PER_MINUTE = 10
const BINDING_RETRY_AFTER = 60
const MAX_BUCKETS = 10_000
const MAX_VERDICTS = 2_000
const VERDICT_PASS_MS = 24 * 3_600_000
const VERDICT_FAIL_MS = 3_600_000
/**
 * S3, Y3: nothing serves the host (no addresses; or definitive DNS and no HTTPS answer: refused,
 * TLS error, Cloudflare 530); short, so a new domain recovers quickly.
 */
const VERDICT_NO_SERVER_MS = 600_000
/** S6: an inconclusive check is remembered in memory only, briefly. */
const VERDICT_UNKNOWN_MS = 60_000
/** Y1: the host refused the proof without Substack's fingerprint; not Substack, but kept as briefly as 'unknown'. */
const VERDICT_REFUSED_MS = VERDICT_UNKNOWN_MS
const TARGET_IPS_MS = 3_600_000
/** S2: at most one round of health probes per isolate per minute. */
const PROBE_MEMO_MS = 60_000
/** Rate-limit key for every client when the client address cannot be trusted (S7). */
const SHARED_CLIENT = 'shared'
const MAX_AUTHORS = 5
const MAX_SEARCH_RESULTS = 20
const MAX_SUBSCRIPTIONS = 500

const ACCEPT_JSON = 'application/json'
const ACCEPT_FEED = 'application/rss+xml, application/xml;q=0.9'
const ACCEPT_HTML = 'text/html'
const ACCEPT_DOH = 'application/dns-json'
const JSON_TYPE = 'application/json; charset=utf-8'
/** S1: feed XML goes out as text, so a browser never renders upstream markup on the relay origin. */
const FEED_TYPE = 'text/plain; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
const CACHED_FALSE = '"cached":false'
const CACHED_TRUE = '"cached":true'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const BLOCKED_TLD_RE = /\.(localhost|local|internal|test|invalid|example|onion|arpa)$/
/** substack.com itself and its app hosts are never publications. */
const RESERVED_HOSTS = new Set(['substack.com', 'www.substack.com', 'open.substack.com'])
const SUBSTACK_COM = 'substack.com'
const LABEL_RE = /^[a-z0-9-]{1,63}$/
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,199}$/i
/** First character is never '.', so a handle can never be a '.' or '..' path segment. */
const HANDLE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const ID_RE = /^[1-9]\d{0,9}$/
/** C3: Substack's by-id endpoint takes a signed 32-bit id and answers 400 above it. */
const MAX_POST_ID = 2_147_483_647
/**
 * S1 defense in depth: the document element is <rss>, preceded only by an XML declaration,
 * comments and whitespace (so no xml-stylesheet instruction and no DOCTYPE). Comments cannot
 * contain '-->', so the scan is linear.
 */
const RSS_ROOT_RE = /^\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--(?:(?!-->)[\s\S])*-->\s*)*<rss[\s>]/
const HEXTET_RE = /^[0-9a-f]{1,4}$/
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/
const FEED_TYPE_RE = /^(application\/(rss\+)?xml|text\/xml)$/
const JSON_SUFFIX_RE = /^application\/[a-z0-9!#$&^_.+-]+\+json$/
const XML_LIKE_RE = /^(application\/(rss\+|atom\+)?xml|text\/xml)$/
const HTTP_DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

const TTL = {
  archive: { edge: 300, client: 60 },
  post: { edge: 900, client: 300 },
  profile: { edge: 3600, client: 600 },
  search: { edge: 3600, client: 600 },
  feed: { edge: 600, client: 120 },
} as const
const NOT_FOUND_EDGE_TTL = 60
const PAGE_TTL = 3600

const HEALTH_PROBES: ReadonlyArray<readonly [HealthProbe['target'], string]> = [
  ['subdomain', 'https://on.substack.com/api/v1/archive?sort=new&offset=0&limit=1'],
  ['customDomain', 'https://www.slowboring.com/api/v1/archive?sort=new&offset=0&limit=1'],
  ['substackCom', 'https://substack.com/api/v1/top/search?query=substack'],
]

/** On every response; the HTML pages replace the CSP with PAGE_CSP. */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': SANDBOX_CSP,
}

const ERRORS: Readonly<Record<RelayErrorCode, readonly [number, string]>> = {
  INVALID_HOST: [400, 'Enter a publication address such as name.substack.com or its own domain.'],
  INVALID_SLUG: [400, 'This post address is not valid.'],
  INVALID_HANDLE: [400, 'This Substack handle is not valid.'],
  INVALID_QUERY: [400, 'Search needs 2 to 100 characters.'],
  INVALID_PARAM: [400, 'A request parameter is not valid.'],
  HOST_NOT_SUBSTACK: [403, 'This address is not served by Substack.'],
  NOT_FOUND: [404, 'Not found.'],
  PUBLICATION_NOT_FOUND: [404, 'Substack has no publication at this address.'],
  POST_NOT_FOUND: [404, 'This post was not found.'],
  PROFILE_NOT_FOUND: [404, 'This Substack profile was not found.'],
  METHOD_NOT_ALLOWED: [405, 'Only GET is supported.'],
  RATE_LIMITED: [429, 'Too many requests. Try again shortly.'],
  UPSTREAM_INVALID: [502, 'Substack returned a response the relay cannot read.'],
  UPSTREAM_TOO_LARGE: [502, 'The Substack response is too large.'],
  UPSTREAM_ERROR: [502, 'Substack could not complete this request.'],
  TOO_MANY_REDIRECTS: [502, 'Substack redirected too many times.'],
  REDIRECT_NOT_ALLOWED: [502, 'Substack redirected to an address the relay does not follow.'],
  UPSTREAM_BLOCKED: [503, 'Substack refused the relay connection.'],
  UPSTREAM_RATE_LIMITED: [503, 'Substack is limiting requests from the relay.'],
  UPSTREAM_UNAVAILABLE: [503, 'Substack is temporarily unavailable.'],
  UPSTREAM_TIMEOUT: [504, 'Substack did not answer in time.'],
  INTERNAL_ERROR: [500, 'The relay hit an unexpected error.'],
}

/* ------------------------------------------------------------------ errors and responses */

interface FailureExtra {
  retryAfterSeconds?: number
  upstream?: RelayUpstreamInfo
}

class RelayFailure extends Error {
  readonly status: number

  constructor(readonly code: RelayErrorCode, readonly extra: FailureExtra = {}) {
    super(ERRORS[code][1])
    this.status = ERRORS[code][0]
  }
}

function responseHeaders(contentType: string, cacheControl: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ ...COMMON_HEADERS, 'Content-Type': contentType, 'Cache-Control': cacheControl, ...extra })
}

function errorJson(failure: RelayFailure): string {
  const error: RelayError = { code: failure.code, message: failure.message }
  if (failure.extra.retryAfterSeconds !== undefined) error.retryAfterSeconds = failure.extra.retryAfterSeconds
  if (failure.extra.upstream) error.upstream = failure.extra.upstream
  return JSON.stringify({ ok: false, error })
}

function errorResponse(failure: RelayFailure): Response {
  const extra: Record<string, string> = {}
  if (failure.extra.retryAfterSeconds !== undefined) extra['Retry-After'] = String(failure.extra.retryAfterSeconds)
  if (failure.code === 'METHOD_NOT_ALLOWED') extra.Allow = 'GET, OPTIONS'
  return new Response(errorJson(failure), { status: failure.status, headers: responseHeaders(JSON_TYPE, 'no-store', extra) })
}

/** `meta` precedes `data` so the first `"cached":false` is always meta's (see replay). */
function okJson(data: unknown, host: string, fetchedAt: string): string {
  return JSON.stringify({ ok: true, meta: { host, cached: false, fetchedAt }, data })
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: responseHeaders(HTML_TYPE, `public, max-age=${PAGE_TTL}`, { 'Content-Security-Policy': PAGE_CSP }),
  })
}

/* ------------------------------------------------------------------ defensive readers */

type Json = Record<string, unknown>

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

/** A host the relay may fetch publication data from (syntax only, no DNS). */
function isPublicationHost(host: string): boolean {
  return PUBLIC_HOST_RE.test(host) && !BLOCKED_TLD_RE.test(host) && !RESERVED_HOSTS.has(host)
}

function hostnameOf(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const host = raw.trim().toLowerCase().replace(/\.$/, '')
  return isPublicationHost(host) ? host : null
}

function hostFromBaseUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.port && !url.username && !url.password ? hostnameOf(url.hostname) : null
  } catch {
    return null
  }
}

function subdomainOf(value: unknown): string | null {
  const raw = text(value)?.trim().toLowerCase() ?? ''
  return LABEL_RE.test(raw) ? raw : null
}

function httpsUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ trimming */

/**
 * PubMeta from any upstream publication object. Host: base_url/hostname when present
 * (by-id, search posts), otherwise C3/hostOfPublication: the custom domain unless it is
 * optional, else `<subdomain>.substack.com`.
 */
function publicationMeta(value: unknown): PubMeta | null {
  const pub = record(value)
  if (!pub) return null
  const subdomain = subdomainOf(pub.subdomain)
  const optional = pub.custom_domain_optional === true
  const custom = hostnameOf(pub.custom_domain)
  const host = hostFromBaseUrl(pub.base_url)
    ?? hostnameOf(pub.hostname)
    ?? hostOfPublication({ subdomain, custom_domain: custom, custom_domain_optional: optional })
  if (!host || !isPublicationHost(host)) return null
  const name = (text(pub.name) ?? '').trim() || subdomain || host
  return { id: positiveInt(pub.id), name, subdomain, customDomain: custom && !optional ? custom : null, host }
}

/** PostSummary from an archive item or post object; null when id or slug is unusable. */
function postSummary(value: unknown, host: string | null): PostSummary | null {
  const post = record(value)
  if (!post) return null
  const id = positiveInt(post.id)
  const slug = text(post.slug)?.trim() ?? ''
  if (id === null || !slug || slug.length > 300) return null
  const audience = text(post.audience)?.trim() || 'unknown'
  const authors = list(post.publishedBylines)
    .map(byline => (text(record(byline)?.name) ?? '').trim())
    .filter(name => name.length > 0)
    .slice(0, MAX_AUTHORS)
  return {
    id,
    publicationId: positiveInt(post.publication_id),
    slug,
    title: (text(post.title) ?? '').trim(),
    subtitle: (text(post.subtitle) ?? '').trim() || null,
    postDate: text(post.post_date) ?? '',
    audience,
    isPaywalled: isPaywalledAudience(audience),
    type: text(post.type)?.trim() || 'newsletter',
    wordcount: nonNegativeInt(post.wordcount),
    canonicalUrl: httpsUrl(post.canonical_url)
      ?? (host ? `https://${host}/p/${encodeURIComponent(slug)}` : `https://substack.com/home/post/p-${id}`),
    authors,
    podcastDurationSec: seconds(post.podcast_duration),
  }
}

function postDetail(value: unknown, host: string | null): PostDetail | null {
  const summary = postSummary(value, host)
  if (!summary) return null
  const body = record(value)?.body_html
  return { ...summary, bodyHtml: typeof body === 'string' ? body : null, truncated: summary.isPaywalled }
}

/**
 * publishedBylines[].publicationUsers[].publication of any post in `posts` whose id === that
 * post's publication_id; otherwise (C2: staff and guest bylines often name no such publication)
 * the first one whose host is `host`, the host that served the posts.
 */
function bylinePublication(posts: unknown[], host: string | null): PubMeta | null {
  let byHost: PubMeta | null = null
  for (const value of posts) {
    const post = record(value)
    const publicationId = positiveInt(post?.publication_id)
    for (const byline of list(post?.publishedBylines)) {
      for (const membership of list(record(byline)?.publicationUsers)) {
        const pub = record(record(membership)?.publication)
        const idMatch = publicationId !== null && positiveInt(pub?.id) === publicationId
        if (!pub || (!idMatch && (byHost !== null || host === null))) continue
        const meta = publicationMeta(pub)
        if (meta && idMatch) return meta
        if (meta && meta.host === host) byHost = meta
      }
    }
  }
  return byHost
}

/** Dedupes by id and by host, keeping the first occurrence. */
function collectPublications(limit: number): { add(meta: PubMeta | null): void; items: PubMeta[] } {
  const items: PubMeta[] = []
  const ids = new Set<number>()
  const hosts = new Set<string>()
  return {
    items,
    add(meta) {
      if (!meta || items.length >= limit || hosts.has(meta.host) || (meta.id !== null && ids.has(meta.id))) return
      items.push(meta)
      hosts.add(meta.host)
      if (meta.id !== null) ids.add(meta.id)
    },
  }
}

/* ------------------------------------------------------------------ request plans */

interface Plan {
  route: 'archive' | 'post' | 'profile' | 'search' | 'feed'
  /** Requested upstream host (verified before the first fetch). */
  host: string
  allowSubstackCom: boolean
  href: string
  accept: string
  cap: number
  kind: 'json' | 'xml' | 'html'
  archive?: { offset: number; limit: number; sort: 'new' | 'top'; source?: 'sitemap' }
  publicPostSlug?: string
  ttl: { readonly edge: number; readonly client: number }
  /** > 0: cache upstream 404s at the edge for this many seconds. */
  notFoundEdgeTtl: number
  notFound(info: RelayUpstreamInfo): RelayErrorCode
  /** Path and query of the synthetic cache key (prefixed with the request's cache namespace). */
  cachePath(host: string): string
  shape(json: unknown, finalHost: string): { data: unknown; host: string }
}

function invalidShape(): never {
  throw new RelayFailure('UPSTREAM_INVALID')
}

function hostParam(raw: string | null): string {
  const host = (raw ?? '').toLowerCase()
  if (!isPublicationHost(host)) throw new RelayFailure('INVALID_HOST')
  return host
}

function integerParam(raw: string | null, fallback: number, min: number, max: number, mode: 'reject' | 'clamp'): number {
  if (raw === null || raw === '') return fallback
  if (!/^\d{1,9}$/.test(raw)) throw new RelayFailure('INVALID_PARAM')
  const value = Number(raw)
  if (value >= min && value <= max) return value
  if (mode === 'clamp') return Math.min(max, Math.max(min, value))
  throw new RelayFailure('INVALID_PARAM')
}

function archivePlan(params: URLSearchParams): Plan {
  const host = hostParam(params.get('host'))
  const offset = integerParam(params.get('offset'), 0, 0, RELAY_MAX_ARCHIVE_OFFSET, 'reject')
  // C1: Substack may return fewer posts than asked; the relay clamps limit to 1..20.
  const limit = integerParam(params.get('limit'), ARCHIVE_PAGE_SIZE, 1, RELAY_MAX_ARCHIVE_LIMIT, 'clamp')
  const rawSort = params.get('sort')
  if (rawSort !== null && rawSort !== '' && rawSort !== 'new' && rawSort !== 'top') throw new RelayFailure('INVALID_PARAM')
  const sort = rawSort === 'top' ? 'top' : 'new'
  const source = params.get('source')
  if (source !== null && source !== 'sitemap') throw new RelayFailure('INVALID_PARAM')
  if (source === 'sitemap' && sort !== 'new') throw new RelayFailure('INVALID_PARAM')
  return {
    route: 'archive',
    host,
    allowSubstackCom: false,
    href: `https://${host}/api/v1/archive?sort=${sort}&search=&offset=${offset}&limit=${limit}`,
    accept: ACCEPT_JSON,
    cap: ARCHIVE_CAP,
    kind: 'json',
    archive: { offset, limit, sort, ...(source === 'sitemap' ? { source } : {}) },
    ttl: TTL.archive,
    notFoundEdgeTtl: 0,
    notFound: () => 'PUBLICATION_NOT_FOUND',
    cachePath: h => `/v1/archive?host=${h}&offset=${offset}&limit=${limit}&sort=${sort}${source === 'sitemap' ? '&source=sitemap' : ''}`,
    shape(json, finalHost) {
      if (!Array.isArray(json)) invalidShape()
      const items: unknown[] = json
      const posts = items.flatMap(item => postSummary(item, finalHost) ?? [])
      const publication = bylinePublication(items, finalHost)
      // C1: only an empty upstream page ends the list. Count upstream items, not kept ones.
      const end = offset + items.length
      const page: ArchivePage = { publication, posts, nextOffset: items.length > 0 && end <= RELAY_MAX_ARCHIVE_OFFSET ? end : null }
      return { data: page, host: finalHost }
    },
  }
}

function postPlan(params: URLSearchParams): Plan {
  const rawId = params.get('id') ?? ''
  const rawHost = params.get('host') ?? ''
  const rawSlug = params.get('slug') ?? ''
  if (rawId) {
    if (rawHost || rawSlug || !ID_RE.test(rawId) || Number(rawId) > MAX_POST_ID) throw new RelayFailure('INVALID_PARAM')
    const id = Number(rawId)
    return {
      route: 'post',
      host: SUBSTACK_COM,
      allowSubstackCom: true,
      href: `https://substack.com/api/v1/posts/by-id/${id}`,
      accept: ACCEPT_JSON,
      cap: POST_CAP,
      kind: 'json',
      ttl: TTL.post,
      notFoundEdgeTtl: NOT_FOUND_EDGE_TTL,
      notFound: () => 'POST_NOT_FOUND',
      cachePath: () => `/v1/post?id=${id}`,
      shape(json) {
        const root = record(json) ?? invalidShape()
        const publication = publicationMeta(root.publication) ?? bylinePublication([root.post], null)
        const post = postDetail(root.post, publication?.host ?? null) ?? invalidShape()
        const data: PostResponse = { post, publication }
        return { data, host: publication?.host ?? SUBSTACK_COM }
      },
    }
  }
  if (!rawHost && !rawSlug) throw new RelayFailure('INVALID_PARAM')
  const host = hostParam(rawHost)
  if (!SLUG_RE.test(rawSlug)) throw new RelayFailure('INVALID_SLUG')
  const slug = rawSlug
  return {
    route: 'post',
    host,
    allowSubstackCom: false,
    href: `https://${host}/api/v1/posts/${encodeURIComponent(slug)}`,
    publicPostSlug: slug,
    accept: ACCEPT_JSON,
    cap: POST_CAP,
    kind: 'json',
    ttl: TTL.post,
    notFoundEdgeTtl: NOT_FOUND_EDGE_TTL,
    // Substack answers a missing post with 404 JSON; an unknown publication with an empty 404.
    notFound: info => info.contentType === 'application/json' ? 'POST_NOT_FOUND' : 'PUBLICATION_NOT_FOUND',
    cachePath: h => `/v1/post?host=${h}&slug=${encodeURIComponent(slug)}`,
    shape(json, finalHost) {
      const post = postDetail(json, finalHost) ?? invalidShape()
      const data: PostResponse = { post, publication: bylinePublication([json], finalHost) }
      return { data, host: finalHost }
    },
  }
}

function profilePlan(params: URLSearchParams): Plan {
  // C1: Substack's public_profile lookup is case-sensitive and handles are lowercase.
  const handle = (params.get('handle') ?? '').replace(/^@/, '').toLowerCase()
  if (!HANDLE_RE.test(handle)) throw new RelayFailure('INVALID_HANDLE')
  return {
    route: 'profile',
    host: SUBSTACK_COM,
    allowSubstackCom: true,
    href: `https://substack.com/api/v1/user/${encodeURIComponent(handle)}/public_profile`,
    accept: ACCEPT_JSON,
    cap: PROFILE_CAP,
    kind: 'json',
    ttl: TTL.profile,
    notFoundEdgeTtl: 0,
    notFound: () => 'PROFILE_NOT_FOUND',
    cachePath: () => `/v1/profile?handle=${encodeURIComponent(handle)}`,
    shape(json) {
      const root = record(json) ?? invalidShape()
      const upstreamHandle = text(root.handle)?.trim() ?? ''
      const subscriptions = collectPublications(MAX_SUBSCRIPTIONS)
      for (const item of list(root.subscriptions)) {
        const subscription = record(item)
        // Substack lists only public subscriptions; skip anything explicitly marked otherwise.
        if (!subscription || (typeof subscription.visibility === 'string' && subscription.visibility !== 'public')) continue
        subscriptions.add(publicationMeta(subscription.publication))
      }
      const resolvedHandle = HANDLE_RE.test(upstreamHandle) ? upstreamHandle : handle
      const data: Profile = {
        handle: resolvedHandle,
        name: (text(root.name) ?? '').trim() || resolvedHandle,
        primaryPublication: publicationMeta(root.primaryPublication),
        subscriptions: subscriptions.items,
      }
      return { data, host: SUBSTACK_COM }
    },
  }
}

function searchPlan(params: URLSearchParams): Plan {
  const query = (params.get('q') ?? '').trim()
  const length = [...query].length
  if (length < 2 || length > 100 || CONTROL_RE.test(query)) throw new RelayFailure('INVALID_QUERY')
  return {
    route: 'search',
    host: SUBSTACK_COM,
    allowSubstackCom: true,
    // C3: top/search (publication/search returns nothing for honest user agents).
    href: `https://substack.com/api/v1/top/search?query=${encodeURIComponent(query)}`,
    accept: ACCEPT_JSON,
    cap: SEARCH_CAP,
    kind: 'json',
    ttl: TTL.search,
    notFoundEdgeTtl: 0,
    notFound: () => 'NOT_FOUND',
    cachePath: () => `/v1/search?q=${encodeURIComponent(query)}`,
    shape(json) {
      const root = record(json) ?? invalidShape()
      if (!Array.isArray(root.items)) invalidShape()
      const results = collectPublications(MAX_SEARCH_RESULTS)
      for (const value of list(root.items)) {
        const item = record(value)
        if (!item) continue
        if (item.type === 'profileSearchResults') {
          for (const result of list(item.results)) results.add(publicationMeta(record(result)?.primaryPublication))
        } else if (item.type === 'post') {
          results.add(publicationMeta(item.publication))
        }
        // 'comment' and unknown item types are ignored.
      }
      const data: SearchResponse = { results: results.items }
      return { data, host: SUBSTACK_COM }
    },
  }
}

function feedPlan(params: URLSearchParams): Plan {
  const host = hostParam(params.get('host'))
  return {
    route: 'feed',
    host,
    allowSubstackCom: false,
    href: `https://${host}/feed`,
    accept: ACCEPT_FEED,
    cap: FEED_CAP,
    kind: 'xml',
    ttl: TTL.feed,
    notFoundEdgeTtl: 0,
    notFound: () => 'PUBLICATION_NOT_FOUND',
    cachePath: h => `/v1/feed?host=${h}`,
    shape: () => invalidShape(),
  }
}

/* ------------------------------------------------------------------ upstream helpers */

/** Copied from LIHKG worker/index.ts: streaming read that stops at `limit` bytes. */
class TooLarge extends Error {}

async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let result = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => undefined)
        throw new TooLarge()
      }
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The body is never used.
  }
}

function mediaType(response: Response): string {
  return (response.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase()
}

function contentTypeOf(response: Response): UpstreamContentType {
  const type = mediaType(response)
  if (!type) return 'missing'
  if (type === 'application/json' || JSON_SUFFIX_RE.test(type)) return 'application/json'
  if (XML_LIKE_RE.test(type)) return 'application/xml'
  if (type === 'text/html' || type === 'text/plain') return type
  return 'other'
}

/** Only fixed categories leave the upstream boundary (LIHKG upstreamDiagnostics). */
function describe(response: Response): RelayUpstreamInfo {
  return {
    status: response.status,
    contentType: contentTypeOf(response),
    challenge: response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge',
  }
}

/** C4: x-served-by: Substack or x-cluster: substack, case-insensitive. */
function fingerprinted(response: Response): boolean {
  return response.headers.get('x-served-by')?.trim().toLowerCase() === 'substack'
    || response.headers.get('x-cluster')?.trim().toLowerCase() === 'substack'
}

type Verdict = 'pass' | 'fail' | 'unknown'

/** A host check result; `blocked`: Substack refused the check itself (S5, reported as UPSTREAM_BLOCKED). */
interface Outcome {
  verdict: Verdict
  blocked?: RelayUpstreamInfo
  /** A mapping proof's 'fail' kept shorter than VERDICT_FAIL_MS (Y1, Y3). */
  ttlMs?: number
}

/** A verdict remembered in isolate memory ('unknown' only briefly). */
interface MemoVerdict extends Outcome {
  expires: number
}

/** A verdict in the Cache API ('unknown' is never stored there). */
interface StoredVerdict {
  verdict: 'pass' | 'fail'
  expires: number
}

/** The result of the checks and how long to remember it. */
interface Checked extends Outcome {
  ttlMs: number
}

/** Per-request context for the routes. */
interface Call {
  request: Request
  env: Env
  ctx?: Ctx
  /** S4: `<relay origin><CACHE_PATH>`, the prefix of every synthetic cache key for this request. */
  cacheNs: string
}

const UNKNOWN: Outcome = { verdict: 'unknown' }
const NO_SERVER: Outcome = { verdict: 'fail', ttlMs: VERDICT_NO_SERVER_MS }
const REFUSED: Outcome = { verdict: 'fail', ttlMs: VERDICT_REFUSED_MS }

function refusal(response: Response, info: RelayUpstreamInfo): boolean {
  return info.challenge || response.status === 401 || response.status === 403
}

/**
 * S5: an answer that proves nothing about the host. 429 and 5xx are outages; 401, 403 and
 * challenges mean Substack refused the relay, which must never be cached as "not Substack".
 */
function inconclusive(response: Response): Outcome | null {
  const info = describe(response)
  if (refusal(response, info)) return { verdict: 'unknown', blocked: info }
  return response.status === 429 || response.status >= 500 ? UNKNOWN : null
}

/**
 * The host's own answer to the proof's first request, before anything ties it to Substack. Y1:
 * only a fingerprinted refusal is Substack's (S5); an unmarked 401, 403 or challenge comes from
 * whatever else serves the host (its own WAF), so it is a brief fail and the phone tries www.
 * Y3: an unmarked 530 is a Cloudflare zone with no origin. Other 429 and 5xx stay outages (a
 * genuine domain proxied through its owner's zone shows unmarked 52x while Substack is down).
 */
function firstAnswer(response: Response): Outcome | null {
  if (fingerprinted(response)) return inconclusive(response)
  if (refusal(response, describe(response))) return REFUSED
  if (response.status === 530) return NO_SERVER
  return response.status === 429 || response.status >= 500 ? UNKNOWN : null
}

function unverified(outcome: Outcome): RelayFailure {
  return outcome.blocked ? new RelayFailure('UPSTREAM_BLOCKED', { upstream: outcome.blocked }) : new RelayFailure('UPSTREAM_UNAVAILABLE')
}

/** The /64 of an IPv6 address as `a:b:c:d::/64`, or null when it does not parse. */
function ipv6Prefix(address: string): string | null {
  const halves = address.split('::')
  if (halves.length > 2) return null
  const groups = (value: string): string[] => value ? value.split(':') : []
  const width = (parts: string[]): number => parts.reduce((sum, part) => sum + (part.includes('.') ? 2 : 1), 0)
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - width(head) - width(tail)
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const prefix = [...head, ...Array.from({ length: missing }, () => '0'), ...tail].slice(0, 4)
  if (!prefix.every(part => HEXTET_RE.test(part))) return null
  return `${prefix.map(part => part.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * S7: the rate-limit client key. CF-Connecting-IP is trusted only on Cloudflare (the request has
 * `cf`), whose edge sets it; on other hosts a client could pick any value, so every client shares
 * one key. An IPv6 client is keyed by its /64, which one subscriber normally holds whole.
 */
function clientKey(request: Request): string {
  const cf: unknown = (request as { cf?: unknown }).cf
  if (cf === null || typeof cf !== 'object') return SHARED_CLIENT
  const raw = (request.headers.get('CF-Connecting-IP') ?? '').trim().toLowerCase()
  if (!raw) return SHARED_CLIENT
  return raw.includes(':') ? ipv6Prefix(raw) ?? SHARED_CLIENT : raw.slice(0, 64)
}

interface DnsRecord {
  type: number
  data: string
}

interface Deadline {
  signal: AbortSignal
  expired(): boolean
  clear(): void
  cancel(): void
}

interface UpstreamBody {
  text: string
  finalHost: string
  info: RelayUpstreamInfo
}

function fqdn(value: string): string {
  const lower = value.trim().toLowerCase()
  return lower.endsWith('.') ? lower : `${lower}.`
}

function pointsAtTarget(records: DnsRecord[]): boolean {
  return records.some(entry => entry.type === 5 && fqdn(entry.data) === CUSTOM_DOMAIN_TARGET)
}

function addresses(records: DnsRecord[]): string[] {
  return records.filter(entry => entry.type === 1 || entry.type === 28).map(entry => entry.data.trim().toLowerCase())
}

function wwwVariant(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`
}

/** C4(c) first half: the subdomain of a publication whose custom domain is `host` (or its www variant). */
function claimedSubdomain(items: unknown, host: string): string | null {
  const accepted = new Set([host, wwwVariant(host)])
  for (const item of list(items)) {
    for (const byline of list(record(item)?.publishedBylines)) {
      for (const membership of list(record(byline)?.publicationUsers)) {
        const pub = record(record(membership)?.publication)
        const custom = hostnameOf(pub?.custom_domain)
        const subdomain = subdomainOf(pub?.subdomain)
        if (custom && subdomain && accepted.has(custom) && isPublicationHost(`${subdomain}.substack.com`)) return subdomain
      }
    }
  }
  return null
}

function isCacheLike(value: unknown): value is CacheLike {
  const candidate = value as { match?: unknown; put?: unknown } | null
  return candidate !== null && typeof candidate === 'object'
    && typeof candidate.match === 'function' && typeof candidate.put === 'function'
}

function envOf(env: unknown): Env {
  return env !== null && typeof env === 'object' ? env as Env : {}
}

function revisionOf(env: Env): string | null {
  return typeof env.REVISION === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(env.REVISION) ? env.REVISION : null
}

/** The request Origin (printable ASCII, at most 128 chars) so the owner can learn the WebView origin. */
function originOf(request: Request): string | null {
  const raw = request.headers.get('Origin')
  if (raw === null) return null
  const clean = raw.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 128)
  return clean || null
}

/* ------------------------------------------------------------------ the relay */

export function createRelay(options: RelayOptions = {}): Relay {
  const now = options.now ?? (() => Date.now())
  const send = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const perMinute = Math.max(1, Math.floor(options.rateLimitPerMinute ?? RATE_LIMIT_PER_MINUTE))
  const strictPerMinute = Math.max(1, Math.floor(options.strictRateLimitPerMinute ?? STRICT_RATE_LIMIT_PER_MINUTE))
  const buckets = new Map<string, { units: number; at: number }>()
  /** Y2: strict 'verify' tokens that passing proofs gave back, per client key. */
  const credits = new Map<string, number>()
  /** Y2: passes apart from fail/unknown, so a stream of cheap failures never evicts them. */
  const passes = new Map<string, MemoVerdict>()
  const verdicts = new Map<string, MemoVerdict>()
  const pendingVerdicts = new Map<string, Promise<Outcome>>()
  let targetIps: { ips: string[]; expires: number } | null = null
  let cachePromise: Promise<CacheLike | null> | null = null
  let probeMemo: { at: number; probes: HealthProbe[] } | null = null
  let pendingProbes: Promise<HealthProbe[]> | null = null

  function cacheStore(): Promise<CacheLike | null> {
    if (options.cache !== undefined) return Promise.resolve(options.cache)
    cachePromise ??= (async () => {
      const storage: unknown = (globalThis as { caches?: unknown }).caches
      if (storage === null || typeof storage !== 'object') return null
      const workersDefault = (storage as { default?: unknown }).default
      if (isCacheLike(workersDefault)) return workersDefault
      const open = (storage as { open?: unknown }).open
      if (typeof open !== 'function') return null
      try {
        const opened: unknown = await open.call(storage, SERVICE)
        return isCacheLike(opened) ? opened : null
      } catch {
        return null
      }
    })()
    return cachePromise
  }

  function deadline(): Deadline {
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, timeoutMs)
    return { signal: controller.signal, expired: () => expired, clear: () => clearTimeout(timer), cancel: () => controller.abort() }
  }

  /** Exactly two request headers, no cookies, no body, manual redirects. */
  async function get(href: string, accept: string, signal: AbortSignal): Promise<Response> {
    return send(href, { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: accept }, redirect: 'manual', signal })
  }

  function iso(): string {
    return new Date(now()).toISOString()
  }

  function retryAfterOf(response: Response): number | undefined {
    const raw = response.headers.get('Retry-After')?.trim()
    if (!raw) return undefined
    const value = /^\d{1,10}$/.test(raw) ? Number(raw)
      : HTTP_DATE_RE.test(raw) ? Math.ceil((Date.parse(raw) - now()) / 1000)
        : Number.NaN
    return Number.isFinite(value) ? Math.min(MAX_RETRY_AFTER, Math.max(0, value)) : undefined
  }

  /** 403/challenge, 429 and 5xx are reported honestly whatever the fingerprint (bodies are dropped). */
  function blockedFailure(response: Response, info: RelayUpstreamInfo): RelayFailure | null {
    const retryAfterSeconds = retryAfterOf(response)
    const extra: FailureExtra = retryAfterSeconds === undefined ? { upstream: info } : { upstream: info, retryAfterSeconds }
    if (info.challenge || response.status === 403) return new RelayFailure('UPSTREAM_BLOCKED', extra)
    if (response.status === 429) return new RelayFailure('UPSTREAM_RATE_LIMITED', extra)
    if (response.status >= 500) return new RelayFailure('UPSTREAM_UNAVAILABLE', extra)
    return null
  }

  /* ---------- rate limiting (no logging; the IP lives only in this Map) */

  function takeToken(key: string, perMinute: number): number {
    // Integer units: one request costs MINUTE_MS units, refill is perMinute units per ms.
    const capacity = perMinute * MINUTE_MS
    const time = now()
    const previous = buckets.get(key)
    const units = previous ? Math.min(capacity, previous.units + Math.max(0, time - previous.at) * perMinute) : capacity
    buckets.delete(key)
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next()
      if (!oldest.done) buckets.delete(oldest.value)
    }
    if (units >= MINUTE_MS) {
      buckets.set(key, { units: units - MINUTE_MS, at: time })
      return 0
    }
    buckets.set(key, { units, at: time })
    return Math.max(1, Math.ceil((MINUTE_MS - units) / perMinute / 1000))
  }

  /**
   * One token per request from the client's bucket for `route`. `strict` routes (mapping proofs,
   * health probes) use the RL_STRICT binding or a 10 per minute local bucket instead.
   */
  async function rateLimit(route: string, call: Call, strict = false): Promise<void> {
    const key = `${clientKey(call.request)}:${route}`
    const binding = strict ? call.env.RL_STRICT : call.env.RL
    if (binding && typeof binding.limit === 'function') {
      let outcome: unknown = null
      try {
        outcome = await binding.limit({ key })
      } catch {
        outcome = null // A broken binding falls back to the local bucket.
      }
      if (outcome !== null) {
        if (record(outcome)?.success === false) throw new RelayFailure('RATE_LIMITED', { retryAfterSeconds: BINDING_RETRY_AFTER })
        return
      }
    }
    const wait = takeToken(key, strict ? strictPerMinute : perMinute)
    if (wait > 0) throw new RelayFailure('RATE_LIMITED', { retryAfterSeconds: wait })
  }

  /**
   * Y2: a mapping proof takes its strict 'verify' token before it runs, so a burst of proofs is
   * bounded by the budget, and returns a refund for a proof that passes: a credit (at most a
   * budget's worth) that pays for the client's next proof, because the RL_STRICT binding cannot
   * give a token back. Only proofs that fail or prove nothing cost budget, so verifying many
   * genuine custom domains on a cold isolate (whose Cache API may store nothing on workers.dev)
   * is never limited.
   */
  async function reserveProof(call: Call): Promise<() => void> {
    const key = `${clientKey(call.request)}:verify`
    const credit = credits.get(key) ?? 0
    if (credit > 1) credits.set(key, credit - 1)
    else if (credit === 1) credits.delete(key)
    else await rateLimit('verify', call, true)
    return () => {
      const kept = credits.get(key) ?? 0
      credits.delete(key)
      if (credits.size >= MAX_BUCKETS) {
        const oldest = credits.keys().next()
        if (!oldest.done) credits.delete(oldest.value)
      }
      credits.set(key, Math.min(strictPerMinute, kept + 1))
    }
  }

  /* ---------- host verification (C4) */

  async function dohQuery(name: string, type: 'CNAME' | 'A' | 'AAAA'): Promise<DnsRecord[] | null> {
    const clock = deadline()
    try {
      const response = await get(`${DOH_ENDPOINT}?name=${name}&type=${type}`, ACCEPT_DOH, clock.signal)
      if (response.status !== 200) {
        await discard(response)
        return null
      }
      const json = record(JSON.parse(await boundedText(response.body, DOH_CAP)))
      if (!json || typeof json.Status !== 'number') return null
      if (json.Status === 3) return [] // NXDOMAIN is a definitive answer.
      if (json.Status !== 0) return null
      return list(json.Answer).flatMap(value => {
        const entry = record(value)
        return entry && typeof entry.type === 'number' && typeof entry.data === 'string' ? [{ type: entry.type, data: entry.data }] : []
      })
    } catch {
      return null
    } finally {
      clock.clear()
    }
  }

  async function targetAddresses(): Promise<string[] | null> {
    if (targetIps && targetIps.expires > now()) return targetIps.ips
    const name = CUSTOM_DOMAIN_TARGET.slice(0, -1)
    const [a, aaaa] = await Promise.all([dohQuery(name, 'A'), dohQuery(name, 'AAAA')])
    if (a === null || aaaa === null) return null
    targetIps = { ips: addresses([...a, ...aaaa]), expires: now() + TARGET_IPS_MS }
    return targetIps.ips
  }

  /**
   * C4(c): the host serves Substack JSON naming publication S, and S.substack.com redirects to the
   * host. S5: Substack refusing (401, 403, challenge) or an outage is 'unknown', never a cached
   * 'fail'. Y1, Y3: the host's own unmarked refusal, a connection or TLS error (not a timeout) and
   * an unmarked 530 are short fails; runChecks makes them 'unknown' unless DNS was definitive.
   */
  async function mappingProof(host: string): Promise<Outcome> {
    const fail: Outcome = { verdict: 'fail' }
    const clock = deadline()
    try {
      let first: Response
      try {
        first = await get(`https://${host}/api/v1/archive?sort=new&offset=0&limit=1`, ACCEPT_JSON, clock.signal)
      } catch {
        return clock.expired() ? UNKNOWN : NO_SERVER
      }
      const refused = firstAnswer(first)
      if (refused || first.status !== 200 || !fingerprinted(first) || contentTypeOf(first) !== 'application/json') {
        await discard(first)
        return refused ?? fail
      }
      let items: unknown
      try {
        items = JSON.parse(await boundedText(first.body, ARCHIVE_CAP))
      } catch {
        return clock.expired() ? UNKNOWN : fail
      }
      const subdomain = claimedSubdomain(items, host)
      if (!subdomain) return fail
      const checkUrl = `https://${subdomain}.substack.com/api/v1/archive?sort=new&offset=0&limit=1`
      let check: Response
      try {
        check = await get(checkUrl, ACCEPT_JSON, clock.signal)
      } catch {
        return UNKNOWN
      }
      await discard(check)
      const checkRefused = inconclusive(check)
      if (checkRefused) return checkRefused
      const location = check.headers.get('Location')
      if (!REDIRECT_STATUSES.has(check.status) || !fingerprinted(check) || !location) return fail
      try {
        const target = new URL(location, checkUrl)
        return target.protocol === 'https:' && target.hostname.toLowerCase() === host ? { verdict: 'pass' } : fail
      } catch {
        return fail
      }
    } finally {
      clock.clear()
    }
  }

  /**
   * C4 checks, cheapest first: (a) CNAME to the target; (b) a CNAME chain in the A answer that
   * ends at the target, or apex flattening (the host's A/AAAA records intersect the target's);
   * (c) the mapping proof. S3: definitive but empty A and AAAA answers mean nothing can serve the
   * host, so it fails without any request to it. S6, Y2: the proof, the only request to a
   * caller-chosen host, first takes a token from the caller's strict budget (RATE_LIMITED, and
   * nothing is remembered); a proof that passes gives it back. Without definitive DNS (a lookup
   * failed), a proof that did not pass is inconclusive: the host may be Substack's after all.
   */
  async function runChecks(host: string, call: Call): Promise<Checked> {
    const cname = await dohQuery(host, 'CNAME')
    if (cname !== null && pointsAtTarget(cname)) return { verdict: 'pass', ttlMs: VERDICT_PASS_MS }
    const [a, aaaa, target] = await Promise.all([dohQuery(host, 'A'), dohQuery(host, 'AAAA'), targetAddresses()])
    const records = [...(a ?? []), ...(aaaa ?? [])]
    const hostIps = new Set(addresses(records))
    if (pointsAtTarget(records) || (target !== null && target.some(ip => hostIps.has(ip)))) return { verdict: 'pass', ttlMs: VERDICT_PASS_MS }
    if (a !== null && aaaa !== null && hostIps.size === 0) return { verdict: 'fail', ttlMs: VERDICT_NO_SERVER_MS }
    const refund = await reserveProof(call)
    const proof = await mappingProof(host)
    if (proof.verdict === 'pass') {
      refund()
      return { verdict: 'pass', ttlMs: VERDICT_PASS_MS }
    }
    if (proof.verdict === 'unknown' || cname === null || a === null || aaaa === null || target === null) {
      return { ...proof, verdict: 'unknown', ttlMs: VERDICT_UNKNOWN_MS }
    }
    return { verdict: 'fail', ttlMs: proof.ttlMs ?? VERDICT_FAIL_MS }
  }

  function verdictKey(host: string, cacheNs: string): string {
    return `${cacheNs}/host-verdict?host=${host}`
  }

  /** Y2: a live remembered verdict, moved to most recently used (eviction is LRU). */
  function memoOf(host: string): MemoVerdict | null {
    for (const memos of [passes, verdicts]) {
      const memo = memos.get(host)
      if (!memo) continue
      memos.delete(host)
      if (memo.expires <= now()) return null
      memos.set(host, memo)
      return memo
    }
    return null
  }

  function remember(host: string, memo: MemoVerdict): void {
    passes.delete(host)
    verdicts.delete(host)
    const memos = memo.verdict === 'pass' ? passes : verdicts
    if (memos.size >= MAX_VERDICTS) {
      const oldest = memos.keys().next()
      if (!oldest.done) memos.delete(oldest.value)
    }
    memos.set(host, memo)
  }

  /** S4: an entry that claims to live longer than the relay ever stores one is not the relay's. */
  async function storedVerdict(host: string, cacheNs: string): Promise<StoredVerdict | null> {
    const cache = await cacheStore()
    if (!cache) return null
    try {
      const hit = await cache.match(verdictKey(host, cacheNs))
      if (!hit) return null
      const value = record(JSON.parse(await hit.text()))
      const verdict = value?.verdict
      const expires = value?.expires
      if ((verdict === 'pass' || verdict === 'fail') && typeof expires === 'number' && expires > now()
        && expires <= now() + (verdict === 'pass' ? VERDICT_PASS_MS : VERDICT_FAIL_MS)) return { verdict, expires }
    } catch {
      // A broken cache entry is treated as a miss.
    }
    return null
  }

  async function saveVerdict(host: string, stored: StoredVerdict, cacheNs: string): Promise<void> {
    remember(host, stored)
    const cache = await cacheStore()
    if (!cache) return
    const maxAge = Math.max(1, Math.round((stored.expires - now()) / 1000))
    try {
      await cache.put(verdictKey(host, cacheNs), new Response(JSON.stringify(stored), {
        headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': `public, max-age=${maxAge}` },
      }))
    } catch {
      // Best effort.
    }
  }

  /**
   * Remembered per host: pass 24 h, fail 1 h (10 min when nothing serves the host, 60 s when it
   * refused the proof itself) in memory and the Cache API; 'unknown' (lookup outage, Substack
   * refusing the proof) 60 s in memory only. Concurrent callers share one verification.
   */
  async function verifyCustomDomain(host: string, call: Call): Promise<Outcome> {
    const memo = memoOf(host)
    if (memo) return memo
    const pending = pendingVerdicts.get(host)
    // Y4: a shared verification spends its starter's strict budget. A waiter never inherits that
    // RATE_LIMITED: it retries under its own budget. Bounded: the starter's `finally` has already
    // run, so the retry starts its own verification or joins one another waiter started just now.
    if (pending) {
      return pending.catch(error => {
        if (error instanceof RelayFailure && error.code === 'RATE_LIMITED') return verifyCustomDomain(host, call)
        throw error
      })
    }
    const work = (async (): Promise<Outcome> => {
      const stored = await storedVerdict(host, call.cacheNs)
      if (stored) {
        remember(host, stored)
        return stored
      }
      const checked = await runChecks(host, call)
      const expires = now() + checked.ttlMs
      if (checked.verdict === 'unknown') {
        const unknown: MemoVerdict = checked.blocked ? { verdict: 'unknown', blocked: checked.blocked, expires } : { verdict: 'unknown', expires }
        remember(host, unknown)
        return unknown
      }
      const saved: StoredVerdict = { verdict: checked.verdict, expires }
      await saveVerdict(host, saved, call.cacheNs)
      return saved
    })()
    pendingVerdicts.set(host, work)
    try {
      return await work
    } finally {
      if (pendingVerdicts.get(host) === work) pendingVerdicts.delete(host)
    }
  }

  /** Security rule 2: the allowlist, applied to the first host and to every redirect target. */
  async function hostVerdict(host: string, allowSubstackCom: boolean, call: Call): Promise<Outcome> {
    if (allowSubstackCom) return { verdict: host === SUBSTACK_COM ? 'pass' : 'fail' }
    if (!isPublicationHost(host)) return { verdict: 'fail' }
    if (SUBSTACK_SUBDOMAIN_HOST_RE.test(host)) return { verdict: 'pass' }
    if (host.endsWith('.substack.com')) return { verdict: 'fail' }
    return verifyCustomDomain(host, call)
  }

  /* ---------- upstream fetch with redirect validation */

  async function nextHop(current: URL, location: string | null, plan: Plan, info: RelayUpstreamInfo, call: Call): Promise<URL> {
    if (!location) throw new RelayFailure('REDIRECT_NOT_ALLOWED', { upstream: info })
    let target: URL
    try {
      target = new URL(location, current) // Location may be relative.
    } catch {
      throw new RelayFailure('REDIRECT_NOT_ALLOWED', { upstream: info })
    }
    const host = target.hostname.toLowerCase()
    // Unknown subdomains bounce to substack.com (root or /@handle): there is no publication.
    if (!plan.allowSubstackCom && (host === SUBSTACK_COM || host === 'www.substack.com')) {
      throw new RelayFailure('PUBLICATION_NOT_FOUND', { upstream: info })
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.pathname !== current.pathname) {
      throw new RelayFailure('REDIRECT_NOT_ALLOWED', { upstream: info })
    }
    const outcome = await hostVerdict(host, plan.allowSubstackCom, call)
    if (outcome.verdict === 'unknown') throw unverified(outcome)
    if (outcome.verdict === 'fail') throw new RelayFailure('REDIRECT_NOT_ALLOWED', { upstream: info })
    // Only the host may change; path and query stay the relay's own.
    return new URL(`https://${host}${current.pathname}${current.search}`)
  }

  async function readBody(response: Response, plan: Plan, info: RelayUpstreamInfo, clock: Deadline): Promise<string> {
    const declared = Number(response.headers.get('Content-Length') ?? '')
    if (Number.isFinite(declared) && declared > plan.cap) {
      await discard(response)
      throw new RelayFailure('UPSTREAM_TOO_LARGE', { upstream: info })
    }
    try {
      return await boundedText(response.body, plan.cap)
    } catch (error) {
      if (error instanceof TooLarge) throw new RelayFailure('UPSTREAM_TOO_LARGE', { upstream: info })
      throw clock.expired() ? new RelayFailure('UPSTREAM_TIMEOUT') : new RelayFailure('UPSTREAM_UNAVAILABLE', { upstream: info })
    }
  }

  async function fetchUpstream(plan: Plan, call: Call, sharedClock?: Deadline): Promise<UpstreamBody> {
    const clock = sharedClock ?? deadline()
    let url = new URL(plan.href)
    let redirects = 0
    try {
      for (;;) {
        if (clock.expired()) throw new RelayFailure('UPSTREAM_TIMEOUT')
        let response: Response
        try {
          response = await get(url.href, plan.accept, clock.signal)
        } catch {
          throw clock.expired() ? new RelayFailure('UPSTREAM_TIMEOUT') : new RelayFailure('UPSTREAM_UNAVAILABLE')
        }
        const info = describe(response)
        const blocked = blockedFailure(response, info)
        if (blocked) {
          await discard(response)
          throw blocked
        }
        if (!fingerprinted(response)) {
          await discard(response)
          throw new RelayFailure('HOST_NOT_SUBSTACK', { upstream: info })
        }
        if (REDIRECT_STATUSES.has(response.status)) {
          await discard(response)
          if (redirects >= MAX_REDIRECTS) throw new RelayFailure('TOO_MANY_REDIRECTS', { upstream: info })
          url = await nextHop(url, response.headers.get('Location'), plan, info, call)
          redirects += 1
          continue
        }
        if (response.status === 404) {
          await discard(response)
          throw new RelayFailure(plan.notFound(info), { upstream: info })
        }
        if (response.status < 200 || response.status > 299) {
          await discard(response)
          throw new RelayFailure('UPSTREAM_ERROR', { upstream: info })
        }
        const acceptable = plan.kind === 'json' ? info.contentType === 'application/json'
          : plan.kind === 'html' ? info.contentType === 'text/html' : FEED_TYPE_RE.test(mediaType(response))
        if (!acceptable) {
          await discard(response)
          throw new RelayFailure('UPSTREAM_INVALID', { upstream: info })
        }
        return { text: await readBody(response, plan, info, clock), finalHost: url.hostname, info }
      }
    } finally {
      if (!sharedClock) clock.clear()
    }
  }

  /** Public pages use the same host, redirect, fingerprint, byte and deadline checks as the API. */
  async function publicPost(plan: Plan, host: string, slug: string, call: Call, clock: Deadline): Promise<{ data: PostResponse; host: string }> {
    const upstream = await fetchUpstream({ ...plan, host, allowSubstackCom: false,
      href: `https://${host}/p/${encodeURIComponent(slug)}`, accept: ACCEPT_HTML, kind: 'html', cap: POST_CAP,
      notFound: () => 'POST_NOT_FOUND',
    }, call, clock)
    let parsed: ReturnType<typeof parsePublicPost>
    try { parsed = parsePublicPost(upstream.text, slug) } catch { return invalidShape() }
    const post = postDetail(parsed.post, upstream.finalHost) ?? invalidShape()
    const publication = publicationMeta(parsed.pub)
    if (!publication || (publication.host !== upstream.finalHost
      && `${publication.subdomain}.substack.com` !== upstream.finalHost)) invalidShape()
    return { data: { post, publication }, host: upstream.finalHost }
  }

  async function publicArchive(plan: Plan, call: Call, clock: Deadline): Promise<{ data: ArchivePage; host: string }> {
    const page = plan.archive ?? invalidShape()
    // A page hydrates at most four public documents, only on demand. Cache hits cost no fan-out.
    await rateLimit('archive-public', call, true)
    const upstream = await fetchUpstream({ ...plan, href: `https://${plan.host}/sitemap.xml`,
      accept: 'application/xml', kind: 'xml', cap: ARCHIVE_CAP,
    }, call, clock)
    let slugs: string[]
    try { slugs = parseSitemapSlugs(upstream.text, upstream.finalHost) } catch { return invalidShape() }
    const selected = slugs.slice(page.offset, page.offset + Math.min(page.limit, PUBLIC_ARCHIVE_PAGE_SIZE))
    // Reject a partial page on any failure: retrying must not silently skip an unread post.
    const details = await Promise.all(selected.map(slug => publicPost(plan, upstream.finalHost, slug, call, clock)))
    const end = page.offset + selected.length
    const posts = details.map(({ data: { post } }) => {
      const { bodyHtml: _body, truncated: _truncated, ...summary } = post
      return summary
    })
    return { data: { publication: details[0]?.data.publication ?? null, posts, source: 'sitemap',
      nextOffset: end < slugs.length && end <= RELAY_MAX_ARCHIVE_OFFSET ? end : null,
    }, host: upstream.finalHost }
  }

  function canUsePublicPages(error: unknown): boolean {
    return error instanceof RelayFailure && ['UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE'].includes(error.code)
  }

  async function load(plan: Plan, call: Call): Promise<{ upstream: UpstreamBody } | { shaped: { data: unknown; host: string } }> {
    const clock = deadline()
    try {
      if (plan.archive?.source === 'sitemap') return { shaped: await publicArchive(plan, call, clock) }
      try {
        return { upstream: await fetchUpstream(plan, call, clock) }
      } catch (error) {
        if (!canUsePublicPages(error)) throw error
        try {
          if (plan.publicPostSlug) return { shaped: await publicPost(plan, plan.host, plan.publicPostSlug, call, clock) }
          // An API offset and a sitemap offset are different sequences. Switch only at the start;
          // subsequent pages explicitly carry source=sitemap even if the API recovers meanwhile.
          if (call.env.PUBLIC_ARCHIVE_FALLBACK !== '0' && plan.archive?.offset === 0 && plan.archive.sort === 'new') {
            return { shaped: await publicArchive(plan, call, clock) }
          }
        } catch {
          // Keep the original API failure (including Retry-After) for the client's RSS recovery.
        }
        throw error
      }
    } finally {
      clock.clear()
      clock.cancel()
    }
  }

  /* ---------- edge cache */

  async function store(cache: CacheLike, keys: string[], body: string, status: number, contentType: string, edgeTtl: number, ctx?: Ctx): Promise<void> {
    const puts = keys.map(async key => {
      try {
        await cache.put(key, new Response(body, {
          status,
          headers: { 'Content-Type': contentType, 'Cache-Control': `public, max-age=${edgeTtl}` },
        }))
      } catch {
        // Best effort: a cache failure never fails the request.
      }
    })
    const all = Promise.all(puts).then(() => undefined)
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(all)
    else await all
  }

  async function replay(cache: CacheLike, key: string, plan: Plan): Promise<Response | null> {
    try {
      const hit = await cache.match(key)
      if (!hit) return null
      const body = await hit.text()
      if (hit.status === 200) {
        const client = `public, max-age=${plan.ttl.client}`
        if (plan.kind === 'xml') return new Response(body, { status: 200, headers: responseHeaders(FEED_TYPE, client) })
        return new Response(body.replace(CACHED_FALSE, CACHED_TRUE), { status: 200, headers: responseHeaders(JSON_TYPE, client) })
      }
      if (hit.status === 404) return new Response(body, { status: 404, headers: responseHeaders(JSON_TYPE, 'no-store') })
    } catch {
      // Treat a broken cache as a miss.
    }
    return null
  }

  /* ---------- routes */

  async function serve(plan: Plan, call: Call): Promise<Response> {
    await rateLimit(plan.route, call)
    const cache = await cacheStore()
    const key = call.cacheNs + plan.cachePath(plan.host)
    if (cache) {
      const replayed = await replay(cache, key, plan)
      if (replayed) return replayed
    }
    const outcome = await hostVerdict(plan.host, plan.allowSubstackCom, call)
    if (outcome.verdict === 'unknown') throw unverified(outcome)
    if (outcome.verdict === 'fail') throw new RelayFailure('HOST_NOT_SUBSTACK')
    let loaded: Awaited<ReturnType<typeof load>>
    try {
      loaded = await load(plan, call)
    } catch (error) {
      if (cache && plan.notFoundEdgeTtl > 0 && error instanceof RelayFailure && error.status === 404) {
        await store(cache, [key], errorJson(error), 404, JSON_TYPE, plan.notFoundEdgeTtl, call.ctx)
      }
      throw error
    }
    if ('shaped' in loaded) {
      const { shaped } = loaded
      const keys = shaped.host === plan.host ? [key] : [key, call.cacheNs + plan.cachePath(shaped.host)]
      const body = okJson(shaped.data, shaped.host, iso())
      if (cache) await store(cache, keys, body, 200, JSON_TYPE, plan.ttl.edge, call.ctx)
      return new Response(body, { status: 200, headers: responseHeaders(JSON_TYPE, `public, max-age=${plan.ttl.client}`) })
    }
    const { upstream } = loaded
    // Also cache under the post-redirect host, which the client adopts from meta.host.
    const keys = upstream.finalHost === plan.host ? [key] : [key, call.cacheNs + plan.cachePath(upstream.finalHost)]
    const clientCache = `public, max-age=${plan.ttl.client}`
    if (plan.kind === 'xml') {
      // S1: only an RSS document passes, and it leaves as text/plain under the sandbox CSP.
      if (!RSS_ROOT_RE.test(upstream.text)) throw new RelayFailure('UPSTREAM_INVALID', { upstream: upstream.info })
      if (cache) await store(cache, keys, upstream.text, 200, FEED_TYPE, plan.ttl.edge, call.ctx)
      return new Response(upstream.text, { status: 200, headers: responseHeaders(FEED_TYPE, clientCache) })
    }
    let json: unknown
    try {
      json = JSON.parse(upstream.text)
    } catch {
      throw new RelayFailure('UPSTREAM_INVALID', { upstream: upstream.info })
    }
    const shaped = plan.shape(json, upstream.finalHost)
    const body = okJson(shaped.data, shaped.host, iso())
    if (cache) await store(cache, keys, body, 200, JSON_TYPE, plan.ttl.edge, call.ctx)
    return new Response(body, { status: 200, headers: responseHeaders(JSON_TYPE, clientCache) })
  }

  async function probe(target: HealthProbe['target'], href: string): Promise<HealthProbe> {
    const started = now()
    const clock = deadline()
    try {
      const response = await get(href, ACCEPT_JSON, clock.signal)
      const info = describe(response)
      await discard(response)
      return { target, status: info.status, contentType: info.contentType, challenge: info.challenge, ms: Math.max(0, now() - started) }
    } catch {
      return { target, status: 0, contentType: 'missing', challenge: false, ms: Math.max(0, now() - started) }
    } finally {
      clock.clear()
    }
  }

  /** S2: one probe round per isolate per PROBE_MEMO_MS, shared by concurrent callers; `fresh` when this call ran it. */
  async function probeRound(): Promise<{ probes: HealthProbe[]; fresh: boolean }> {
    if (probeMemo && now() - probeMemo.at < PROBE_MEMO_MS) return { probes: probeMemo.probes, fresh: false }
    if (pendingProbes) return { probes: await pendingProbes, fresh: false }
    const work = Promise.all(HEALTH_PROBES.map(([target, href]) => probe(target, href)))
    pendingProbes = work
    try {
      const probes = await work
      probeMemo = { at: now(), probes }
      return { probes, fresh: true }
    } finally {
      pendingProbes = null
    }
  }

  async function health(url: URL, call: Call): Promise<Response> {
    await rateLimit('health', call)
    const data: HealthResponse = { service: SERVICE, protocol: RELAY_PROTOCOL, revision: revisionOf(call.env), origin: originOf(call.request) }
    let cached = false
    if (url.searchParams.get('probe') === '1') {
      await rateLimit('health-probe', call, true)
      const round = await probeRound()
      data.probes = round.probes
      cached = !round.fresh
    }
    const body = okJson(data, url.hostname, iso())
    return new Response(cached ? body.replace(CACHED_FALSE, CACHED_TRUE) : body, { status: 200, headers: responseHeaders(JSON_TYPE, 'no-store') })
  }

  async function handle(request: Request, env?: Env, ctx?: Ctx): Promise<Response> {
    try {
      const method = request.method.toUpperCase()
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(JSON_TYPE, 'no-store') })
      if (method !== 'GET') throw new RelayFailure('METHOD_NOT_ALLOWED')
      const url = new URL(request.url)
      const params = url.searchParams
      const call: Call = { request, env: envOf(env), ctx, cacheNs: `${url.origin}${CACHE_PATH}` }
      switch (url.pathname) {
        case '/': return htmlResponse(landingPage(url.hostname, version))
        case '/privacy': return htmlResponse(privacyPage(url.hostname))
        case '/v1/health': return await health(url, call)
        case '/v1/archive': return await serve(archivePlan(params), call)
        case '/v1/post': return await serve(postPlan(params), call)
        case '/v1/profile': return await serve(profilePlan(params), call)
        case '/v1/search': return await serve(searchPlan(params), call)
        case '/v1/feed': return await serve(feedPlan(params), call)
        default: throw new RelayFailure('NOT_FOUND')
      }
    } catch (error) {
      return errorResponse(error instanceof RelayFailure ? error : new RelayFailure('INTERNAL_ERROR'))
    }
  }

  return { fetch: handle }
}

/** The deployed Worker: one instance per isolate (in-memory buckets and verdicts live here). */
const relay: Relay = createRelay()
export default relay
