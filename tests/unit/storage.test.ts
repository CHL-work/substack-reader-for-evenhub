import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, defaultSettings, emptyState, type Position, type PostRef, type Publication } from '../../src/app/types'
import { STORAGE_TIMEOUT_MS, createBridgeQueue } from '../../src/events'
import {
  KEYS, MAX_KEY_CHARS, SAVE_DEBOUNCE_MS, SYNC_KEY, addPublication, addSaved, browserKV, bridgeKV, clearReading, createStore,
  markRead, mergePrefs, mergeProgress, mirroredKV, normalizePrefs, normalizeProgress, prefsFit, recordHistory,
  recordPosition, refKey, rehostPost, rehostPublication, removeSaved, reorderItem, serializePrefs, serializeProgress,
  type AddResult, type KV,
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
    /** The fake time, for a store's `now`. */
    now: () => time,
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

  const failing: KV = { name: 'bridge', async get() { throw new Error('bridge read failed') }, async set() { return true } }
  await assert.rejects(mirroredKV(failing, local.kv).get(KEYS.prefs), /bridge read failed/,
    'A failed primary read is not replaced by the mirror copy or by an absent key.')
})

test('bridgeKV treats an empty or missing value as absent, refuses oversized values and lets read failures through', async () => {
  const calls: string[] = []
  const values = new Map<string, unknown>([['blank', ''], ['null', null], ['number', 42]])
  const kv = bridgeKV({
    async storageGet(key) {
      calls.push(`get:${key}`)
      if (key === 'boom') throw new Error('bridge failed')
      return (values.has(key) ? values.get(key) : '') as string
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
  assert.equal(await kv.get('null'), '', 'null counts as absent')
  await assert.rejects(kv.get('boom'), /bridge failed/, 'A failed read is never mistaken for an absent key.')
  await assert.rejects(kv.get('number'), /unreadable/, 'A non-string value is a failed read.')
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

const hosts = (items: Array<{ host: string }>) => items.map(item => item.host)

test('attachBridge merges bridge and browser documents item by item and writes the union to both', async () => {
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
  assert.equal(store.loadedEmpty(), false)
  assert.deepEqual(hosts(store.state.publications), ['local.substack.com'])
  const state = store.state
  clock = 2_000
  const applied: Array<[boolean, number]> = []
  const changed = await store.attachBridge(bridge.kv, value => applied.push([value, bridge.writes.length]))
  assert.equal(changed, true)
  assert.deepEqual(applied, [[true, 0]], 'onApplied runs once, before anything is written')
  assert.equal(store.state, state, 'The state object keeps its identity.')
  assert.deepEqual(hosts(store.state.publications), ['bridge.substack.com', 'local.substack.com'],
    'the newer (bridge) order first, then what only the browser copy had')
  assert.equal(store.state.settings.linesPerPage, 5)
  assert.deepEqual(store.state.read, [1, 2], 'the newer (browser) read ids first, then the bridge ones')
  for (const backend of [bridge, local]) {
    const prefs = JSON.parse(backend.data.get(KEYS.prefs)!)
    const progress = JSON.parse(backend.data.get(KEYS.progress)!)
    assert.deepEqual(hosts(prefs.publications), ['bridge.substack.com', 'local.substack.com'])
    assert.deepEqual(progress.read, [1, 2])
    assert.equal(prefs.savedAt, 2_000)
    assert.equal(progress.savedAt, 2_000)
  }
  assert.equal(store.backend(), 'bridge+localStorage')
  assert.equal(store.attached(), true)
  assert.equal(store.pending(), false)
  const writes = bridge.writes.length
  assert.equal(await store.attachBridge(bridge.kv), false, 'Attaching again is a no-op.')
  assert.equal(bridge.writes.length, writes)
})

const BRIDGE_PREFS = JSON.stringify({
  schemaVersion: 1, savedAt: 800, publications: [{ host: 'bridge.substack.com', name: 'Bridge' }], saved: [ref(5)], settings: { linesPerPage: 5 },
})
const BRIDGE_PROGRESS = JSON.stringify({ schemaVersion: 1, savedAt: 700, read: [2], lastOpen: ref(5) })

test('attachBridge adopts the bridge library when the browser copy was lost, and refreshes only the mirror', async () => {
  const scheduler = fakeScheduler()
  const local = memoryKV('localStorage')
  const bridge = memoryKV('bridge', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  const store = createStore({ now: () => 2_000, schedule: scheduler.schedule })
  await store.load(local.kv)
  assert.equal(store.loadedEmpty(), true)
  assert.equal(await store.attachBridge(bridge.kv), true)
  assert.deepEqual(hosts(store.state.publications), ['bridge.substack.com'])
  assert.equal(store.state.saved[0]!.postId, 5)
  assert.equal(store.state.settings.linesPerPage, 5)
  assert.equal(store.state.lastOpen?.postId, 5)
  assert.deepEqual(bridge.writes, [], 'The adopted documents are not written back to the bridge.')
  assert.equal(local.data.get(KEYS.prefs), BRIDGE_PREFS)
  assert.equal(local.data.get(KEYS.progress), BRIDGE_PROGRESS)
  assert.equal(store.pending(), false)
  assert.deepEqual(store.sizes(), { prefs: BRIDGE_PREFS.length, progress: BRIDGE_PROGRESS.length })
})

test('a failed bridge read writes nothing and keeps the browser copy in charge; a later attach merges', async () => {
  const scheduler = fakeScheduler()
  // The browser copy was lost (a stray sync stamp without its documents means nothing), so the
  // bridge may hold anything this session never saw: the copies are united, never replaced.
  const local = memoryKV('localStorage', { [SYNC_KEY]: JSON.stringify({ prefs: 800, progress: 700 }) })
  const bridge = memoryKV('bridge', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  let failReads = 1
  const flaky: KV = {
    name: 'bridge',
    async get(key) {
      if (failReads > 0) {
        failReads -= 1
        throw new Error('getLocalStorage timed out')
      }
      return bridge.kv.get(key)
    },
    set: (key, value) => bridge.kv.set(key, value),
  }
  const store = createStore({ now: () => 3_000, schedule: scheduler.schedule })
  await store.load(local.kv)
  const applied: boolean[] = []
  await assert.rejects(store.attachBridge(flaky, value => applied.push(value)), /timed out/)
  assert.deepEqual(applied, [])
  assert.deepEqual(bridge.writes, [], 'The unread bridge library is never overwritten.')
  assert.equal(store.backend(), 'localStorage')
  assert.equal(store.attached(), false)
  assert.equal(store.pending(), false)
  assert.deepEqual(store.state, emptyState())

  // An edit while unattached goes to the browser copy only...
  store.state.publications.push(publication('mine.substack.com'))
  store.save('prefs')
  assert.equal(await store.flush(), true)
  assert.deepEqual(bridge.writes, [])
  // ...and the next attempt merges it into the bridge library instead of replacing it.
  assert.equal(await store.attachBridge(flaky), true)
  assert.deepEqual(hosts(store.state.publications), ['mine.substack.com', 'bridge.substack.com'])
  assert.deepEqual(hosts(JSON.parse(bridge.data.get(KEYS.prefs)!).publications), ['mine.substack.com', 'bridge.substack.com'])
  assert.equal(store.state.saved[0]!.postId, 5)
  assert.equal(store.state.settings.linesPerPage, 5, 'Default settings in the browser copy never override chosen ones.')
  assert.equal(store.state.lastOpen?.postId, 5)
  assert.equal(store.backend(), 'bridge+localStorage')
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 3_001, progress: 700 },
    'the browser copy now matches the bridge: the merged prefs written to both, the adopted progress')
})

test('phone edits made before the bridge arrived are merged into the bridge library, never replace it', async () => {
  const scheduler = fakeScheduler()
  const bridge = memoryKV('bridge', {
    [KEYS.prefs]: JSON.stringify({ schemaVersion: 1, savedAt: 2_000, publications: [{ host: 'bridge.substack.com' }], saved: [], settings: { linesPerPage: 5 } }),
    [KEYS.progress]: JSON.stringify({ schemaVersion: 1, savedAt: 2_000, read: [1] }),
  })
  const edited = createStore({ now: () => 3_000, schedule: scheduler.schedule })
  await edited.load(memoryKV('localStorage').kv)
  edited.state.publications.push(publication('mine.substack.com'))
  edited.save('prefs')
  assert.equal(await edited.attachBridge(bridge.kv), true)
  assert.deepEqual(edited.state.read, [1], 'bridge progress was adopted')
  assert.deepEqual(hosts(edited.state.publications), ['mine.substack.com', 'bridge.substack.com'])
  assert.equal(edited.state.settings.linesPerPage, 5)
  assert.deepEqual(hosts(JSON.parse(bridge.data.get(KEYS.prefs)!).publications), ['mine.substack.com', 'bridge.substack.com'])
  assert.equal(JSON.parse(bridge.data.get(KEYS.progress)!).savedAt, 2_000, 'an adopted document is not written back')
  assert.equal(edited.pending(), false)
})

test('attaching never writes the pristine defaults, and copies already in sync need no write', async () => {
  const scheduler = fakeScheduler()
  const bridge = memoryKV('bridge')
  const local = memoryKV('localStorage')
  const fresh = createStore({ now: () => 5_000, schedule: scheduler.schedule })
  await fresh.load(local.kv)
  assert.equal(await fresh.attachBridge(bridge.kv), false)
  assert.equal(bridge.writes.length, 0, 'Nothing to write: memory still holds the defaults.')
  assert.equal(local.writes.length, 0)
  assert.equal(fresh.backend(), 'bridge+localStorage')
  fresh.state.publications.push(publication('first.substack.com'))
  fresh.save('prefs')
  assert.equal(await fresh.flush(), true)
  assert.deepEqual(bridge.writes.map(([key]) => key), [KEYS.prefs])
  assert.deepEqual(local.writes.map(([key]) => key), [KEYS.prefs, SYNC_KEY], 'the sync stamp stays in the browser copy')
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 5_000, progress: -1 })

  // The usual relaunch: both copies hold the same documents (this browser copy has no sync stamp yet).
  const synced = memoryKV('localStorage', Object.fromEntries(bridge.data))
  const again = createStore({ now: () => 6_000, schedule: scheduler.schedule })
  await again.load(synced.kv)
  const before = bridge.writes.length
  assert.equal(await again.attachBridge(bridge.kv), false)
  assert.equal(bridge.writes.length, before)
  assert.deepEqual(synced.writes.map(([key]) => key), [SYNC_KEY], 'no document is written; only the sync stamp is recorded')
  assert.deepEqual(hosts(again.state.publications), ['first.substack.com'])
  // And the next relaunch writes nothing at all.
  const third = createStore({ now: () => 7_000, schedule: scheduler.schedule })
  await third.load(synced.kv)
  assert.equal(await third.attachBridge(bridge.kv), false)
  assert.equal(bridge.writes.length, before)
  assert.equal(synced.writes.length, 1)
  assert.equal(third.pending(), false)
})

test('removals, Clear reading and Reset settings made while the bridge write failed stick at the next attach', async () => {
  const scheduler = fakeScheduler()
  let clock = 2_000
  const bridge = memoryKV('bridge', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  const local = memoryKV('localStorage', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  const first = createStore({ now: () => clock, schedule: scheduler.schedule })
  await first.load(local.kv)
  assert.equal(await first.attachBridge(bridge.kv), false, 'both copies hold the same documents')
  assert.deepEqual(bridge.writes, [])
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 800, progress: 700 })
  // The user removes the saved post, clears reading and resets settings; the app closes before the
  // bridge write lands (it timed out, or the exit cut it off). Only the browser copy has the edits.
  assert.equal(removeSaved(first.state, ref(5)), true)
  clearReading(first.state)
  first.state.settings = defaultSettings()
  clock = 3_000
  first.save()
  bridge.failWrites(true)
  assert.equal(await first.flush(), false)
  assert.equal(JSON.parse(local.data.get(KEYS.prefs)!).savedAt, 3_000)
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 800, progress: 700 }, 'a failed bridge write moves no stamp')

  bridge.failWrites(false)
  clock = 4_000
  const next = createStore({ now: () => clock, schedule: scheduler.schedule })
  await next.load(local.kv)
  assert.equal(await next.attachBridge(bridge.kv), false, 'the bridge copy holds nothing new: memory is kept as a whole')
  assert.deepEqual(next.state.saved, [])
  assert.deepEqual(next.state.settings, defaultSettings())
  assert.deepEqual(hosts(next.state.publications), ['bridge.substack.com'])
  assert.deepEqual([next.state.positions, next.state.history, next.state.read, next.state.lastOpen], [[], [], [], null])
  const prefs = JSON.parse(bridge.data.get(KEYS.prefs)!)
  const progress = JSON.parse(bridge.data.get(KEYS.progress)!)
  assert.deepEqual(prefs.saved, [], 'the removal is written to the bridge')
  assert.equal(prefs.settings.linesPerPage, defaultSettings().linesPerPage)
  assert.deepEqual([progress.read, progress.history, progress.lastOpen], [[], [], null])
  assert.equal(prefs.savedAt, 4_000)
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 4_000, progress: 4_000 })
  assert.equal(next.pending(), false)
})

