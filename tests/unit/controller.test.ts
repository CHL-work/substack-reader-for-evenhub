import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createController, positionVersion, resumePage, sameText, toViewError,
  type Controller, type FeedResult, type ReaderApi,
} from '../../src/app/controller'
import { TEXT } from '../../src/app/frames'
import type { Article, Position, PostRef, Publication, Settings } from '../../src/app/types'
import type { GlassesPage } from '../../src/events'
import { bodyBox, pageIndexForOffset, paginate } from '../../src/pagination'
import { KEYS, createStore, positionOf, type KV, type Store } from '../../src/storage'
import type { ArchivePage, PostDetail, PostSummary, PubMeta } from '../../src/substack/types'
import { flushPromises } from './helpers'

const NB = '\u00a0\u00a0\u00a0'
const DOT = ' \u00b7 '
const X = '\u00d7'
const LOADING = 'Loading\u2026'
const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const ALPHA = 'alpha.substack.com'

// ---------------------------------------------------------------------------
// Fakes

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

type ArchiveReply = { page: ArchivePage; host: string }
type PostReply = { post: PostDetail; publication: PubMeta | null; host: string }

function fakeApi() {
  const archive: Array<{ host: string; offset?: number; limit?: number; signal?: AbortSignal; reply: Deferred<ArchiveReply> }> = []
  const posts: Array<{ ref: { host: string; slug: string } | { id: number }; signal?: AbortSignal; reply: Deferred<PostReply> }> = []
  const api: ReaderApi = {
    getArchive(host, options, signal) {
      const reply = deferred<ArchiveReply>()
      archive.push({ host, offset: options.offset, limit: options.limit, signal, reply })
      return reply.promise
    },
    getPost(ref, signal) {
      const reply = deferred<PostReply>()
      posts.push({ ref, signal, reply })
      return reply.promise
    },
  }
  return { api, archive, posts }
}

function memoryKV(): { kv: KV; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    kv: {
      name: 'memory',
      async get(key) { return data.get(key) ?? '' },
      async set(key, value) { data.set(key, value); return true },
    },
  }
}

function fakeScheduler() {
  let time = 0
  let tasks: Array<{ at: number; run: () => void }> = []
  return {
    schedule(run: () => void, ms: number): () => void {
      const task = { at: time + ms, run }
      tasks.push(task)
      return () => { tasks = tasks.filter(item => item !== task) }
    },
    advance(ms: number) {
      time += ms
      const due = tasks.filter(task => task.at <= time)
      tasks = tasks.filter(task => task.at > time)
      for (const task of due) task.run()
    },
  }
}

// ---------------------------------------------------------------------------
// Synthetic Substack data (invented text only)

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu']

function bodyText(postId: number): string {
  return Array.from({ length: 12 }, (_, paragraph) =>
    `Paragraph ${paragraph + 1} of post ${postId}. ${Array.from({ length: 40 }, (_, word) => WORDS[(word + paragraph) % WORDS.length]).join(' ')}.`,
  ).join('\n\n')
}

function summary(id: number, overrides: Partial<PostSummary> = {}): PostSummary {
  return {
    id,
    publicationId: 100,
    slug: `post-${id}`,
    title: `Post ${id}`,
    subtitle: null,
    postDate: '2026-10-01T12:00:00.000Z',
    audience: 'everyone',
    isPaywalled: false,
    type: 'newsletter',
    wordcount: 540,
    canonicalUrl: `https://${ALPHA}/p/post-${id}`,
    authors: ['Writer'],
    podcastDurationSec: null,
    ...overrides,
  }
}

function pubMeta(host: string, name: string): PubMeta {
  return { id: 100, name, subdomain: host.split('.')[0]!, customDomain: null, host }
}

function archiveReply(host: string, name: string, posts: PostSummary[], offset: number): ArchiveReply {
  return { page: { publication: pubMeta(host, name), posts, nextOffset: posts.length ? offset + posts.length : null }, host }
}

function postReply(id: number, overrides: Partial<PostDetail> = {}): PostReply {
  return { post: { ...summary(id), bodyHtml: bodyText(id), truncated: false, ...overrides }, publication: pubMeta(ALPHA, 'Alpha'), host: ALPHA }
}

function ref(id: number, overrides: Partial<PostRef> = {}): PostRef {
  return {
    postId: id,
    host: ALPHA,
    slug: `post-${id}`,
    title: `Post ${id}`,
    pubName: 'Alpha',
    postDate: '2026-10-01T12:00:00.000Z',
    isPaywalled: false,
    wordcount: 540,
    addedAt: 1,
    ...overrides,
  }
}

function pub(host: string, name: string): Publication {
  return { id: null, name, host, addedAt: 1, inLatest: true }
}

/** Stub converter: the synthetic "HTML" is already reader text. */
function buildArticle(post: PostDetail, publication: PubMeta | null, _settings: Settings): Article {
  const text = post.bodyHtml ?? ''
  return {
    postId: post.id,
    title: post.title,
    pubName: publication?.name ?? '',
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    paywalled: post.isPaywalled,
    isPodcast: false,
    version: '1',
  }
}

const pagesOf = (id: number, lines: 5 | 6 | 7 = 7) => paginate(bodyText(id), bodyBox(lines))

// ---------------------------------------------------------------------------
// Harness

interface Setup {
  publications?: Publication[]
  saved?: PostRef[]
  lastOpen?: PostRef | null
  positions?: Position[]
  settings?: Partial<Settings>
  relay?: boolean
  getFeed?: (host: string, signal?: AbortSignal) => Promise<FeedResult>
}

interface Harness {
  controller: Controller
  store: Store
  frames: GlassesPage[]
  api: ReturnType<typeof fakeApi>
  data: Map<string, string>
  scheduler: ReturnType<typeof fakeScheduler>
  gates: Deferred<void>[]
  hold(value: boolean): void
  /** The next render rejects with `error` (the frame is still recorded in `frames`). */
  fail(error: unknown): void
  exits(): number
  resets(): number
  invalidations(): number
  last(): GlassesPage
}

