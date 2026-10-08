import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  API_MESSAGES,
  ApiError,
  MAX_RETRY_AFTER_SECONDS,
  REQUEST_TIMEOUT_MS,
  RSS2JSON_ENDPOINT,
  appendPosts,
  createApi,
  getArchive,
  getFeedXml,
  getHealth,
  getPost,
  getProfile,
  getRss2Json,
  relayConfigured,
  rss2jsonEnabled,
  searchPublications,
  type FetchLike,
} from '../../src/substack/api'
import type { PostSummary } from '../../src/substack/types'
import { fetchCalls, jsonResponse, stubFetch } from './helpers'

const RELAY = 'https://relay.ci.invalid'
const META = { host: 'foo.substack.com', cached: false, fetchedAt: '2026-10-06T00:00:00.000Z' }
const INIT_KEYS = ['credentials', 'method', 'redirect', 'referrerPolicy', 'signal']

function ok(data: unknown, meta: Record<string, unknown> = META): Response {
  return jsonResponse({ ok: true, data, meta })
}

function fail(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return jsonResponse({ ok: false, error }, status, headers)
}

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' } })
}

interface Recorded {
  url: string
  init: RequestInit
}

function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return respond(url, init)
    },
  }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof ApiError)) throw new assert.AssertionError({ message: `Expected ApiError ${code}, got ${String(error)}` })
    assert.equal(error.code, code, error.message)
    return error
  }
  throw new assert.AssertionError({ message: `Expected ApiError ${code}, but the call resolved.` })
}

function assertSimpleGet(init: RequestInit | undefined): void {
  assert.ok(init, 'fetch must receive an init object')
  assert.deepEqual(Object.keys(init).sort(), INIT_KEYS)
  assert.equal(init.method, 'GET')
  assert.equal(init.credentials, 'omit')
  assert.equal(init.redirect, 'error')
  assert.equal(init.referrerPolicy, 'no-referrer')
  assert.equal(init.headers, undefined, 'no custom headers (CORS simple request)')
  assert.equal(init.body, undefined)
  assert.equal(init.cache, undefined, 'cache stays default so max-age is honoured')
  assert.ok(init.signal instanceof AbortSignal)
}

const postFixture = {
  id: 11,
  publicationId: 159185,
  slug: 'free-post',
  title: 'A free post',
  subtitle: 'Sub',
  postDate: '2026-10-05T12:00:00.000Z',
  audience: 'everyone',
  isPaywalled: false,
  type: 'newsletter',
  wordcount: 1200,
  canonicalUrl: 'https://www.slowboring.com/p/free-post',
  authors: ['Ada'],
  podcastDurationSec: null,
}

const pubFixture = { id: 159185, name: 'Slow Boring', subdomain: 'matthewyglesias', customDomain: 'www.slowboring.com', host: 'www.slowboring.com' }

test('the build client uses the CI relay origin and a CORS simple GET', async () => {
  const restore = stubFetch(() => ok({ publication: null, posts: [], nextOffset: null }))
  try {
    assert.equal(relayConfigured(), true)
    assert.equal(rss2jsonEnabled(), false)
    assert.equal(REQUEST_TIMEOUT_MS, 15_000)
    const result = await getArchive('Foo.Substack.com', { offset: 12 })
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0]!.url, 'https://relay.ci.invalid/v1/archive?host=foo.substack.com&offset=12&limit=12&sort=new')
    assertSimpleGet(fetchCalls[0]!.init)
    assert.deepEqual(result, { page: { publication: null, posts: [], nextOffset: null }, host: 'foo.substack.com' })
  } finally {
    restore()
  }
})

