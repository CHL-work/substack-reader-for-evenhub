import { assert, assertEqual, test } from './harness'
import feedXml from '../fixtures/feed/substack-feed.xml'
import rss2json from '../fixtures/feed/rss2json.json'
import { ApiError } from '../../src/substack/api'
import {
  FEED_FREE_AUDIENCE,
  FEED_PAID_AUDIENCE,
  hasReadMoreTail,
  parseFeed,
  parseRss2Json,
  slugFromLink,
  syntheticPostId,
} from '../../src/substack/feed'
import { htmlToReaderText } from '../../src/substack/html'
import type { PostSummary } from '../../src/substack/types'

const HOST = 'fieldnotes.substack.com'
const BASE = `https://${HOST}/p/`

function summary(slug: string, fields: Partial<PostSummary>): PostSummary {
  return {
    id: syntheticPostId(HOST, slug),
    publicationId: null,
    slug,
    title: '',
    subtitle: null,
    postDate: '',
    audience: FEED_FREE_AUDIENCE,
    isPaywalled: false,
    type: 'newsletter',
    wordcount: null,
    canonicalUrl: `${BASE}${slug}`,
    authors: ['Ada Example'],
    podcastDurationSec: null,
    ...fields,
  }
}

const EXPECTED: PostSummary[] = [
  summary('a-free-essay-about-tidy-gardens', {
    title: 'A free essay about tidy gardens',
    subtitle: 'Why the rows lean east \u{2014} a subtitle',
    postDate: '2026-10-05T15:03:24.000Z',
  }),
  summary('paid-notes-on-compost', {
    title: 'Paid notes on compost',
    subtitle: 'Only the opening is public',
    postDate: '2026-10-04T09:00:00.000Z',
    audience: FEED_PAID_AUDIENCE,
    isPaywalled: true,
  }),
  summary('episode-12-soil', {
    title: 'Episode 12: Soil, slowly',
    subtitle: 'Listen now (36 mins) | A synthetic episode',
    postDate: '2026-10-03T07:30:00.000Z',
    type: 'podcast',
    podcastDurationSec: 2170,
  }),
  summary('weekly-links', {
    title: 'Links & notes',
    postDate: '2026-10-02T18:00:00.000Z',
    authors: ['Ada Example', 'Bo Sample'],
  }),
]

const FREE_BODY = '<p>The first paragraph of an invented essay.</p><p>A second paragraph ends the free post.</p>'

function expectApiError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert(error instanceof ApiError, `Expected ApiError ${code}, got ${String(error)}`)
    assertEqual(error.code, code)
    return
  }
  throw new Error(`Expected ApiError ${code}, but nothing was thrown.`)
}

test('parseFeed: free, paid (Read more tail) and podcast items', () => {
  const result = parseFeed(feedXml, HOST)
  assertEqual(result.title, 'Synthetic Field Notes')
  assertEqual(result.posts, EXPECTED)
  assertEqual([...result.bodies.keys()], EXPECTED.map(post => post.slug))
  assertEqual(result.bodies.get('a-free-essay-about-tidy-gardens'), FREE_BODY)
  assertEqual(result.bodies.get('episode-12-soil'), '<p>Show notes for an invented episode.</p>')
  const paid = result.bodies.get('paid-notes-on-compost') ?? ''
  assert(paid.startsWith('<p>The public opening of an invented paid post.</p>'), 'paid preview body kept as HTML')
  assert(hasReadMoreTail(paid, `${BASE}paid-notes-on-compost`), 'the paid body keeps its Read more tail for html.ts')
})

test('feed bodies convert with their audience: only a paid item loses its Read more tail (C1)', () => {
  const result = parseFeed(feedXml, HOST)
  const convert = (slug: string) => htmlToReaderText(result.bodies.get(slug), { audience: result.posts.find(post => post.slug === slug)?.audience })
  const free = convert('weekly-links')
  assertEqual(free.text, 'A short free post.\n\nRead more', 'a free item ending in a link to another post keeps it')
  assertEqual(free.paywalled, false)
  const paid = convert('paid-notes-on-compost')
  assertEqual(paid.text, 'The public opening of an invented paid post.\n\n[Preview ends here. The rest of this post is for paid subscribers.]')
  assertEqual(paid.paywalled, true)
  assertEqual(paid.wordCount, 8)
})