async function setup(options: Setup = {}): Promise<Harness> {
  const scheduler = fakeScheduler()
  const memory = memoryKV()
  const store = createStore({ now: () => NOW, schedule: scheduler.schedule })
  await store.load(memory.kv)
  store.state.publications = options.publications ?? []
  store.state.saved = options.saved ?? []
  store.state.lastOpen = options.lastOpen ?? null
  store.state.positions = options.positions ?? []
  store.state.settings = { ...store.state.settings, ...options.settings }
  const frames: GlassesPage[] = []
  const gates: Deferred<void>[] = []
  const api = fakeApi()
  let holding = false
  let exits = 0
  let resets = 0
  let invalidations = 0
  const failures: unknown[] = []
  const controller = createController({
    render(page) {
      frames.push(page)
      if (failures.length) return Promise.reject(failures.shift())
      if (!holding) return Promise.resolve()
      const gate = deferred<void>()
      gates.push(gate)
      return gate.promise
    },
    async exit() { exits += 1 },
    api: api.api,
    getFeed: options.getFeed,
    store,
    buildArticle,
    now: () => NOW,
    relayConfigured: () => options.relay !== false,
    resetGestures() { resets += 1 },
    invalidate() { invalidations += 1 },
  })
  return {
    controller,
    store,
    frames,
    api,
    data: memory.data,
    scheduler,
    gates,
    hold(value) { holding = value },
    fail(error) { failures.push(error) },
    exits: () => exits,
    resets: () => resets,
    invalidations: () => invalidations,
    last: () => frames[frames.length - 1]!,
  }
}

/**
 * Home (no Continue entry): Latest, Publications, Saved -> open Saved item `index`.
 * `done` stays pending until the test answers the post request (wrapped so `await` does not flatten it).
 */
async function openSaved(t: Harness, index = 0): Promise<{ done: Promise<void> }> {
  await t.controller.start()
  await t.controller.onAction('next')
  await t.controller.onAction('next')
  await t.controller.onAction('select')
  assert.equal(t.last().title, 'Saved')
  for (let step = 0; step < index; step += 1) await t.controller.onAction('next')
  return { done: t.controller.onAction('select') }
}

/** Home -> Publications -> first publication; resolves its first archive page. */
async function openFirstPublication(t: Harness, posts: PostSummary[]): Promise<void> {
  await t.controller.start()
  await t.controller.onAction('next')
  await t.controller.onAction('select')
  const opening = t.controller.onAction('select')
  const call = t.api.archive[t.api.archive.length - 1]!
  call.reply.resolve(archiveReply(call.host, 'Alpha', posts, 0))
  await opening
}

// ---------------------------------------------------------------------------

