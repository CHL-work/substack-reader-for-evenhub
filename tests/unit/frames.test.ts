import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { minutesFor, pctString, relativeDate } from '../../src/app/format'
import {
  EMPTY_TEXT, TEXT, errorBody, errorFrame, fitBody, frameFor, homeEntries, homeFrame, loadingFrame, menuBody,
  postsFrame, publicationsFrame, readerFrame, type PostsView, type ReaderView,
} from '../../src/app/frames'
import { emptyState, type AppState, type Article, type PostRef, type Publication } from '../../src/app/types'
import type { GlassesPage } from '../../src/events'
import { READER_BODY_WIDTH, isReaderPage, type TextPage } from '../../src/pagination'

// relativeDate uses the local calendar; pin it for exact month/day strings.
process.env.TZ = 'UTC'

const NB = '\u00a0\u00a0\u00a0'
const DOT = ' \u00b7 '
const X = '\u00d7'
const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const OPTIONS = { now: NOW, relayConfigured: true }

function pub(host: string, name: string): Publication {
  return { id: null, name, host, addedAt: 1, inLatest: true }
}

function ref(id: number, overrides: Partial<PostRef> = {}): PostRef {
  return {
    postId: id,
    host: 'alpha.substack.com',
    slug: `post-${id}`,
    title: `Post ${id}`,
    pubName: 'Alpha',
    postDate: '2026-10-01T12:00:00.000Z',
    isPaywalled: false,
    wordcount: 1200,
    addedAt: 1,
    ...overrides,
  }
}

function posts(overrides: Partial<PostsView>): PostsView {
  return { kind: 'posts', source: 'latest', sel: 0, items: [], nextOffset: null, state: 'ready', error: null, ...overrides }
}

function assertFits(frame: GlassesPage) {
  assert.ok(isReaderPage(frame.body, 7), `body overflows: ${JSON.stringify(frame.body)}`)
  for (const line of frame.body.split('\n')) {
    assert.ok(getTextWidth(line) <= READER_BODY_WIDTH, `line too wide: ${JSON.stringify(line)}`)
  }
}

test('format: minutes, relative dates and percentages', () => {
  assert.equal(minutesFor(0), 1)
  assert.equal(minutesFor(null), 1)
  assert.equal(minutesFor(114), 1)
  assert.equal(minutesFor(345), 2)
  assert.equal(minutesFor(2760), 12)
  assert.equal(minutesFor(Number.NaN), 1)

  assert.equal(relativeDate('2026-10-06T11:59:30.000Z', NOW), 'now')
  assert.equal(relativeDate('2026-10-07T00:00:00.000Z', NOW), 'now')
  assert.equal(relativeDate('2026-10-06T11:15:00.000Z', NOW), '45m')
  assert.equal(relativeDate('2026-10-06T09:00:00.000Z', NOW), '3h')
  assert.equal(relativeDate('2026-10-04T12:00:00.000Z', NOW), '2d')
  assert.equal(relativeDate('2026-09-30T12:00:01.000Z', NOW), '5d')
  assert.equal(relativeDate('2026-09-29T12:00:00.000Z', NOW), 'Sep 29')
  assert.equal(relativeDate('2026-03-04T12:00:00.000Z', NOW), 'Mar 4')
  assert.equal(relativeDate('2025-12-31T12:00:00.000Z', NOW), 'Dec 31, 2025')
  assert.equal(relativeDate('garbage', NOW), '')
  assert.equal(relativeDate(null, NOW), '')

  assert.equal(pctString(0), '0%')
  assert.equal(pctString(12 / 41), '29%')
  assert.equal(pctString(0.996), '99%')
  assert.equal(pctString(1), '100%')
  assert.equal(pctString(Number.NaN), '0%')
})

