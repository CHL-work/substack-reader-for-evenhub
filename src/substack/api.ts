/**
 * Relay client (SPEC section 3.7). Every request is a CORS "simple request":
 * GET, no custom headers, credentials omitted, no redirects followed, and a
 * 15 s timeout combined with the caller's AbortSignal. Responses are
 * normalized defensively; no shape from the network is trusted as-is.
 */
import { ENABLE_RSS2JSON_FALLBACK, RELAY_BASE, normalizeRelayOrigin } from '../config'
import {
  ARCHIVE_PAGE_SIZE,
  RELAY_MAX_ARCHIVE_LIMIT,
  RELAY_MAX_ARCHIVE_OFFSET,
  isPaywalledAudience,
  type ArchivePage,
  type HealthProbe,
  type HealthResponse,
  type PostDetail,
  type PostSummary,
  type Profile,
  type PubMeta,
  type RelayUpstreamInfo,
  type UpstreamContentType,
} from './types'
import { HANDLE_RE, SLUG_RE, normalizeHost } from './urls'

export const REQUEST_TIMEOUT_MS = 15_000
export const RSS2JSON_ENDPOINT = 'https://api.rss2json.com/v1/api.json'
/** Longest Retry-After the client accepts (the relay applies the same bound). */
export const MAX_RETRY_AFTER_SECONDS = 86_400

/**
 * Every failure of this module. `code` mirrors the relay's error codes
 * (RelayErrorCode) plus the client codes NOT_CONFIGURED, NETWORK_ERROR,
 * TIMEOUT and ABORTED (the caller's own signal fired). `status` is the
 * relay's HTTP status when a response arrived.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly status?: number,
    readonly upstream?: RelayUpstreamInfo,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Fallback English messages; the relay's own `error.message` wins when present. */
export const API_MESSAGES: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: 'The reader service is not set up in this build. No request was sent.',
  NETWORK_ERROR: "Can't reach the reader service. Check your connection and try again.",
  TIMEOUT: 'The reader service did not answer in time. Try again.',
  ABORTED: 'The request was cancelled.',
  INVALID_HOST: 'That is not a valid publication address.',
  INVALID_SLUG: 'That post address is not valid.',
  INVALID_HANDLE: 'That @handle is not valid.',
  INVALID_QUERY: 'Search text must be 2 to 100 characters.',
  INVALID_PARAM: 'The request was not valid.',
  UPSTREAM_INVALID: 'The reader service sent an unexpected response.',
  UPSTREAM_ERROR: 'The feed service reported an error.',
  UPSTREAM_RATE_LIMITED: 'The feed service is busy. Try again later.',
  RSS2JSON_DISABLED: 'The rss2json fallback is turned off in this build. No request was sent.',
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ArchiveOptions {
  offset?: number
  limit?: number
  sort?: 'new' | 'top'
}

export type PostLookup = { host: string; slug: string } | { id: number }

export interface ArchiveResult {
  page: ArchivePage
  /** Final host after the relay's allowed redirects (store it instead of the requested one). */
  host: string
}

export interface PostResult {
  post: PostDetail
  publication: PubMeta | null
  host: string
}

/** The relay client as an object, so the controller and tests can inject fakes. */
export interface RelayApi {
  relayConfigured(): boolean
  /** True when this build may call rss2json (VITE_ENABLE_RSS2JSON_FALLBACK=1). */
  rss2jsonEnabled(): boolean
  getArchive(host: string, o?: ArchiveOptions, signal?: AbortSignal): Promise<ArchiveResult>
  getPost(ref: PostLookup, signal?: AbortSignal): Promise<PostResult>
  getProfile(handle: string, signal?: AbortSignal): Promise<Profile>
  searchPublications(q: string, signal?: AbortSignal): Promise<PubMeta[]>
  /** Raw RSS XML from relay /v1/feed (parse with feed.ts parseFeed). */
  getFeedXml(host: string, signal?: AbortSignal): Promise<string>
  getHealth(probe?: boolean, signal?: AbortSignal): Promise<HealthResponse>
  /** rss2json JSON with status 'ok' (parse with feed.ts parseRss2Json). */
  getRss2Json(host: string, signal?: AbortSignal): Promise<unknown>
}