test('Home -> Publications -> posts -> reader, back preserves selections, root back exits once', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha'), pub('beta.substack.com', 'Beta')] })
  await t.controller.start()
  assert.deepEqual(t.last(), {
    title: 'Reader for Substack',
    body: `> Latest\n\n${NB}Publications (2)\n\n${NB}Saved (0)`,
    footer: `Tap open${DOT}2${X}tap exit`,
  })
  await t.controller.onAction('next')
  assert.equal(t.last().body, `${NB}Latest\n\n> Publications (2)\n\n${NB}Saved (0)`)
  await t.controller.onAction('select')
  assert.deepEqual(t.last(), { title: 'Publications', body: `> Alpha\n\n${NB}Beta`, footer: `1/2${DOT}Tap open${DOT}2${X}tap back` })

  const opening = t.controller.onAction('select')
  assert.deepEqual(t.last(), { title: 'Alpha', body: LOADING, footer: `2${X}tap cancel` }, 'Loading is drawn before the reply')
  assert.equal(t.api.archive.length, 1)
  assert.deepEqual([t.api.archive[0]!.host, t.api.archive[0]!.offset, t.api.archive[0]!.limit], [ALPHA, 0, 12])
  assert.equal(t.controller.isBusy(), true)
  t.api.archive[0]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(11), summary(12), summary(13)], 0))
  await opening
  assert.equal(t.controller.isBusy(), false)
  assert.equal(t.last().title, 'Alpha')
  assert.equal(t.last().footer, `1/4${DOT}Tap read${DOT}2${X}tap back`, '3 posts and the Load older row')
  assert.equal(t.last().body.split('\n')[0], '> Post 11')

  await t.controller.onAction('next')
  const reading = t.controller.onAction('select')
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 12`, body: LOADING, footer: `2${X}tap cancel` })
  assert.deepEqual(t.api.posts[0]!.ref, { host: ALPHA, slug: 'post-12' })
  t.api.posts[0]!.reply.resolve(postReply(12))
  await reading
  const pages = pagesOf(12)
  assert.ok(pages.length >= 6, `fixture needs several pages (${pages.length})`)
  assert.equal(t.last().title, `Alpha${DOT}Post 12`)
  assert.equal(t.last().body, pages[0]!.text)
  assert.ok(t.last().footer.startsWith(`1/${pages.length}${DOT}`), t.last().footer)

  await t.controller.onAction('next')
  await t.controller.onAction('next')
  assert.equal(t.last().body, pages[2]!.text)
  assert.ok(t.last().footer.startsWith(`3/${pages.length}${DOT}`))
  await t.controller.onAction('previous')
  await t.controller.onAction('next')

  await t.controller.onAction('back')
  assert.equal(t.last().title, 'Alpha')
  assert.equal(t.last().body.split('\n')[2], '> Post 12', 'the list keeps the opened post selected')
  assert.equal(t.last().footer, `2/4${DOT}Tap read${DOT}2${X}tap back`)
  await t.controller.onAction('back')
  assert.equal(t.last().title, 'Publications')
  await t.controller.onAction('back')
  assert.equal(t.last().body, `${NB}Continue: Post 12\n\n${NB}Latest\n\n> Publications (2)\n\n${NB}Saved (0)`,
    'Home shows Continue for the unfinished post and the cursor stays on the entry it left from')
  assert.equal(t.exits(), 0)
  await t.controller.onAction('hold')
  assert.equal(t.exits(), 0, 'long-press is ignored on Home')
  await t.controller.onAction('back')
  assert.equal(t.exits(), 1)
  assert.equal(t.controller.depth(), 1)
  assert.equal(t.resets(), 6, 'gestures reset on every view change')
})

test('a reply that arrives after back is dropped and the request is aborted', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await t.controller.start()
  await t.controller.onAction('next')
  await t.controller.onAction('select')
  const opening = t.controller.onAction('select')
  const call = t.api.archive[0]!
  assert.equal(t.last().body, LOADING)
  await t.controller.onAction('back')
  assert.equal(call.signal?.aborted, true)
  assert.equal(t.last().title, 'Publications')
  const count = t.frames.length
  call.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(1)], 0))
  await opening
  await flushPromises()
  assert.equal(t.frames.length, count)
  assert.equal(t.controller.view().kind, 'publications')

  // Same for a post: back during Loading pops to the list and ignores the late reply.
  const reopening = t.controller.onAction('select')
  t.api.archive[1]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(1)], 0))
  await reopening
  const reading = t.controller.onAction('select')
  await t.controller.onAction('back')
  t.api.posts[0]!.reply.resolve(postReply(1))
  await reading
  await flushPromises()
  assert.equal(t.controller.view().kind, 'posts')
  assert.equal(t.store.state.lastOpen, null, 'a cancelled open records nothing')
})

test('the end card marks the post read; tap opens the next post; the last post checks for older posts, then says No more posts', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await openFirstPublication(t, [summary(21), summary(22)])
  const opening = t.controller.onAction('select')
  t.api.posts[0]!.reply.resolve(postReply(21))
  await opening
  const pages = pagesOf(21)
  for (let page = 1; page < pages.length; page += 1) await t.controller.onAction('next')
  assert.ok(t.last().footer.startsWith(`${pages.length}/${pages.length}${DOT}100%`))
  await t.controller.onAction('next')
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 21`, body: TEXT.endFree, footer: `End${DOT}${pages.length}/${pages.length}` })
  assert.deepEqual(t.store.state.read, [21])
  assert.equal(positionOf(t.store.state, 21)!.page, pages.length)
  const count = t.frames.length
  await t.controller.onAction('next')
  assert.equal(t.frames.length, count, 'swiping past the end card does nothing')
  await t.controller.onAction('previous')
  assert.equal(t.last().body, pages[pages.length - 1]!.text)
  await t.controller.onAction('next')

  const next = t.controller.onAction('select')
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 22`, body: LOADING, footer: `2${X}tap cancel` })
  t.api.posts[1]!.reply.resolve(postReply(22))
  await next
  const second = pagesOf(22)
  assert.equal(t.last().body, second[0]!.text)
  assert.equal(t.controller.depth(), 4, 'the next post replaces the reader')
  for (let page = 0; page < second.length; page += 1) await t.controller.onAction('select')
  assert.equal(t.last().body, TEXT.endFree)
  const ending = t.controller.onAction('select')
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 22`, body: LOADING, footer: `2${X}tap cancel` }, 'the list still has a Load older row')
  assert.deepEqual([t.api.archive[1]!.host, t.api.archive[1]!.offset, t.api.archive[1]!.limit], [ALPHA, 2, 12])
  t.api.archive[1]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [], 2))
  await ending
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 22`, body: 'No more posts.', footer: `2${X}tap back` })
  await t.controller.onAction('back')
  assert.equal(t.last().body.split('\n')[2], '> Post 22')
  assert.ok(t.last().body.split('\n')[1]!.endsWith('Read'), t.last().body)
  assert.equal(t.last().footer, `2/2${DOT}Tap read${DOT}2${X}tap back`, 'the empty page removed the Load older row')
})

test('Next post on the last loaded post loads the next archive page and opens its first new post', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await openFirstPublication(t, [summary(1), summary(2)])
  await t.controller.onAction('next')
  const reading = t.controller.onAction('select')
  t.api.posts[0]!.reply.resolve(postReply(2))
  await reading

  // Menu "Next post" from a page of the last loaded post.
  const loading = t.controller.onAction('menu:3')
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 2`, body: LOADING, footer: `2${X}tap cancel` })
  assert.deepEqual([t.api.archive[1]!.host, t.api.archive[1]!.offset, t.api.archive[1]!.limit], [ALPHA, 2, 12])
  assert.equal(t.controller.isBusy(), true)
  const count = t.frames.length
  await t.controller.onAction('next')
  assert.equal(t.frames.length, count, 'swipes wait for the load')
  // Substack may repeat a post across pages: the first new one opens.
  t.api.archive[1]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(2), summary(3), summary(4)], 2))
  await flushPromises()
  assert.equal(t.api.posts.length, 2)
  assert.deepEqual(t.api.posts[1]!.ref, { host: ALPHA, slug: 'post-3' })
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 3`, body: LOADING, footer: `2${X}tap cancel` })
  t.api.posts[1]!.reply.resolve(postReply(3))
  await loading
  assert.equal(t.last().body, pagesOf(3)[0]!.text)
  assert.equal(t.controller.depth(), 4, 'the next post replaces the reader')
  await t.controller.onAction('back')
  assert.equal(t.last().footer, `3/5${DOT}Tap read${DOT}2${X}tap back`, 'Post 3 is selected; posts 3 and 4 and a new Load older row were added')

  // Post 4 is already listed, so Next post from Post 3 opens it directly; from Post 4, back cancels the next page.
  let opening = t.controller.onAction('select')
  await opening
  assert.equal(t.api.posts.length, 2, 'Post 3 comes from the post cache')
  opening = t.controller.onAction('menu:3')
  assert.deepEqual(t.api.posts[2]!.ref, { host: ALPHA, slug: 'post-4' })
  t.api.posts[2]!.reply.resolve(postReply(4))
  await opening
  assert.equal(t.api.archive.length, 2)
  const cancelled = t.controller.onAction('menu:3')
  const call = t.api.archive[2]!
  assert.equal(call.offset, 5)
  await t.controller.onAction('back')
  assert.equal(call.signal?.aborted, true)
  assert.equal(t.controller.view().kind, 'posts')
  assert.equal(t.last().footer, `4/5${DOT}Tap read${DOT}2${X}tap back`, 'back returns to the list with Post 4 selected')
  const frames = t.frames.length
  call.reply.reject({ code: 'ABORTED', message: 'The request was cancelled.' })
  await cancelled
  assert.equal(t.frames.length, frames, 'the cancelled page is dropped')

  // A failed page shows the error for one frame on the end card; a tap there tries again.
  opening = t.controller.onAction('select')
  await opening
  const pages = pagesOf(4)
  for (let page = 0; page < pages.length; page += 1) await t.controller.onAction('next')
  assert.equal(t.last().body, TEXT.endFree)
  let ending = t.controller.onAction('select')
  t.api.archive[3]!.reply.reject({ code: 'NETWORK_ERROR', message: 'offline' })
  await ending
  assert.deepEqual(t.last(), {
    title: `Alpha${DOT}Post 4`,
    body: "Can't reach the reader service.\nCheck the phone's connection.",
    footer: `Tap retry${DOT}2${X}tap back`,
  })
  ending = t.controller.onAction('select')
  assert.equal(t.api.archive[4]!.offset, 5)
  t.api.archive[4]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [], 5))
  await ending
  assert.equal(t.last().body, 'No more posts.')
  await t.controller.onAction('back')
  assert.equal(t.last().footer, `4/4${DOT}Tap read${DOT}2${X}tap back`)
})

test('a paywalled post ends with the paid end card', async () => {
  const t = await setup({ saved: [ref(31, { isPaywalled: true })] })
  const { done: opening } = await openSaved(t)
  t.api.posts[0]!.reply.resolve(postReply(31, { audience: 'only_paid', isPaywalled: true, truncated: true }))
  await opening
  const pages = pagesOf(31)
  for (let page = 0; page < pages.length; page += 1) await t.controller.onAction('next')
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 31`, body: TEXT.endPaid, footer: `End${DOT}${pages.length}/${pages.length}` })
})

