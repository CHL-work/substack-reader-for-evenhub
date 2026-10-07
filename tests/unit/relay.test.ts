import { test } from 'node:test'
import assert from 'node:assert/strict'
import relayDefault, { CACHE_PATH, USER_AGENT, createRelay, type CacheLike, type Env, type Relay, type RelayOptions } from '../../worker/relay'
import { version } from '../../package.json'
import type {
  ArchivePage,
  HealthResponse,
  PostDetail,
  PostResponse,
  PostSummary,
  Profile,
  PubMeta,
  RelayEnvelope,
  RelayError,
  RelayMeta,
  RelayUpstreamInfo,
  SearchResponse,
} from '../../src/substack/types'
import { createFakeClock, fetchCalls, jsonResponse, stubFetch } from './helpers'
import archiveFixture from '../fixtures/relay/archive.json'
import postFreeFixture from '../fixtures/relay/post-free.json'
import postPaidPreviewFixture from '../fixtures/relay/post-paid-preview.json'
import postPaidNullFixture from '../fixtures/relay/post-paid-null.json'
import byIdFixture from '../fixtures/relay/by-id.json'
import profileFixture from '../fixtures/relay/profile.json'
import topSearchFixture from '../fixtures/relay/top-search.json'

/* ------------------------------------------------------------------ helpers */

const RELAY_ORIGIN = 'https://relay.example.com'
/** S4: synthetic cache keys live under the relay's own origin. */
const CACHE_NS = `${RELAY_ORIGIN}${CACHE_PATH}`
const FINGERPRINT: Record<string, string> = { 'x-served-by': 'Substack', 'x-cluster': 'substack' }
const TARGET = 'target.substack-custom-domains.com'
const CNAME_TO_TARGET = [{ type: 5, data: `${TARGET}.` }]
const JSON_TYPE = 'application/json; charset=utf-8'
const FEED_TYPE = 'text/plain; charset=utf-8'
const SANDBOX_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'"
/** A Workers `request.cf` object: the request came through Cloudflare's edge (S7). */
const CF = { colo: 'TST', country: 'NL' }

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>
/** RequestInit plus `cf`, which (as on Workers) is attached to the Request as `request.cf`. */
type CallInit = RequestInit & { cf?: Record<string, unknown> }

function newRelay(options: RelayOptions = {}): Relay {
  return createRelay({ cache: null, ...options })
}

/** Stub globalThis.fetch with an exact-URL table; any other URL fails the test. */
async function withUpstream(table: Record<string, Handler>, body: () => Promise<void>): Promise<void> {
  const unexpected: string[] = []
  const restore = stubFetch((url, init) => {
    const handler = Object.prototype.hasOwnProperty.call(table, url) ? table[url] : undefined
    if (!handler) {
      unexpected.push(url)
      throw new TypeError(`Unexpected upstream request in test: ${url}`)
    }
    return handler(init)
  })
  try {
    await body()
  } finally {
    restore()
  }
  assert.deepEqual(unexpected, [])
}

function substackJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return jsonResponse(data, status, { ...FINGERPRINT, 'set-cookie': 'ab_testing_id=synthetic; Path=/; Secure', ...headers })
}

function redirectTo(location: string | null, status = 301, headers: Record<string, string> = FINGERPRINT): Response {
  return new Response(null, { status, headers: location === null ? headers : { ...headers, location } })
}

function html(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
}

function dns(answers: Array<{ type: number; data: string }>, status = 0): Response {
  const body = { Status: status, TC: false, RD: true, RA: true, AD: false, CD: false, Answer: answers.map(answer => ({ name: 'synthetic.', TTL: 300, ...answer })) }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } })
}

function dohUrl(name: string, type: 'CNAME' | 'A' | 'AAAA'): string {
  return `https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`
}

function archiveUrl(host: string, offset = 0, limit = 12, sort = 'new'): string {
  return `https://${host}/api/v1/archive?sort=${sort}&search=&offset=${offset}&limit=${limit}`
}

function proofUrl(host: string): string {
  return `https://${host}/api/v1/archive?sort=new&offset=0&limit=1`
}

const TARGET_DNS: Record<string, Handler> = {
  [dohUrl(TARGET, 'A')]: () => dns([{ type: 1, data: '198.51.100.7' }]),
  [dohUrl(TARGET, 'AAAA')]: () => dns([{ type: 28, data: '2001:db8::7' }]),
}

/** DNS for a host that neither CNAMEs to the target nor shares its addresses. */
function plainDns(host: string): Record<string, Handler> {
  return {
    [dohUrl(host, 'CNAME')]: () => dns([]),
    [dohUrl(host, 'A')]: () => dns([{ type: 1, data: '203.0.113.10' }]),
    [dohUrl(host, 'AAAA')]: () => dns([]),
  }
}

/** An archive page whose byline names a publication with custom domain `host` and this subdomain. */
function claimFor(host: string, subdomain: string): unknown[] {
  return [{
    id: 2,
    publication_id: 77,
    slug: 'claim',
    publishedBylines: [{ id: 1, name: 'X', publicationUsers: [{ id: 1, publication_id: 77, publication: { id: 77, name: 'X', subdomain, custom_domain: host, custom_domain_optional: false } }] }],
  }]
}

function hung(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) {
      reject(new Error('The relay must pass an AbortSignal.'))
      return
    }
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
  })
}

function assertCommonHeaders(res: Response): void {
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
  assert.equal(res.headers.get('access-control-max-age'), '86400')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(res.headers.get('access-control-allow-credentials'), null)
  assert.equal(res.headers.get('set-cookie'), null)
  // S1: everything but the two HTML pages (which carry their own CSP) is sandboxed.
  if (!res.headers.get('content-type')?.startsWith('text/html')) assert.equal(res.headers.get('content-security-policy'), SANDBOX_CSP)
}

function assertUpstreamInit(init: RequestInit | undefined, accept: string): void {
  if (!init) throw new Error('fetch must receive an init object')
  assert.equal(init.method, 'GET')
  assert.equal(init.redirect, 'manual')
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(init.body, undefined)
  assert.equal(init.credentials, undefined)
  assert.deepEqual(init.headers, { 'User-Agent': USER_AGENT, Accept: accept })
}

function relayRequest(url: string, init: CallInit = {}): Request {
  const { cf, ...rest } = init
  const request = new Request(url, rest)
  if (cf) Object.defineProperty(request, 'cf', { value: cf, enumerable: true })
  return request
}

async function call(relay: Relay, path: string, init: CallInit = {}, env?: Env): Promise<{ res: Response; text: string }> {
  const res = await relay.fetch(relayRequest(`${RELAY_ORIGIN}${path}`, init), env)
  assertCommonHeaders(res)
  return { res, text: await res.text() }
}

async function expectOk<T>(relay: Relay, path: string, init: CallInit = {}, env?: Env): Promise<{ res: Response; data: T; meta: RelayMeta }> {
  const { res, text } = await call(relay, path, init, env)
  assert.equal(res.status, 200, text)
  assert.equal(res.headers.get('content-type'), JSON_TYPE)
  const body = JSON.parse(text) as RelayEnvelope<T>
  if (!body.ok) throw new Error(`Expected success for ${path}, got ${text}`)
  return { res, data: body.data, meta: body.meta }
}

async function expectError(relay: Relay, path: string, status: number, code: string, init: CallInit = {}, env?: Env): Promise<{ res: Response; error: RelayError; text: string }> {
  const { res, text } = await call(relay, path, init, env)
  assert.equal(res.status, status, `${path}: ${text}`)
  assert.equal(res.headers.get('content-type'), JSON_TYPE)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = JSON.parse(text) as RelayEnvelope<unknown>
  if (body.ok) throw new Error(`Expected ${code} for ${path}, got ${text}`)
  assert.equal(body.error.code, code, `${path}: ${text}`)
  assert.equal(typeof body.error.message, 'string')
  return { res, error: body.error, text }
}

/* ------------------------------------------------------------------ expected shapes */

const EXAMPLE_LETTERS: PubMeta = {
  id: 424242,
  name: 'Example Letters',
  subdomain: 'exampleletters',
  customDomain: 'news.example.com',
  host: 'news.example.com',
}

const ARCHIVE_POSTS: PostSummary[] = [
  {
    id: 9001,
    publicationId: 424242,
    slug: 'the-first-synthetic-post',
    title: 'The First Synthetic Post',
    subtitle: 'An invented subtitle for testing.',
    postDate: '2026-10-01T12:00:00.000Z',
    audience: 'everyone',
    isPaywalled: false,
    type: 'newsletter',
    wordcount: 1150,
    canonicalUrl: 'https://news.example.com/p/the-first-synthetic-post',
    authors: ['Ada Example', 'Bo Sample'],
    podcastDurationSec: null,
  },
  {
    id: 9002,
    publicationId: 424242,
    slug: 'second-synthetic-post',
    title: 'Second Synthetic Post',
    subtitle: null,
    postDate: '2026-09-24T08:30:00.000Z',
    audience: 'only_paid',
    isPaywalled: true,
    type: 'podcast',
    wordcount: 300,
    canonicalUrl: 'https://news.example.com/p/second-synthetic-post',
    authors: ['Ada Example'],
    podcastDurationSec: 1835,
  },
  {
    id: 9003,
    publicationId: 424242,
    slug: 'third-synthetic-post',
    title: 'Third Synthetic Post',
    subtitle: null,
    postDate: '2026-09-20T18:00:00.000Z',
    audience: 'founding',
    isPaywalled: true,
    type: 'thread',
    wordcount: null,
    canonicalUrl: 'https://news.example.com/p/third-synthetic-post',
    authors: [],
    podcastDurationSec: null,
  },
]

/* ------------------------------------------------------------------ tests */

test('upstream User-Agent is exactly SubstackReaderForEvenHub/<version> with no URL (C2)', () => {
  assert.equal(USER_AGENT, `SubstackReaderForEvenHub/${version}`)
  assert.doesNotMatch(USER_AGENT, /https?:|\/\/|\(|\)|\s/)
})

test('archive: a 301 to a verified custom domain is followed; posts and publication are trimmed exactly', async () => {
  const relay = newRelay({ now: createFakeClock(1_700_000_000_000).now })
  await withUpstream({
    [archiveUrl('exampleletters.substack.com')]: () => redirectTo(archiveUrl('news.example.com')),
    [dohUrl('news.example.com', 'CNAME')]: () => dns(CNAME_TO_TARGET),
    [archiveUrl('news.example.com')]: () => substackJson(archiveFixture),
  }, async () => {
    const { res, data, meta } = await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com')
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60')
    assert.deepEqual(meta, { host: 'news.example.com', cached: false, fetchedAt: new Date(1_700_000_000_000).toISOString() })
    assert.deepEqual(data, { publication: EXAMPLE_LETTERS, posts: ARCHIVE_POSTS, nextOffset: 3 })
    assert.deepEqual(fetchCalls.map(entry => entry.url), [
      archiveUrl('exampleletters.substack.com'),
      dohUrl('news.example.com', 'CNAME'),
      archiveUrl('news.example.com'),
    ])
    for (const entry of fetchCalls) {
      assertUpstreamInit(entry.init, entry.url.startsWith('https://cloudflare-dns.com/') ? 'application/dns-json' : 'application/json')
    }
  })
})