type RecordValue = Record<string, unknown>

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g
const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/
const CONTENT_TYPES: readonly UpstreamContentType[] = ['application/json', 'application/xml', 'text/html', 'text/plain', 'other', 'missing']
const PROBE_TARGETS: readonly HealthProbe['target'][] = ['subdomain', 'customDomain', 'substackCom']
const MAX_SUBSCRIPTIONS = 500
const MAX_SEARCH_RESULTS = 20

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Single-line text: control characters and whitespace runs become one space, trimmed, capped. */
function line(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, parsed))
}

function dateString(value: unknown): string {
  const text = line(value, 64)
  return text && Number.isFinite(Date.parse(text)) ? text : ''
}

function httpsUrl(value: unknown): string | null {
  const text = string(value).trim()
  if (!/^https:\/\//i.test(text) || text.length > 2048) return null
  try {
    return new URL(text).protocol === 'https:' ? text : null
  } catch {
    return null
  }
}

function bounded(seconds: number): number | undefined {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds)) : undefined
}

function retryAfterOf(error: RecordValue, response: Response | null): number | undefined {
  if (typeof error.retryAfterSeconds === 'number') return bounded(error.retryAfterSeconds)
  // Only readable when the relay exposes it; the envelope field is the contract.
  const header = response?.headers.get('retry-after')?.trim() ?? ''
  return /^\d{1,9}$/.test(header) ? bounded(Number(header)) : undefined
}

function upstreamOf(value: unknown): RelayUpstreamInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const u = value as RecordValue
  const status = nonNegativeInt(u.status)
  const contentType = CONTENT_TYPES.find(type => type === u.contentType) ?? 'other'
  return { status: status !== null && status <= 999 ? status : 0, contentType, challenge: u.challenge === true }
}

function messageFor(code: string): string {
  return API_MESSAGES[code] ?? 'The reader service reported an error.'
}

export function pubMetaFrom(value: unknown): PubMeta | null {
  const p = record(value)
  const host = normalizeHost(string(p.host))
  if (!host) return null
  const subdomain = string(p.subdomain).trim().toLowerCase()
  return {
    id: positiveInt(p.id),
    name: line(p.name, 200) || host,
    subdomain: SUBDOMAIN_RE.test(subdomain) ? subdomain : null,
    customDomain: normalizeHost(string(p.customDomain)),
    host,
  }
}

function uniquePubs(values: unknown[], limit: number): PubMeta[] {
  const out: PubMeta[] = []
  const hosts = new Set<string>()
  const ids = new Set<number>()
  for (const value of values) {
    const pub = pubMetaFrom(value)
    if (!pub || hosts.has(pub.host) || (pub.id !== null && ids.has(pub.id))) continue
    hosts.add(pub.host)
    if (pub.id !== null) ids.add(pub.id)
    out.push(pub)
    if (out.length >= limit) break
  }
  return out
}

/** A relay PostSummary, or null when its id or slug is unusable. `host` builds a fallback canonical URL. */
export function postSummaryFrom(value: unknown, host: string): PostSummary | null {
  const p = record(value)
  const id = positiveInt(p.id)
  const slug = string(p.slug)
  if (id === null || !SLUG_RE.test(slug)) return null
  const audience = line(p.audience, 40)
  return {
    id,
    publicationId: positiveInt(p.publicationId),
    slug,
    title: line(p.title, 500) || 'Untitled post',
    subtitle: line(p.subtitle, 1000) || null,
    postDate: dateString(p.postDate),
    audience,
    isPaywalled: isPaywalledAudience(audience) || p.isPaywalled === true,
    type: line(p.type, 40) || 'newsletter',
    wordcount: nonNegativeInt(p.wordcount),
    canonicalUrl: httpsUrl(p.canonicalUrl) ?? `https://${host}/p/${slug}`,
    authors: array(p.authors).map(name => line(name, 200)).filter(Boolean).slice(0, 5),
    podcastDurationSec: nonNegativeNumber(p.podcastDurationSec),
  }
}