test('resume by character offset; by fraction after a converter change; offset survives a density change', async () => {
  const seven = pagesOf(41)
  const exact = await setup({
    saved: [ref(41)],
    positions: [{ postId: 41, offset: seven[3]!.start + 5, fraction: 0.01, page: 3, pages: seven.length, version: positionVersion('1', 7), updatedAt: 1 }],
  })
  let opening = (await openSaved(exact)).done
  exact.api.posts[0]!.reply.resolve(postReply(41))
  await opening
  assert.equal(exact.last().body, seven[3]!.text)
  assert.ok(exact.last().footer.startsWith(`4/${seven.length}${DOT}`))

  const byFraction = await setup({
    saved: [ref(41)],
    positions: [{ postId: 41, offset: 0, fraction: 0.5, page: 2, pages: 10, version: '0.1.7', updatedAt: 1 }],
  })
  opening = (await openSaved(byFraction)).done
  byFraction.api.posts[0]!.reply.resolve(postReply(41))
  await opening
  const half = Math.round(0.5 * seven.length)
  assert.equal(byFraction.last().body, seven[half]!.text)

  const five = pagesOf(41, 5)
  const denser = await setup({
    saved: [ref(41)],
    settings: { linesPerPage: 5 },
    positions: [{ postId: 41, offset: seven[3]!.start, fraction: 0.01, page: 3, pages: seven.length, version: positionVersion('1', 7), updatedAt: 1 }],
  })
  opening = (await openSaved(denser)).done
  denser.api.posts[0]!.reply.resolve(postReply(41))
  await opening
  const index = pageIndexForOffset(five, seven[3]!.start)
  assert.equal(denser.last().body, five[index]!.text)
  assert.ok(denser.last().footer.startsWith(`${index + 1}/${five.length}${DOT}`))

  const finished = await setup({
    saved: [ref(41)],
    positions: [{ postId: 41, offset: 9999, fraction: 1, page: seven.length, pages: seven.length, version: positionVersion('1', 7), updatedAt: 1 }],
  })
  opening = (await openSaved(finished)).done
  finished.api.posts[0]!.reply.resolve(postReply(41))
  await opening
  assert.equal(finished.last().body, seven[0]!.text, 'a finished post starts again')
})

test('a glasses-menu launch resumes lastOpen directly; other launches stay on Home', async () => {
  const pages = pagesOf(51)
  const positions = [{ postId: 51, offset: pages[2]!.start, fraction: 2 / pages.length, page: 2, pages: pages.length, version: positionVersion('1', 7), updatedAt: 1 }]
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')], lastOpen: ref(51), positions })
  const starting = t.controller.start('glassesMenu')
  assert.deepEqual(t.frames, [{ title: `Alpha${DOT}Post 51`, body: LOADING, footer: `2${X}tap cancel` }], 'no Home frame first')
  assert.deepEqual(t.api.posts[0]!.ref, { host: ALPHA, slug: 'post-51' })
  t.api.posts[0]!.reply.resolve(postReply(51))
  await starting
  assert.equal(t.last().body, pages[2]!.text)
  assert.equal(t.controller.depth(), 2)
  await t.controller.onAction('back')
  assert.deepEqual(t.last(), {
    title: 'Reader for Substack',
    body: `> Continue: Post 51\n\n${NB}Latest\n\n${NB}Publications (1)\n\n${NB}Saved (0)`,
    footer: `Tap open${DOT}2${X}tap exit`,
  })

  // The launch source may arrive after start().
  const late = await setup({ publications: [pub(ALPHA, 'Alpha')], lastOpen: ref(51), positions })
  await late.controller.start()
  assert.equal(late.last().title, 'Reader for Substack')
  late.controller.onLaunchSource('glassesMenu')
  assert.equal(late.last().body, LOADING)
  assert.equal(late.controller.depth(), 2)

  const appMenu = await setup({ publications: [pub(ALPHA, 'Alpha')], lastOpen: ref(51), positions })
  await appMenu.controller.start('appMenu')
  assert.equal(appMenu.controller.depth(), 1)
  assert.equal(appMenu.api.posts.length, 0)

  const done = await setup({
    publications: [pub(ALPHA, 'Alpha')],
    lastOpen: ref(51),
    positions: [{ ...positions[0]!, page: pages.length, fraction: 1 }],
  })
  await done.controller.start('glassesMenu')
  assert.equal(done.controller.depth(), 1, 'a finished post is not resumed')
  assert.equal(done.last().body.startsWith('> Latest'), true)
})

test('an error frame maps the code and a tap retries', async () => {
  const t = await setup({ saved: [ref(61)] })
  const { done: opening } = await openSaved(t)
  t.api.posts[0]!.reply.reject({ code: 'UPSTREAM_BLOCKED', message: 'Substack answered 403.' })
  await opening
  assert.deepEqual(t.last(), {
    title: `Alpha${DOT}Post 61`,
    body: 'Substack refused the reader service.\nTry again later.',
    footer: `Tap retry${DOT}2${X}tap back`,
  })
  assert.deepEqual(t.controller.lastError(), { code: 'UPSTREAM_BLOCKED', message: 'Substack answered 403.' })
  await t.controller.onAction('next')
  assert.equal(t.api.posts.length, 1, 'swipes do nothing on an error frame')

  const retrying = t.controller.onAction('select')
  assert.equal(t.last().body, LOADING)
  assert.equal(t.api.posts.length, 2)
  t.api.posts[1]!.reply.reject({ code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 120 })
  await retrying
  assert.equal(t.last().body, 'Busy. Try again in 120 s.')

  const again = t.controller.retry()
  t.api.posts[2]!.reply.resolve(postReply(61))
  await again
  assert.equal(t.last().body, pagesOf(61)[0]!.text)
  assert.equal(t.controller.lastError(), null)
})

test('empty converted text shows a non-retryable message', async () => {
  const t = await setup({ saved: [ref(65)] })
  const { done: opening } = await openSaved(t)
  t.api.posts[0]!.reply.resolve(postReply(65, { bodyHtml: '' }))
  await opening
  assert.deepEqual(t.last(), { title: `Alpha${DOT}Post 65`, body: 'No readable text in this post.', footer: `2${X}tap back` })
  await t.controller.onAction('select')
  assert.equal(t.api.posts.length, 1)
  await t.controller.onAction('back')
  assert.equal(t.last().title, 'Saved')
})