test('archive: limit is clamped to 1..20, short pages still page on, only an empty page ends (C1)', async () => {
  const relay = newRelay()
  const host = 'exampleletters.substack.com'
  await withUpstream({
    [archiveUrl(host, 24, 20, 'top')]: () => substackJson(archiveFixture),
    [archiveUrl(host, 0, 1)]: () => substackJson([]),
    [archiveUrl(host, 12, 12)]: () => substackJson([...archiveFixture, { id: 'not-a-number', slug: 'junk' }, { id: 9004 }]),
    [archiveUrl(host, 4999, 12)]: () => substackJson(archiveFixture),
  }, async () => {
    const short = await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}&offset=24&limit=25&sort=top`)
    assert.equal(short.meta.host, host)
    assert.equal(short.data.posts.length, 3)
    assert.equal(short.data.nextOffset, 27, 'fewer posts than the limit is not the end of the list')
    assert.equal(short.data.posts[2].canonicalUrl, `https://${host}/p/third-synthetic-post`, 'missing canonical_url falls back to the host')
    const empty = await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}&limit=0`)
    assert.deepEqual(empty.data, { publication: null, posts: [], nextOffset: null })
    const junk = await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}&offset=12`)
    assert.deepEqual(junk.data.posts.map(post => post.id), [9001, 9002, 9003])
    assert.equal(junk.data.nextOffset, 17, 'the offset advances by every upstream item, kept or not')
    const last = await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}&offset=4999`)
    assert.equal(last.data.nextOffset, null, 'never point past the relay offset limit')
  })
})

test('every route validates its parameters before any upstream request', async () => {
  const relay = newRelay()
  const cases: Array<[string, string]> = [
    ['/v1/archive', 'INVALID_HOST'],
    ['/v1/archive?host=', 'INVALID_HOST'],
    ['/v1/archive?host=https%3A%2F%2Fexampleletters.substack.com', 'INVALID_HOST'],
    ['/v1/archive?host=exampleletters.substack.com%2Fevil', 'INVALID_HOST'],
    ['/v1/archive?host=exampleletters.substack.com%3A8443', 'INVALID_HOST'],
    ['/v1/archive?host=user%40exampleletters.substack.com', 'INVALID_HOST'],
    ['/v1/archive?host=127.0.0.1', 'INVALID_HOST'],
    ['/v1/archive?host=%5B%3A%3A1%5D', 'INVALID_HOST'],
    ['/v1/archive?host=localhost', 'INVALID_HOST'],
    ['/v1/archive?host=printer.local', 'INVALID_HOST'],
    ['/v1/archive?host=metadata.internal', 'INVALID_HOST'],
    ['/v1/archive?host=pub.test', 'INVALID_HOST'],
    ['/v1/archive?host=pub.invalid', 'INVALID_HOST'],
    ['/v1/archive?host=substack.com', 'INVALID_HOST'],
    ['/v1/archive?host=www.substack.com', 'INVALID_HOST'],
    ['/v1/archive?host=exampleletters.substack.com&offset=-1', 'INVALID_PARAM'],
    ['/v1/archive?host=exampleletters.substack.com&offset=1.5', 'INVALID_PARAM'],
    ['/v1/archive?host=exampleletters.substack.com&offset=5001', 'INVALID_PARAM'],
    ['/v1/archive?host=exampleletters.substack.com&limit=ten', 'INVALID_PARAM'],
    ['/v1/archive?host=exampleletters.substack.com&sort=old', 'INVALID_PARAM'],
    ['/v1/post', 'INVALID_PARAM'],
    ['/v1/post?slug=a-post', 'INVALID_HOST'],
    ['/v1/post?host=exampleletters.substack.com', 'INVALID_SLUG'],
    ['/v1/post?host=exampleletters.substack.com&slug=..', 'INVALID_SLUG'],
    ['/v1/post?host=exampleletters.substack.com&slug=a%2Fb', 'INVALID_SLUG'],
    ['/v1/post?host=exampleletters.substack.com&slug=%2e%2e%2fadmin', 'INVALID_SLUG'],
    [`/v1/post?host=exampleletters.substack.com&slug=${'a'.repeat(201)}`, 'INVALID_SLUG'],
    ['/v1/post?id=0', 'INVALID_PARAM'],
    ['/v1/post?id=-5', 'INVALID_PARAM'],
    ['/v1/post?id=1e5', 'INVALID_PARAM'],
    ['/v1/post?id=9007199254740993', 'INVALID_PARAM'],
    // C3: Substack's by-id endpoint answers 400 above the signed 32-bit range.
    ['/v1/post?id=2147483648', 'INVALID_PARAM'],
    ['/v1/post?id=99999999999', 'INVALID_PARAM'],
    ['/v1/post?id=02147483647', 'INVALID_PARAM'],
    ['/v1/post?id=9001&host=exampleletters.substack.com&slug=a-post', 'INVALID_PARAM'],
    ['/v1/profile', 'INVALID_HANDLE'],
    ['/v1/profile?handle=..', 'INVALID_HANDLE'],
    ['/v1/profile?handle=.', 'INVALID_HANDLE'],
    ['/v1/profile?handle=a%2Fb', 'INVALID_HANDLE'],
    ['/v1/profile?handle=two%20words', 'INVALID_HANDLE'],
    [`/v1/profile?handle=${'h'.repeat(65)}`, 'INVALID_HANDLE'],
    ['/v1/search', 'INVALID_QUERY'],
    ['/v1/search?q=a', 'INVALID_QUERY'],
    ['/v1/search?q=%20%20a%20%20', 'INVALID_QUERY'],
    [`/v1/search?q=${'q'.repeat(101)}`, 'INVALID_QUERY'],
    ['/v1/search?q=ab%00cd', 'INVALID_QUERY'],
    ['/v1/feed', 'INVALID_HOST'],
    ['/v1/feed?host=substack.com', 'INVALID_HOST'],
    ['/v1/feed?host=bad_host.com', 'INVALID_HOST'],
  ]
  await withUpstream({}, async () => {
    for (const [path, code] of cases) await expectError(relay, path, 400, code)
    assert.equal(fetchCalls.length, 0)
  })
})

test('IDN hosts: punycode TLDs are publication hosts, malformed ones are refused (C6)', async () => {
  const relay = newRelay()
  const idn = 'xn--e1afmkfd.xn--p1ai'
  await withUpstream({
    [dohUrl(idn, 'CNAME')]: () => dns(CNAME_TO_TARGET),
    [archiveUrl(idn)]: () => substackJson([]),
  }, async () => {
    const { data, meta } = await expectOk<ArchivePage>(relay, `/v1/archive?host=${idn}`)
    assert.equal(meta.host, idn)
    assert.deepEqual(data, { publication: null, posts: [], nextOffset: null })
    for (const bad of ['foo.xn--', 'foo.xn---', 'foo.xn--p1ai-', 'foo.xn--p1_ai']) {
      await expectError(relay, `/v1/archive?host=${bad}`, 400, 'INVALID_HOST')
    }
    assert.deepEqual(fetchCalls.map(entry => entry.url), [dohUrl(idn, 'CNAME'), archiveUrl(idn)])
  })
})

test('OPTIONS is 204, other methods are 405 and unknown paths 404, all with CORS headers', async () => {
  const relay = newRelay()
  await withUpstream({}, async () => {
    const preflight = await call(relay, '/v1/archive?host=exampleletters.substack.com', { method: 'OPTIONS' })
    assert.equal(preflight.res.status, 204)
    assert.equal(preflight.text, '')
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const { res } = await expectError(relay, '/v1/archive?host=exampleletters.substack.com', 405, 'METHOD_NOT_ALLOWED', { method })
      assert.equal(res.headers.get('allow'), 'GET, OPTIONS')
    }
    await expectError(relay, '/v1/nothing', 404, 'NOT_FOUND')
    await expectError(relay, '/v1/archive/', 404, 'NOT_FOUND')
    await expectError(relay, '/api/v1/archive?host=exampleletters.substack.com', 404, 'NOT_FOUND')
    assert.equal(fetchCalls.length, 0)
  })
})

test('GET / and /privacy serve static HTML with a strict CSP', async () => {
  const relay = newRelay()
  await withUpstream({}, async () => {
    for (const path of ['/', '/privacy']) {
      const { res, text } = await call(relay, path)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600')
      assert.match(text, /Reader for Substack/)
      assert.match(text, /not affiliated with Substack/)
      assert.match(text, /relay\.example\.com/, 'the pages name the relay domain')
      assert.doesNotMatch(text, /<script/i)
    }
    assert.equal(fetchCalls.length, 0)
  })
})

test('a Substack response without x-served-by or x-cluster is discarded as HOST_NOT_SUBSTACK', async () => {
  const relay = newRelay()
  const url = archiveUrl('exampleletters.substack.com')
  await withUpstream({ [url]: () => jsonResponse(archiveFixture) }, async () => {
    const { text, error } = await expectError(relay, '/v1/archive?host=exampleletters.substack.com', 403, 'HOST_NOT_SUBSTACK')
    assert.deepEqual(error.upstream, { status: 200, contentType: 'application/json', challenge: false })
    assert.doesNotMatch(text, /Synthetic/)
  })
  await withUpstream({ [url]: () => jsonResponse([], 200, { 'X-Cluster': 'SubStack' }) }, async () => {
    await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com')
  })
  await withUpstream({ [url]: () => jsonResponse([], 200, { 'X-Served-By': 'substack' }) }, async () => {
    await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com')
  })
})

test('custom domains: CNAME verdicts are cached for 24 h (pass) and 1 h (fail)', async () => {
  const clock = createFakeClock(1_000_000)
  const relay = newRelay({ now: clock.now })
  await withUpstream({
    [dohUrl('news.example.com', 'CNAME')]: () => dns(CNAME_TO_TARGET),
    [archiveUrl('news.example.com')]: () => substackJson(archiveFixture),
    [dohUrl('www.example.org', 'CNAME')]: () => dns([{ type: 5, data: 'elsewhere.example.net.' }]),
    [dohUrl('www.example.org', 'A')]: () => dns([{ type: 1, data: '192.0.2.10' }]),
    [dohUrl('www.example.org', 'AAAA')]: () => dns([]),
    ...TARGET_DNS,
    [proofUrl('www.example.org')]: () => html('<html>not substack</html>', 200),
  }, async () => {
    await expectOk<ArchivePage>(relay, '/v1/archive?host=news.example.com')
    await expectError(relay, '/v1/archive?host=www.example.org', 403, 'HOST_NOT_SUBSTACK')
    const urls = fetchCalls.map(entry => entry.url)
    assert.deepEqual(urls.filter(url => url.includes('news.example.com')), [dohUrl('news.example.com', 'CNAME'), archiveUrl('news.example.com')])
    assert.deepEqual(urls.filter(url => url.includes('www.example.org')).sort(), [
      dohUrl('www.example.org', 'A'),
      dohUrl('www.example.org', 'AAAA'),
      dohUrl('www.example.org', 'CNAME'),
      proofUrl('www.example.org'),
    ].sort())
    assert.equal(urls.includes(archiveUrl('www.example.org')), false, 'an unverified host is never fetched for content')

    fetchCalls.length = 0
    clock.advance(59 * 60_000)
    await expectOk<ArchivePage>(relay, '/v1/archive?host=news.example.com')
    await expectError(relay, '/v1/archive?host=www.example.org', 403, 'HOST_NOT_SUBSTACK')
    assert.deepEqual(fetchCalls.map(entry => entry.url), [archiveUrl('news.example.com')], 'both verdicts come from memory')

    fetchCalls.length = 0
    clock.advance(2 * 60_000) // 61 minutes: the fail verdict expired, the pass verdict did not.
    await expectOk<ArchivePage>(relay, '/v1/archive?host=news.example.com')
    await expectError(relay, '/v1/archive?host=www.example.org', 403, 'HOST_NOT_SUBSTACK')
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl('news.example.com', 'CNAME')).length, 0)
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl('www.example.org', 'CNAME')).length, 1)

    fetchCalls.length = 0
    clock.advance(24 * 3_600_000)
    await expectOk<ArchivePage>(relay, '/v1/archive?host=news.example.com')
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl('news.example.com', 'CNAME')).length, 1)
  })
})

test('custom domains: A/AAAA records shared with the Substack target pass (apex flattening, C4b)', async () => {
  const relay = newRelay()
  await withUpstream({
    [dohUrl('letters.example.net', 'CNAME')]: () => dns([]),
    [dohUrl('letters.example.net', 'A')]: () => dns([{ type: 1, data: '203.0.113.8' }, { type: 1, data: '198.51.100.7' }]),
    [dohUrl('letters.example.net', 'AAAA')]: () => dns([]),
    [dohUrl('chain.example.net', 'CNAME')]: () => dns([{ type: 5, data: 'pub.provider.example.net.' }]),
    [dohUrl('chain.example.net', 'A')]: () => dns([
      { type: 5, data: 'pub.provider.example.net.' },
      { type: 5, data: 'TARGET.substack-custom-domains.com' },
      { type: 1, data: '203.0.113.99' },
    ]),
    [dohUrl('chain.example.net', 'AAAA')]: () => dns([]),
    ...TARGET_DNS,
    [archiveUrl('letters.example.net')]: () => substackJson([]),
    [archiveUrl('chain.example.net')]: () => substackJson([]),
  }, async () => {
    const flattened = await expectOk<ArchivePage>(relay, '/v1/archive?host=letters.example.net')
    assert.equal(flattened.meta.host, 'letters.example.net')
    assert.deepEqual(flattened.data, { publication: null, posts: [], nextOffset: null })
    const chained = await expectOk<ArchivePage>(relay, '/v1/archive?host=chain.example.net')
    assert.equal(chained.meta.host, 'chain.example.net')
    assert.equal(fetchCalls.some(entry => entry.url.endsWith('&offset=0&limit=1')), false, 'no mapping proof was needed')
  })
})

test('custom domains: Substack mapping proof passes when S.substack.com redirects to the host (C4c)', async () => {
  const relay = newRelay()
  const host = 'apex.example.net'
  const claim = [{
    id: 1,
    publication_id: 4343,
    slug: 'claim-post',
    title: 'Claim',
    audience: 'everyone',
    publishedBylines: [{
      id: 9,
      name: 'Ann Example',
      publicationUsers: [{
        id: 3,
        publication_id: 4343,
        publication: { id: 4343, name: 'Apex Pub', subdomain: 'apexpub', custom_domain: host, custom_domain_optional: false },
      }],
    }],
  }]
  await withUpstream({
    ...plainDns(host),
    ...TARGET_DNS,
    [proofUrl(host)]: () => substackJson(claim),
    [proofUrl('apexpub.substack.com')]: () => redirectTo(proofUrl(host), 301),
    [archiveUrl(host)]: () => substackJson(claim),
  }, async () => {
    const { meta, data } = await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}`)
    assert.equal(meta.host, host)
    assert.deepEqual(data.publication, { id: 4343, name: 'Apex Pub', subdomain: 'apexpub', customDomain: host, host })
    for (const entry of fetchCalls) {
      assertUpstreamInit(entry.init, entry.url.startsWith('https://cloudflare-dns.com/') ? 'application/dns-json' : 'application/json')
    }
  })
})