test('every build-client route builds its URL with URLSearchParams on the relay origin', async () => {
  const restore = stubFetch(url => {
    if (url.includes('/v1/feed')) return xmlResponse('<rss version="2.0"/>')
    if (url.includes('/v1/post')) return ok({ post: postFixture, publication: pubFixture })
    if (url.includes('/v1/health')) return ok({ service: 'substack-reader-relay', protocol: 1, revision: null, origin: null })
    if (url.includes('/v1/profile')) return ok({ handle: 'thezvi', name: 'Zvi', primaryPublication: null, subscriptions: [] })
    return ok({ results: [] })
  })
  try {
    await getPost({ host: 'www.slowboring.com', slug: 'free-post' })
    await getPost({ id: 218912642 })
    await getProfile('@thezvi')
    await searchPublications('  economics   newsletter ')
    assert.equal(await getFeedXml('foo.substack.com'), '<rss version="2.0"/>')
    await getHealth()
    await getHealth(true)
    assert.deepEqual(fetchCalls.map(call => call.url), [
      'https://relay.ci.invalid/v1/post?host=www.slowboring.com&slug=free-post',
      'https://relay.ci.invalid/v1/post?id=218912642',
      'https://relay.ci.invalid/v1/profile?handle=thezvi',
      'https://relay.ci.invalid/v1/search?q=economics+newsletter',
      'https://relay.ci.invalid/v1/feed?host=foo.substack.com',
      'https://relay.ci.invalid/v1/health',
      'https://relay.ci.invalid/v1/health?probe=1',
    ])
    for (const call of fetchCalls) assertSimpleGet(call.init)
  } finally {
    restore()
  }
})

test('archive offset, limit and sort are clamped to what the relay accepts', async () => {
  const rec = recorder(() => ok({ publication: null, posts: [], nextOffset: null }))
  const api = createApi(RELAY, rec.fetch)
  await api.getArchive('foo.substack.com', { offset: -5, limit: 50, sort: 'top' })
  await api.getArchive('foo.substack.com', { offset: 99999, limit: 0 })
  await api.getArchive('foo.substack.com', { limit: 2.7 })
  await api.getArchive('foo.substack.com')
  assert.deepEqual(rec.calls.map(call => call.url), [
    `${RELAY}/v1/archive?host=foo.substack.com&offset=0&limit=20&sort=top`,
    `${RELAY}/v1/archive?host=foo.substack.com&offset=5000&limit=1&sort=new`,
    `${RELAY}/v1/archive?host=foo.substack.com&offset=0&limit=2&sort=new`,
    `${RELAY}/v1/archive?host=foo.substack.com&offset=0&limit=12&sort=new`,
  ])
})

test('archive data is normalized defensively; meta.host wins', async () => {
  const data = {
    publication: { ...pubFixture, subdomain: 'MatthewYglesias' },
    posts: [
      { ...postFixture, title: '  A   free post ', subtitle: '', authors: ['Ada', '', 42, 'Bob'] },
      {
        id: 12, publicationId: 159185, slug: 'founders-only', title: 'Founders', subtitle: 'Sub', postDate: 'not a date',
        audience: 'founding', isPaywalled: false, type: 'podcast', wordcount: -3, canonicalUrl: 'javascript:alert(1)',
        authors: 'nope', podcastDurationSec: 1834.5,
      },
      { id: 11, slug: 'duplicate', title: 'Dup' },
      { id: 'x', slug: 'bad-id' },
      { id: 13, slug: 'bad slug' },
      null,
    ],
    nextOffset: 14,
  }
  const rec = recorder(() => ok(data, { ...META, host: 'www.slowboring.com' }))
  const result = await createApi(RELAY, rec.fetch).getArchive('matthewyglesias.substack.com')
  assert.equal(result.host, 'www.slowboring.com')
  assert.deepEqual(result.page, {
    publication: { id: 159185, name: 'Slow Boring', subdomain: 'matthewyglesias', customDomain: 'www.slowboring.com', host: 'www.slowboring.com' },
    posts: [
      { ...postFixture, subtitle: null, authors: ['Ada', 'Bob'] },
      {
        id: 12, publicationId: 159185, slug: 'founders-only', title: 'Founders', subtitle: 'Sub', postDate: '',
        audience: 'founding', isPaywalled: true, type: 'podcast', wordcount: null,
        canonicalUrl: 'https://www.slowboring.com/p/founders-only', authors: [], podcastDurationSec: 1834.5,
      },
    ],
    nextOffset: 14,
  })
})

