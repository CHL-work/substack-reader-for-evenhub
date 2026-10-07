/**
 * Pasted phone input -> what to load (SPEC section 3.6). The pasted text is
 * never fetched or navigated to: only a validated host, slug, post id,
 * handle or search query reaches the relay's fixed routes.
 */
import { PUBLIC_HOST_RE, SUBSTACK_SUBDOMAIN_HOST_RE } from './types'

export type ParsedInput =
  | { kind: 'publication'; host: string }
  | { kind: 'post'; host: string; slug: string }
  | { kind: 'postId'; id: number }
  | { kind: 'handle'; handle: string }
  | { kind: 'search'; query: string }
  | { kind: 'invalid'; reason: string }

/** A public DNS host name (the same rule the relay applies). */
export const HOST_RE = PUBLIC_HOST_RE
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,199}$/i
export const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/

export const MAX_INPUT_CHARS = 8192
/** parseMany: whole-paste cap and the number of entries returned. */
export const MAX_PASTE_CHARS = 65536
export const MAX_LINES = 50
export const SEARCH_MIN_CHARS = 2
export const SEARCH_MAX_CHARS = 100

/** Phone-facing reasons for `{ kind: 'invalid' }`. */
export const INVALID_REASONS = {
  empty: 'Nothing to add.',
  tooLong: 'That text is too long. Paste one link, domain, @handle or search per line.',
  unsafe: 'That kind of link is not supported.',
  notHttp: 'Only web links (https://) are supported.',
  manyLinks: 'Paste one link per line.',
  userinfo: 'Links with a user name are not supported.',
  port: 'Links with a port number are not supported.',
  ip: 'IP addresses are not supported.',
  host: 'That is not a valid web address.',
  reserved: 'That address is not a public website.',
  path: 'That link is not valid.',
  notSubstack: 'That is not a Substack publication address.',
  notPublication: 'Paste a publication link or an @handle',
  slug: 'That post link is not valid.',
  postId: 'That post link is not valid.',
  handle: 'That @handle is not valid.',
  searchShort: 'Type at least 2 characters to search.',
  searchLong: 'Search text is too long (100 characters at most).',
} as const

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
const UNSAFE_SCHEME_RE = /(?:^|[^a-z0-9+.-])(?:javascript|vbscript|data|file|blob):/i
const HAS_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i
/** scheme://... up to whitespace or a quoting/bracketing delimiter used in share text. */
const SCHEME_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'\x60\u{ab}\u{bb}\u{2018}\u{2019}\u{201c}\u{201d}\u{300c}-\u{300f}\u{3010}\u{3011}\u{ff08}\u{ff09}]+/giu
/** Punctuation that belongs to the surrounding message, not to the URL. */
const TRAILING_PUNCT_RE = /[)\]}>.,!?;:'"\u{2026}\u{3001}\u{3002}\u{ff0c}\u{ff01}\u{ff1f}\u{ff1b}\u{ff1a}]+$/u
const HANDLE_TRAILING_RE = /[.,!?;:)\]}>]+$/
const LINE_SPLIT_RE = /\r\n|[\r\n\u{2028}\u{2029}]/u
const IPV4_RE = /^\d+(?:\.\d+){3}$/
const SUBDOMAIN_LABEL_RE = /^[a-z0-9-]{1,63}$/
const POST_ID_RE = /^[1-9]\d{0,15}$/
/** Top-level names that never belong to a public Substack publication. */
const RESERVED_TLDS = new Set(['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion', 'arpa', 'home', 'corp', 'lan'])
const RESERVED_DOMAIN_RE = /(?:^|\.)example\.(?:com|net|org)$/

function invalid(reason: string): ParsedInput {
  return { kind: 'invalid', reason }
}

/** null when `hostname` (already lowercase, no trailing dot) is a usable public host. */
function hostProblem(hostname: string): string | null {
  if (hostname.startsWith('[') || IPV4_RE.test(hostname)) return INVALID_REASONS.ip
  if (!HOST_RE.test(hostname)) return INVALID_REASONS.host
  const tld = hostname.slice(hostname.lastIndexOf('.') + 1)
  if (RESERVED_TLDS.has(tld) || RESERVED_DOMAIN_RE.test(hostname)) return INVALID_REASONS.reserved
  return null
}

/**
 * A bare host name -> lowercase ASCII (punycode via URL), trailing dot
 * removed. null for anything with a scheme, path, port, userinfo or
 * percent-escape, IP literals, reserved names and invalid DNS names.
 */