test('custom domains: a failed proof is HOST_NOT_SUBSTACK; lookup outages are 503, remembered 60 s in memory only', async () => {
  const clock = createFakeClock(1_000_000)
  const cache = memoryCache()
  const relay = newRelay({ cache, now: clock.now })
  const offline = (): Response => {
    throw new TypeError('network down')
  }
  await withUpstream({
    ...TARGET_DNS,
    ...plainDns('mirror.example.net'),
    [proofUrl('mirror.example.net')]: () => substackJson(claimFor('mirror.example.net', 'mirrorpub')),
    // A relative Location resolves against the request URL, i.e. back to mirrorpub.substack.com.
    [proofUrl('mirrorpub.substack.com')]: () => redirectTo('/api/v1/archive?sort=new&offset=0&limit=1', 302),
    ...plainDns('plain.example.net'),
    [proofUrl('plain.example.net')]: () => jsonResponse(claimFor('plain.example.net', 'plainpub')),
    [dohUrl('down.example.net', 'CNAME')]: offline,
    [dohUrl('down.example.net', 'A')]: offline,
    [dohUrl('down.example.net', 'AAAA')]: offline,
    [proofUrl('down.example.net')]: offline,
  }, async () => {
    await expectError(relay, '/v1/archive?host=mirror.example.net', 403, 'HOST_NOT_SUBSTACK')
    await expectError(relay, '/v1/archive?host=plain.example.net', 403, 'HOST_NOT_SUBSTACK')
    assert.equal(fetchCalls.some(entry => entry.url === proofUrl('plainpub.substack.com')), false, 'an unfingerprinted claim is never followed up')
    assert.deepEqual(JSON.parse(cache.entries.get(`${CACHE_NS}/host-verdict?host=mirror.example.net`)?.body ?? 'null'), { verdict: 'fail', expires: 1_000_000 + 3_600_000 })
    await expectError(relay, '/v1/archive?host=down.example.net', 503, 'UPSTREAM_UNAVAILABLE')
    // S6: the inconclusive check is remembered for 60 s, so a retry makes no lookups or proof request.
    clock.advance(59_000)
    await expectError(relay, '/v1/archive?host=down.example.net', 503, 'UPSTREAM_UNAVAILABLE')
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl('down.example.net', 'CNAME')).length, 1)
    assert.equal(fetchCalls.filter(entry => entry.url === proofUrl('down.example.net')).length, 1)
    clock.advance(2_000)
    await expectError(relay, '/v1/archive?host=down.example.net', 503, 'UPSTREAM_UNAVAILABLE')
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl('down.example.net', 'CNAME')).length, 2)
    assert.equal([...cache.entries.keys()].some(key => key.includes('down.example.net')), false, 'unknown is never put in the Cache API')
  })
})

test('custom domains: a host without addresses fails for 10 min without any request to it (S3)', async () => {
  const clock = createFakeClock(2_000_000)
  const cache = memoryCache()
  const relay = newRelay({ cache, now: clock.now })
  const typo = 'www.slowbornig.example.net'
  const dangling = 'gone.example.net'
  await withUpstream({
    ...TARGET_DNS,
    // NXDOMAIN (Status 3) is a definitive answer.
    [dohUrl(typo, 'CNAME')]: () => dns([], 3),
    [dohUrl(typo, 'A')]: () => dns([], 3),
    [dohUrl(typo, 'AAAA')]: () => dns([], 3),
    // A CNAME to a name without addresses.
    [dohUrl(dangling, 'CNAME')]: () => dns([{ type: 5, data: 'lapsed.provider.example.net.' }]),
    [dohUrl(dangling, 'A')]: () => dns([{ type: 5, data: 'lapsed.provider.example.net.' }]),
    [dohUrl(dangling, 'AAAA')]: () => dns([{ type: 5, data: 'lapsed.provider.example.net.' }]),
  }, async () => {
    await expectError(relay, `/v1/archive?host=${typo}`, 403, 'HOST_NOT_SUBSTACK')
    await expectError(relay, `/v1/feed?host=${typo}`, 403, 'HOST_NOT_SUBSTACK')
    await expectError(relay, `/v1/archive?host=${dangling}`, 403, 'HOST_NOT_SUBSTACK')
    assert.equal(fetchCalls.filter(entry => !entry.url.startsWith('https://cloudflare-dns.com/')).length, 0, 'no proof request')
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl(typo, 'CNAME')).length, 1, 'the verdict is remembered')
    assert.deepEqual(JSON.parse(cache.entries.get(`${CACHE_NS}/host-verdict?host=${typo}`)?.body ?? 'null'), { verdict: 'fail', expires: 2_000_000 + 600_000 })
    clock.advance(601_000)
    await expectError(relay, `/v1/archive?host=${typo}`, 403, 'HOST_NOT_SUBSTACK')
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl(typo, 'CNAME')).length, 2, 'a domain set up since then is seen after 10 min')
  })
})

