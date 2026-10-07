import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, defaultSettings, emptyState, type Position, type PostRef, type Publication } from '../../src/app/types'
import {
  KEYS, MAX_KEY_CHARS, SAVE_DEBOUNCE_MS, addPublication, addSaved, browserKV, bridgeKV, clearReading, createStore,
  markRead, mergePrefs, mergeProgress, mirroredKV, normalizePrefs, normalizeProgress, prefsFit, recordHistory,
  recordPosition, refKey, rehostPost, rehostPublication, reorderItem, serializePrefs, serializeProgress,
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
  const local = memoryKV('localStorage')
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
  assert.deepEqual(local.writes.map(([key]) => key), [KEYS.prefs])

  // The usual relaunch: both copies hold the same documents.
  const synced = memoryKV('localStorage', Object.fromEntries(bridge.data))
  const again = createStore({ now: () => 6_000, schedule: scheduler.schedule })
  await again.load(synced.kv)
  const before = bridge.writes.length
  assert.equal(await again.attachBridge(bridge.kv), false)
  assert.equal(bridge.writes.length, before)
  assert.equal(synced.writes.length, 0)
  assert.deepEqual(hosts(again.state.publications), ['first.substack.com'])
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
