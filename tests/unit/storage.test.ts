import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, defaultSettings, emptyState, type Position, type PostRef, type Publication } from '../../src/app/types'
import {
  KEYS, MAX_KEY_CHARS, SAVE_DEBOUNCE_MS, addPublication, addSaved, browserKV, bridgeKV, clearReading, createStore,
  markRead, mirroredKV, normalizePrefs, normalizeProgress, recordHistory, recordPosition, refKey, rehostPost,
  rehostPublication, reorderItem, serializeProgress, type KV,
} from '../../src/storage'
import { flushPromises, installLocalStorage } from './helpers'

interface MemoryKV {
  kv: KV
  data: Map<string, string>
  writes: Array<[string, string]>
  failWrites(value: boolean): void
}

function memoryKV(name = 'memory', seed: Record<string, string> = {}): MemoryKV {
  const data = new Map(Object.entries(seed))
  const writes: Array<[string, string]> = []
  let failing = false
  return {
    data,
    writes,
    failWrites(value) { failing = value },
    kv: {
      name,
      async get(key) { return data.get(key) ?? '' },
      async set(key, value) {
        writes.push([key, value])
        if (failing) return false
        data.set(key, value)
        return true
      },
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
    size: () => tasks.length,
  }
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
    addedAt: 1000 + id,
    ...overrides,
  }
}

function position(id: number, updatedAt: number, overrides: Partial<Position> = {}): Position {
  return { postId: id, offset: 100, fraction: 0.25, page: 2, pages: 8, version: '1.1.7', updatedAt, ...overrides }
}

function publication(host: string, name = host): Publication {
  return { id: null, name, host, addedAt: 1, inLatest: true }
}

test('corrupt, foreign or missing documents load as defaults', async () => {
  for (const raw of ['{not json', '[]', '"text"', 'null', '42', '']) {
    const { kv } = memoryKV('memory', { [KEYS.prefs]: raw, [KEYS.progress]: raw })
    const store = createStore()
    await store.load(kv)
    assert.deepEqual(store.state, emptyState(), `input ${JSON.stringify(raw)}`)
  }
  const oversized = memoryKV('memory', { [KEYS.prefs]: `{"savedAt":1,"x":"${'y'.repeat(4 * MAX_KEY_CHARS)}"}` })
  const store = createStore()
  await store.load(oversized.kv)
  assert.deepEqual(store.state, emptyState())
})

test('normalizers validate hosts, dedupe, cap, clamp settings and drop unknown fields', () => {
  const prefs = normalizePrefs({
    savedAt: 5,
    publications: [
      { host: 'Alpha.Substack.com.', name: '  Alpha  ', id: 7, addedAt: 3, inLatest: false },
      { host: 'alpha.substack.com', name: 'Duplicate' },
      { host: 'localhost' },
      { host: 'http://x.com/' },
      { name: 'No host' },
      null,
      'text',
    ],
    saved: [
      { ...ref(1), bodyHtml: '<p>secret</p>', text: 'secret body' },
      ref(1),
      { ...ref(-5), slug: '' },
      ref(2, { title: 'x'.repeat(500) }),
    ],
    settings: {
      linesPerPage: 4,
      tapInReader: 'none',
      invertSwipe: 'yes',
      footnotes: 'inline',
      homeItems: ['history', 'bogus', 'history', 'saved'],
      latestMaxPublications: 21,
    },
  })
  assert.equal(prefs.schemaVersion, 1)
  assert.equal(prefs.savedAt, 5)
  assert.deepEqual(prefs.publications, [{ id: 7, name: 'Alpha', host: 'alpha.substack.com', addedAt: 3, inLatest: false }])
  assert.equal(prefs.saved.length, 2)
  assert.deepEqual(Object.keys(prefs.saved[0]!).sort(), ['addedAt', 'host', 'isPaywalled', 'postDate', 'postId', 'pubName', 'slug', 'title', 'wordcount'])
  assert.equal(prefs.saved[1]!.title.length, 200)
  assert.deepEqual(prefs.settings, { ...defaultSettings(), tapInReader: 'none', footnotes: 'inline', homeItems: ['history', 'saved'] })

  const many = normalizePrefs({ publications: Array.from({ length: 150 }, (_, index) => ({ host: `p${index}.substack.com` })) })
  assert.equal(many.publications.length, LIMITS.publications)
  assert.equal(many.publications[99]!.host, 'p99.substack.com')
  assert.equal(many.publications[0]!.name, 'p0.substack.com')
  assert.equal(many.publications[0]!.inLatest, true)

  const progress = normalizeProgress({
    positions: [position(1, 10), position(2, 30), position(1, 20), { ...position(3, 5), page: 9 }, { ...position(4, 1), fraction: 7 }],
    history: [ref(1), ref(1), ref(2)],
    read: [3, 3, 0, 1.5, -2, 'x', 4],
    lastOpen: { postId: 'x' },
  })
  assert.deepEqual(progress.positions.map(item => [item.postId, item.updatedAt]), [[2, 30], [1, 20], [4, 1]])
  assert.equal(progress.positions[2]!.fraction, 1)
  assert.deepEqual(progress.history.map(item => item.postId), [1, 2])
  assert.deepEqual(progress.read, [3, -2, 4])
  assert.equal(progress.lastOpen, null)
})