test('custom domains: Substack refusing the mapping proof is UPSTREAM_BLOCKED, never a cached failure (S5)', async () => {
  const clock = createFakeClock(3_000_000)
  const cache = memoryCache()
  const relay = newRelay({ cache, now: clock.now })
  const host = 'proxied.example.net'
  const claim = [{
    id: 5,
    publication_id: 66,
    slug: 'claim',
    publishedBylines: [{ id: 1, name: 'P', publicationUsers: [{ id: 2, publication_id: 66, publication: { id: 66, name: 'P', subdomain: 'proxiedpub', custom_domain: host, custom_domain_optional: false } }] }],
  }]
  let check: () => Response = () => html('blocked', 403)
  let first: () => Response = () => substackJson(claim)
  await withUpstream({
    ...TARGET_DNS,
    ...plainDns(host),
    [proofUrl(host)]: () => first(),
    [proofUrl('proxiedpub.substack.com')]: () => check(),
  }, async () => {
    const blocked = await expectError(relay, `/v1/archive?host=${host}`, 503, 'UPSTREAM_BLOCKED')
    assert.deepEqual(blocked.error.upstream, { status: 403, contentType: 'text/html', challenge: false })
    assert.equal([...cache.entries.keys()].some(key => key.includes(host)), false, 'the refusal is not stored')
    // Remembered 60 s in memory: same answer, no new requests.
    const calls = fetchCalls.length
    await expectError(relay, `/v1/archive?host=${host}`, 503, 'UPSTREAM_BLOCKED')
    assert.equal(fetchCalls.length, calls)

    clock.advance(61_000)
    check = () => html('challenge', 403, { 'cf-mitigated': 'challenge' })
    const challenged = await expectError(relay, `/v1/archive?host=${host}`, 503, 'UPSTREAM_BLOCKED')
    assert.deepEqual(challenged.error.upstream, { status: 403, contentType: 'text/html', challenge: true })

    // Y1: a refusal of the first request is Substack's when it carries Substack's fingerprint.
    clock.advance(61_000)
    first = () => html('denied', 401, FINGERPRINT)
    const denied = await expectError(relay, `/v1/archive?host=${host}`, 503, 'UPSTREAM_BLOCKED')
    assert.deepEqual(denied.error.upstream, { status: 401, contentType: 'text/html', challenge: false })

    clock.advance(61_000)
    first = () => html('forbidden', 403, FINGERPRINT)
    const forbidden = await expectError(relay, `/v1/archive?host=${host}`, 503, 'UPSTREAM_BLOCKED')
    assert.deepEqual(forbidden.error.upstream, { status: 403, contentType: 'text/html', challenge: false })

    clock.advance(61_000)
    first = () => html('busy', 503)
    await expectError(relay, `/v1/archive?host=${host}`, 503, 'UPSTREAM_UNAVAILABLE')
    assert.equal([...cache.entries.keys()].some(key => key.includes(host)), false)
  })
})

test('custom domains: the host refusing the proof without the Substack fingerprint is HOST_NOT_SUBSTACK for 60 s (Y1)', async () => {
  const clock = createFakeClock(4_000_000)
  const cache = memoryCache()
  const relay = newRelay({ cache, now: clock.now })
  // An apex behind its owner's WAF (only www is on Substack), or any other site that refuses bots.
  const host = 'walled.example.net'
  const stored = () => JSON.parse(cache.entries.get(`${CACHE_NS}/host-verdict?host=${host}`)?.body ?? 'null')
  let first: () => Response = () => html('denied', 403)
  await withUpstream({
    ...TARGET_DNS,
    ...plainDns(host),
    [proofUrl(host)]: () => first(),
  }, async () => {
    const refused = await expectError(relay, `/v1/archive?host=${host}`, 403, 'HOST_NOT_SUBSTACK')
    assert.equal(refused.error.upstream, undefined)
    assert.deepEqual(stored(), { verdict: 'fail', expires: 4_000_000 + 60_000 })
    // Remembered for the minute: no new request.
    const calls = fetchCalls.length
    await expectError(relay, `/v1/feed?host=${host}`, 403, 'HOST_NOT_SUBSTACK')
    assert.equal(fetchCalls.length, calls)

    clock.advance(61_000)
    first = () => html('challenge', 403, { 'cf-mitigated': 'challenge' })
    await expectError(relay, `/v1/archive?host=${host}`, 403, 'HOST_NOT_SUBSTACK')
    assert.deepEqual(stored(), { verdict: 'fail', expires: 4_061_000 + 60_000 })

    clock.advance(61_000)
    first = () => html('denied', 401)
    await expectError(relay, `/v1/archive?host=${host}`, 403, 'HOST_NOT_SUBSTACK')
    assert.deepEqual(stored(), { verdict: 'fail', expires: 4_122_000 + 60_000 })
    assert.equal(fetchCalls.filter(entry => entry.url === proofUrl(host)).length, 3)
  })
})

test('custom domains: definitive DNS and no HTTPS answer fails for 10 min; a timeout or 502 stays inconclusive (Y3)', async () => {
  const clock = createFakeClock(5_000_000)
  const cache = memoryCache()
  const relay = newRelay({ cache, now: clock.now, timeoutMs: 25 })
  const parked = 'parked.example.net'
  const noOrigin = 'noorigin.example.net'
  const busy = 'busy.example.net'
  const slow = 'slow.example.net'
  const stored = (host: string) => JSON.parse(cache.entries.get(`${CACHE_NS}/host-verdict?host=${host}`)?.body ?? 'null')
  await withUpstream({
    ...TARGET_DNS,
    ...plainDns(parked),
    [proofUrl(parked)]: () => {
      throw new TypeError('connection refused')
    },
    ...plainDns(noOrigin),
    [proofUrl(noOrigin)]: () => html('origin DNS error', 530),
    ...plainDns(busy),
    [proofUrl(busy)]: () => html('bad gateway', 502),
    ...plainDns(slow),
    [proofUrl(slow)]: hung,
  }, async () => {
    await expectError(relay, `/v1/archive?host=${parked}`, 403, 'HOST_NOT_SUBSTACK')
    await expectError(relay, `/v1/archive?host=${noOrigin}`, 403, 'HOST_NOT_SUBSTACK')
    assert.deepEqual(stored(parked), { verdict: 'fail', expires: 5_000_000 + 600_000 })
    assert.deepEqual(stored(noOrigin), { verdict: 'fail', expires: 5_000_000 + 600_000 })
    // A domain proxied through its owner's zone shows unmarked 52x while Substack is down.
    await expectError(relay, `/v1/archive?host=${busy}`, 503, 'UPSTREAM_UNAVAILABLE')
    await expectError(relay, `/v1/archive?host=${slow}`, 503, 'UPSTREAM_UNAVAILABLE')
    assert.equal(stored(busy), null)
    assert.equal(stored(slow), null)
    clock.advance(599_000)
    await expectError(relay, `/v1/feed?host=${parked}`, 403, 'HOST_NOT_SUBSTACK')
    assert.equal(fetchCalls.filter(entry => entry.url === proofUrl(parked)).length, 1, 'remembered for 10 min')
  })
})

test('custom domains: mapping proofs, the only requests to caller-chosen hosts, have a strict budget (S6)', async () => {
  const clock = createFakeClock(0)
  const relay = newRelay({ now: clock.now, strictRateLimitPerMinute: 2 })
  const ip = { headers: { 'CF-Connecting-IP': '203.0.113.77' }, cf: CF }
  const hosts = ['one.example.net', 'two.example.net', 'three.example.net']
  const table: Record<string, Handler> = { ...TARGET_DNS, [dohUrl('cname.example.net', 'CNAME')]: () => dns(CNAME_TO_TARGET), [archiveUrl('cname.example.net')]: () => substackJson([]) }
  for (const host of hosts) Object.assign(table, plainDns(host), { [proofUrl(host)]: () => html('<html>not substack</html>', 200) })
  await withUpstream(table, async () => {
    await expectError(relay, `/v1/archive?host=${hosts[0]}`, 403, 'HOST_NOT_SUBSTACK', ip)
    await expectError(relay, `/v1/feed?host=${hosts[1]}`, 403, 'HOST_NOT_SUBSTACK', ip)
    const limited = await expectError(relay, `/v1/post?host=${hosts[2]}&slug=a-post`, 429, 'RATE_LIMITED', ip)
    assert.equal(limited.error.retryAfterSeconds, 30)
    assert.equal(fetchCalls.some(entry => entry.url === proofUrl(hosts[2])), false, 'no request reached the third host')
    // Remembered verdicts and DNS passes cost nothing from the strict budget; other clients have their own.
    await expectError(relay, `/v1/archive?host=${hosts[0]}`, 403, 'HOST_NOT_SUBSTACK', ip)
    await expectOk<ArchivePage>(relay, '/v1/archive?host=cname.example.net', ip)
    await expectError(relay, `/v1/archive?host=${hosts[2]}`, 403, 'HOST_NOT_SUBSTACK', { headers: { 'CF-Connecting-IP': '203.0.113.78' }, cf: CF })
    assert.equal(fetchCalls.filter(entry => entry.url === proofUrl(hosts[2])).length, 1)
  })
})