test('a removal made while the mirror is ahead of the bridge is not undone by the attach', async () => {
  const scheduler = fakeScheduler()
  const x = { host: 'x.substack.com' }
  const y = { host: 'y.substack.com' }
  const bridge = memoryKV('bridge', {
    [KEYS.prefs]: JSON.stringify({ schemaVersion: 1, savedAt: 1_000, publications: [x, y], saved: [], settings: {} }),
  })
  const local = memoryKV('localStorage', {
    [KEYS.prefs]: JSON.stringify({ schemaVersion: 1, savedAt: 2_000, publications: [y], saved: [], settings: {} }),
    [SYNC_KEY]: JSON.stringify({ prefs: 1_000, progress: -1 }),
  })
  const store = createStore({ now: () => 3_000, schedule: scheduler.schedule })
  await store.load(local.kv)
  assert.equal(await store.attachBridge(bridge.kv), false)
  assert.deepEqual(hosts(store.state.publications), ['y.substack.com'], 'x stays removed')
  for (const backend of [bridge, local]) {
    const prefs = JSON.parse(backend.data.get(KEYS.prefs)!)
    assert.deepEqual(hosts(prefs.publications), ['y.substack.com'])
    assert.equal(prefs.savedAt, 3_000)
  }
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 3_000, progress: -1 })
  assert.equal(bridge.data.has(KEYS.progress), false, 'the pristine progress defaults are never written')
})