test('reorderItem moves to a final index and never drops, clamps or wraps', () => {
  const items = ['a', 'b', 'c', 'd']
  assert.equal(reorderItem(items, 0, 3), true)
  assert.deepEqual(items, ['b', 'c', 'd', 'a'])
  assert.equal(reorderItem(items, 3, 1), true)
  assert.deepEqual(items, ['b', 'a', 'c', 'd'])
  for (const [from, to] of [[0, 4], [-1, 0], [1, 1], [0.5, 1], [4, 0]] as const) {
    assert.equal(reorderItem(items, from, to), false, `${from} -> ${to}`)
  }
  assert.deepEqual(items, ['b', 'a', 'c', 'd'])
})

test('mirroredKV reads the newest savedAt (primary on ties) and writes both backends', async () => {
  const bridge = memoryKV('bridge', {
    [KEYS.prefs]: JSON.stringify({ savedAt: 200, publications: [{ host: 'new.substack.com' }] }),
    [KEYS.progress]: JSON.stringify({ savedAt: 100 }),
  })
  const local = memoryKV('localStorage', {
    [KEYS.prefs]: JSON.stringify({ savedAt: 150 }),
    [KEYS.progress]: JSON.stringify({ savedAt: 300, read: [9] }),
  })
  const kv = mirroredKV(bridge.kv, local.kv)
  assert.equal(kv.name, 'bridge+localStorage')
  assert.equal(JSON.parse(await kv.get(KEYS.prefs)).savedAt, 200)
  assert.equal(JSON.parse(await kv.get(KEYS.progress)).savedAt, 300)

  bridge.data.set('corrupt', '{broken')
  local.data.set('corrupt', JSON.stringify({ savedAt: 1 }))
  assert.equal(await kv.get('corrupt'), JSON.stringify({ savedAt: 1 }), 'A corrupt copy never wins.')
  bridge.data.set('tie', JSON.stringify({ savedAt: 5, from: 'bridge' }))
  local.data.set('tie', JSON.stringify({ savedAt: 5, from: 'local' }))
  assert.equal(JSON.parse(await kv.get('tie')).from, 'bridge')
  local.data.set('only-local', JSON.stringify({ savedAt: 0 }))
  assert.equal(await kv.get('only-local'), JSON.stringify({ savedAt: 0 }))
  assert.equal(await kv.get('absent'), '')

  assert.equal(await kv.set('w', 'value'), true)
  assert.equal(bridge.data.get('w'), 'value')
  assert.equal(local.data.get('w'), 'value')
  bridge.failWrites(true)
  assert.equal(await kv.set('w2', 'v'), false, 'The bridge is the source of truth.')
  assert.equal(local.data.get('w2'), 'v')
  assert.equal(await mirroredKV(null, local.kv).set('w3', 'v'), true)
})