test('positions are recorded only after the glasses accept a page, debounced, and flushed on background', async () => {
  const t = await setup({ saved: [ref(71)] })
  const { done: opening } = await openSaved(t)
  t.api.posts[0]!.reply.resolve(postReply(71))
  await opening
  const pages = pagesOf(71)
  assert.equal(positionOf(t.store.state, 71)!.page, 0)
  assert.equal(t.store.state.lastOpen?.postId, 71)
  assert.equal(t.store.state.history[0]?.postId, 71)

  t.hold(true)
  const turning = t.controller.onAction('next')
  assert.equal(t.last().body, pages[1]!.text)
  await flushPromises()
  assert.equal(positionOf(t.store.state, 71)!.page, 0, 'not recorded before the glasses accept the page')
  t.gates[0]!.resolve()
  await turning
  t.hold(false)
  const position = positionOf(t.store.state, 71)!
  assert.deepEqual([position.page, position.pages, position.offset, position.version], [1, pages.length, pages[1]!.start, '1.1.7'])
  assert.equal(t.data.has(KEYS.progress), false, 'the write is debounced')

  t.controller.onLifecycle('background')
  await flushPromises()
  const progress = JSON.parse(t.data.get(KEYS.progress)!)
  assert.equal(progress.positions[0].postId, 71)
  assert.equal(progress.positions[0].page, 1)
  assert.equal(progress.lastOpen.postId, 71)
  assert.ok(!t.data.get(KEYS.progress)!.includes('Paragraph 1 of post 71'), 'article text is never stored')

  await t.controller.onAction('next')
  t.scheduler.advance(799)
  await flushPromises()
  assert.equal(JSON.parse(t.data.get(KEYS.progress)!).positions[0].page, 1)
  t.scheduler.advance(1)
  await flushPromises()
  assert.equal(JSON.parse(t.data.get(KEYS.progress)!).positions[0].page, 2)
})

test('after a refused frame the next action shows the model again instead of moving past it', async () => {
  const refused = () => new Error('G2 rejected the body update. Try the page again.')
  const t = await setup({ saved: [ref(101)] })
  const { done: opening } = await openSaved(t)
  t.api.posts[0]!.reply.resolve(postReply(101))
  await opening
  const pages = pagesOf(101)
  assert.ok(pages.length >= 6, `fixture needs several pages (${pages.length})`)
  await t.controller.onAction('next')
  assert.equal(positionOf(t.store.state, 101)!.page, 1)

  t.fail(refused())
  await t.controller.onAction('next')
  assert.equal(t.last().body, pages[2]!.text, 'page 3 was sent')
  assert.equal(positionOf(t.store.state, 101)!.page, 1, 'a refused page is not recorded')
  const count = t.frames.length
  await t.controller.onAction('next')
  assert.equal(t.frames.length, count + 1)
  assert.equal(t.last().body, pages[2]!.text, 'the swipe resends page 3 instead of skipping to page 4')
  assert.equal(t.invalidations(), 1, 'as a full redraw')
  assert.equal(positionOf(t.store.state, 101)!.page, 2)
  await t.controller.onAction('next')
  assert.equal(t.last().body, pages[3]!.text, 'a delivered frame ends the redraw state')
  assert.equal(t.invalidations(), 1)

  // A frame replaced by a newer one before it was written is not a failure.
  const superseded = new Error('A newer frame replaced this one.')
  superseded.name = 'SupersededRenderError'
  t.fail(superseded)
  await t.controller.onAction('next')
  await t.controller.onAction('next')
  assert.equal(t.last().body, pages[5]!.text)
  assert.equal(t.invalidations(), 1)

  // Lists: the tap after a refused cursor move redraws, so it never opens a row the wearer did not see.
  const list = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await openFirstPublication(list, [summary(1), summary(2)])
  list.fail(refused())
  await list.controller.onAction('next')
  list.fail(refused())
  await list.controller.onAction('menu:2')
  assert.deepEqual(list.store.state.saved, [], 'a menu item redraws instead (refused again)')
  list.fail(refused())
  await list.controller.onAction('back')
  assert.equal(list.controller.view().kind, 'posts', 'so does double-tap below the root (refused again)')
  await list.controller.onAction('select')
  assert.equal(list.api.posts.length, 0, 'the tap only redrew the list')
  assert.equal(list.last().body.split('\n')[2], '> Post 2')
  assert.equal(list.invalidations(), 3)
  const reading = list.controller.onAction('select')
  assert.deepEqual(list.api.posts[0]!.ref, { host: ALPHA, slug: 'post-2' })
  list.api.posts[0]!.reply.resolve(postReply(2))
  await reading
  assert.equal(list.last().body, pagesOf(2)[0]!.text)

  // The root double-tap always reaches the exit dialog, even while frames keep failing.
  const home = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await home.controller.start()
  home.fail(refused())
  await home.controller.onAction('next')
  await home.controller.onAction('back')
  assert.equal(home.exits(), 1)
})

test('Latest loads two publications at a time, merges newest first, dedupes and reports failures', async () => {
  const hosts = ['a.substack.com', 'b.substack.com', 'c.substack.com']
  const t = await setup({ publications: [pub(hosts[0]!, 'A'), pub(hosts[1]!, 'B'), pub(hosts[2]!, 'C')] })
  await t.controller.start()
  const opening = t.controller.onAction('select')
  assert.deepEqual(t.last(), { title: 'Latest', body: LOADING, footer: `2${X}tap cancel` })
  assert.deepEqual(t.api.archive.map(call => call.host), hosts.slice(0, 2))
  t.api.archive[0]!.reply.resolve(archiveReply(hosts[0]!, 'A', [
    summary(1, { postDate: '2026-10-05T10:00:00.000Z' }),
    summary(2, { postDate: '2026-10-01T10:00:00.000Z' }),
  ], 0))
  await flushPromises()
  assert.deepEqual(t.api.archive.map(call => call.host), hosts)
  t.api.archive[1]!.reply.reject({ code: 'UPSTREAM_UNAVAILABLE', message: 'down' })
  t.api.archive[2]!.reply.resolve(archiveReply(hosts[2]!, 'C', [
    summary(3, { postDate: '2026-10-06T08:00:00.000Z' }),
    summary(1, { postDate: '2026-10-05T10:00:00.000Z' }),
  ], 0))
  await opening
  const lines = t.last().body.split('\n')
  assert.deepEqual([lines[0], lines[2], lines[4]], ['> Post 3', `${NB}Post 1`, `${NB}Post 2`])
  assert.ok(lines[1]!.startsWith(`${NB}C${DOT}4h`), lines[1])
  assert.ok(lines[3]!.startsWith(`${NB}A${DOT}1d`), lines[3])
  assert.equal(t.last().footer, `1/3${DOT}Tap read${DOT}2${X}tap back${DOT}1 failed`)

  // Cached for 5 minutes: re-opening makes no request; Refresh does.
  await t.controller.onAction('back')
  await t.controller.onAction('select')
  assert.equal(t.api.archive.length, 3)
  assert.equal(t.last().body.split('\n')[0], '> Post 3')
  const refreshing = t.controller.onAction('menu:5')
  assert.equal(t.last().body, LOADING)
  assert.equal(t.api.archive.length, 5)
  for (const call of t.api.archive.slice(3)) call.reply.reject({ code: 'NETWORK_ERROR', message: 'offline' })
  await flushPromises()
  t.api.archive[5]!.reply.reject({ code: 'NETWORK_ERROR', message: 'offline' })
  await refreshing
  assert.deepEqual(t.last(), {
    title: 'Latest',
    body: "Can't reach the reader service.\nCheck the phone's connection.",
    footer: `Tap retry${DOT}2${X}tap back`,
  })
})