test('archive source is accepted only for sitemap pages and is sent only when explicitly requested', async () => {
  let source: unknown = 'sitemap'
  let nextOffset = 4
  const rec = recorder(() => ok({ publication: null, posts: [postFixture], nextOffset, source }))
  const api = createApi(RELAY, rec.fetch)
  const initial = await api.getArchive('foo.substack.com')
  assert.equal(initial.page.source, 'sitemap')
  nextOffset = 8
  const older = await api.getArchive('foo.substack.com', { offset: initial.page.nextOffset!, source: initial.page.source })
  assert.equal(older.page.source, 'sitemap')
  assert.equal(older.page.nextOffset, 8, 'a short sitemap page keeps its own cursor')
  assert.deepEqual(rec.calls.slice(0, 2).map(call => call.url), [
    `${RELAY}/v1/archive?host=foo.substack.com&offset=0&limit=12&sort=new`,
    `${RELAY}/v1/archive?host=foo.substack.com&offset=4&limit=12&sort=new&source=sitemap`,
  ])
  for (source of ['SITEMAP', 'api', '', null, false, {}]) {
    const result = await api.getArchive('foo.substack.com', { source: 'unknown' as 'sitemap' })
    assert.equal(Object.hasOwn(result.page, 'source'), false, 'unknown response sources are discarded')
    assert.equal(new URL(rec.calls[rec.calls.length - 1]!.url).searchParams.has('source'), false)
  }
  for (const call of rec.calls) assertSimpleGet(call.init)
})

test('nextOffset: short pages continue (C1); offsets that do not advance end the list', async () => {
  let nextOffset: unknown = 13
  const rec = recorder(() => ok({ publication: null, posts: [postFixture], nextOffset }))
  const api = createApi(RELAY, rec.fetch)
  assert.equal((await api.getArchive('foo.substack.com', { offset: 12, limit: 12 })).page.nextOffset, 13)
  nextOffset = 12
  assert.equal((await api.getArchive('foo.substack.com', { offset: 12 })).page.nextOffset, null)
  nextOffset = 5001
  assert.equal((await api.getArchive('foo.substack.com', { offset: 12 })).page.nextOffset, null)
  nextOffset = '24'
  assert.equal((await api.getArchive('foo.substack.com', { offset: 12 })).page.nextOffset, null)
  nextOffset = null
  assert.equal((await api.getArchive('foo.substack.com', { offset: 12 })).page.nextOffset, null)
})

test('getPost by slug and by id returns the post, its publication and the final host', async () => {
  let payload: unknown = { post: { ...postFixture, bodyHtml: '<p>Hi</p>' }, publication: pubFixture }
  let meta: Record<string, unknown> = { ...META, host: 'www.slowboring.com' }
  const rec = recorder(() => ok(payload, meta))
  const api = createApi(RELAY, rec.fetch)

  const bySlug = await api.getPost({ host: 'matthewyglesias.substack.com', slug: 'free-post' })
  assert.equal(rec.calls[0]!.url, `${RELAY}/v1/post?host=matthewyglesias.substack.com&slug=free-post`)
  assert.equal(bySlug.host, 'www.slowboring.com')
  assert.deepEqual(bySlug.post, { ...postFixture, bodyHtml: '<p>Hi</p>', truncated: false })
  assert.deepEqual(bySlug.publication, pubFixture)

  payload = { post: { ...postFixture, audience: 'only_paid', bodyHtml: 42 }, publication: null }
  meta = { ...META, host: 'www.astralcodexten.com' }
  const byId = await api.getPost({ id: 218912642 })
  assert.equal(rec.calls[1]!.url, `${RELAY}/v1/post?id=218912642`)
  assert.equal(byId.host, 'www.astralcodexten.com')
  assert.equal(byId.publication, null)
  assert.equal(byId.post.bodyHtml, null)
  assert.equal(byId.post.isPaywalled, true)
  assert.equal(byId.post.truncated, true)

  // No usable meta.host: by-id falls back to the publication's host...
  payload = { post: postFixture, publication: pubFixture }
  meta = { cached: true, host: 'not a host' }
  assert.equal((await api.getPost({ id: 5 })).host, 'www.slowboring.com')
  // ...a slug lookup to the requested host...
  assert.equal((await api.getPost({ host: 'foo.substack.com', slug: 'free-post' })).host, 'foo.substack.com')
  // ...and with neither, the answer is unusable.
  payload = { post: postFixture, publication: null }
  await rejectsWith(api.getPost({ id: 5 }), 'UPSTREAM_INVALID')
})