test('bridgeKV treats an empty string as absent, refuses oversized values and contains bridge errors', async () => {
  const calls: string[] = []
  const values = new Map<string, string>([['blank', '']])
  const kv = bridgeKV({
    async storageGet(key) {
      calls.push(`get:${key}`)
      if (key === 'boom') throw new Error('bridge failed')
      return values.get(key) ?? ''
    },
    async storageSet(key, value) {
      calls.push(`set:${key}`)
      if (key === 'boom') throw new Error('bridge failed')
      values.set(key, value)
      return true
    },
  })
  assert.equal(kv.name, 'bridge')
  assert.equal(await kv.get('missing'), '')
  assert.equal(await kv.get('blank'), '')
  assert.equal(await kv.get('boom'), '')
  assert.equal(await kv.set('big', 'x'.repeat(MAX_KEY_CHARS + 1)), false)
  assert.ok(!calls.includes('set:big'), 'Oversized values never reach the bridge.')
  assert.equal(await kv.set('a', 'ok'), true)
  assert.equal(values.get('a'), 'ok')
  assert.equal(await kv.set('boom', 'ok'), false)

  const store = createStore()
  await store.load(kv)
  assert.deepEqual(store.state, emptyState(), "'' from bridge storage means absent")
})

test('browserKV survives blocked or full localStorage', async () => {
  const blocked = installLocalStorage({ throwing: true })
  try {
    const kv = browserKV()
    assert.equal(kv.name, 'localStorage')
    assert.equal(await kv.get(KEYS.prefs), '')
    assert.equal(await kv.set(KEYS.prefs, '{}'), false)
    const scheduler = fakeScheduler()
    const saves: boolean[] = []
    const store = createStore({ schedule: scheduler.schedule, onSaved: ok => saves.push(ok) })
    await store.load(kv)
    assert.deepEqual(store.state, emptyState())
    store.state.publications.push(publication('alpha.substack.com'))
    store.save('prefs')
    assert.equal(await store.flush(), false)
    assert.equal(store.lastSaveOk(), false)
    assert.deepEqual(saves, [false])
    assert.equal(store.pending(), true, 'A failed document stays dirty for the next attempt.')
  } finally {
    blocked.restore()
  }
  const full = installLocalStorage({ quotaChars: 10 })
  try {
    assert.equal(await browserKV().set('key', 'x'.repeat(20)), false)
    assert.equal(await browserKV().set('k', 'v'), true)
    assert.equal(full.data.get('k'), 'v')
    assert.equal(await browserKV().get('k'), 'v')
  } finally {
    full.restore()
  }
})

test('save is debounced 800 ms, flush writes at once, savedAt is monotonic', async () => {
  const scheduler = fakeScheduler()
  let clock = 50_000
  const memory = memoryKV()
  const store = createStore({ now: () => clock, schedule: scheduler.schedule })
  await store.load(memory.kv)
  assert.equal(store.backend(), 'memory')
  store.state.publications.push(publication('alpha.substack.com', 'Alpha'))
  store.save('prefs')
  assert.equal(store.pending(), true)
  scheduler.advance(SAVE_DEBOUNCE_MS - 1)
  await flushPromises()
  assert.equal(memory.writes.length, 0)
  store.save('prefs') // restarts the window
  scheduler.advance(SAVE_DEBOUNCE_MS - 1)
  await flushPromises()
  assert.equal(memory.writes.length, 0)
  scheduler.advance(1)
  await flushPromises()
  assert.deepEqual(memory.writes.map(([key]) => key), [KEYS.prefs])
  const prefs = JSON.parse(memory.data.get(KEYS.prefs)!)
  assert.equal(prefs.schemaVersion, 1)
  assert.equal(prefs.savedAt, 50_000)
  assert.deepEqual(prefs.publications, [{ id: null, name: 'Alpha', host: 'alpha.substack.com', addedAt: 1, inLatest: true }])
  assert.equal(store.pending(), false)
  assert.deepEqual(store.sizes(), { prefs: memory.data.get(KEYS.prefs)!.length, progress: 0 })

  assert.equal(await store.flush(), true, 'Nothing dirty is a successful no-op.')
  assert.equal(memory.writes.length, 1)

  clock = 10
  store.save()
  assert.equal(scheduler.size(), 1)
  assert.equal(await store.flush(), true)
  assert.equal(scheduler.size(), 0, 'flush cancels the pending debounce')
  assert.deepEqual(memory.writes.map(([key]) => key), [KEYS.prefs, KEYS.prefs, KEYS.progress])
  assert.equal(JSON.parse(memory.data.get(KEYS.prefs)!).savedAt, 50_001)
  assert.equal(JSON.parse(memory.data.get(KEYS.progress)!).savedAt, 10)
})