test('parseFeed: synthetic ids are negative, stable and host-scoped', () => {
  const ids = parseFeed(feedXml, HOST).posts.map(post => post.id)
  for (const id of ids) assert(Number.isSafeInteger(id) && id < 0, `bad id ${id}`)
  assertEqual(new Set(ids).size, ids.length)
  assertEqual(parseFeed(feedXml, 'FieldNotes.Substack.com').posts.map(post => post.id), ids)
  assertEqual(syntheticPostId(HOST, 'x'), syntheticPostId(HOST, 'x'))
  assert(syntheticPostId(HOST, 'x') !== syntheticPostId(HOST, 'y'), 'slug changes the id')
  assert(syntheticPostId(HOST, 'x') !== syntheticPostId('other.substack.com', 'x'), 'host changes the id')
})

test('parseFeed never touches the live document', () => {
  const before = document.getElementsByTagName('*').length
  parseFeed(feedXml, HOST)
  assertEqual(document.getElementsByTagName('*').length, before)
  assertEqual(document.getElementsByTagName('item').length, 0)
})

test('parseFeed rejects empty, malformed and non-RSS documents', () => {
  expectApiError(() => parseFeed('', HOST), 'UPSTREAM_INVALID')
  expectApiError(() => parseFeed('<rss><channel><item></rss>', HOST), 'UPSTREAM_INVALID')
  expectApiError(() => parseFeed('<html><body>Not a feed</body></html>', HOST), 'UPSTREAM_INVALID')
  const empty = parseFeed('<rss version="2.0"><channel><title> Empty </title></channel></rss>', HOST)
  assertEqual(empty.posts, [])
  assertEqual(empty.bodies.size, 0)
  assertEqual(empty.title, 'Empty')
})

test('hasReadMoreTail matches only a trailing Read more link to the same post', () => {
  const link = `${BASE}s`
  assert(hasReadMoreTail(`<p>x</p><p><a href="${link}">Read more</a></p>`, link), 'plain tail')
  assert(hasReadMoreTail(`<p>x</p>\n  <p>\n    <a href="${link}">\n      Read more\n    </a>\n  </p>\n `, link), 'padded tail')
  assert(hasReadMoreTail(`<p>x</p><p><a href='${link}/' rel="nofollow">Read more</a></p>`, link), 'quotes, attributes, slash')
  assert(!hasReadMoreTail(`<p><a href="${link}">Read more</a></p><p>More text after.</p>`, link), 'not at the end')
  assert(!hasReadMoreTail(`<p>x</p><p><a href="${BASE}other">Read more</a></p>`, link), 'another post')
  assert(!hasReadMoreTail('<p>Read more</p>', link), 'no link')
})

test('slugFromLink reads /p/<slug> from http(s) links only', () => {
  assertEqual(slugFromLink(`${BASE}my-slug`), 'my-slug')
  assertEqual(slugFromLink(` ${BASE}my-slug/ `), 'my-slug')
  assertEqual(slugFromLink('http://www.example.org/p/my-slug'), 'my-slug')
  assertEqual(slugFromLink(`https://${HOST}/about`), null)
  assertEqual(slugFromLink(`${BASE}my-slug/comments`), null)
  assertEqual(slugFromLink(`${BASE}bad.slug`), null)
  assertEqual(slugFromLink('javascript:alert(1)'), null)
  assertEqual(slugFromLink('not a url'), null)
})

test('parseRss2Json matches parseFeed for the same items', () => {
  const fromJson = parseRss2Json(rss2json, HOST)
  const fromXml = parseFeed(feedXml, HOST)
  assertEqual(fromJson.title, 'Synthetic Field Notes')
  assertEqual(fromJson.posts, fromXml.posts.slice(0, 3))
  assertEqual(fromJson.posts, EXPECTED.slice(0, 3))
  assertEqual([...fromJson.bodies.keys()], EXPECTED.slice(0, 3).map(post => post.slug))
  assertEqual(fromJson.bodies.get('a-free-essay-about-tidy-gardens'), FREE_BODY)
})

test('parseRss2Json rejects error and malformed responses', () => {
  expectApiError(() => parseRss2Json({ status: 'error', message: 'Feed not found' }, HOST), 'UPSTREAM_ERROR')
  expectApiError(() => parseRss2Json({}, HOST), 'UPSTREAM_INVALID')
  expectApiError(() => parseRss2Json(null, HOST), 'UPSTREAM_INVALID')
  expectApiError(() => parseRss2Json({ status: 'ok', items: 'x' }, HOST), 'UPSTREAM_INVALID')
  const junk = parseRss2Json({ status: 'ok', items: [null, 1, { link: 'https://x.substack.com/about' }, { title: 'T', link: `${BASE}ok` }] }, HOST)
  assertEqual(junk.posts.map(post => post.slug), ['ok'])
  assertEqual(junk.posts[0]!.authors, [])
  assertEqual(junk.posts[0]!.postDate, '')
  assertEqual(junk.title, null)
})