test('a bridge copy that moved while the browser copy did not is adopted: removals, Clear reading and Reset settings stick (A1)', async () => {
  const scheduler = fakeScheduler()
  const x = { host: 'x.substack.com' }
  const y = { host: 'y.substack.com' }
  const bridgePrefs = JSON.stringify({ schemaVersion: 1, savedAt: 2_000, publications: [y], saved: [], settings: {} })
  const bridgeProgress = JSON.stringify({ schemaVersion: 1, savedAt: 2_000, positions: [], history: [], read: [], lastOpen: null })
  const local = memoryKV('localStorage', {
    [KEYS.prefs]: JSON.stringify({ schemaVersion: 1, savedAt: 1_000, publications: [x, y], saved: [ref(5)], settings: { linesPerPage: 5, invertSwipe: true } }),
    [KEYS.progress]: JSON.stringify({ schemaVersion: 1, savedAt: 1_000, positions: [position(5, 900)], history: [ref(5)], read: [5], lastOpen: ref(5) }),
    [SYNC_KEY]: JSON.stringify({ prefs: 1_000, progress: 1_000 }),
  })
  const bridge = memoryKV('bridge', { [KEYS.prefs]: bridgePrefs, [KEYS.progress]: bridgeProgress })
  const store = createStore({ now: () => 3_000, schedule: scheduler.schedule })
  await store.load(local.kv)
  assert.equal(await store.attachBridge(bridge.kv), true)
  assert.deepEqual(hosts(store.state.publications), ['y.substack.com'], 'x stays removed')
  assert.deepEqual(store.state.saved, [])
  assert.deepEqual(store.state.settings, defaultSettings(), 'Reset settings sticks')
  assert.deepEqual([store.state.positions, store.state.history, store.state.read, store.state.lastOpen], [[], [], [], null], 'Clear reading sticks')
  assert.deepEqual(bridge.writes, [], 'nothing is written back to the bridge')
  assert.equal(local.data.get(KEYS.prefs), bridgePrefs, 'the browser copy is refreshed from the bridge')
  assert.equal(local.data.get(KEYS.progress), bridgeProgress)
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 2_000, progress: 2_000 })
  assert.equal(store.pending(), false)
})