test('progress over 48k evicts the oldest positions first and keeps memory in sync', async () => {
  const state = emptyState()
  state.positions = Array.from({ length: LIMITS.positions }, (_, index) =>
    position(index + 1, 10_000 - index, { offset: 123_456, version: 'v'.repeat(32) }))
  state.history = Array.from({ length: LIMITS.history }, (_, index) =>
    ref(1000 + index, { title: 'T'.repeat(200), pubName: 'P'.repeat(120) }))
  state.read = Array.from({ length: LIMITS.read }, (_, index) => 9_007_199_254_000_000 + index)
  const untrimmed = JSON.stringify({ schemaVersion: 1, savedAt: 123, ...state })
  assert.ok(untrimmed.length > MAX_KEY_CHARS, `fixture must exceed the cap (${untrimmed.length})`)

  const raw = serializeProgress(state, 123)
  assert.ok(raw !== null && raw.length <= MAX_KEY_CHARS)
  assert.equal(state.history.length, LIMITS.history, 'history is evicted only after every position')
  assert.equal(state.read.length, LIMITS.read)
  assert.ok(state.positions.length > 100 && state.positions.length < LIMITS.positions, `${state.positions.length}`)
  assert.deepEqual(state.positions.map(item => item.postId), Array.from({ length: state.positions.length }, (_, index) => index + 1),
    'the most recently updated positions survive')
  assert.equal(JSON.parse(raw!).positions.length, state.positions.length)

  // A prefs document that cannot fit is refused rather than truncated.
  const scheduler = fakeScheduler()
  const memory = memoryKV()
  const store = createStore({ schedule: scheduler.schedule })
  await store.load(memory.kv)
  store.state.publications = Array.from({ length: LIMITS.publications }, (_, index) => publication(`p${index}.substack.com`, 'N'.repeat(120)))
  store.state.saved = Array.from({ length: LIMITS.saved }, (_, index) => ref(index + 1, { title: 'T'.repeat(200), pubName: 'P'.repeat(120) }))
  store.save('prefs')
  assert.equal(await store.flush(), false)
  assert.equal(store.lastSaveOk(), false)
  assert.equal(memory.data.has(KEYS.prefs), false)
})

test('stored documents never contain article text or HTML', async () => {
  const scheduler = fakeScheduler()
  const memory = memoryKV()
  const store = createStore({ now: () => 1, schedule: scheduler.schedule })
  await store.load(memory.kv)
  const secret = 'Synthetic body paragraph that must never be stored.'
  const leaky = { ...ref(7), bodyHtml: `<p>${secret}</p>`, text: secret, body: secret, article: { text: secret } }
  store.state.saved.push(leaky as PostRef)
  store.state.history.push(leaky as PostRef)
  store.state.lastOpen = leaky as PostRef
  recordHistory(store.state, leaky as PostRef)
  store.save()
  assert.equal(await store.flush(), true)
  assert.equal(memory.data.size, 2)
  for (const value of memory.data.values()) {
    assert.ok(!value.includes('Synthetic body paragraph'))
    assert.ok(!value.includes('bodyHtml'))
    assert.ok(!value.includes('"text"'))
  }
})

