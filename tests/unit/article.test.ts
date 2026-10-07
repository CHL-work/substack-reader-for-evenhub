import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings, type Settings } from '../../src/app/types'
import { CONVERTER_VERSION, type HtmlToReaderTextOptions, type ReaderTextResult } from '../../src/substack/html'
import type { PostDetail, PubMeta } from '../../src/substack/types'
import {
  EMPTY_BODY_NOTE,
  PAID_PREVIEW_HEADER,
  PODCAST_HEADER,
  WORDS_PER_MINUTE,
  articleVersion,
  buildArticle,
  converterOptions,
  formatPostDate,
  isCovered,
  readingMinutes,
  type Converter,
} from '../../src/substack/article'

// No DOM in Node: every buildArticle call gets a stub converter.

const DOT = '\u00B7'
const PREVIEW_NOTE = '[Preview ends here. The rest of this post is for paid subscribers.]'

function post(overrides: Partial<PostDetail> = {}): PostDetail {
  return {
    id: 101,
    publicationId: 7,
    slug: 'on-rye',
    title: 'On Rye',
    subtitle: 'A short history',
    postDate: '2026-03-05T12:00:00.000Z', // midday UTC: Mar 5 in every time zone from UTC-11 to UTC+11
    audience: 'everyone',
    isPaywalled: false,
    type: 'newsletter',
    wordcount: 1000,
    canonicalUrl: 'https://example.substack.com/p/on-rye',
    authors: ['Ada Baker', 'Ben Miller'],
    podcastDurationSec: null,
    bodyHtml: '<p>Synthetic body.</p>',
    truncated: false,
    ...overrides,
  }
}

const PUB: PubMeta = { id: 7, name: 'Example Letter', subdomain: 'example', customDomain: null, host: 'example.substack.com' }

interface ConvertCall { html: string | null | undefined; opts: HtmlToReaderTextOptions | undefined }

function stub(result: Partial<ReaderTextResult> = {}): { convert: Converter; calls: ConvertCall[] } {
  const calls: ConvertCall[] = []
  const convert: Converter = (html, opts) => {
    calls.push({ html, opts })
    return { text: 'Body text.', body: 'Body text.', footnotes: [], wordCount: 2, paywalled: false, ...result }
  }
  return { convert, calls }
}