test('custom domains: a mapping proof that passes gives its strict token back; failing ones are still limited (Y2)', async () => {
  const ip: CallInit = { headers: { 'CF-Connecting-IP': '203.0.113.90' }, cf: CF }
  // Twelve genuine domains proxied through their owners' zones: only the proof can verify them.
  const genuine = Array.from({ length: 12 }, (_value, index) => `pub${index}.example.net`)
  const other = Array.from({ length: 11 }, (_value, index) => `other${index}.example.net`)
  const table: Record<string, Handler> = { ...TARGET_DNS }
  genuine.forEach((host, index) => Object.assign(table, plainDns(host), {
    [proofUrl(host)]: () => substackJson(claimFor(host, `genuine${index}`)),
    [proofUrl(`genuine${index}.substack.com`)]: () => redirectTo(proofUrl(host)),
    [archiveUrl(host)]: () => substackJson([]),
  }))
  for (const host of other) Object.assign(table, plainDns(host), { [proofUrl(host)]: () => html('<html>not substack</html>', 200) })
  await withUpstream(table, async () => {
    // A cold isolate without the Cache API, 10 proofs per minute: all twelve pass.
    const relay = newRelay({ now: createFakeClock(0).now })
    for (const host of genuine) await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}`, ip)
    assert.equal(fetchCalls.filter(entry => /^https:\/\/genuine\d+\.substack\.com\//.test(entry.url)).length, 12, 'every domain needed the proof')
    // The budget is whole again: ten failing proofs, then 429.
    for (const host of other.slice(0, 10)) await expectError(relay, `/v1/archive?host=${host}`, 403, 'HOST_NOT_SUBSTACK', ip)
    const limited = await expectError(relay, `/v1/archive?host=${other[10]}`, 429, 'RATE_LIMITED', ip)
    assert.equal(limited.error.retryAfterSeconds, 6)
    assert.equal(fetchCalls.some(entry => entry.url === proofUrl(other[10])), false)

    // RL_STRICT cannot refund: it is asked once, and each pass leaves a credit for the next proof.
    const strictKeys: string[] = []
    const env: Env = {
      RL_STRICT: {
        async limit({ key }) {
          strictKeys.push(key)
          return { success: strictKeys.length === 1 }
        },
      },
    }
    const bound = newRelay({ now: createFakeClock(0).now })
    for (const host of genuine) await expectOk<ArchivePage>(bound, `/v1/archive?host=${host}`, ip, env)
    assert.deepEqual(strictKeys, ['203.0.113.90:verify'])
    await expectError(bound, `/v1/archive?host=${other[0]}`, 403, 'HOST_NOT_SUBSTACK', ip, env)
    const refused = await expectError(bound, `/v1/archive?host=${other[1]}`, 429, 'RATE_LIMITED', ip, env)
    assert.equal(refused.error.retryAfterSeconds, 60)
    assert.deepEqual(strictKeys, ['203.0.113.90:verify', '203.0.113.90:verify'])
  })
})

test('custom domains: a client over its strict budget never hands its 429 to another client verifying the same host (Y4)', async () => {
  const relay = newRelay({ now: createFakeClock(0).now, strictRateLimitPerMinute: 1 })
  const over: CallInit = { headers: { 'CF-Connecting-IP': '203.0.113.60' }, cf: CF }
  const fresh: CallInit = { headers: { 'CF-Connecting-IP': '203.0.113.61' }, cf: CF }
  const spent = 'spent.example.net'
  const host = 'shared.example.net'
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  await withUpstream({
    ...TARGET_DNS,
    ...plainDns(spent),
    [proofUrl(spent)]: () => html('<html>not substack</html>', 200),
    ...plainDns(host),
    // Holds the first verification open until the second request has joined it.
    [dohUrl(host, 'CNAME')]: async () => {
      await gate
      return dns([])
    },
    [proofUrl(host)]: () => html('<html>not substack</html>', 200),
  }, async () => {
    await expectError(relay, `/v1/archive?host=${spent}`, 403, 'HOST_NOT_SUBSTACK', over)
    const first = expectError(relay, `/v1/archive?host=${host}`, 429, 'RATE_LIMITED', over)
    const second = expectError(relay, `/v1/feed?host=${host}`, 403, 'HOST_NOT_SUBSTACK', fresh)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl(host, 'CNAME')).length, 1, 'the second request joined the first verification')
    release()
    const [limited] = await Promise.all([first, second])
    assert.equal(limited.error.retryAfterSeconds, 60)
    assert.equal(fetchCalls.filter(entry => entry.url === dohUrl(host, 'CNAME')).length, 2, 'the second client verified under its own budget')
    assert.equal(fetchCalls.filter(entry => entry.url === proofUrl(host)).length, 1)
    // The verdict it reached is shared and costs the first client nothing.
    await expectError(relay, `/v1/archive?host=${host}`, 403, 'HOST_NOT_SUBSTACK', over)
  })
})

test('redirects: same-path hops to allowed hosts are followed, at most 3', async () => {
  const relay = newRelay()
  const path = '/api/v1/posts/a-post'
  const request = '/v1/post?host=one.substack.com&slug=a-post'
  await withUpstream({
    [`https://one.substack.com${path}`]: () => redirectTo(`//two.substack.com${path}`, 302),
    [`https://two.substack.com${path}`]: () => redirectTo(`https://three.substack.com${path}`, 307),
    [`https://three.substack.com${path}`]: () => redirectTo(`https://four.substack.com${path}`, 308),
    [`https://four.substack.com${path}`]: () => substackJson(postFreeFixture),
  }, async () => {
    const { meta, data } = await expectOk<PostResponse>(relay, request)
    assert.equal(meta.host, 'four.substack.com')
    assert.equal(data.post.id, 9001)
    assert.equal(fetchCalls.length, 4)
  })
  await withUpstream({
    [`https://one.substack.com${path}`]: () => redirectTo(`https://two.substack.com${path}`),
    [`https://two.substack.com${path}`]: () => redirectTo(`https://three.substack.com${path}`),
    [`https://three.substack.com${path}`]: () => redirectTo(`https://four.substack.com${path}`),
    [`https://four.substack.com${path}`]: () => redirectTo(`https://five.substack.com${path}`),
  }, async () => {
    await expectError(relay, request, 502, 'TOO_MANY_REDIRECTS')
    assert.equal(fetchCalls.length, 4)
  })
})

test('redirects: other paths, schemes, ports, hosts and substack.com are refused', async () => {
  const relay = newRelay()
  const url = 'https://one.substack.com/api/v1/posts/a-post'
  const request = '/v1/post?host=one.substack.com&slug=a-post'
  const cases: Array<{ reply: () => Response; status: number; code: string }> = [
    { reply: () => redirectTo('https://one.substack.com/p/a-post'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo('/'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo('http://two.substack.com/api/v1/posts/a-post'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo('https://two.substack.com:8443/api/v1/posts/a-post'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo('https://10.0.0.1/api/v1/posts/a-post'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo('https://metadata.internal/api/v1/posts/a-post'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo('https://a.b.substack.com/api/v1/posts/a-post'), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    { reply: () => redirectTo(null), status: 502, code: 'REDIRECT_NOT_ALLOWED' },
    // C4: an unknown subdomain bounces to substack.com: there is no such publication.
    { reply: () => redirectTo('https://substack.com/'), status: 404, code: 'PUBLICATION_NOT_FOUND' },
    { reply: () => redirectTo('https://substack.com/@ghost', 302), status: 404, code: 'PUBLICATION_NOT_FOUND' },
    { reply: () => redirectTo('https://two.substack.com/api/v1/posts/a-post', 301, {}), status: 403, code: 'HOST_NOT_SUBSTACK' },
  ]
  let reply: () => Response = () => redirectTo(null)
  await withUpstream({ [url]: () => reply() }, async () => {
    for (const entry of cases) {
      reply = entry.reply
      fetchCalls.length = 0
      const { error } = await expectError(relay, request, entry.status, entry.code)
      assert.equal(error.upstream?.status, entry.reply().status)
      assert.equal(fetchCalls.length, 1, `${entry.code}: no hop is fetched`)
    }
  })
})

test('upstream failures map to honest codes with bounded diagnostics and never echo bodies', async () => {
  const relay = newRelay({ now: createFakeClock(Date.parse('2026-10-06T00:00:00Z')).now })
  const url = 'https://exampleletters.substack.com/api/v1/posts/a-post'
  const request = '/v1/post?host=exampleletters.substack.com&slug=a-post'
  const SECRET = 'UPSTREAM-BODY-MUST-NOT-LEAK'
  const cases: Array<{ reply: () => Response; status: number; code: string; upstream?: RelayUpstreamInfo; retryAfterSeconds?: number }> = [
    { reply: () => html(`<html>${SECRET}</html>`, 403), status: 503, code: 'UPSTREAM_BLOCKED', upstream: { status: 403, contentType: 'text/html', challenge: false } },
    { reply: () => html(SECRET, 403, { 'cf-mitigated': 'challenge' }), status: 503, code: 'UPSTREAM_BLOCKED', upstream: { status: 403, contentType: 'text/html', challenge: true } },
    { reply: () => html(SECRET, 429, { 'Retry-After': '120', ...FINGERPRINT }), status: 503, code: 'UPSTREAM_RATE_LIMITED', upstream: { status: 429, contentType: 'text/html', challenge: false }, retryAfterSeconds: 120 },
    { reply: () => html(SECRET, 429, { 'Retry-After': '99999999' }), status: 503, code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 86_400 },
    { reply: () => html(SECRET, 429, { 'Retry-After': 'Tue, 06 Oct 2026 00:01:30 GMT' }), status: 503, code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 90 },
    { reply: () => html(SECRET, 429, { 'Retry-After': SECRET }), status: 503, code: 'UPSTREAM_RATE_LIMITED' },
    { reply: () => html(SECRET, 500, FINGERPRINT), status: 503, code: 'UPSTREAM_UNAVAILABLE', upstream: { status: 500, contentType: 'text/html', challenge: false } },
    { reply: () => html(SECRET, 503), status: 503, code: 'UPSTREAM_UNAVAILABLE' },
    { reply: () => substackJson({ error: 'Post not found', type: 'single' }, 404), status: 404, code: 'POST_NOT_FOUND', upstream: { status: 404, contentType: 'application/json', challenge: false } },
    { reply: () => new Response(null, { status: 404, headers: FINGERPRINT }), status: 404, code: 'PUBLICATION_NOT_FOUND', upstream: { status: 404, contentType: 'missing', challenge: false } },
    { reply: () => html(SECRET, 404), status: 403, code: 'HOST_NOT_SUBSTACK' },
    { reply: () => substackJson({ error: SECRET }, 400), status: 502, code: 'UPSTREAM_ERROR', upstream: { status: 400, contentType: 'application/json', challenge: false } },
    { reply: () => html(SECRET, 200, FINGERPRINT), status: 502, code: 'UPSTREAM_INVALID', upstream: { status: 200, contentType: 'text/html', challenge: false } },
    { reply: () => html(SECRET, 200), status: 403, code: 'HOST_NOT_SUBSTACK', upstream: { status: 200, contentType: 'text/html', challenge: false } },
    { reply: () => new Response(`{${SECRET}`, { headers: { 'content-type': 'application/json', ...FINGERPRINT } }), status: 502, code: 'UPSTREAM_INVALID' },
    { reply: () => substackJson([SECRET]), status: 502, code: 'UPSTREAM_INVALID' },
    { reply: () => substackJson({ slug: 'a-post', title: SECRET }), status: 502, code: 'UPSTREAM_INVALID' },
    {
      reply: () => {
        throw new TypeError(SECRET)
      },
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    },
  ]
  let reply: () => Response = () => html('', 500)
  await withUpstream({ [url]: () => reply() }, async () => {
    for (const entry of cases) {
      reply = entry.reply
      const { res, error, text } = await expectError(relay, request, entry.status, entry.code)
      assert.doesNotMatch(text, new RegExp(SECRET))
      if (entry.upstream) assert.deepEqual(error.upstream, entry.upstream)
      assert.equal(error.retryAfterSeconds, entry.retryAfterSeconds, `${entry.code} retryAfterSeconds`)
      assert.equal(res.headers.get('retry-after'), entry.retryAfterSeconds === undefined ? null : String(entry.retryAfterSeconds))
    }
  })
})

test('responses over the route cap are UPSTREAM_TOO_LARGE, streamed or declared', async () => {
  const relay = newRelay()
  const url = archiveUrl('exampleletters.substack.com')
  const stream = (total: number): ReadableStream<Uint8Array> => {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close()
          return
        }
        const size = Math.min(65_536, total - sent)
        sent += size
        controller.enqueue(new Uint8Array(size).fill(0x20))
      },
    })
  }
  let reply: () => Response = () => new Response(stream(1024 * 1024 + 1), { headers: { 'content-type': 'application/json', ...FINGERPRINT } })
  await withUpstream({ [url]: () => reply() }, async () => {
    const streamed = await expectError(relay, '/v1/archive?host=exampleletters.substack.com', 502, 'UPSTREAM_TOO_LARGE')
    assert.deepEqual(streamed.error.upstream, { status: 200, contentType: 'application/json', challenge: false })
    reply = () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024), ...FINGERPRINT } })
    await expectError(relay, '/v1/archive?host=exampleletters.substack.com', 502, 'UPSTREAM_TOO_LARGE')
    reply = () => new Response(stream(1024 * 1024), { headers: { 'content-type': 'application/json', ...FINGERPRINT } })
    // Exactly at the cap is read in full (then fails JSON parsing, which is a different error).
    await expectError(relay, '/v1/archive?host=exampleletters.substack.com', 502, 'UPSTREAM_INVALID')
  })
})