export function postDetailFrom(value: unknown, host: string): PostDetail | null {
  const summary = postSummaryFrom(value, host)
  if (!summary) return null
  const p = record(value)
  return {
    ...summary,
    bodyHtml: typeof p.bodyHtml === 'string' ? p.bodyHtml : null,
    truncated: summary.isPaywalled || p.truncated === true,
  }
}

/** Append a page of posts, keeping the first occurrence of every id. */
export function appendPosts(existing: readonly PostSummary[], more: readonly PostSummary[]): PostSummary[] {
  const ids = new Set<number>()
  const out: PostSummary[] = []
  for (const post of [...existing, ...more]) {
    if (ids.has(post.id)) continue
    ids.add(post.id)
    out.push(post)
  }
  return out
}

function archiveFrom(data: unknown, offset: number, host: string): ArchivePage {
  const d = record(data)
  const posts = appendPosts([], array(d.posts).map(post => postSummaryFrom(post, host)).filter((post): post is PostSummary => post !== null))
  const next = nonNegativeInt(d.nextOffset)
  // Trust the relay's offset arithmetic (Substack returns fewer posts than
  // `limit`), but never go backwards or past what the relay accepts.
  return {
    publication: pubMetaFrom(d.publication),
    posts,
    nextOffset: next !== null && next > offset && next <= RELAY_MAX_ARCHIVE_OFFSET ? next : null,
  }
}

function profileFrom(data: unknown, requested: string): Profile {
  const d = record(data)
  const handle = line(d.handle, 64)
  const finalHandle = HANDLE_RE.test(handle) ? handle : requested
  return {
    handle: finalHandle,
    name: line(d.name, 200) || finalHandle,
    primaryPublication: pubMetaFrom(d.primaryPublication),
    subscriptions: uniquePubs(array(d.subscriptions), MAX_SUBSCRIPTIONS),
  }
}

function healthFrom(data: unknown): HealthResponse {
  const d = record(data)
  if (d.service !== 'substack-reader-relay') {
    throw new ApiError('UPSTREAM_INVALID', 'The configured relay is not a Substack Reader relay.')
  }
  const health: HealthResponse = {
    service: 'substack-reader-relay',
    protocol: nonNegativeInt(d.protocol) ?? 0,
    revision: line(d.revision, 64) || null,
    origin: line(d.origin, 128) || null,
  }
  if (Array.isArray(d.probes)) {
    health.probes = d.probes.flatMap((value): HealthProbe[] => {
      const p = record(value)
      const target = PROBE_TARGETS.find(name => name === p.target)
      if (!target) return []
      const upstream = upstreamOf(p) ?? { status: 0, contentType: 'other' as const, challenge: false }
      return [{ target, ...upstream, ms: nonNegativeInt(p.ms) ?? 0 }]
    })
  }
  return health
}

function errorFrom(response: Response, root: RecordValue): ApiError {
  const error = record(root.ok === false ? root.error : undefined)
  const code = typeof error.code === 'string' && CODE_RE.test(error.code) ? error.code : null
  if (!code) return new ApiError('NETWORK_ERROR', messageFor('NETWORK_ERROR'), retryAfterOf({}, response), response.status)
  return new ApiError(
    code,
    line(error.message, 300) || messageFor(code),
    retryAfterOf(error, response),
    response.status,
    upstreamOf(error.upstream),
  )
}

/** The relay envelope: `data` and `meta` on success, an ApiError otherwise. */
function envelope(response: Response, body: string): { data: unknown; meta: RecordValue } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  const root = record(parsed)
  if (response.ok && root.ok === true) return { data: root.data, meta: record(root.meta) }
  throw errorFrom(response, root)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * A relay client. `base` is the relay origin (normalized like
 * VITE_RELAY_ORIGIN; anything else means "not configured"). `fetchImpl`
 * defaults to the global fetch, looked up on every call.
 */