test('edits that reached only the bridge (the browser copy write failed) are adopted at the next attach, never merged away (A1)', async () => {
  const scheduler = fakeScheduler()
  let clock = 2_000
  const bridge = memoryKV('bridge', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  const local = memoryKV('localStorage', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  const first = createStore({ now: () => clock, schedule: scheduler.schedule })
  await first.load(local.kv)
  assert.equal(await first.attachBridge(bridge.kv), false)
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 800, progress: 700 })
  // The user removes the saved post, clears reading and resets settings; the browser copy refuses the write (quota).
  assert.equal(removeSaved(first.state, ref(5)), true)
  clearReading(first.state)
  first.state.settings = defaultSettings()
  clock = 3_000
  first.save()
  local.failWrites(true)
  assert.equal(await first.flush(), true, 'the bridge (the source of truth) stored both documents')
  local.failWrites(false)
  assert.equal(JSON.parse(local.data.get(KEYS.prefs)!).savedAt, 800, 'the browser copy kept the old documents')
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 800, progress: 700 })
  const writes = bridge.writes.length

  clock = 4_000
  const next = createStore({ now: () => clock, schedule: scheduler.schedule })
  await next.load(local.kv)
  assert.equal(next.state.saved.length, 1, 'the stale browser copy still has the saved post')
  assert.equal(await next.attachBridge(bridge.kv), true)
  assert.deepEqual(next.state.saved, [])
  assert.deepEqual(next.state.settings, defaultSettings())
  assert.deepEqual([next.state.positions, next.state.history, next.state.read, next.state.lastOpen], [[], [], [], null])
  assert.equal(bridge.writes.length, writes, 'nothing is written back to the bridge')
  assert.equal(JSON.parse(local.data.get(KEYS.prefs)!).savedAt, 3_000, 'the browser copy is refreshed from the bridge')
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 3_000, progress: 3_000 })
  assert.equal(next.pending(), false)
})