test('a hung upstream answers UPSTREAM_TIMEOUT', async () => {
  const relay = newRelay({ timeoutMs: 25 })
  await withUpstream({ [archiveUrl('exampleletters.substack.com')]: hung }, async () => {
    const { error } = await expectError(relay, '/v1/archive?host=exampleletters.substack.com', 504, 'UPSTREAM_TIMEOUT')
    assert.equal(error.upstream, undefined)
  })
})

test('post: free, paid preview and paid-without-preview bodies are trimmed exactly (C11)', async () => {
  const relay = newRelay()
  const base = 'https://exampleletters.substack.com/api/v1/posts/'
  await withUpstream({
    [`${base}the-first-synthetic-post`]: () => substackJson(postFreeFixture),
    [`${base}a-paid-synthetic-post`]: () => substackJson(postPaidPreviewFixture),
    [`${base}hidden-synthetic-thread`]: () => substackJson(postPaidNullFixture),
  }, async () => {
    const free = await expectOk<PostResponse>(relay, '/v1/post?host=exampleletters.substack.com&slug=the-first-synthetic-post')
    assert.equal(free.res.headers.get('cache-control'), 'public, max-age=300')
    assert.equal(free.meta.host, 'exampleletters.substack.com')
    const expectedFree: PostDetail = {
      ...ARCHIVE_POSTS[0],
      authors: ['Ada Example'],
      bodyHtml: '<p>Synthetic paragraph one.</p><p>Synthetic paragraph two with <em>emphasis</em>.</p>',
      truncated: false,
    }
    assert.deepEqual(free.data, { post: expectedFree, publication: EXAMPLE_LETTERS })

    const preview = await expectOk<PostResponse>(relay, '/v1/post?host=exampleletters.substack.com&slug=a-paid-synthetic-post')
    const expectedPreview: PostDetail = {
      id: 9101,
      publicationId: 424242,
      slug: 'a-paid-synthetic-post',
      title: 'A Paid Synthetic Post',
      subtitle: 'Invented paid subtitle',
      postDate: '2026-09-30T07:15:00.000Z',
      audience: 'only_paid',
      isPaywalled: true,
      type: 'newsletter',
      wordcount: 1859,
      canonicalUrl: 'https://news.example.com/p/a-paid-synthetic-post',
      authors: ['Ada Example'],
      podcastDurationSec: null,
      bodyHtml: '<p>Invented free preview paragraph.</p>',
      truncated: true,
    }
    assert.deepEqual(preview.data, { post: expectedPreview, publication: EXAMPLE_LETTERS })

    const hidden = await expectOk<PostResponse>(relay, '/v1/post?host=exampleletters.substack.com&slug=hidden-synthetic-thread')
    const expectedHidden: PostDetail = {
      id: 9102,
      publicationId: 424242,
      slug: 'hidden-synthetic-thread',
      title: 'Hidden Synthetic Thread',
      subtitle: null,
      postDate: '2026-09-28T21:00:00.000Z',
      audience: 'only_paid',
      isPaywalled: true,
      type: 'thread',
      wordcount: 20,
      canonicalUrl: 'https://news.example.com/p/hidden-synthetic-thread',
      authors: [],
      podcastDurationSec: null,
      bodyHtml: null,
      truncated: true,
    }
    assert.deepEqual(hidden.data, { post: expectedHidden, publication: null })
  })
})

test('post by id: substack.com by-id is allowed and meta.host is the publication host', async () => {
  const relay = newRelay()
  await withUpstream({ 'https://substack.com/api/v1/posts/by-id/9201': () => substackJson(byIdFixture) }, async () => {
    const { data, meta, res } = await expectOk<PostResponse>(relay, '/v1/post?id=9201')
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300')
    assert.equal(meta.host, 'news.example.com')
    const expected: PostDetail = {
      id: 9201,
      publicationId: 424242,
      slug: 'shared-by-id',
      title: 'Shared By Id',
      subtitle: 'Reached through a share link',
      postDate: '2026-10-03T09:45:00.000Z',
      audience: 'everyone',
      isPaywalled: false,
      type: 'newsletter',
      wordcount: 640,
      canonicalUrl: 'https://news.example.com/p/shared-by-id',
      authors: ['Ada Example'],
      podcastDurationSec: null,
      bodyHtml: '<p>Invented body reached by numeric id.</p>',
      truncated: false,
    }
    assert.deepEqual(data, { post: expected, publication: EXAMPLE_LETTERS })
    assert.equal(fetchCalls.length, 1, 'substack.com needs no DNS check')
    assertUpstreamInit(fetchCalls[0].init, 'application/json')
  })
})

test('profile: public subscriptions and the primary publication follow the host rules', async () => {
  const relay = newRelay()
  await withUpstream({
    'https://substack.com/api/v1/user/adaexample/public_profile': () => substackJson(profileFixture),
    'https://substack.com/api/v1/user/ghost/public_profile': () => substackJson({ error: 'User not found' }, 404),
    'https://substack.com/api/v1/user/elsewhere/public_profile': () => redirectTo('https://www.substack.com/api/v1/user/elsewhere/public_profile'),
  }, async () => {
    const { data, meta, res } = await expectOk<Profile>(relay, '/v1/profile?handle=%40adaexample')
    assert.equal(res.headers.get('cache-control'), 'public, max-age=600')
    assert.equal(meta.host, 'substack.com')
    const expected: Profile = {
      handle: 'adaexample',
      name: 'Ada Example',
      primaryPublication: EXAMPLE_LETTERS,
      subscriptions: [
        { id: 555, name: 'Plain Example', subdomain: 'plainexample', customDomain: null, host: 'plainexample.substack.com' },
        { id: 556, name: 'Optional Domain Example', subdomain: 'optionalexample', customDomain: null, host: 'optionalexample.substack.com' },
        { id: 559, name: 'Custom Example', subdomain: 'customexample', customDomain: 'letters.example.org', host: 'letters.example.org' },
      ],
    }
    assert.deepEqual(data, expected)
    await expectError(relay, '/v1/profile?handle=ghost', 404, 'PROFILE_NOT_FOUND')
    await expectError(relay, '/v1/profile?handle=elsewhere', 502, 'REDIRECT_NOT_ALLOWED')
  })
})

test('search: top/search groups become deduped PubMeta, comments are ignored (C3)', async () => {
  const relay = newRelay()
  const many = {
    items: [{
      type: 'profileSearchResults',
      results: Array.from({ length: 30 }, (_value, index) => ({
        id: index + 1,
        primaryPublication: { id: 1000 + index, name: `Pub ${index}`, subdomain: `pub${index}`, custom_domain: null, custom_domain_optional: false },
      })),
    }],
  }
  await withUpstream({
    'https://substack.com/api/v1/top/search?query=example%20letters': () => substackJson(topSearchFixture),
    'https://substack.com/api/v1/top/search?query=many%20pubs': () => substackJson(many),
    'https://substack.com/api/v1/top/search?query=odd%20shape': () => substackJson({ results: [] }),
  }, async () => {
    const { data, meta, res } = await expectOk<SearchResponse>(relay, '/v1/search?q=%20example%20letters%20')
    assert.equal(res.headers.get('cache-control'), 'public, max-age=600')
    assert.equal(meta.host, 'substack.com')
    assert.deepEqual(data, {
      results: [
        EXAMPLE_LETTERS,
        { id: 888, name: 'Cy Writes', subdomain: 'cywrites', customDomain: null, host: 'cywrites.substack.com' },
        { id: 321, name: 'Base Url Example', subdomain: 'baseurlexample', customDomain: 'read.example.org', host: 'read.example.org' },
        { id: 322, name: 'Optional Base', subdomain: 'optionalbase', customDomain: null, host: 'optionalbase.substack.com' },
      ],
    })
    assertUpstreamInit(fetchCalls[0].init, 'application/json')
    const capped = await expectOk<SearchResponse>(relay, '/v1/search?q=many%20pubs')
    assert.equal(capped.data.results.length, 20)
    assert.equal(capped.data.results[19].host, 'pub19.substack.com')
    await expectError(relay, '/v1/search?q=odd%20shape', 502, 'UPSTREAM_INVALID')
  })
})

test('feed: RSS XML is passed through as sandboxed text/plain; other types and documents are refused (S1)', async () => {
  const relay = newRelay()
  const xml = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Example Letters</title></channel></rss>'
  let reply: () => Response = () => new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', ...FINGERPRINT } })
  await withUpstream({ 'https://exampleletters.substack.com/feed': () => reply() }, async () => {
    const { res, text } = await call(relay, '/v1/feed?host=exampleletters.substack.com')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), FEED_TYPE, 'never rendered as XML on the relay origin')
    assert.equal(res.headers.get('content-security-policy'), SANDBOX_CSP)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=120')
    assert.equal(text, xml)
    assertUpstreamInit(fetchCalls[0].init, 'application/rss+xml, application/xml;q=0.9')
    reply = () => new Response(xml, { headers: { 'content-type': 'text/xml', ...FINGERPRINT } })
    assert.equal((await call(relay, '/v1/feed?host=exampleletters.substack.com')).res.status, 200)
    const commented = '\n<?xml version="1.0"?>\n<!-- generated -->\n<!-- twice -->\n<rss\n version="2.0"><channel/></rss>'
    reply = () => new Response(commented, { headers: { 'content-type': 'application/rss+xml', ...FINGERPRINT } })
    assert.equal((await call(relay, '/v1/feed?host=exampleletters.substack.com')).text, commented, 'declaration, comments and whitespace may precede <rss>')
    reply = () => html(xml, 200, FINGERPRINT)
    await expectError(relay, '/v1/feed?host=exampleletters.substack.com', 502, 'UPSTREAM_INVALID')
    const refused = [
      '{"not":"xml"}',
      '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="https://evil.example.net/x.xsl"?><rss version="2.0"><channel/></rss>',
      '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><rss version="2.0"><channel/></rss>',
      '<!-- unterminated <rss version="2.0"><channel/></rss>',
      '<rssfeed><channel/></rssfeed>',
    ]
    for (const body of refused) {
      reply = () => new Response(body, { headers: { 'content-type': 'application/xml', ...FINGERPRINT } })
      const { text: errorText } = await expectError(relay, '/v1/feed?host=exampleletters.substack.com', 502, 'UPSTREAM_INVALID')
      assert.doesNotMatch(errorText, /script|evil/)
    }
  })
  // Replayed from the edge cache: still text/plain under the sandbox CSP.
  const cache = memoryCache()
  const cached = newRelay({ cache })
  await withUpstream({ 'https://exampleletters.substack.com/feed': () => new Response(xml, { headers: { 'content-type': 'application/xml', ...FINGERPRINT } }) }, async () => {
    await call(cached, '/v1/feed?host=exampleletters.substack.com')
    assert.equal(cache.entries.get(`${CACHE_NS}/v1/feed?host=exampleletters.substack.com`)?.headers.get('content-type'), FEED_TYPE)
    const replayed = await call(cached, '/v1/feed?host=exampleletters.substack.com')
    assert.equal(replayed.res.status, 200)
    assert.equal(replayed.res.headers.get('content-type'), FEED_TYPE)
    assert.equal(replayed.text, xml)
    assert.equal(fetchCalls.length, 1)
  })
})