test('a post response without a usable post is UPSTREAM_INVALID', async () => {
  const rec = recorder(() => ok({ post: { id: 'nope' }, publication: null }))
  await rejectsWith(createApi(RELAY, rec.fetch).getPost({ host: 'foo.substack.com', slug: 'x' }), 'UPSTREAM_INVALID')
})

test('invalid input is rejected before any request', async () => {
  const rec = recorder(() => ok({}))
  const api = createApi(RELAY, rec.fetch)
  await rejectsWith(api.getArchive('not a host'), 'INVALID_HOST')
  await rejectsWith(api.getArchive('https://foo.substack.com'), 'INVALID_HOST')
  await rejectsWith(api.getFeedXml('127.0.0.1'), 'INVALID_HOST')
  await rejectsWith(api.getPost({ host: 'foo.substack.com', slug: '../x' }), 'INVALID_SLUG')
  await rejectsWith(api.getPost({ host: 'localhost', slug: 'x' }), 'INVALID_HOST')
  await rejectsWith(api.getPost({ id: 0 }), 'INVALID_PARAM')
  await rejectsWith(api.getPost({ id: 1.5 }), 'INVALID_PARAM')
  await rejectsWith(api.getPost({ id: 2_147_483_648 }), 'INVALID_PARAM') // Above Substack's by-id range (relay C3).
  await rejectsWith(api.getProfile('bad handle!'), 'INVALID_HANDLE')
  await rejectsWith(api.searchPublications('a'), 'INVALID_QUERY')
  await rejectsWith(api.searchPublications('x'.repeat(101)), 'INVALID_QUERY')
  assert.equal(rec.calls.length, 0)
})

test('NOT_CONFIGURED: no relay origin means no request at all', async () => {
  for (const base of [null, '', 'http://relay.example.org', 'https://relay.example.org/path', 'https://relay.example.org/?x=1', 'not a url']) {
    const rec = recorder(() => ok({}))
    const api = createApi(base, rec.fetch)
    assert.equal(api.relayConfigured(), false, String(base))
    const error = await rejectsWith(api.getArchive('foo.substack.com'), 'NOT_CONFIGURED')
    assert.equal(error.message, API_MESSAGES.NOT_CONFIGURED)
    await rejectsWith(api.getPost({ host: 'foo.substack.com', slug: 'x' }), 'NOT_CONFIGURED')
    await rejectsWith(api.getPost({ id: 1 }), 'NOT_CONFIGURED')
    await rejectsWith(api.getProfile('thezvi'), 'NOT_CONFIGURED')
    await rejectsWith(api.searchPublications('economics'), 'NOT_CONFIGURED')
    await rejectsWith(api.getFeedXml('foo.substack.com'), 'NOT_CONFIGURED')
    await rejectsWith(api.getHealth(true), 'NOT_CONFIGURED')
    await rejectsWith(api.getRss2Json('foo.substack.com'), 'NOT_CONFIGURED')
    assert.equal(rec.calls.length, 0, String(base))
  }
})