export function normalizeHost(host: string): string | null {
  if (typeof host !== 'string') return null
  const value = host.trim()
  if (!value || value.length > 300 || CONTROL_RE.test(value) || /[\s/\\?#@:%[\]]/.test(value)) return null
  let hostname: string
  try {
    hostname = new URL(`https://${value}/`).hostname
  } catch {
    return null
  }
  hostname = hostname.replace(/\.$/, '')
  return hostProblem(hostname) ? null : hostname
}

/**
 * `www.` + host for a custom domain typed without it (C4: the phone retries
 * once with this host when the bare one fails with HOST_NOT_SUBSTACK).
 * null for *.substack.com hosts, hosts that already start with www., and
 * anything normalizeHost rejects.
 */
export function wwwAlternative(host: string): string | null {
  const value = normalizeHost(host)
  if (!value || value.startsWith('www.') || value === 'substack.com' || value.endsWith('.substack.com')) return null
  return normalizeHost(`www.${value}`)
}

function parseHandle(raw: string): ParsedInput {
  const handle = raw.replace(HANDLE_TRAILING_RE, '')
  return HANDLE_RE.test(handle) ? { kind: 'handle', handle } : invalid(INVALID_REASONS.handle)
}

function parseSearch(text: string): ParsedInput {
  const query = text.replace(/\s+/g, ' ').trim()
  if (query.length < SEARCH_MIN_CHARS) return invalid(INVALID_REASONS.searchShort)
  if (query.length > SEARCH_MAX_CHARS) return invalid(INVALID_REASONS.searchLong)
  return { kind: 'search', query }
}

function postIdOf(digits: string | null | undefined): ParsedInput {
  if (!digits || !POST_ID_RE.test(digits)) return invalid(INVALID_REASONS.postId)
  const id = Number(digits)
  return Number.isSafeInteger(id) ? { kind: 'postId', id } : invalid(INVALID_REASONS.postId)
}

/** Any path on a publication host: /p/<slug>[/...] is a post, everything else the publication. */
function publicationPath(host: string, path: string): ParsedInput {
  const post = /^\/p\/([^/]+)(?:\/.*)?$/.exec(path)
  if (!post) return { kind: 'publication', host }
  const slug = post[1]!
  return SLUG_RE.test(slug) ? { kind: 'post', host, slug } : invalid(INVALID_REASONS.slug)
}

/** substack.com (and www., and open. outside /pub/): post ids and @handles only. */
function substackComPath(url: URL): ParsedInput {
  const path = url.pathname
  const byHome = /^\/(?:home\/post|@[^/]+)\/p-(\d+)(?:\/.*)?$/.exec(path)
  if (byHome) return postIdOf(byHome[1])
  const byInbox = /^\/inbox\/post\/(\d+)(?:\/.*)?$/.exec(path)
  if (byInbox) return postIdOf(byInbox[1])
  if (path === '/app-link/post' && url.searchParams.has('post_id')) return postIdOf(url.searchParams.get('post_id'))
  const profile = /^\/@([^/]+)(?:\/.*)?$/.exec(path)
  if (profile) return parseHandle(profile[1]!)
  return invalid(INVALID_REASONS.notPublication)
}

/** open.substack.com/pub/<subdomain>[/p/<slug>] -> <subdomain>.substack.com. */
function openSubstackPath(url: URL): ParsedInput {
  const pub = /^\/pub\/([^/]+)(?:\/(.*))?$/.exec(url.pathname)
  if (!pub) return substackComPath(url)
  const label = pub[1]!.toLowerCase()
  const host = `${label}.substack.com`
  if (!SUBDOMAIN_LABEL_RE.test(label) || !SUBSTACK_SUBDOMAIN_HOST_RE.test(host) || hostProblem(host)) {
    return invalid(INVALID_REASONS.notSubstack)
  }
  return publicationPath(host, `/${pub[2] ?? ''}`)
}

/** An absolute http(s) URL candidate (already stripped of share-text punctuation). */
function parseUrl(candidate: string): ParsedInput {
  const raw = /^http:\/\//i.test(candidate) ? `https://${candidate.slice(7)}` : candidate
  const authority = /^https:\/\/([^/?#]*)/i.exec(raw)
  if (!authority) return invalid(INVALID_REASONS.notHttp)
  const auth = authority[1]!
  // Explicit authority checks: URL normalization would hide default ports and
  // turn backslashes into slashes.
  if (auth.includes('@')) return invalid(INVALID_REASONS.userinfo)
  if (auth.startsWith('[')) return invalid(INVALID_REASONS.ip)
  if (auth.includes(':')) return invalid(INVALID_REASONS.port)
  if (!auth || auth.includes('\\') || auth.includes('%')) return invalid(INVALID_REASONS.host)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return invalid(INVALID_REASONS.host)
  }
  if (url.protocol !== 'https:' || url.username || url.password) return invalid(INVALID_REASONS.userinfo)
  if (url.port) return invalid(INVALID_REASONS.port)
  // The path as typed must survive normalization unchanged: rejects dot
  // segments (also %2e), backslashes and characters URL would escape.
  const typedPath = /^https:\/\/[^/?#]*(\/[^?#]*)?/i.exec(raw)?.[1] ?? '/'
  if (typedPath !== url.pathname) return invalid(INVALID_REASONS.path)
  const host = url.hostname.replace(/\.$/, '')
  const problem = hostProblem(host)
  if (problem) return invalid(problem)
  if (host === 'substack.com' || host === 'www.substack.com') return substackComPath(url)
  if (host === 'open.substack.com') return openSubstackPath(url)
  if (host.endsWith('.substack.com') && !SUBSTACK_SUBDOMAIN_HOST_RE.test(host)) return invalid(INVALID_REASONS.notSubstack)
  return publicationPath(host, url.pathname)
}

/**
 * One pasted value: a link (or share text containing exactly one link), a
 * bare domain, an @handle, or a search phrase.
 */
export function parseSubstackInput(input: string): ParsedInput {
  if (typeof input !== 'string') return invalid(INVALID_REASONS.empty)
  if (input.length > MAX_INPUT_CHARS) return invalid(INVALID_REASONS.tooLong)
  const text = input.trim()
  if (!text) return invalid(INVALID_REASONS.empty)
  if (CONTROL_RE.test(text) || UNSAFE_SCHEME_RE.test(text)) return invalid(INVALID_REASONS.unsafe)

  const urls = text.match(SCHEME_URL_RE) ?? []
  if (urls.length) {
    if (urls.some(url => !/^https?:\/\//i.test(url))) return invalid(INVALID_REASONS.notHttp)
    if (urls.length > 1) return invalid(INVALID_REASONS.manyLinks)
    return parseUrl(urls[0]!.replace(TRAILING_PUNCT_RE, ''))
  }
  if (HAS_SCHEME_RE.test(text)) return invalid(INVALID_REASONS.notHttp)

  if (text.startsWith('@')) return parseHandle(text.slice(1))
  const hasSpace = /\s/.test(text)
  if (!hasSpace && text.includes('.')) return parseUrl(`https://${text.replace(TRAILING_PUNCT_RE, '')}`)
  if (!hasSpace && /[/\\:@[\]]/.test(text)) return invalid(INVALID_REASONS.notPublication)
  return parseSearch(text)
}

function resultKey(parsed: ParsedInput): string | null {
  switch (parsed.kind) {
    case 'publication': return `publication ${parsed.host}`
    case 'post': return `post ${parsed.host} ${parsed.slug}`
    case 'postId': return `postId ${parsed.id}`
    case 'handle': return `handle ${parsed.handle.toLowerCase()}`
    case 'search': return `search ${parsed.query.toLowerCase()}`
    case 'invalid': return null
  }
}

/**
 * One result per non-empty line (at most MAX_LINES), duplicates removed.
 * When the paste contains a link, plain-text lines are share-text
 * decoration (a title, "Check this out") and are dropped instead of being
 * turned into searches.
 */
export function parseMany(input: string): ParsedInput[] {
  if (typeof input !== 'string' || !input.trim()) return []
  if (input.length > MAX_PASTE_CHARS) return [invalid(INVALID_REASONS.tooLong)]
  const lines = input.split(LINE_SPLIT_RE).map(line => line.trim()).filter(Boolean)
  const hasLink = lines.some(line => HAS_SCHEME_RE.test(line))
  const results: ParsedInput[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const parsed = parseSubstackInput(line)
    if (hasLink && parsed.kind === 'search') continue
    const key = resultKey(parsed)
    if (key !== null) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    results.push(parsed)
    if (results.length >= MAX_LINES) break
  }
  return results
}