test('health reports the protocol and echoes the Origin without touching the network', async () => {
  const relay = newRelay({ now: createFakeClock(5_000).now })
  await withUpstream({}, async () => {
    const { data, meta, res } = await expectOk<HealthResponse>(relay, '/v1/health', { headers: { Origin: 'https://webview.example.com' } })
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(data, { service: 'substack-reader-relay', protocol: 1, revision: null, origin: 'https://webview.example.com' })
    assert.deepEqual(meta, { host: 'relay.example.com', cached: false, fetchedAt: new Date(5_000).toISOString() })
    const nullOrigin = await expectOk<HealthResponse>(relay, '/v1/health', { headers: { Origin: 'null' } }, { REVISION: 'abc1234' })
    assert.equal(nullOrigin.data.origin, 'null')
    assert.equal(nullOrigin.data.revision, 'abc1234')
    const none = await expectOk<HealthResponse>(relay, '/v1/health?probe=0')
    assert.equal(none.data.origin, null)
    assert.equal(none.data.probes, undefined)
    const long = await expectOk<HealthResponse>(relay, '/v1/health', { headers: { Origin: `https://${'o'.repeat(200)}.example.com` } })
    assert.equal(long.data.origin?.length, 128)
    assert.equal(fetchCalls.length, 0)
  })
})

test('health probe=1 reports status-only probes of the three upstream kinds', async () => {
  const relay = newRelay({ now: createFakeClock(5_000).now })
  await withUpstream({
    'https://on.substack.com/api/v1/archive?sort=new&offset=0&limit=1': () => substackJson([{ id: 1 }]),
    'https://www.slowboring.com/api/v1/archive?sort=new&offset=0&limit=1': () => html('blocked', 403, { 'cf-mitigated': 'challenge' }),
    'https://substack.com/api/v1/top/search?query=substack': () => {
      throw new TypeError('offline')
    },
  }, async () => {
    const { data } = await expectOk<HealthResponse>(relay, '/v1/health?probe=1')
    assert.deepEqual(data.probes, [
      { target: 'subdomain', status: 200, contentType: 'application/json', challenge: false, ms: 0 },
      { target: 'customDomain', status: 403, contentType: 'text/html', challenge: true, ms: 0 },
      { target: 'substackCom', status: 0, contentType: 'missing', challenge: false, ms: 0 },
    ])
    for (const entry of fetchCalls) assertUpstreamInit(entry.init, 'application/json')
  })
})

test('health probe=1 runs at most one probe round per minute and has a strict budget (S2)', async () => {
  const clock = createFakeClock(5_000)
  const relay = newRelay({ now: clock.now })
  let status = 200
  await withUpstream({
    'https://on.substack.com/api/v1/archive?sort=new&offset=0&limit=1': () => substackJson([], status),
    'https://www.slowboring.com/api/v1/archive?sort=new&offset=0&limit=1': () => substackJson([], status),
    'https://substack.com/api/v1/top/search?query=substack': () => substackJson({ items: [] }, status),
  }, async () => {
    const first = await expectOk<HealthResponse>(relay, '/v1/health?probe=1')
    assert.equal(first.meta.cached, false)
    assert.deepEqual(first.data.probes?.map(probe => probe.status), [200, 200, 200])
    status = 503
    clock.advance(59_000)
    const reused = await expectOk<HealthResponse>(relay, '/v1/health?probe=1')
    assert.equal(reused.meta.cached, true, 'the round from 59 s ago is reused')
    assert.deepEqual(reused.data.probes, first.data.probes)
    assert.equal(fetchCalls.length, 3)
    clock.advance(1_000)
    const fresh = await expectOk<HealthResponse>(relay, '/v1/health?probe=1')
    assert.equal(fresh.meta.cached, false)
    assert.deepEqual(fresh.data.probes?.map(probe => probe.status), [503, 503, 503])
    assert.equal(fetchCalls.length, 6)

    // probe=1 has its own strict bucket (2 per minute here); plain health is unaffected.
    const strict = newRelay({ now: createFakeClock(0).now, strictRateLimitPerMinute: 2 })
    await expectOk<HealthResponse>(strict, '/v1/health?probe=1')
    await expectOk<HealthResponse>(strict, '/v1/health?probe=1')
    const limited = await expectError(strict, '/v1/health?probe=1', 429, 'RATE_LIMITED')
    assert.equal(limited.error.retryAfterSeconds, 30)
    await expectOk<HealthResponse>(strict, '/v1/health')
    assert.equal(fetchCalls.length, 9, 'one more probe round in total')
  })
})

test('the local limiter allows 60 requests per minute per client and route (fake clock)', async () => {
  const clock = createFakeClock(0)
  const relay = newRelay({ now: clock.now })
  const ip: CallInit = { headers: { 'CF-Connecting-IP': '203.0.113.50' }, cf: CF }
  await withUpstream({ [archiveUrl('exampleletters.substack.com')]: () => substackJson([]) }, async () => {
    for (let index = 0; index < 60; index += 1) await expectOk<HealthResponse>(relay, '/v1/health', ip)
    const limited = await expectError(relay, '/v1/health', 429, 'RATE_LIMITED', ip)
    assert.equal(limited.error.retryAfterSeconds, 1)
    assert.equal(limited.res.headers.get('retry-after'), '1')
    await expectOk<HealthResponse>(relay, '/v1/health', { headers: { 'CF-Connecting-IP': '203.0.113.51' }, cf: CF })
    await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com', ip)
    clock.advance(1_000)
    await expectOk<HealthResponse>(relay, '/v1/health', ip)
    await expectError(relay, '/v1/health', 429, 'RATE_LIMITED', ip)
    clock.advance(60_000)
    for (let index = 0; index < 60; index += 1) await expectOk<HealthResponse>(relay, '/v1/health', ip)
    await expectError(relay, '/v1/health', 429, 'RATE_LIMITED', ip)
  })
})

test('with the RL binding the relay asks it with ip:route keys and honours a refusal', async () => {
  const keys: string[] = []
  const env: Env = {
    RL: {
      async limit({ key }) {
        keys.push(key)
        return { success: keys.length < 2 }
      },
    },
  }
  const relay = newRelay()
  const init: CallInit = { headers: { 'CF-Connecting-IP': '198.51.100.20' }, cf: CF }
  await withUpstream({}, async () => {
    await expectOk<HealthResponse>(relay, '/v1/health', init, env)
    const { error, res } = await expectError(relay, '/v1/health', 429, 'RATE_LIMITED', init, env)
    assert.equal(error.retryAfterSeconds, 60)
    assert.equal(res.headers.get('retry-after'), '60')
    assert.deepEqual(keys, ['198.51.100.20:health', '198.51.100.20:health'])
  })
})

test('rate-limit keys: CF-Connecting-IP only on Cloudflare, IPv6 by its /64, otherwise one shared key (S7)', async () => {
  const keys: string[] = []
  const strictKeys: string[] = []
  const env: Env = {
    RL: {
      async limit({ key }) {
        keys.push(key)
        return { success: true }
      },
    },
    RL_STRICT: {
      async limit({ key }) {
        strictKeys.push(key)
        return { success: false }
      },
    },
  }
  const relay = newRelay()
  const cases: Array<[CallInit, string]> = [
    [{ headers: { 'CF-Connecting-IP': '203.0.113.9' }, cf: CF }, '203.0.113.9'],
    [{ headers: { 'CF-Connecting-IP': '2001:0DB8:0001:0002:ffff::1' }, cf: CF }, '2001:db8:1:2::/64'],
    [{ headers: { 'CF-Connecting-IP': '2001:db8:1:2::a' }, cf: CF }, '2001:db8:1:2::/64'],
    [{ headers: { 'CF-Connecting-IP': '2001:db8:1:3:4:5:6:7' }, cf: CF }, '2001:db8:1:3::/64'],
    [{ headers: { 'CF-Connecting-IP': '::1' }, cf: CF }, '0:0:0:0::/64'],
    [{ headers: { 'CF-Connecting-IP': '1::2::3' }, cf: CF }, 'shared'],
    [{ headers: { 'CF-Connecting-IP': '1:2:3:4:5:6:7' }, cf: CF }, 'shared'],
    [{ cf: CF }, 'shared'],
    // Not on Cloudflare: the header is the client's own choice.
    [{ headers: { 'CF-Connecting-IP': '203.0.113.9' } }, 'shared'],
    [{ headers: { 'CF-Connecting-IP': '198.51.100.1' } }, 'shared'],
  ]
  await withUpstream({}, async () => {
    for (const [init] of cases) await expectOk<HealthResponse>(relay, '/v1/health', init, env)
    assert.deepEqual(keys, cases.map(([, client]) => `${client}:health`))
    assert.deepEqual(strictKeys, [], 'plain health never asks the strict binding')
    // probe=1 also asks RL_STRICT, under its own route key; a refusal sends nothing upstream.
    const probe = await expectError(relay, '/v1/health?probe=1', 429, 'RATE_LIMITED', cases[1][0], env)
    assert.equal(probe.error.retryAfterSeconds, 60)
    assert.deepEqual(strictKeys, ['2001:db8:1:2::/64:health-probe'])
    assert.equal(fetchCalls.length, 0)
  })

  // The local buckets follow the same keys.
  const local = newRelay({ rateLimitPerMinute: 1, now: createFakeClock(0).now })
  await withUpstream({}, async () => {
    await expectOk<HealthResponse>(local, '/v1/health', { headers: { 'CF-Connecting-IP': '203.0.113.1' } })
    await expectError(local, '/v1/health', 429, 'RATE_LIMITED', { headers: { 'CF-Connecting-IP': '203.0.113.2' } })
    await expectOk<HealthResponse>(local, '/v1/health', { headers: { 'CF-Connecting-IP': '2001:db8:1:2::a' }, cf: CF })
    await expectError(local, '/v1/health', 429, 'RATE_LIMITED', { headers: { 'CF-Connecting-IP': '2001:db8:1:2:ffff::1' }, cf: CF })
    await expectOk<HealthResponse>(local, '/v1/health', { headers: { 'CF-Connecting-IP': '2001:db8:1:3::a' }, cf: CF })
  })
})

interface StoredEntry {
  status: number
  body: string
  headers: Headers
}

function memoryCache(): CacheLike & { entries: Map<string, StoredEntry> } {
  const entries = new Map<string, StoredEntry>()
  return {
    entries,
    async match(key) {
      const entry = entries.get(key)
      return entry ? new Response(entry.body, { status: entry.status, headers: entry.headers }) : undefined
    },
    async put(key, response) {
      entries.set(key, { status: response.status, body: await response.text(), headers: new Headers(response.headers) })
    },
  }
}