test('error envelopes map to ApiError with code, message, status, Retry-After and upstream', async () => {
  let response: () => Response = () => fail(503, {
    code: 'UPSTREAM_RATE_LIMITED',
    message: 'Substack is rate limiting the relay.',
    retryAfterSeconds: 120,
    upstream: { status: 429, contentType: 'text/html', challenge: false },
  })
  const rec = recorder(() => response())
  const api = createApi(RELAY, rec.fetch)

  let error = await rejectsWith(api.getArchive('foo.substack.com'), 'UPSTREAM_RATE_LIMITED')
  assert.equal(error.message, 'Substack is rate limiting the relay.')
  assert.equal(error.status, 503)
  assert.equal(error.retryAfterSeconds, 120)
  assert.deepEqual(error.upstream, { status: 429, contentType: 'text/html', challenge: false })
  assert.equal(error.name, 'ApiError')

  response = () => fail(503, { code: 'UPSTREAM_BLOCKED', message: 'Blocked.', upstream: { status: 403, contentType: 'weird', challenge: true } })
  error = await rejectsWith(api.getPost({ host: 'foo.substack.com', slug: 'x' }), 'UPSTREAM_BLOCKED')
  assert.deepEqual(error.upstream, { status: 403, contentType: 'other', challenge: true })
  assert.equal(error.retryAfterSeconds, undefined)

  response = () => fail(429, { code: 'RATE_LIMITED', message: 'Slow down.' }, { 'retry-after': '30' })
  error = await rejectsWith(api.searchPublications('economics'), 'RATE_LIMITED')
  assert.equal(error.retryAfterSeconds, 30)
  assert.equal(error.upstream, undefined)

  response = () => fail(503, { code: 'UPSTREAM_RATE_LIMITED', message: 'x', retryAfterSeconds: 999_999 })
  assert.equal((await rejectsWith(api.getProfile('thezvi'), 'UPSTREAM_RATE_LIMITED')).retryAfterSeconds, MAX_RETRY_AFTER_SECONDS)
  response = () => fail(503, { code: 'UPSTREAM_RATE_LIMITED', message: 'x', retryAfterSeconds: 1.2 })
  assert.equal((await rejectsWith(api.getProfile('thezvi'), 'UPSTREAM_RATE_LIMITED')).retryAfterSeconds, 2)
  response = () => fail(503, { code: 'UPSTREAM_RATE_LIMITED', message: 'x', retryAfterSeconds: -1 })
  assert.equal((await rejectsWith(api.getProfile('thezvi'), 'UPSTREAM_RATE_LIMITED')).retryAfterSeconds, undefined)

  response = () => fail(404, { code: 'POST_NOT_FOUND', message: '' })
  error = await rejectsWith(api.getPost({ host: 'foo.substack.com', slug: 'gone' }), 'POST_NOT_FOUND')
  assert.equal(error.message, 'The reader service reported an error.')
  assert.equal(error.status, 404)

  response = () => fail(400, { code: 'INVALID_HOST', message: 'Bad host.\u0000\n' })
  error = await rejectsWith(api.getArchive('foo.substack.com'), 'INVALID_HOST')
  assert.equal(error.message, 'Bad host.')

  response = () => jsonResponse({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Oops.' } }, 200)
  await rejectsWith(api.getArchive('foo.substack.com'), 'INTERNAL_ERROR')

  response = () => fail(500, { code: 'drop table', message: 'x' })
  error = await rejectsWith(api.getArchive('foo.substack.com'), 'NETWORK_ERROR')
  assert.equal(error.status, 500)
})

test('network failures and non-JSON answers are NETWORK_ERROR', async () => {
  let respond: () => Response | Promise<Response> = () => { throw new TypeError('Failed to fetch') }
  const api = createApi(RELAY, async () => respond())

  let error = await rejectsWith(api.getArchive('foo.substack.com'), 'NETWORK_ERROR')
  assert.equal(error.status, undefined)
  assert.equal(error.message, API_MESSAGES.NETWORK_ERROR)

  respond = () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
  error = await rejectsWith(api.getArchive('foo.substack.com'), 'NETWORK_ERROR')
  assert.equal(error.status, 502)

  respond = () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })
  error = await rejectsWith(api.getProfile('thezvi'), 'NETWORK_ERROR')
  assert.equal(error.status, 200)

  respond = () => jsonResponse({ data: {} })
  await rejectsWith(api.getProfile('thezvi'), 'NETWORK_ERROR')
})

test('the timeout aborts the request and gives TIMEOUT', async () => {
  let seen: AbortSignal | null | undefined
  const hanging = createApi(RELAY, async (_url, init) => {
    seen = init.signal
    return new Promise<Response>(() => {})
  }, 30)
  await rejectsWith(hanging.getArchive('foo.substack.com'), 'TIMEOUT')
  assert.equal(seen?.aborted, true)

  const honouring = createApi(RELAY, (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  }), 30)
  const error = await rejectsWith(honouring.getPost({ id: 1 }), 'TIMEOUT')
  assert.equal(error.message, API_MESSAGES.TIMEOUT)

  const slowBody = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => new Promise<string>(() => {}),
  } as unknown as Response
  await rejectsWith(createApi(RELAY, async () => slowBody, 30).getHealth(), 'TIMEOUT')
})

