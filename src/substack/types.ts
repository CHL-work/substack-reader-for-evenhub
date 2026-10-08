/**
 * Shapes shared by the phone client (src/substack/api.ts) and the relay
 * (worker/relay.ts imports this file by relative path). No runtime imports:
 * this module must load in a Worker, in Node tests and in the WebView.
 */

/** Relay protocol version reported by /v1/health. */
export const RELAY_PROTOCOL = 1

/** Client archive page size (Substack may return fewer posts than requested). */
export const ARCHIVE_PAGE_SIZE = 12
/** The relay clamps archive `limit` to 1..RELAY_MAX_ARCHIVE_LIMIT. */
export const RELAY_MAX_ARCHIVE_LIMIT = 20
/** The relay rejects archive offsets above this. */
export const RELAY_MAX_ARCHIVE_OFFSET = 5000

/** `<sub>.substack.com`, lowercase, a single DNS label before substack.com. */
export const SUBSTACK_SUBDOMAIN_HOST_RE = /^[a-z0-9-]{1,63}\.substack\.com$/
/**
 * A public DNS host name (lowercase, at least one dot, no port). The TLD is alphabetic or an IDN TLD
 * as URL punycodes it (xn--p1ai, xn--fiqs8s).
 */
export const PUBLIC_HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/
const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/

export interface PubMeta {
  id: number | null
  /** Trimmed (Substack names can carry trailing spaces). */
  name: string
  subdomain: string | null
  customDomain: string | null
  /** Canonical host to fetch from: hostOfPublication() of the upstream object. */
  host: string
}

export interface PostSummary {
  id: number
  publicationId: number | null
  slug: string
  title: string
  subtitle: string | null
  /** ISO 8601 as sent by Substack (`post_date`). */
  postDate: string
  /** `everyone`, `only_paid`, `founding`, `only_free`, ... */
  audience: string
  /** isPaywalledAudience(audience): anything other than 'everyone'. */
  isPaywalled: boolean
  /** `newsletter`, `podcast`, `thread`, `video`, ... */
  type: string
  wordcount: number | null
  canonicalUrl: string
  /** publishedBylines[].name, at most 5. */
  authors: string[]
  podcastDurationSec: number | null
}

export interface PostDetail extends PostSummary {
  /** Public HTML (a free preview for paid posts), or null. Never stored. */
  bodyHtml: string | null
  /** True when the body may be cut short: equals isPaywalled. */
  truncated: boolean
}

export interface ArchivePage {
  publication: PubMeta | null
  posts: PostSummary[]
  /** Relay cursor for the next page; null when this archive source is exhausted. */
  nextOffset: number | null
  /** Pin subsequent offsets to this ordering; absent for the normal Substack archive. */
  source?: 'sitemap'
}

export interface Profile {
  handle: string
  name: string
  primaryPublication: PubMeta | null
  /** Public subscriptions only. */
  subscriptions: PubMeta[]
}

/** `data` of /v1/post. */
export interface PostResponse {
  post: PostDetail
  publication: PubMeta | null
}

/** `data` of /v1/search (at most 20, deduped by id). */
export interface SearchResponse {
  results: PubMeta[]
}

export type UpstreamContentType = 'application/json' | 'application/xml' | 'text/html' | 'text/plain' | 'other' | 'missing'

export interface HealthProbe {
  target: 'subdomain' | 'customDomain' | 'substackCom'
  status: number
  contentType: UpstreamContentType
  challenge: boolean
  ms: number
}

/** `data` of /v1/health. */
export interface HealthResponse {
  service: 'substack-reader-relay'
  protocol: number
  revision: string | null
  /** The request Origin header (<= 128 chars), so the owner can learn the WebView origin. */
  origin: string | null
  probes?: HealthProbe[]
}

export interface RelayMeta {
  /** Final upstream host after allowed redirects (may differ from the requested one). */
  host: string
  cached: boolean
  fetchedAt: string
}

export interface RelayUpstreamInfo {
  status: number
  contentType: UpstreamContentType
  challenge: boolean
}

export interface RelayError {
  code: string
  message: string
  retryAfterSeconds?: number
  upstream?: RelayUpstreamInfo
}

export type RelayEnvelope<T> =
  | { ok: true; data: T; meta: RelayMeta }
  | { ok: false; error: RelayError }

/** Error codes the relay sends (SPEC section 6). `code` stays a string for forward compatibility. */
export type RelayErrorCode =
  | 'INVALID_HOST' | 'INVALID_SLUG' | 'INVALID_HANDLE' | 'INVALID_QUERY' | 'INVALID_PARAM'
  | 'HOST_NOT_SUBSTACK'
  | 'NOT_FOUND' | 'PUBLICATION_NOT_FOUND' | 'POST_NOT_FOUND' | 'PROFILE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_INVALID' | 'UPSTREAM_TOO_LARGE' | 'UPSTREAM_ERROR' | 'TOO_MANY_REDIRECTS' | 'REDIRECT_NOT_ALLOWED'
  | 'UPSTREAM_BLOCKED' | 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'INTERNAL_ERROR'

/** Codes produced only by the phone client (never sent by the relay). ABORTED: the caller's own signal fired. */
export type ClientErrorCode = 'NOT_CONFIGURED' | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED'

export type ErrorCode = RelayErrorCode | ClientErrorCode

/** Anything other than 'everyone' may be truncated (paid, founding, unknown future values). */
export function isPaywalledAudience(audience: string | null | undefined): boolean {
  return audience !== 'everyone'
}

function cleanHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.trim().toLowerCase()
  if (!value) return null
  if (value.includes('://')) {
    try { value = new URL(value).hostname } catch { return null }
  }
  value = value.replace(/\.$/, '')
  return PUBLIC_HOST_RE.test(value) ? value : null
}

/**
 * Canonical host of an upstream publication object (snake_case as Substack
 * sends it): the custom domain when set and not optional, otherwise
 * `<subdomain>.substack.com`. Returns null when neither is usable.
 * Objects that carry `base_url`/`hostname` (by-id, search posts) can use
 * those instead; this rule covers profile/search results without them.
 */
export function hostOfPublication(p: {
  subdomain?: string | null
  custom_domain?: string | null
  custom_domain_optional?: boolean | null
}): string | null {
  const custom = cleanHost(p.custom_domain)
  if (custom && !p.custom_domain_optional) return custom
  const sub = typeof p.subdomain === 'string' ? p.subdomain.trim().toLowerCase() : ''
  return SUBDOMAIN_RE.test(sub) ? `${sub}.substack.com` : null
}