test('free post: header block, blank line, converted text', () => {
  const { convert, calls } = stub()
  const article = buildArticle(post(), PUB, defaultSettings(), convert)
  assert.equal(article.text, `On Rye\nA short history\nBy Ada Baker, Ben Miller ${DOT} Mar 5, 2026 ${DOT} 4 min read\n\nBody text.`)
  assert.deepEqual(article, {
    postId: 101,
    title: 'On Rye',
    pubName: 'Example Letter',
    text: article.text,
    wordCount: 2,
    paywalled: false,
    isPodcast: false,
    version: `${CONVERTER_VERSION}-end-drop-10`,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.html, '<p>Synthetic body.</p>')
  assert.ok(!('bodyHtml' in article), 'the article never carries the HTML')
})

test('converter options follow the post and the reader settings', () => {
  const { convert, calls } = stub()
  buildArticle(post(), PUB, defaultSettings(), convert)
  const opts = calls[0]!.opts
  assert.ok(opts)
  assert.equal(opts.isCovered, isCovered)
  const { isCovered: _covered, ...rest } = opts
  assert.deepEqual(rest, {
    audience: 'everyone',
    expectedWordCount: 1000,
    footnoteMode: 'end',
    bareImages: 'drop',
    uppercaseHeadingMax: 60,
    stripEmoji: false,
  })

  const settings: Settings = { ...defaultSettings(), footnotes: 'inline', bareImages: 'placeholder', uppercaseHeadings: false, stripEmoji: true }
  const custom = converterOptions(post({ wordcount: null }), settings)
  assert.equal(custom.footnoteMode, 'inline')
  assert.equal(custom.bareImages, 'placeholder')
  assert.equal(custom.uppercaseHeadingMax, 0)
  assert.equal(custom.stripEmoji, true)
  assert.equal(custom.expectedWordCount, null)
})

test('isCovered uses the firmware font metrics', () => {
  assert.equal(isCovered(0x41), true)
  assert.equal(isCovered(0x2022), true)
  assert.equal(isCovered(0x05E9), false) // Hebrew is not in the G2 fonts
  assert.equal(isCovered(0x05E9), false) // memoized path
})

test('paid preview: header note, gated audience passed through', () => {
  const { convert, calls } = stub({ text: `Preview.\n\n${PREVIEW_NOTE}`, body: `Preview.\n\n${PREVIEW_NOTE}`, wordCount: 1, paywalled: true })
  const article = buildArticle(post({ audience: 'only_paid', isPaywalled: true, truncated: true, subtitle: null, wordcount: 2300 }), PUB, defaultSettings(), convert)
  assert.equal(article.text, `On Rye\nBy Ada Baker, Ben Miller ${DOT} Mar 5, 2026 ${DOT} 10 min read\n${PAID_PREVIEW_HEADER}\n\nPreview.\n\n${PREVIEW_NOTE}`)
  assert.equal(article.paywalled, true)
  assert.equal(calls[0]!.opts?.audience, 'only_paid')
})

test('any audience other than everyone is gated (C11)', () => {
  const { convert, calls } = stub()
  const founding = buildArticle(post({ audience: 'founding', isPaywalled: true, truncated: true }), PUB, defaultSettings(), convert)
  assert.equal(calls[0]!.opts?.audience, 'founding')
  assert.equal(founding.paywalled, true)
  assert.ok(founding.text.includes(`\n${PAID_PREVIEW_HEADER}\n\n`))

  // Inconsistent flags: the paywall flag wins and the converter is told the post is gated.
  const flagged = buildArticle(post({ audience: 'everyone', isPaywalled: true }), PUB, defaultSettings(), convert)
  assert.equal(calls[1]!.opts?.audience, 'only_paid')
  assert.equal(flagged.paywalled, true)

  // The converter can detect a cut (RSS "Read more") on a post that looked free.
  const cut = stub({ paywalled: true })
  assert.equal(buildArticle(post(), PUB, defaultSettings(), cut.convert).paywalled, true)
})

test('podcast note; minutes from the converted text when Substack has no count', () => {
  const { convert } = stub({ wordCount: 700 })
  const article = buildArticle(post({ type: 'podcast', title: 'Episode 12', subtitle: null, authors: [], wordcount: null }), null, defaultSettings(), convert)
  assert.equal(article.text, `Episode 12\nMar 5, 2026 ${DOT} 3 min read\n${PODCAST_HEADER}\n\nBody text.`)
  assert.equal(article.isPodcast, true)
  assert.equal(article.pubName, '')
})

test('a bad date is omitted and short posts read in one minute', () => {
  const { convert } = stub()
  const article = buildArticle(post({ postDate: 'not a date', wordcount: 40, authors: ['Solo'], subtitle: '' }), PUB, defaultSettings(), convert)
  assert.equal(article.text, `On Rye\nBy Solo ${DOT} 1 min read\n\nBody text.`)
})

test('header text is glyph-normalized and whitespace-collapsed', () => {
  const { convert } = stub()
  const article = buildArticle(post({
    title: '  The `best`\u00A0bread\u00AD ',
    subtitle: 'Hot \u{1F600} takes',
    authors: ['  A\u200Bda  ', '   '],
  }), { ...PUB, name: '   ' }, defaultSettings(), convert)
  assert.equal(article.title, "The 'best' bread")
  assert.equal(article.pubName, 'example.substack.com', 'a blank publication name falls back to the host')
  assert.equal(article.text, `The 'best' bread\nHot \u{1F600} takes\nBy Ada ${DOT} Mar 5, 2026 ${DOT} 4 min read\n\nBody text.`)

  const stripped = buildArticle(post({ subtitle: 'Hot \u{1F600} takes' }), PUB, { ...defaultSettings(), stripEmoji: true }, convert)
  assert.ok(stripped.text.startsWith('On Rye\nHot takes\n'))
  assert.equal(stripped.version, `${CONVERTER_VERSION}-end-drop-11`)
})

test('an empty title and an empty body get placeholders', () => {
  const { convert } = stub({ text: '', body: '', wordCount: 0 })
  const article = buildArticle(post({ title: '', wordcount: null }), PUB, defaultSettings(), convert)
  assert.equal(article.title, 'Untitled')
  assert.equal(article.text, `Untitled\nA short history\nBy Ada Baker, Ben Miller ${DOT} Mar 5, 2026 ${DOT} 1 min read\n\n${EMPTY_BODY_NOTE}`)
})

test('header lines never start with an ASCII space (C7)', () => {
  const { convert } = stub()
  const article = buildArticle(post({ title: ' \n Spaced \n title ', subtitle: ' \t sub ' }), PUB, defaultSettings(), convert)
  assert.ok(!/\n /.test(article.text))
  assert.ok(article.text.startsWith('Spaced title\nsub\n'))
})

test('readingMinutes rounds at 230 words per minute, at least one', () => {
  assert.equal(WORDS_PER_MINUTE, 230)
  assert.equal(readingMinutes(0), 1)
  assert.equal(readingMinutes(114), 1)
  assert.equal(readingMinutes(345), 2)
  assert.equal(readingMinutes(1000), 4)
  assert.equal(readingMinutes(2300), 10)
  assert.equal(readingMinutes(Number.NaN), 1)
  assert.equal(readingMinutes(-50), 1)
})

test('formatPostDate', () => {
  assert.equal(formatPostDate('2026-03-05T12:00:00.000Z'), 'Mar 5, 2026')
  assert.equal(formatPostDate('2025-12-24T12:30:00Z'), 'Dec 24, 2025')
  assert.equal(formatPostDate(''), '')
  assert.equal(formatPostDate('garbage'), '')
})

test('articleVersion changes with every text-affecting setting only', () => {
  const base = defaultSettings()
  const version = articleVersion(base)
  assert.equal(version, `${CONVERTER_VERSION}-end-drop-10`)
  assert.equal(articleVersion({ ...base, linesPerPage: 5, invertSwipe: true, tapInReader: 'none' }), version)
  const variants = [
    articleVersion({ ...base, footnotes: 'inline' }),
    articleVersion({ ...base, footnotes: 'omit' }),
    articleVersion({ ...base, bareImages: 'placeholder' }),
    articleVersion({ ...base, uppercaseHeadings: false }),
    articleVersion({ ...base, stripEmoji: true }),
  ]
  assert.equal(new Set([version, ...variants]).size, 6)
  for (const v of variants) assert.ok(!v.includes('.'), 'no dots: Position.version joins parts with dots')
})