test('the caller signal is combined with the timeout', async () => {
  let seen: AbortSignal | null | undefined
  const rec = recorder((_url, init) => {
    seen = init.signal
    return new Promise<Response>(() => {})
  })
  const api = createApi(RELAY, rec.fetch, 60_000)

  const controller = new AbortController()
  const pending = api.getArchive('foo.substack.com', {}, controller.signal)
  controller.abort()
  await rejectsWith(pending, 'ABORTED')
  assert.equal(seen?.aborted, true)
  assert.notEqual(seen, controller.signal, 'the request uses its own combined signal')

  const already = new AbortController()
  already.abort()
  const calls = rec.calls.length
  await rejectsWith(api.getPost({ id: 1 }, already.signal), 'ABORTED')
  assert.equal(rec.calls.length, calls, 'an already-aborted signal sends nothing')
})

test('getProfile strips @, lowercases the handle and normalizes the profile', async () => {
  const subscription = (index: number) => ({ id: index, name: `Pub ${index} `, subdomain: `pub${index}`, customDomain: null, host: `pub${index}.substack.com` })
  const rec = recorder(() => ok({
    handle: 'thezvi',
    name: ' Zvi ',
    primaryPublication: { id: 1, name: 'Thinking Notes', subdomain: 'thezvi', customDomain: null, host: 'thezvi.substack.com' },
    subscriptions: [subscription(2), subscription(2), { host: 'bad host' }, 'junk', subscription(3)],
  }))
  const profile = await createApi(RELAY, rec.fetch).getProfile('  @TheZvi ')
  assert.equal(rec.calls[0]!.url, `${RELAY}/v1/profile?handle=thezvi`, 'lowercased: Substack profile lookups are case-sensitive (relay C1)')
  assert.deepEqual(profile, {
    handle: 'thezvi',
    name: 'Zvi',
    primaryPublication: { id: 1, name: 'Thinking Notes', subdomain: 'thezvi', customDomain: null, host: 'thezvi.substack.com' },
    subscriptions: [
      { id: 2, name: 'Pub 2', subdomain: 'pub2', customDomain: null, host: 'pub2.substack.com' },
      { id: 3, name: 'Pub 3', subdomain: 'pub3', customDomain: null, host: 'pub3.substack.com' },
    ],
  })
})

test('searchPublications dedupes by host and id and keeps at most 20', async () => {
  const result = (index: number) => ({ id: index + 1, name: `Pub ${index}`, subdomain: `pub${index}`, customDomain: null, host: `pub${index}.substack.com` })
  const results = [
    result(0),
    { ...result(0), id: 999 },
    { ...result(1), id: 1, host: 'other.substack.com' },
    ...Array.from({ length: 24 }, (_, index) => result(index + 1)),
  ]
  const rec = recorder(() => ok({ results }))
  const pubs = await createApi(RELAY, rec.fetch).searchPublications('economics')
  assert.equal(pubs.length, 20)
  assert.deepEqual(pubs.map(pub => pub.host), Array.from({ length: 20 }, (_, index) => `pub${index}.substack.com`))
})