test('attachBridge adopts newer bridge documents, keeps newer local ones and persists to both', async () => {
  const scheduler = fakeScheduler()
  let clock = 1_000
  const local = memoryKV('localStorage', {
    [KEYS.prefs]: JSON.stringify({ schemaVersion: 1, savedAt: 500, publications: [{ host: 'local.substack.com' }], saved: [], settings: {} }),
    [KEYS.progress]: JSON.stringify({ schemaVersion: 1, savedAt: 900, read: [1] }),
  })
  const bridge = memoryKV('bridge', {
    [KEYS.prefs]: JSON.stringify({ schemaVersion: 1, savedAt: 800, publications: [{ host: 'bridge.substack.com' }], saved: [], settings: { linesPerPage: 5 } }),
    [KEYS.progress]: JSON.stringify({ schemaVersion: 1, savedAt: 700, read: [2] }),
  })
  const store = createStore({ now: () => clock, schedule: scheduler.schedule })
  await store.load(local.kv)
  assert.deepEqual(store.state.publications.map(item => item.host), ['local.substack.com'])
  const state = store.state
  clock = 2_000
  const changed = await store.attachBridge(mirroredKV(bridge.kv, local.kv))
  assert.equal(changed, true)
  assert.equal(store.state, state, 'The state object keeps its identity.')
  assert.deepEqual(store.state.publications.map(item => item.host), ['bridge.substack.com'])
  assert.equal(store.state.settings.linesPerPage, 5)
  assert.deepEqual(store.state.read, [1], 'local progress (900) is newer than the bridge copy (700)')
  for (const backend of [bridge, local]) {
    const prefs = JSON.parse(backend.data.get(KEYS.prefs)!)
    const progress = JSON.parse(backend.data.get(KEYS.progress)!)
    assert.deepEqual(prefs.publications.map((item: { host: string }) => item.host), ['bridge.substack.com'])
    assert.deepEqual(progress.read, [1])
    assert.equal(prefs.savedAt, 2_000)
  }
  assert.equal(store.backend(), 'bridge+localStorage')

  // Unsaved phone edits made before the bridge arrived beat an older bridge copy.
  const edited = createStore({ now: () => clock, schedule: scheduler.schedule })
  await edited.load(memoryKV('localStorage').kv)
  clock = 3_000
  edited.state.publications.push(publication('mine.substack.com'))
  edited.save('prefs')
  assert.equal(await edited.attachBridge(mirroredKV(bridge.kv, memoryKV('localStorage').kv)), true, 'bridge progress (2000) was adopted')
  assert.deepEqual(edited.state.read, [1])
  assert.deepEqual(edited.state.publications.map(item => item.host), ['mine.substack.com'])
  assert.deepEqual(JSON.parse(bridge.data.get(KEYS.prefs)!).publications.map((item: { host: string }) => item.host), ['mine.substack.com'])
})

test('state helpers keep MRU order, caps and dedupe', () => {
  const state = emptyState()
  for (let id = 1; id <= LIMITS.positions + 5; id += 1) recordPosition(state, position(id, id))
  assert.equal(state.positions.length, LIMITS.positions)
  assert.equal(state.positions[0]!.postId, LIMITS.positions + 5)
  recordPosition(state, position(50, 999))
  assert.equal(state.positions[0]!.postId, 50)
  assert.equal(state.positions.filter(item => item.postId === 50).length, 1)
  recordPosition(state, { ...position(51, 1), page: 99 })
  assert.equal(state.positions[0]!.postId, 50, 'invalid positions are ignored')

  markRead(state, 3)
  markRead(state, 4)
  markRead(state, 3)
  assert.deepEqual(state.read, [3, 4])
  recordHistory(state, ref(1))
  recordHistory(state, ref(2))
  recordHistory(state, ref(1, { title: 'Renamed' }))
  assert.deepEqual(state.history.map(item => [item.postId, item.title]), [[1, 'Renamed'], [2, 'Post 2']])

  assert.equal(addSaved(state, ref(1)), 'added')
  assert.equal(addSaved(state, ref(1)), 'exists')
  assert.equal(addSaved(state, ref(9, { host: 'bad host' })), 'invalid')
  assert.equal(addPublication(state, publication('alpha.substack.com', 'Alpha')), 'added')
  assert.equal(addPublication(state, publication('ALPHA.substack.com', 'Again')), 'exists')
  assert.equal(rehostPublication(state, 'alpha.substack.com', 'www.alpha.com'), true)
  assert.deepEqual(state.publications.map(item => item.host), ['www.alpha.com'])
  assert.equal(rehostPost(state, 1, 'www.alpha.com'), true)
  assert.equal(state.saved[0]!.host, 'www.alpha.com')
  assert.equal(state.history[0]!.host, 'www.alpha.com')
  assert.equal(state.history[1]!.host, 'alpha.substack.com')

  assert.equal(refKey(ref(-4, { slug: 'feed-post' })), 'alpha.substack.com/feed-post')
  assert.equal(refKey(ref(4)), '#4')
  clearReading(state)
  assert.deepEqual([state.positions, state.history, state.read, state.lastOpen], [[], [], [], null])
  assert.equal(state.saved.length, 1, 'clearing reading keeps Saved')
})