test('home frame: exact strings, Continue entry and 4-per-screen windows', () => {
  const state = emptyState()
  state.publications = [pub('alpha.substack.com', 'Alpha'), pub('beta.substack.com', 'Beta')]
  state.saved = [ref(1)]
  assert.deepEqual(homeFrame(state, 1), {
    title: 'Reader for Substack',
    body: `${NB}Latest\n\n> Publications (2)\n\n${NB}Saved (1)`,
    footer: `Tap open${DOT}2${X}tap exit`,
  })
  assert.deepEqual(frameFor({ kind: 'home', sel: 1 }, state, OPTIONS), homeFrame(state, 1))

  state.lastOpen = ref(5, { title: 'Deep Dive' })
  state.settings.homeItems = ['latest', 'publications', 'saved', 'history']
  assert.deepEqual(homeEntries(state).map(entry => entry.id), ['continue', 'latest', 'publications', 'saved', 'history'])
  assert.equal(homeFrame(state, 0).body, `> Continue: Deep Dive\n\n${NB}Latest\n\n${NB}Publications (2)\n\n${NB}Saved (1)`)
  assert.equal(homeFrame(state, 4).body, '> History', 'the second screen holds the fifth item')
  assert.equal(homeFrame(state, 99).body, '> History', 'the selection is clamped')

  // A finished lastOpen (end-card position) is not offered.
  state.positions = [{ postId: 5, offset: 900, fraction: 1, page: 10, pages: 10, version: '1.1.7', updatedAt: 1 }]
  assert.equal(homeEntries(state)[0]!.id, 'latest')
  state.positions = [{ postId: 5, offset: 400, fraction: 0.5, page: 5, pages: 10, version: '1.1.7', updatedAt: 1 }]
  assert.equal(homeEntries(state)[0]!.id, 'continue')
})

test('root frames: first run and relay not configured', () => {
  const state = emptyState()
  assert.deepEqual(frameFor({ kind: 'home', sel: 0 }, state, OPTIONS), {
    title: 'Reader for Substack',
    body: 'No publications yet.\n\nOn your phone, open Reader for Substack\nin the Even app and add a publication.',
    footer: `2${X}tap exit`,
  })
  state.publications = [pub('alpha.substack.com', 'Alpha')]
  assert.deepEqual(frameFor({ kind: 'home', sel: 0 }, state, { now: NOW, relayConfigured: false }), {
    title: 'Reader for Substack',
    body: 'This build has no reader service.\nSee the phone for details.',
    footer: `2${X}tap exit`,
  })
})

test('publications frame', () => {
  const state = emptyState()
  assert.deepEqual(publicationsFrame(state, 0), { title: 'Publications', body: 'No publications yet.\nAdd one on your phone.', footer: `2${X}tap back` })
  state.publications = [pub('alpha.substack.com', 'Alpha'), pub('beta.substack.com', 'Beta')]
  assert.deepEqual(publicationsFrame(state, 0), {
    title: 'Publications',
    body: `> Alpha\n\n${NB}Beta`,
    footer: `1/2${DOT}Tap open${DOT}2${X}tap back`,
  })
  assert.equal(publicationsFrame(state, 7).footer, `2/2${DOT}Tap open${DOT}2${X}tap back`)
})