test('edge cache: hits skip upstream and set meta.cached; 404s are kept 60 s; failures are never cached', async () => {
  const cache = memoryCache()
  const clock = createFakeClock(1_000)
  const relay = newRelay({ cache, now: clock.now })
  const post = (slug: string) => `https://exampleletters.substack.com/api/v1/posts/${slug}`
  await withUpstream({
    [archiveUrl('exampleletters.substack.com')]: () => redirectTo(archiveUrl('news.example.com')),
    [dohUrl('news.example.com', 'CNAME')]: () => dns(CNAME_TO_TARGET),
    [archiveUrl('news.example.com')]: () => substackJson(archiveFixture),
    [archiveUrl('news.example.com', 12)]: () => substackJson([]),
    [post('missing-post')]: () => substackJson({ error: 'Post not found', type: 'single' }, 404),
    [post('blocked-post')]: () => html('blocked', 403),
  }, async () => {
    const first = await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com')
    assert.equal(first.meta.cached, false)
    assert.equal(fetchCalls.length, 3)
    const requestedKey = `${CACHE_NS}/v1/archive?host=exampleletters.substack.com&offset=0&limit=12&sort=new`
    const finalKey = `${CACHE_NS}/v1/archive?host=news.example.com&offset=0&limit=12&sort=new`
    assert.deepEqual([...cache.entries.keys()].filter(key => key.includes('/v1/archive')).sort(), [finalKey, requestedKey].sort())
    assert.equal(cache.entries.get(requestedKey)?.headers.get('cache-control'), 'public, max-age=300')
    assert.equal(cache.entries.get(requestedKey)?.headers.get('set-cookie'), null)
    const verdict = cache.entries.get(`${CACHE_NS}/host-verdict?host=news.example.com`)
    assert.deepEqual(verdict && JSON.parse(verdict.body), { verdict: 'pass', expires: 1_000 + 24 * 3_600_000 })

    const second = await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com')
    assert.equal(second.meta.cached, true)
    assert.equal(second.meta.fetchedAt, first.meta.fetchedAt)
    assert.equal(second.meta.host, 'news.example.com')
    assert.deepEqual(second.data, first.data)
    assert.equal(second.res.headers.get('cache-control'), 'public, max-age=60')
    const alias = await expectOk<ArchivePage>(relay, '/v1/archive?host=news.example.com')
    assert.equal(alias.meta.cached, true)
    assert.equal(fetchCalls.length, 3, 'cache hits make no upstream requests')

    // Another isolate sharing the edge cache reuses the stored verdict instead of asking DNS again.
    fetchCalls.length = 0
    const otherIsolate = newRelay({ cache, now: clock.now })
    await expectOk<ArchivePage>(otherIsolate, '/v1/archive?host=news.example.com&offset=12')
    assert.deepEqual(fetchCalls.map(entry => entry.url), [archiveUrl('news.example.com', 12)])

    fetchCalls.length = 0
    await expectError(relay, '/v1/post?host=exampleletters.substack.com&slug=missing-post', 404, 'POST_NOT_FOUND')
    await expectError(relay, '/v1/post?host=exampleletters.substack.com&slug=missing-post', 404, 'POST_NOT_FOUND')
    assert.equal(fetchCalls.filter(entry => entry.url === post('missing-post')).length, 1)
    const notFound = cache.entries.get(`${CACHE_NS}/v1/post?host=exampleletters.substack.com&slug=missing-post`)
    assert.equal(notFound?.status, 404)
    assert.equal(notFound?.headers.get('cache-control'), 'public, max-age=60')

    await expectError(relay, '/v1/post?host=exampleletters.substack.com&slug=blocked-post', 503, 'UPSTREAM_BLOCKED')
    await expectError(relay, '/v1/post?host=exampleletters.substack.com&slug=blocked-post', 503, 'UPSTREAM_BLOCKED')
    assert.equal(fetchCalls.filter(entry => entry.url === post('blocked-post')).length, 2)
    assert.equal([...cache.entries.keys()].some(key => key.includes('blocked-post')), false)
  })
})

test('edge cache: keys live under the relay origin; a stored verdict claiming too long a life is ignored (S4)', async () => {
  const cache = memoryCache()
  const clock = createFakeClock(1_000)
  const relay = newRelay({ cache, now: clock.now })
  const host = 'www.example.org'
  const archiveKey = '/v1/archive?host=exampleletters.substack.com&offset=0&limit=12&sort=new'
  const forged = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } })
  // Written by someone else sharing the cache: a pass that outlives anything the relay stores...
  await cache.put(`${CACHE_NS}/host-verdict?host=${host}`, forged(JSON.stringify({ verdict: 'pass', expires: 1e15 })))
  // ...and entries under another origin's namespace or the old fixed origin.
  await cache.put(`https://relay.cache/p1${archiveKey}`, forged('{"ok":true,"meta":{"host":"forged.example.net","cached":false,"fetchedAt":"x"},"data":{}}'))
  await cache.put(`https://other.example.net${CACHE_PATH}${archiveKey}`, forged('{"ok":true,"meta":{"host":"forged.example.net","cached":false,"fetchedAt":"x"},"data":{}}'))
  await withUpstream({
    ...TARGET_DNS,
    [dohUrl(host, 'CNAME')]: () => dns([{ type: 5, data: 'elsewhere.example.net.' }]),
    [dohUrl(host, 'A')]: () => dns([{ type: 1, data: '192.0.2.10' }]),
    [dohUrl(host, 'AAAA')]: () => dns([]),
    [proofUrl(host)]: () => html('<html>not substack</html>', 200),
    [archiveUrl('exampleletters.substack.com')]: () => substackJson([]),
  }, async () => {
    await expectError(relay, `/v1/archive?host=${host}`, 403, 'HOST_NOT_SUBSTACK')
    assert.deepEqual(JSON.parse(cache.entries.get(`${CACHE_NS}/host-verdict?host=${host}`)?.body ?? 'null'), { verdict: 'fail', expires: 1_000 + 3_600_000 })
    const own = await expectOk<ArchivePage>(relay, '/v1/archive?host=exampleletters.substack.com')
    assert.deepEqual(own.meta, { host: 'exampleletters.substack.com', cached: false, fetchedAt: new Date(1_000).toISOString() })
    assert.equal(cache.entries.has(`${CACHE_NS}${archiveKey}`), true)
    // The same relay reached under another origin keeps a separate namespace.
    const other = await relay.fetch(new Request('https://relay-two.example.com/v1/archive?host=exampleletters.substack.com'))
    assert.equal(other.status, 200)
    assert.equal((JSON.parse(await other.text()) as RelayEnvelope<ArchivePage>).ok, true)
    assert.equal(cache.entries.has(`https://relay-two.example.com${CACHE_PATH}${archiveKey}`), true)
    assert.equal(fetchCalls.filter(entry => entry.url === archiveUrl('exampleletters.substack.com')).length, 2)
  })
})

test('profile: handles are lowercased before the case-sensitive Substack lookup and the cache key (C1)', async () => {
  const cache = memoryCache()
  const relay = newRelay({ cache })
  await withUpstream({ 'https://substack.com/api/v1/user/adaexample/public_profile': () => substackJson(profileFixture) }, async () => {
    const { data } = await expectOk<Profile>(relay, '/v1/profile?handle=%40AdaExample')
    assert.equal(data.handle, 'adaexample')
    const again = await expectOk<Profile>(relay, '/v1/profile?handle=ADAEXAMPLE')
    assert.equal(again.meta.cached, true, 'case variants share one cache entry')
    assert.deepEqual(fetchCalls.map(entry => entry.url), ['https://substack.com/api/v1/user/adaexample/public_profile'])
    assert.deepEqual([...cache.entries.keys()], [`${CACHE_NS}/v1/profile?handle=adaexample`])
  })
})

test('post by id: the largest id Substack accepts is forwarded (C3)', async () => {
  const relay = newRelay()
  await withUpstream({ 'https://substack.com/api/v1/posts/by-id/2147483647': () => substackJson({ error: 'Post not found' }, 404) }, async () => {
    await expectError(relay, '/v1/post?id=2147483647', 404, 'POST_NOT_FOUND')
    assert.equal(fetchCalls.length, 1)
  })
})

test('archive: without an id match, the byline publication served from the final host is used (C2)', async () => {
  const relay = newRelay()
  const host = 'onexample.substack.com'
  const pub = (id: number | null, subdomain: string, name: string): Record<string, unknown> => ({
    ...(id === null ? {} : { id }),
    name,
    subdomain,
    custom_domain: null,
    custom_domain_optional: false,
  })
  const post = (id: number, publication: Record<string, unknown>) => ({
    id,
    publication_id: 1,
    slug: `post-${id}`,
    title: `Post ${id}`,
    audience: 'everyone',
    publishedBylines: [{ id: id + 100, name: 'Writer', publicationUsers: [{ id: id + 200, publication }] }],
  })
  const guest = post(71, pub(4210070, 'guestpub', 'Guest Pub'))
  const staff = post(72, pub(null, 'onexample', 'On Example'))
  const owner = post(73, pub(1, 'onexample', 'On Example Owner'))
  let page: unknown[] = []
  await withUpstream({ [archiveUrl(host)]: () => substackJson(page) }, async () => {
    page = [guest]
    assert.equal((await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}`)).data.publication, null, 'a guest byline names another publication')
    page = [guest, staff]
    assert.deepEqual((await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}`)).data.publication,
      { id: null, name: 'On Example', subdomain: 'onexample', customDomain: null, host })
    page = [guest, staff, owner]
    assert.deepEqual((await expectOk<ArchivePage>(relay, `/v1/archive?host=${host}`)).data.publication,
      { id: 1, name: 'On Example Owner', subdomain: 'onexample', customDomain: null, host }, 'an id match wins')
  })
  await withUpstream({ [`https://${host}/api/v1/posts/post-72`]: () => substackJson(staff) }, async () => {
    const { data } = await expectOk<PostResponse>(relay, `/v1/post?host=${host}&slug=post-72`)
    assert.equal(data.publication?.name, 'On Example')
  })
})

test('the default export is a ready relay that looks up globalThis.fetch per call', async () => {
  await withUpstream({
    'https://on.substack.com/api/v1/archive?sort=new&offset=0&limit=1': () => substackJson([]),
    'https://www.slowboring.com/api/v1/archive?sort=new&offset=0&limit=1': () => substackJson([]),
    'https://substack.com/api/v1/top/search?query=substack': () => substackJson({ items: [] }),
  }, async () => {
    const res = await relayDefault.fetch(new Request(`${RELAY_ORIGIN}/v1/health?probe=1`))
    assertCommonHeaders(res)
    assert.equal(res.status, 200)
    const body = JSON.parse(await res.text()) as RelayEnvelope<HealthResponse>
    if (!body.ok) throw new Error('health failed')
    assert.deepEqual(body.data.probes?.map(probe => probe.status), [200, 200, 200])
    assert.equal(fetchCalls.length, 3)
  })
})