export function createApi(
  base: string | null,
  fetchImpl?: FetchLike | null,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  rss2json = false,
): RelayApi {
  const origin = normalizeRelayOrigin(base)
  const send: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))

  function requireRelay(): string {
    if (!origin) throw new ApiError('NOT_CONFIGURED', messageFor('NOT_CONFIGURED'))
    return origin
  }

  function relayUrl(relay: string, route: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString()
    return `${relay}/v1/${route}${query ? `?${query}` : ''}`
  }

  function requireHost(host: string): string {
    const value = normalizeHost(typeof host === 'string' ? host : '')
    if (!value) throw new ApiError('INVALID_HOST', messageFor('INVALID_HOST'))
    return value
  }

  /** GET `url`, read the whole body, then hand both to `handle` (which may throw ApiError). */
  async function exchange<T>(url: string, signal: AbortSignal | undefined, handle: (response: Response, body: string) => T): Promise<T> {
    if (signal?.aborted) throw new ApiError('ABORTED', messageFor('ABORTED'))
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onCallerAbort = () => controller.abort()
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    let response: Response | null = null
    try {
      // No headers, no body, no cookies: a CORS simple request (no preflight).
      // `cache` stays default so the WebView can honour the relay's max-age.
      response = await raceAbort(send(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }), controller.signal)
      const body = await raceAbort(response.text(), controller.signal)
      return handle(response, body)
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (timedOut) throw new ApiError('TIMEOUT', messageFor('TIMEOUT'))
      if (signal?.aborted) throw new ApiError('ABORTED', messageFor('ABORTED'))
      throw new ApiError('NETWORK_ERROR', messageFor('NETWORK_ERROR'), undefined, response?.status)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  function getJson(url: string, signal: AbortSignal | undefined): Promise<{ data: unknown; meta: RecordValue }> {
    return exchange(url, signal, envelope)
  }

  function metaHost(meta: RecordValue): string | null {
    return normalizeHost(string(meta.host))
  }

  return {
    relayConfigured: () => origin !== null,
    rss2jsonEnabled: () => rss2json,

    async getArchive(host, o = {}, signal) {
      const relay = requireRelay()
      const requested = requireHost(host)
      const offset = clampInt(o.offset, 0, 0, RELAY_MAX_ARCHIVE_OFFSET)
      const limit = clampInt(o.limit, ARCHIVE_PAGE_SIZE, 1, RELAY_MAX_ARCHIVE_LIMIT)
      const sort = o.sort === 'top' ? 'top' : 'new'
      const { data, meta } = await getJson(relayUrl(relay, 'archive', {
        host: requested, offset: String(offset), limit: String(limit), sort,
      }), signal)
      const finalHost = metaHost(meta) ?? requested
      return { page: archiveFrom(data, offset, finalHost), host: finalHost }
    },

    async getPost(ref, signal) {
      const relay = requireRelay()
      let params: Record<string, string>
      let requested: string | null = null
      if ('id' in ref) {
        if (!Number.isSafeInteger(ref.id) || ref.id < 1) throw new ApiError('INVALID_PARAM', messageFor('INVALID_PARAM'))
        params = { id: String(ref.id) }
      } else {
        requested = requireHost(ref.host)
        if (typeof ref.slug !== 'string' || !SLUG_RE.test(ref.slug)) throw new ApiError('INVALID_SLUG', messageFor('INVALID_SLUG'))
        params = { host: requested, slug: ref.slug }
      }
      const { data, meta } = await getJson(relayUrl(relay, 'post', params), signal)
      const d = record(data)
      const publication = pubMetaFrom(d.publication)
      const host = metaHost(meta) ?? requested ?? publication?.host ?? null
      const post = host ? postDetailFrom(d.post, host) : null
      if (!host || !post) throw new ApiError('UPSTREAM_INVALID', messageFor('UPSTREAM_INVALID'))
      return { post, publication, host }
    },

    async getProfile(handle, signal) {
      const relay = requireRelay()
      const value = typeof handle === 'string' ? handle.trim().replace(/^@/, '') : ''
      if (!HANDLE_RE.test(value)) throw new ApiError('INVALID_HANDLE', messageFor('INVALID_HANDLE'))
      const { data } = await getJson(relayUrl(relay, 'profile', { handle: value }), signal)
      return profileFrom(data, value)
    },

    async searchPublications(q, signal) {
      const relay = requireRelay()
      const query = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : ''
      if (query.length < 2 || query.length > 100) throw new ApiError('INVALID_QUERY', messageFor('INVALID_QUERY'))
      const { data } = await getJson(relayUrl(relay, 'search', { q: query }), signal)
      return uniquePubs(array(record(data).results), MAX_SEARCH_RESULTS)
    },

    async getFeedXml(host, signal) {
      const relay = requireRelay()
      const requested = requireHost(host)
      return exchange(relayUrl(relay, 'feed', { host: requested }), signal, (response, body) => {
        const type = response.headers.get('content-type') ?? ''
        if (response.ok && !/json/i.test(type)) return body
        envelope(response, body)
        throw new ApiError('UPSTREAM_INVALID', messageFor('UPSTREAM_INVALID'), undefined, response.status)
      })
    },

    async getHealth(probe = false, signal) {
      const relay = requireRelay()
      const { data } = await getJson(relayUrl(relay, 'health', probe ? { probe: '1' } : {}), signal)
      return healthFrom(data)
    },

    async getRss2Json(host, signal) {
      if (!rss2json) throw new ApiError('NOT_CONFIGURED', messageFor('RSS2JSON_DISABLED'))
      const requested = requireHost(host)
      const url = `${RSS2JSON_ENDPOINT}?${new URLSearchParams({ rss_url: `https://${requested}/feed` })}`
      return exchange(url, signal, (response, body) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          throw new ApiError('UPSTREAM_INVALID', messageFor('UPSTREAM_INVALID'), undefined, response.status)
        }
        const root = record(parsed)
        if (response.ok && root.status === 'ok') return root
        const code = response.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_ERROR'
        throw new ApiError(code, line(root.message, 300) || messageFor(code), retryAfterOf({}, response), response.status)
      })
    },
  }
}