test('copies with the same content under different savedAt leave the browser copy carrying the matched savedAt (A1)', async () => {
  const scheduler = fakeScheduler()
  const doc = (savedAt: number, publications: object[]) => JSON.stringify({ schemaVersion: 1, savedAt, publications, saved: [], settings: {} })
  const x = { host: 'x.substack.com' }
  const y = { host: 'y.substack.com' }
  const local = memoryKV('localStorage', { [KEYS.prefs]: doc(1_500, [x, y]) })
  const bridge = memoryKV('bridge', { [KEYS.prefs]: doc(1_000, [x, y]) })
  const store = createStore({ now: () => 3_000, schedule: scheduler.schedule })
  await store.load(local.kv)
  assert.equal(await store.attachBridge(bridge.kv), false)
  assert.deepEqual(bridge.writes, [])
  assert.equal(JSON.parse(local.data.get(KEYS.prefs)!).savedAt, 1_000, 'the browser copy takes the bridge document it matched')
  assert.deepEqual(JSON.parse(local.data.get(SYNC_KEY)!), { prefs: 1_000, progress: -1 })
  // Then only the bridge moves on (x removed in a session whose browser copy was not written): adopted.
  bridge.data.set(KEYS.prefs, doc(2_000, [y]))
  const next = createStore({ now: () => 4_000, schedule: scheduler.schedule })
  await next.load(local.kv)
  assert.equal(await next.attachBridge(bridge.kv), true)
  assert.deepEqual(hosts(next.state.publications), ['y.substack.com'])
  assert.deepEqual(bridge.writes, [])
})