test('a cancelled Latest load caches nothing', async () => {
  const hosts = ['a.substack.com', 'b.substack.com', 'c.substack.com']
  const t = await setup({ publications: [pub(hosts[0]!, 'A'), pub(hosts[1]!, 'B'), pub(hosts[2]!, 'C')] })
  await t.controller.start()
  const opening = t.controller.onAction('select')
  t.api.archive[0]!.reply.resolve(archiveReply(hosts[0]!, 'A', [summary(1)], 0))
  await flushPromises()
  assert.equal(t.api.archive.length, 3)
  await t.controller.onAction('back')
  assert.equal(t.controller.view().kind, 'home')
  for (const call of t.api.archive.slice(1)) {
    assert.equal(call.signal?.aborted, true)
    call.reply.reject({ code: 'ABORTED', message: 'The request was cancelled.' })
  }
  await opening

  const reopening = t.controller.onAction('select')
  assert.equal(t.last().body, LOADING)
  assert.equal(t.api.archive.length, 5, 'the partial result of the cancelled load was not cached')
  t.api.archive[3]!.reply.resolve(archiveReply(hosts[0]!, 'A', [summary(1)], 0))
  t.api.archive[4]!.reply.resolve(archiveReply(hosts[1]!, 'B', [summary(2)], 0))
  await flushPromises()
  t.api.archive[5]!.reply.resolve(archiveReply(hosts[2]!, 'C', [summary(3)], 0))
  await reopening
  assert.equal(t.last().footer, `1/3${DOT}Tap read${DOT}2${X}tap back`, 'all three publications, none failed')
})

test('Load older appends the next archive page; only an empty page ends the list', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await openFirstPublication(t, [summary(1), summary(2)])
  await t.controller.onAction('next')
  await t.controller.onAction('next')
  await t.controller.onAction('next')
  assert.equal(t.last().footer, `3/3${DOT}Tap load${DOT}2${X}tap back`)
  let loading = t.controller.onAction('select')
  assert.equal(t.last().body, LOADING)
  assert.deepEqual([t.api.archive[1]!.offset, t.api.archive[1]!.limit], [2, 12])
  t.api.archive[1]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(3)], 2))
  await loading
  assert.equal(t.last().footer, `3/4${DOT}Tap read${DOT}2${X}tap back`, 'the first new post is selected')
  assert.equal(t.last().body.split('\n')[4], '> Post 3')

  await t.controller.onAction('next')
  loading = t.controller.onAction('select')
  t.api.archive[2]!.reply.reject({ code: 'UPSTREAM_INVALID', message: 'bad' })
  await loading
  assert.equal(t.last().body, 'Substack had a problem.\nTry again.')
  await t.controller.onAction('back')
  assert.equal(t.controller.view().kind, 'posts', 'a failed Load older returns to the list')
  assert.equal(t.last().footer, `4/4${DOT}Tap load${DOT}2${X}tap back`)

  loading = t.controller.onAction('select')
  assert.equal(t.api.archive[3]!.offset, 3)
  t.api.archive[3]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [], 3))
  await loading
  assert.equal(t.last().footer, `3/3${DOT}Tap read${DOT}2${X}tap back`, 'no Load older row after an empty page')
})

test('a cancelled or failed Refresh returns to the loaded list; retry keeps the selected post', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await openFirstPublication(t, [summary(1), summary(2)])
  await t.controller.onAction('next')
  const listed = t.last()
  assert.equal(listed.footer, `2/3${DOT}Tap read${DOT}2${X}tap back`)

  let refreshing = t.controller.onAction('menu:5')
  assert.equal(t.last().body, LOADING)
  const cancelled = t.api.archive[1]!
  assert.equal(cancelled.offset, 0)
  await t.controller.onAction('back')
  assert.equal(cancelled.signal?.aborted, true)
  assert.deepEqual(t.last(), listed, 'cancel returns to the loaded list and its cursor')
  const count = t.frames.length
  cancelled.reply.reject({ code: 'ABORTED', message: 'The request was cancelled.' })
  await refreshing
  assert.equal(t.frames.length, count)

  refreshing = t.controller.onAction('menu:5')
  t.api.archive[2]!.reply.reject({ code: 'NETWORK_ERROR', message: 'offline' })
  await refreshing
  assert.equal(t.last().footer, `Tap retry${DOT}2${X}tap back`)
  await t.controller.onAction('hold')
  assert.deepEqual(t.last(), listed, 'back from the error returns to the loaded list')

  refreshing = t.controller.onAction('menu:5')
  t.api.archive[3]!.reply.reject({ code: 'NETWORK_ERROR', message: 'offline' })
  await refreshing
  // A new post on top: the retried Refresh still selects Post 2 by key, not row 2 by index.
  const retrying = t.controller.onAction('select')
  assert.equal(t.api.archive[4]!.offset, 0)
  t.api.archive[4]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(3), summary(1), summary(2)], 0))
  await retrying
  assert.equal(t.last().footer, `3/4${DOT}Tap read${DOT}2${X}tap back`)
  assert.equal(t.last().body.split('\n')[4], '> Post 2')

  // The phone's Retry re-runs a failed Refresh the same way.
  refreshing = t.controller.onAction('menu:5')
  t.api.archive[5]!.reply.reject({ code: 'NETWORK_ERROR', message: 'offline' })
  await refreshing
  const again = t.controller.retry()
  t.api.archive[6]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(4), summary(3), summary(1), summary(2)], 0))
  await again
  assert.equal(t.last().footer, `4/5${DOT}Tap read${DOT}2${X}tap back`)
})