test('posts frame: two lines per entry, meta fields, progress, load row and failures', () => {
  const state = emptyState()
  const items = [
    ref(1, { title: 'First post', postDate: '2026-10-04T12:00:00.000Z', wordcount: 2760, isPaywalled: true }),
    ref(2, { title: 'Second', pubName: 'Beta', postDate: '2026-10-06T09:00:00.000Z', wordcount: null }),
    ref(3, { title: 'Third', postDate: '2026-03-04T12:00:00.000Z', wordcount: 100 }),
    ref(4, { title: 'Old', postDate: '2024-12-25T12:00:00.000Z', wordcount: 460 }),
  ]
  state.positions = [{ postId: 1, offset: 10, fraction: 9 / 25, page: 9, pages: 25, version: '1.1.7', updatedAt: 1 }]
  state.read = [2]
  const latest = postsFrame(posts({ items }), state, NOW)
  assert.deepEqual(latest, {
    title: 'Latest',
    body: [
      '> First post',
      `${NB}Alpha${DOT}2d${DOT}12 min${DOT}Paid${DOT}40%`,
      `${NB}Second`,
      `${NB}Beta${DOT}3h${DOT}Read`,
      `${NB}Third`,
      `${NB}Alpha${DOT}Mar 4${DOT}1 min`,
    ].join('\n'),
    footer: `1/4${DOT}Tap read${DOT}2${X}tap back`,
  })
  assert.deepEqual(postsFrame(posts({ items, sel: 3, failed: 2 }), state, NOW), {
    title: 'Latest',
    body: `> Old\n${NB}Alpha${DOT}Dec 25, 2024${DOT}2 min`,
    footer: `4/4${DOT}Tap read${DOT}2${X}tap back${DOT}2 failed`,
  })

  // Inside a publication's own list the publication name is omitted; a load row follows.
  const own = postsFrame(posts({ source: { host: 'alpha.substack.com', name: 'Alpha' }, items: [items[0]!], nextOffset: 12, sel: 1 }), state, NOW)
  assert.deepEqual(own, {
    title: 'Alpha',
    body: `${NB}First post\n${NB}2d${DOT}12 min${DOT}Paid${DOT}40%\n> Load older posts\u2026`,
    footer: `2/2${DOT}Tap load${DOT}2${X}tap back`,
  })
  assert.equal(postsFrame(posts({ source: { host: 'alpha.substack.com' }, items: [] }), state, NOW).title, 'alpha.substack.com')

  assert.deepEqual(postsFrame(posts({ source: 'saved' }), state, NOW), { title: 'Saved', body: 'Nothing saved yet.\nSave posts on your phone.', footer: `2${X}tap back` })
  assert.equal(postsFrame(posts({ source: 'history' }), state, NOW).body, 'Nothing read yet.')
  assert.equal(postsFrame(posts({}), state, NOW).body, 'No publications in Latest.\nTurn one on in the phone app.')
  state.publications = [pub('alpha.substack.com', 'Alpha')]
  assert.equal(postsFrame(posts({}), state, NOW).body, 'No posts yet.')

  assert.deepEqual(postsFrame(posts({ state: 'loading' }), state, NOW), { title: 'Latest', body: 'Loading\u2026', footer: `2${X}tap cancel` })
  assert.deepEqual(postsFrame(posts({ state: 'error', error: { code: 'TIMEOUT', message: 'slow' } }), state, NOW), {
    title: 'Latest',
    body: "Can't reach the reader service.\nCheck the phone's connection.",
    footer: `Tap retry${DOT}2${X}tap back`,
  })
  for (const frame of [latest, own]) assertFits(frame)
})

test('long titles and names are pixel-truncated to one line each', () => {
  const state = emptyState()
  const long = 'Extraordinarily '.repeat(30).trim()
  state.publications = [pub('alpha.substack.com', long), pub('beta.substack.com', 'Beta')]
  state.lastOpen = ref(9, { title: long })
  const items = [ref(1, { title: long, pubName: long }), ref(2, { title: long }), ref(3, { title: long })]
  const frames = [
    homeFrame(state, 0),
    publicationsFrame(state, 0),
    postsFrame(posts({ items, source: { host: 'alpha.substack.com', name: long }, nextOffset: 3 }), state, NOW),
  ]
  for (const frame of frames) {
    assertFits(frame)
    assert.ok(frame.body.split('\n').every(line => measureTextWrap(line, READER_BODY_WIDTH).lineCount <= 1))
  }
  assert.equal(frames[2]!.body.split('\n').length, 6)
})

function readerView(overrides: Partial<ReaderView> = {}): ReaderView {
  const pages: TextPage[] = Array.from({ length: 41 }, (_, index) => ({ text: `Page ${index + 1} text.`, start: index * 100, end: index * 100 + 50 }))
  const article: Article = {
    postId: 1,
    title: 'First post',
    pubName: 'Alpha',
    text: 'x'.repeat(4100),
    wordCount: 2870,
    paywalled: false,
    isPodcast: false,
    version: '1',
  }
  return { kind: 'reader', ref: ref(1, { title: 'Ref title', pubName: 'Ref pub' }), pages, page: 11, article, state: 'ready', error: null, ...overrides }
}