test('a late bridge write older than a stored one is rewritten at most once per stored write and per 30 s, never during a write (A2, B1)', async () => {
  const scheduler = fakeScheduler()
  const bridge = memoryKV('bridge', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  const local = memoryKV('localStorage', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  let gate: Promise<void> | null = null
  const gated: KV = {
    name: 'bridge',
    get: key => bridge.kv.get(key),
    async set(key, value) {
      await gate
      return bridge.kv.set(key, value)
    },
  }
  const store = createStore({ now: scheduler.now, schedule: scheduler.schedule })
  /** Let the debounce run out and the write finish. */
  const debounce = async () => {
    scheduler.advance(SAVE_DEBOUNCE_MS)
    await flushPromises()
  }
  const savedAtOnBridge = () => JSON.parse(bridge.data.get(KEYS.prefs)!).savedAt
  const old = JSON.stringify({ schemaVersion: 1, savedAt: 1 }) // Older than anything this session stores.
  await store.load(local.kv)
  store.lateWrite(KEYS.prefs, old)
  assert.equal(store.pending(), false, 'nothing to rewrite before the bridge is attached')
  assert.equal(await store.attachBridge(gated), false)
  store.save('prefs')
  await debounce() // t = 800: prefs stored at 801.
  assert.equal(savedAtOnBridge(), 801)

  // While a write is in flight, a late older write schedules nothing; the document waits for the next save.
  let release = () => undefined as void
  gate = new Promise<void>(resolve => { release = resolve })
  store.save('progress')
  await debounce() // t = 1600: the progress write waits.
  store.lateWrite(KEYS.prefs, old)
  assert.equal(scheduler.size(), 0)
  release()
  gate = null
  await flushPromises()
  assert.equal(store.pending(), true)
  assert.equal(await store.flush(), true) // prefs stored at 1600.

  // Otherwise it is written again after the debounce...
  store.lateWrite(KEYS.prefs, old)
  assert.equal(scheduler.size(), 1)
  await debounce() // t = 2400
  assert.equal(savedAtOnBridge(), 2_400)
  // ...but within 30 s of that rewrite only marked for the next save.
  store.lateWrite(KEYS.prefs, old)
  assert.equal(scheduler.size(), 0)
  assert.equal(store.pending(), true)
  assert.equal(await store.flush(), true) // prefs stored at 2401.

  // Once per stored write: a rewrite the bridge refused is not tried again for the next late answer.
  scheduler.advance(37_600) // t = 40000
  bridge.failWrites(true)
  store.lateWrite(KEYS.prefs, old)
  await debounce()
  assert.equal(store.lastSaveOk(), false)
  const writes = bridge.writes.length
  scheduler.advance(39_200) // t = 80000
  store.lateWrite(KEYS.prefs, old)
  assert.equal(scheduler.size(), 0)
  scheduler.advance(60_000)
  await flushPromises()
  assert.equal(bridge.writes.length, writes)

  // The newest document landing late, or another key, changes nothing; the next save writes the document.
  store.lateWrite(KEYS.prefs, JSON.stringify({ schemaVersion: 1, savedAt: 2_401 }))
  store.lateWrite('sr:other', old)
  assert.equal(scheduler.size(), 0)
  bridge.failWrites(false)
  store.save('prefs')
  await debounce()
  assert.equal(savedAtOnBridge(), 140_800)
  assert.equal(store.lastSaveOk(), true)
  assert.equal(store.pending(), false)
})

test('through the bridge queue, a host that answers writes late never makes the store loop (A2, B1)', async () => {
  const scheduler = fakeScheduler()
  /** The host's storage. */
  const data = new Map<string, string>([[KEYS.prefs, BRIDGE_PREFS], [KEYS.progress, BRIDGE_PROGRESS]])
  const local = memoryKV('localStorage', { [KEYS.prefs]: BRIDGE_PREFS, [KEYS.progress]: BRIDGE_PROGRESS })
  /** Keys the host was asked to write, in order. */
  const sent: string[] = []
  /** How the host answers the next writes (after `ms`, storing only when `stores`); then at once, storing. */
  const answers: Array<{ ms: number; stores: boolean }> = []
  const store = createStore({ now: scheduler.now, schedule: scheduler.schedule })
  const queue = createBridgeQueue({ closed: () => false, schedule: scheduler.schedule })
  // Wired as in glasses.ts: writes go through the queue, and only a late write that stored is reported.
  const bridge = bridgeKV({
    async storageGet(key) { return data.get(key) ?? '' },
    storageSet: (key, value) => queue.run('storage', STORAGE_TIMEOUT_MS, () => new Promise<boolean>(resolve => {
      sent.push(key)
      const { ms, stores } = answers.shift() ?? { ms: 0, stores: true }
      const settle = () => {
        if (stores) data.set(key, value)
        resolve(stores)
      }
      if (ms > 0) scheduler.schedule(settle, ms)
      else settle()
    }), 'set', (ok, stored) => {
      if (ok && stored === true) store.lateWrite(key, value)
    }),
  })
  /** Let `ms` of fake time pass in steps, so the promise chains of each step run. */
  const elapse = async (ms: number) => {
    for (let step = 0; step < ms; step += 200) {
      scheduler.advance(200)
      await flushPromises()
    }
  }
  const storedPrefs = () => JSON.parse(data.get(KEYS.prefs)!)
  await store.load(local.kv)
  assert.equal(await store.attachBridge(bridge), false)
  assert.deepEqual(sent, [])

  // Every write answers true after 5 s (the queue gives up after 4 s). The late answer is the newest
  // document, so nothing is written again, however long the host stays slow.
  answers.push(...Array.from({ length: 20 }, () => ({ ms: 5_000, stores: true })))
  store.state.publications.push(publication('y.substack.com'))
  store.save('prefs')
  await elapse(60_000)
  assert.deepEqual(sent, [KEYS.prefs], 'one write, no rewrite loop')
  assert.deepEqual(hosts(storedPrefs().publications), ['bridge.substack.com', 'y.substack.com'], 'it landed late')
  assert.equal(store.lastSaveOk(), false)

  // A late refusal stored nothing: no rewrite either.
  answers.length = 0
  answers.push(...Array.from({ length: 20 }, () => ({ ms: 5_000, stores: false })))
  store.state.publications.push(publication('z.substack.com'))
  store.save('prefs')
  await elapse(60_000)
  assert.deepEqual(sent, [KEYS.prefs, KEYS.prefs])
  assert.deepEqual(hosts(storedPrefs().publications), ['bridge.substack.com', 'y.substack.com'])

  // A write that timed out lands after a newer one was stored, replacing it: written again, once.
  answers.length = 0
  answers.push({ ms: 5_000, stores: true })
  store.state.publications.push(publication('w.substack.com'))
  store.save('prefs')
  await elapse(1_000) // The write starts at 0.8 s and hangs (it lands at 5.8 s).
  assert.equal(sent.length, 3)
  await elapse(4_000) // It timed out at 4.8 s.
  assert.equal(await store.flush(), true, 'the next write is stored at once')
  assert.equal(sent.length, 4)
  const newest = storedPrefs().savedAt
  await elapse(60_000)
  assert.deepEqual(sent.slice(2), [KEYS.prefs, KEYS.prefs, KEYS.prefs], 'exactly one rewrite')
  assert.ok(storedPrefs().savedAt > newest)
  assert.deepEqual(hosts(storedPrefs().publications), ['bridge.substack.com', 'y.substack.com', 'z.substack.com', 'w.substack.com'])
  assert.equal(store.lastSaveOk(), true)
  assert.equal(store.pending(), false)
  assert.deepEqual(sent.filter(key => key === KEYS.progress), [], 'the other document is never rewritten')
})

test('united copies that would not fit 48k drop what only the older copy had, never the newer copy\'s items', async () => {
  const big = (id: number) => ref(id, { slug: 's'.repeat(200), title: 'T'.repeat(200), pubName: 'P'.repeat(120) })
  const fits = (doc: object) => JSON.stringify({ ...doc, savedAt: Number.MAX_SAFE_INTEGER }).length <= MAX_KEY_CHARS
  const newer = normalizePrefs({ savedAt: 20, saved: Array.from({ length: 60 }, (_, index) => big(index + 1)) })
  const older = normalizePrefs({ savedAt: 10, publications: [{ host: 'a.substack.com' }], saved: Array.from({ length: 60 }, (_, index) => big(index + 101)) })
  assert.ok(fits(newer) && fits(older), 'each copy fits on its own')
  const merged = mergePrefs(newer, older)
  assert.ok(fits(merged))
  const ids = merged.saved.map(item => item.postId)
  assert.deepEqual(ids.slice(0, 60), Array.from({ length: 60 }, (_, index) => index + 1), 'the newer copy keeps every item')
  assert.ok(ids.length > 60 && ids.length < LIMITS.saved, `${ids.length}`)
  assert.deepEqual(ids.slice(60), Array.from({ length: ids.length - 60 }, (_, index) => index + 101), 'the older copy loses its last items')
  assert.ok(!fits({ ...merged, saved: [...merged.saved, big(101 + ids.length - 60)] }), 'no more than needed is dropped')
  assert.deepEqual(hosts(merged.publications), ['a.substack.com'])

  // At attach, the trimmed union is stored, so later saves keep working.
  const scheduler = fakeScheduler()
  const bridge = memoryKV('bridge', { [KEYS.prefs]: JSON.stringify({ ...older, savedAt: 800 }) })
  const local = memoryKV('localStorage', { [KEYS.prefs]: JSON.stringify({ ...newer, savedAt: 900 }) })
  const store = createStore({ now: () => 2_000, schedule: scheduler.schedule })
  await store.load(local.kv)
  assert.equal(await store.attachBridge(bridge.kv), true)
  assert.equal(store.lastSaveOk(), true)
  assert.ok(prefsFit(store.state))
  const stored = JSON.parse(bridge.data.get(KEYS.prefs)!)
  assert.equal(stored.savedAt, 2_000)
  assert.deepEqual(stored.saved.map((item: PostRef) => item.postId), ids)
})

test('one setting changed on an otherwise default copy keeps every other setting chosen in the older copy', () => {
  const newer = normalizePrefs({ savedAt: 20, settings: { linesPerPage: 6 } })
  const older = normalizePrefs({
    savedAt: 10,
    settings: { linesPerPage: 5, invertSwipe: true, footnotes: 'inline', homeItems: ['history', 'saved'], latestMaxPublications: 12 },
  })
  assert.deepEqual(mergePrefs(newer, older).settings, {
    ...defaultSettings(), linesPerPage: 6, invertSwipe: true, footnotes: 'inline', homeItems: ['history', 'saved'], latestMaxPublications: 12,
  })
})

test('merging keeps the newest position per post, unites lists and never lets default settings win', () => {
  const newer = normalizeProgress({ savedAt: 20, positions: [position(1, 10), position(2, 50)], history: [ref(2), ref(1)], read: [2], lastOpen: null })
  const older = normalizeProgress({ savedAt: 10, positions: [position(1, 30, { page: 5 }), position(3, 20)], history: [ref(3), ref(2)], read: [3, 2], lastOpen: ref(3) })
  const progress = mergeProgress(newer, older)
  assert.deepEqual(progress.positions.map(item => [item.postId, item.updatedAt]), [[2, 50], [1, 30], [3, 20]])
  assert.equal(progress.positions[1]!.page, 5)
  assert.deepEqual(progress.history.map(item => item.postId), [2, 1, 3])
  assert.deepEqual(progress.read, [2, 3])
  assert.equal(progress.lastOpen?.postId, 3, 'the older lastOpen fills a missing one')
  assert.equal(progress.savedAt, 20)

  const a = normalizePrefs({ savedAt: 9, publications: [{ host: 'a.substack.com', id: 7 }, { host: 'b.substack.com' }], saved: [ref(1)], settings: { linesPerPage: 6 } })
  const b = normalizePrefs({
    savedAt: 4,
    publications: [{ host: 'www.a.com', id: 7 }, { host: 'c.substack.com' }, { host: 'b.substack.com' }],
    saved: [ref(2), ref(1)],
    settings: { linesPerPage: 5 },
  })
  const prefs = mergePrefs(a, b)
  assert.deepEqual(hosts(prefs.publications), ['a.substack.com', 'b.substack.com', 'c.substack.com'], 'one Substack id is one entry')
  assert.deepEqual(prefs.saved.map(item => item.postId), [1, 2])
  assert.equal(prefs.settings.linesPerPage, 6)
  assert.equal(prefs.savedAt, 9)
  assert.equal(mergePrefs(normalizePrefs({ savedAt: 9 }), b).settings.linesPerPage, 5)
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

  // One Substack publication can answer on its subdomain and its custom domain.
  assert.equal(addPublication(state, { id: 7, name: 'Seven', host: 'seven.substack.com', addedAt: 1, inLatest: true }), 'added')
  assert.equal(addPublication(state, { id: 7, name: 'Seven', host: 'www.seven.com', addedAt: 2, inLatest: true }), 'exists')
  assert.deepEqual(state.publications.map(item => item.host), ['www.alpha.com', 'seven.substack.com'])
})

test('adds that would push the prefs document past 48k are refused as full, so it stays storable', () => {
  const state = emptyState()
  const big = (id: number) => ref(id, { slug: 's'.repeat(200), title: 'T'.repeat(200), pubName: 'P'.repeat(120) })
  let result: AddResult = 'added'
  let id = 0
  while (result === 'added') {
    id += 1
    result = addSaved(state, big(id))
  }
  assert.equal(result, 'full')
  assert.ok(state.saved.length < LIMITS.saved, `${state.saved.length} long saved posts fill the document`)
  assert.equal(state.saved.length, id - 1, 'the refused post is not kept')
  assert.ok(prefsFit(state))
  assert.ok(serializePrefs(state, 1_000)!.length <= MAX_KEY_CHARS)

  let added: AddResult = 'added'
  let count = 0
  while (added === 'added') {
    count += 1
    added = addPublication(state, publication(`p${count}.substack.com`, 'N'.repeat(120)))
  }
  assert.equal(added, 'full')
  assert.ok(state.publications.length < LIMITS.publications)
  assert.equal(state.publications.length, count - 1)
  assert.ok(prefsFit(state))
})