test('a blocked archive falls back to the feed and opens posts from the feed HTML', async () => {
  const feedCalls: string[] = []
  const getFeed = async (host: string): Promise<FeedResult> => {
    feedCalls.push(host)
    return {
      posts: [summary(-5, { slug: 'feed-one', title: 'Feed one', wordcount: null })],
      bodies: new Map([['feed-one', bodyText(5)]]),
    }
  }
  const t = await setup({ publications: [pub(ALPHA, 'Alpha'), pub('beta.substack.com', 'Beta')], getFeed })
  await t.controller.start()
  await t.controller.onAction('next')
  await t.controller.onAction('select')
  const opening = t.controller.onAction('select')
  t.api.archive[0]!.reply.reject({ code: 'UPSTREAM_BLOCKED', message: 'blocked' })
  await opening
  assert.deepEqual(feedCalls, [ALPHA])
  assert.equal(t.last().body.split('\n')[0], '> Feed one')
  assert.equal(t.last().footer, `1/1${DOT}Tap read${DOT}2${X}tap back`)
  await t.controller.onAction('select')
  assert.equal(t.api.posts.length, 0, 'the cached feed body is used')
  assert.equal(t.last().body, pagesOf(5)[0]!.text)

  // Codes that are not upstream blocks never use the feed.
  await t.controller.onAction('back')
  await t.controller.onAction('back')
  await t.controller.onAction('next')
  const other = t.controller.onAction('select')
  t.api.archive[1]!.reply.reject({ code: 'HOST_NOT_SUBSTACK', message: 'no' })
  await other
  assert.deepEqual(feedCalls, [ALPHA])
  assert.deepEqual(t.last(), { title: 'Beta', body: 'That site is not a Substack publication.', footer: `Tap retry${DOT}2${X}tap back` })
})

test('Save for later says Storage is full when the prefs document has no room, below the count limit', async () => {
  // Long references fill the 48k prefs document well before 100 saved posts.
  const long = (id: number) => ref(id, { slug: `p${id}-${'s'.repeat(190)}`, title: 'T'.repeat(200), pubName: 'P'.repeat(120) })
  const saved = Array.from({ length: 75 }, (_, index) => long(1000 + index))
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')], saved })
  await openFirstPublication(t, [summary(1)])
  await t.controller.onAction('menu:2')
  assert.equal(t.last().footer, 'Storage is full')
  assert.equal(t.store.state.saved.length, 75, 'the post was not added')
})

test('contextual menu: Save for later, Restart, Home, Not available here', async () => {
  const t = await setup({ publications: [pub(ALPHA, 'Alpha')] })
  await openFirstPublication(t, [summary(81)])
  const opening = t.controller.onAction('select')
  t.api.posts[0]!.reply.resolve(postReply(81))
  await opening
  const pages = pagesOf(81)
  await t.controller.onAction('next')
  await t.controller.onAction('next')
  await t.controller.onAction('menu:2')
  assert.equal(t.last().footer, 'Saved for later')
  assert.equal(t.last().body, pages[2]!.text)
  assert.deepEqual(t.store.state.saved.map(item => item.postId), [81])
  await t.controller.onAction('menu:2')
  assert.equal(t.last().footer, 'Already saved')
  await t.controller.onAction('next')
  assert.ok(t.last().footer.startsWith(`4/${pages.length}${DOT}`), 'the hint lasts one render')
  await t.controller.onAction('menu:4')
  assert.equal(t.last().body, pages[0]!.text)
  assert.ok(t.last().footer.startsWith(`1/${pages.length}${DOT}`))
  await t.controller.onAction('menu:1')
  assert.equal(t.controller.depth(), 1)
  assert.equal(t.last().body, `${NB}Continue: Post 81\n\n${NB}Latest\n\n> Publications (1)\n\n${NB}Saved (1)`,
    'the cursor stays on the Home entry it left from')
  const count = t.frames.length
  await t.controller.onAction('menu:1')
  assert.equal(t.frames.length, count, 'Home on Home is a no-op')
  await t.controller.onAction('menu:3')
  assert.equal(t.last().footer, TEXT.notAvailable)
  await t.controller.onAction('menu:9')
  assert.equal(t.last().footer, TEXT.notAvailable)
})

test('phone edits never interrupt the reader; a density change keeps the text offset', async () => {
  const t = await setup({ saved: [ref(91)] })
  const { done: opening } = await openSaved(t)
  t.api.posts[0]!.reply.resolve(postReply(91))
  await opening
  const seven = pagesOf(91)
  for (let page = 0; page < 3; page += 1) await t.controller.onAction('next')
  assert.equal(t.last().body, seven[3]!.text)

  t.store.state.publications.push(pub('beta.substack.com', 'Beta'))
  t.store.state.saved = []
  t.controller.configurationChanged()
  await flushPromises()
  assert.equal(t.controller.view().kind, 'reader')
  assert.equal(t.last().body, seven[3]!.text)

  t.store.state.settings.linesPerPage = 5
  t.controller.configurationChanged()
  await flushPromises()
  const five = pagesOf(91, 5)
  const index = pageIndexForOffset(five, seven[3]!.start)
  assert.equal(t.last().body, five[index]!.text)
  assert.ok(t.last().footer.startsWith(`${index + 1}/${five.length}${DOT}`))
  assert.equal(positionOf(t.store.state, 91)!.offset, five[index]!.start)

  await t.controller.onAction('back')
  assert.deepEqual(t.last(), { title: 'Saved', body: 'Nothing saved yet.\nSave posts on your phone.', footer: `2${X}tap back` }, 'Saved re-reads the phone edit')
})