test('reader frame: title, page, percent and minutes left; end cards', () => {
  assert.deepEqual(readerFrame(readerView()), {
    title: `Alpha${DOT}First post`,
    body: 'Page 12 text.',
    footer: `12/41${DOT}29%${DOT}~9 min left`,
  })
  assert.equal(readerFrame(readerView({ page: 40 })).footer, `41/41${DOT}100%${DOT}~1 min left`)
  assert.deepEqual(readerFrame(readerView({ page: 41 })), {
    title: `Alpha${DOT}First post`,
    body: `End of post.\n\nTap: next post\nSwipe up: previous page\n2${X}tap: back to list`,
    footer: `End${DOT}41/41`,
  })
  const paid = readerView({ page: 41 })
  paid.article = { ...paid.article!, paywalled: true }
  assert.deepEqual(readerFrame(paid), {
    title: `Alpha${DOT}First post`,
    body: `The free preview ends here.\nThe rest is for paid subscribers.\nRead it in the Substack app.\n\nTap: next post${DOT}2${X}tap: back`,
    footer: `End${DOT}41/41`,
  })
  assert.deepEqual(readerFrame(readerView({ state: 'loading', article: undefined, pages: [], page: 0 })), {
    title: `Ref pub${DOT}Ref title`,
    body: 'Loading\u2026',
    footer: `2${X}tap cancel`,
  })
  assert.deepEqual(readerFrame(readerView({ state: 'error', error: { code: EMPTY_TEXT, message: '' } })), {
    title: `Alpha${DOT}First post`,
    body: 'No readable text in this post.',
    footer: `2${X}tap back`,
  })
  for (const page of [0, 11, 40, 41]) assertFits(readerFrame(readerView({ page })))
})

test('error bodies follow the code table; every body fits the glasses', () => {
  const cases: Array<[string, string]> = [
    ['NOT_CONFIGURED', 'This build has no reader service.'],
    ['NETWORK_ERROR', "Can't reach the reader service.\nCheck the phone's connection."],
    ['TIMEOUT', "Can't reach the reader service.\nCheck the phone's connection."],
    ['UPSTREAM_BLOCKED', 'Substack refused the reader service.\nTry again later.'],
    ['RATE_LIMITED', 'Busy. Try again in 60 s.'],
    ['UPSTREAM_RATE_LIMITED', 'Busy. Try again in 60 s.'],
    ['POST_NOT_FOUND', 'Not found on Substack.'],
    ['PUBLICATION_NOT_FOUND', 'Not found on Substack.'],
    ['PROFILE_NOT_FOUND', 'Not found on Substack.'],
    ['HOST_NOT_SUBSTACK', 'That site is not a Substack publication.'],
    [EMPTY_TEXT, 'No readable text in this post.'],
    ['UPSTREAM_INVALID', 'Substack had a problem.\nTry again.'],
    ['SOMETHING_NEW', 'Substack had a problem.\nTry again.'],
  ]
  for (const [code, body] of cases) {
    assert.equal(errorBody({ code }), body, code)
    const frame = errorFrame('Title', { code, message: 'details for the phone' })
    assert.equal(frame.body, body)
    assert.equal(frame.footer, code === EMPTY_TEXT || code === 'NOT_CONFIGURED' ? `2${X}tap back` : `Tap retry${DOT}2${X}tap back`)
    assertFits(frame)
  }
  assert.equal(errorBody({ code: 'RATE_LIMITED', retryAfterSeconds: 120 }), 'Busy. Try again in 120 s.')
  assert.equal(errorBody({ code: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: 2.5 }), 'Busy. Try again in 3 s.')
  assert.deepEqual(loadingFrame('Saved'), { title: 'Saved', body: 'Loading\u2026', footer: `2${X}tap cancel` })
  for (const text of Object.values(TEXT)) assertFits({ title: '', body: fitBody(text), footer: '' })
})

test('fitBody keeps a fitting body and cuts an overflowing one to its first page', () => {
  const short = 'One line.\n\nAnother.'
  assert.equal(fitBody(short), short)
  const long = Array.from({ length: 40 }, (_, index) => `Line number ${index + 1} of a long message.`).join('\n')
  const fitted = fitBody(long)
  assert.ok(isReaderPage(fitted, 7))
  assert.ok(long.startsWith(fitted))
  assert.ok(fitted.length < long.length)
  assert.equal(menuBody(['A', 'B', 'C', 'D', 'E', 'F'], 5), `${NB}E\n\n> F`)
  assert.equal(menuBody([], 0), '')
})

test('frameFor dispatches every view kind', () => {
  const state: AppState = emptyState()
  state.publications = [pub('alpha.substack.com', 'Alpha')]
  assert.equal(frameFor({ kind: 'publications', sel: 0 }, state, OPTIONS).title, 'Publications')
  assert.equal(frameFor(posts({ source: 'saved' }), state, OPTIONS).title, 'Saved')
  assert.equal(frameFor(readerView(), state, OPTIONS).body, 'Page 12 text.')
})