test('getFeedXml returns raw XML (also as text/plain); JSON answers are errors', async () => {
  let respond: () => Response = () => xmlResponse('<rss version="2.0"><channel/></rss>')
  const rec = recorder(() => respond())
  const api = createApi(RELAY, rec.fetch)
  assert.equal(await api.getFeedXml('www.slowboring.com'), '<rss version="2.0"><channel/></rss>')
  assert.equal(rec.calls[0]!.url, `${RELAY}/v1/feed?host=www.slowboring.com`)
  // The relay serves feeds as sandboxed text/plain (relay S1); the body is still the XML.
  respond = () => new Response('<rss version="2.0"><channel/></rss>', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  assert.equal(await api.getFeedXml('www.slowboring.com'), '<rss version="2.0"><channel/></rss>')

  respond = () => fail(503, { code: 'UPSTREAM_BLOCKED', message: 'Blocked.' })
  await rejectsWith(api.getFeedXml('www.slowboring.com'), 'UPSTREAM_BLOCKED')
  respond = () => ok({ xml: '<rss/>' })
  await rejectsWith(api.getFeedXml('www.slowboring.com'), 'UPSTREAM_INVALID')
})

test('getHealth normalizes the relay report', async () => {
  let data: unknown = {
    service: 'substack-reader-relay',
    protocol: 1,
    revision: 'abc1234',
    origin: 'https://app.example.org',
    probes: [
      { target: 'subdomain', status: 200, contentType: 'application/json', challenge: false, ms: 120 },
      { target: 'bogus', status: 1 },
      { target: 'substackCom', status: 403, contentType: 'text/html', challenge: true, ms: 80 },
    ],
  }
  const rec = recorder(() => ok(data))
  const api = createApi(RELAY, rec.fetch)
  assert.deepEqual(await api.getHealth(true), {
    service: 'substack-reader-relay',
    protocol: 1,
    revision: 'abc1234',
    origin: 'https://app.example.org',
    probes: [
      { target: 'subdomain', status: 200, contentType: 'application/json', challenge: false, ms: 120 },
      { target: 'substackCom', status: 403, contentType: 'text/html', challenge: true, ms: 80 },
    ],
  })
  data = { service: 'something-else', protocol: 1 }
  await rejectsWith(api.getHealth(), 'UPSTREAM_INVALID')
})

test('rss2json: only when enabled, simple GET, status mapped', async () => {
  let respond: () => Response = () => jsonResponse({ status: 'ok', feed: { title: 'T' }, items: [] })
  const rec = recorder(() => respond())
  const api = createApi(null, rec.fetch, 1000, true)
  assert.equal(api.rss2jsonEnabled(), true)
  assert.equal(api.relayConfigured(), false)
  assert.deepEqual(await api.getRss2Json('WWW.SlowBoring.com'), { status: 'ok', feed: { title: 'T' }, items: [] })
  assert.equal(rec.calls[0]!.url, `${RSS2JSON_ENDPOINT}?rss_url=https%3A%2F%2Fwww.slowboring.com%2Ffeed`)
  assert.equal(rec.calls[0]!.url, 'https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.slowboring.com%2Ffeed')
  assertSimpleGet(rec.calls[0]!.init)

  respond = () => jsonResponse({ status: 'error', message: 'Feed not found' }, 422)
  const error = await rejectsWith(api.getRss2Json('www.slowboring.com'), 'UPSTREAM_ERROR')
  assert.equal(error.message, 'Feed not found')
  respond = () => jsonResponse({ status: 'error', message: 'Too many requests' }, 429)
  await rejectsWith(api.getRss2Json('www.slowboring.com'), 'UPSTREAM_RATE_LIMITED')
  respond = () => new Response('<html></html>', { status: 200 })
  await rejectsWith(api.getRss2Json('www.slowboring.com'), 'UPSTREAM_INVALID')
  await rejectsWith(api.getRss2Json('localhost'), 'INVALID_HOST')
})

test('the build client has rss2json disabled and never fetches it', async () => {
  const restore = stubFetch(() => jsonResponse({ status: 'ok', items: [] }))
  try {
    await rejectsWith(getRss2Json('www.slowboring.com'), 'NOT_CONFIGURED')
    assert.equal(fetchCalls.length, 0)
  } finally {
    restore()
  }
})

test('appendPosts keeps the first occurrence of every id', () => {
  const a = { ...postFixture, id: 1, slug: 'a' } as PostSummary
  const b = { ...postFixture, id: 2, slug: 'b' } as PostSummary
  const bAgain = { ...postFixture, id: 2, slug: 'b-again' } as PostSummary
  const c = { ...postFixture, id: 3, slug: 'c' } as PostSummary
  assert.deepEqual(appendPosts([a, b], [bAgain, c, a]).map(post => post.slug), ['a', 'b', 'c'])
  assert.deepEqual(appendPosts([], []), [])
})