test('the Publications cursor follows the selected publication through phone edits', async () => {
  const BETA = 'beta.substack.com'
  const GAMMA = 'gamma.substack.com'
  const t = await setup({ publications: [pub(ALPHA, 'Alpha'), pub(BETA, 'Beta'), pub(GAMMA, 'Gamma')] })
  await t.controller.start()
  await t.controller.onAction('next')
  await t.controller.onAction('select')
  await t.controller.onAction('next')
  await t.controller.onAction('next')
  assert.deepEqual(t.last(), { title: 'Publications', body: `${NB}Alpha\n\n${NB}Beta\n\n> Gamma`, footer: `3/3${DOT}Tap open${DOT}2${X}tap back` })

  const edit = (publications: Publication[]) => {
    t.store.state.publications = publications
    t.controller.configurationChanged()
  }
  const [alpha, beta, gamma] = t.store.state.publications as [Publication, Publication, Publication]
  edit([beta, gamma])
  await flushPromises()
  assert.deepEqual(t.last(), { title: 'Publications', body: `${NB}Beta\n\n> Gamma`, footer: `2/2${DOT}Tap open${DOT}2${X}tap back` }, 'removed above the cursor')
  edit([gamma, beta])
  await flushPromises()
  assert.equal(t.last().body, `> Gamma\n\n${NB}Beta`, 'moved')
  edit([alpha, gamma, beta])
  await flushPromises()
  assert.equal(t.last().body, `${NB}Alpha\n\n> Gamma\n\n${NB}Beta`, 'added above the cursor')
  edit([alpha, beta])
  await flushPromises()
  assert.equal(t.last().body, `${NB}Alpha\n\n> Beta`, 'the selected one was removed: the row at its index')

  // Also while Publications is below an open list.
  const opening = t.controller.onAction('select')
  assert.equal(t.api.archive[0]!.host, BETA)
  t.api.archive[0]!.reply.resolve(archiveReply(BETA, 'Beta', [summary(1)], 0))
  await opening
  edit([gamma, alpha, beta])
  await flushPromises()
  assert.equal(t.controller.view().kind, 'posts')
  await t.controller.onAction('back')
  assert.deepEqual(t.last(), { title: 'Publications', body: `${NB}Gamma\n\n${NB}Alpha\n\n> Beta`, footer: `3/3${DOT}Tap open${DOT}2${X}tap back` })
})

test('a publication stored under its host takes the name its archive reports', async () => {
  const ON = 'on.substack.com'
  const t = await setup({ publications: [pub(ON, ON), pub(ALPHA, 'My Alpha')] })
  await t.controller.start()
  await t.controller.onAction('next')
  await t.controller.onAction('select')
  assert.equal(t.last().body, `> ${ON}\n\n${NB}My Alpha`)
  let opening = t.controller.onAction('select')
  t.api.archive[0]!.reply.resolve(archiveReply(ON, 'On Substack', [summary(1)], 0))
  await opening
  assert.deepEqual(t.store.state.publications.map(item => [item.host, item.name]), [[ON, 'On Substack'], [ALPHA, 'My Alpha']])
  await t.store.flush()
  assert.ok(t.data.get(KEYS.prefs)!.includes('"On Substack"'), 'saved to prefs')
  await t.controller.onAction('back')
  assert.equal(t.last().body, `> On Substack\n\n${NB}My Alpha`)

  // A real name is never replaced.
  await t.controller.onAction('next')
  opening = t.controller.onAction('select')
  t.api.archive[1]!.reply.resolve(archiveReply(ALPHA, 'Alpha', [summary(2)], 0))
  await opening
  assert.deepEqual(t.store.state.publications.map(item => item.name), ['On Substack', 'My Alpha'])
})

test('first run and missing relay frames only allow exit', async () => {
  const t = await setup()
  await t.controller.start()
  assert.deepEqual(t.last(), { title: 'Reader for Substack', body: TEXT.firstRun, footer: `2${X}tap exit` })
  assert.deepEqual(t.controller.current(), t.last())
  await t.controller.onAction('select')
  await t.controller.onAction('next')
  await t.controller.onAction('hold')
  assert.equal(t.frames.length, 1)
  assert.equal(t.exits(), 0)
  await t.controller.onAction('back')
  assert.equal(t.exits(), 1)

  const offline = await setup({ publications: [pub(ALPHA, 'Alpha')], relay: false, lastOpen: ref(1) })
  assert.deepEqual(offline.controller.current(), { title: 'Reader for Substack', body: TEXT.notConfigured, footer: `2${X}tap exit` }, 'usable as the initial page')
  await offline.controller.start('glassesMenu')
  assert.deepEqual(offline.last(), { title: 'Reader for Substack', body: TEXT.notConfigured, footer: `2${X}tap exit` })
  await offline.controller.onAction('select')
  assert.equal(offline.api.archive.length + offline.api.posts.length, 0)
})

test('foreground after a long background forces a full redraw', async () => {
  let invalidated = 0
  const store = createStore({ now: () => NOW, schedule: fakeScheduler().schedule })
  await store.load(memoryKV().kv)
  store.state.publications = [pub(ALPHA, 'Alpha')]
  let clock = NOW
  const frames: GlassesPage[] = []
  const controller = createController({
    render(page) { frames.push(page); return Promise.resolve() },
    exit: () => Promise.resolve(),
    api: fakeApi().api,
    store,
    buildArticle,
    now: () => clock,
    invalidate() { invalidated += 1 },
  })
  await controller.start()
  controller.onLifecycle('background')
  clock += 10_000
  controller.onLifecycle('foreground')
  assert.deepEqual([invalidated, frames.length], [0, 1], 'a short trip (e.g. the OS menu) changes nothing')
  controller.onLifecycle('background')
  clock += 31_000
  controller.onLifecycle('foreground')
  assert.deepEqual([invalidated, frames.length], [1, 2])
  await controller.redraw()
  assert.deepEqual([invalidated, frames.length], [2, 3])
  assert.deepEqual(frames[2], frames[0])
})

test('helpers: toViewError, sameText and resumePage', () => {
  assert.deepEqual(toViewError({ code: 'RATE_LIMITED', message: 'slow', retryAfterSeconds: 30 }), { code: 'RATE_LIMITED', message: 'slow', retryAfterSeconds: 30 })
  assert.deepEqual(toViewError(new Error('boom')), { code: 'UNKNOWN', message: 'boom' })
  assert.deepEqual(toViewError('x'), { code: 'UNKNOWN', message: 'Something went wrong.' })
  assert.equal(positionVersion('1', 6), '1.1.6')
  assert.equal(sameText('1.1.7', '1.1.5'), true)
  assert.equal(sameText('1.1.7', '2.1.7'), false)
  assert.equal(sameText('', '1.1.7'), false)
  const pages = [{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 10, end: 11 }, { text: 'c', start: 20, end: 21 }]
  const base: Position = { postId: 1, offset: 15, fraction: 0, page: 1, pages: 3, version: '1.1.5', updatedAt: 0 }
  assert.equal(resumePage(null, pages, '1.1.7'), 0)
  assert.equal(resumePage(base, pages, '1.1.7'), 1)
  assert.equal(resumePage({ ...base, offset: 0, fraction: 0.9, page: 2, version: '0.1.7' }, pages, '1.1.7'), 2)
  assert.equal(resumePage({ ...base, page: 3, fraction: 1 }, pages, '1.1.7'), 0)
})