/** The build's relay (VITE_RELAY_ORIGIN) and rss2json flag. */
export const relayApi: RelayApi = createApi(RELAY_BASE, null, REQUEST_TIMEOUT_MS, ENABLE_RSS2JSON_FALLBACK)

export function relayConfigured(): boolean {
  return relayApi.relayConfigured()
}

export function rss2jsonEnabled(): boolean {
  return relayApi.rss2jsonEnabled()
}

export function getArchive(host: string, o?: ArchiveOptions, signal?: AbortSignal): Promise<ArchiveResult> {
  return relayApi.getArchive(host, o, signal)
}

export function getPost(ref: PostLookup, signal?: AbortSignal): Promise<PostResult> {
  return relayApi.getPost(ref, signal)
}

export function getProfile(handle: string, signal?: AbortSignal): Promise<Profile> {
  return relayApi.getProfile(handle, signal)
}

export function searchPublications(q: string, signal?: AbortSignal): Promise<PubMeta[]> {
  return relayApi.searchPublications(q, signal)
}

export function getFeedXml(host: string, signal?: AbortSignal): Promise<string> {
  return relayApi.getFeedXml(host, signal)
}

export function getHealth(probe?: boolean, signal?: AbortSignal): Promise<HealthResponse> {
  return relayApi.getHealth(probe, signal)
}

/** Only when the build enables the fallback; otherwise NOT_CONFIGURED without a request. */
export function getRss2Json(host: string, signal?: AbortSignal): Promise<unknown> {
  return relayApi.getRss2Json(host, signal)
}
