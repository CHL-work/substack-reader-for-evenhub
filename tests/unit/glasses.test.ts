/**
 * mapEvent / describeEvent, the bridge call queue and the reconnect tracker
 * live in src/events.ts so this test never loads the SDK runtime;
 * src/glasses.ts wires them to the bridge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import {
  OsEvent, SCREEN_TIMEOUT_MS, STORAGE_TIMEOUT_MS, SupersededRenderError, UPGRADE_RETRY_MS, createBridgeQueue, createDisplay,
  createLinkTracker, describeEvent, mapEvent, type BridgeCallKind, type Display, type FrameField, type GlassesPage,
} from '../../src/events'
import { flushPromises } from './helpers'

/** Raw host payloads are plain objects; the SDK types them as classes. */
const ev = (raw: Record<string, unknown>) => raw as unknown as EvenHubEvent
const map = (raw: Record<string, unknown>, invert = false) => mapEvent(ev(raw), invert)

test('copied event ordinals match SDK 0.0.16 OsEventTypeList', () => {
  assert.deepEqual(OsEvent, {
    CLICK: 0,
    SCROLL_TOP: 1,
    SCROLL_BOTTOM: 2,
    DOUBLE_CLICK: 3,
    FOREGROUND_ENTER: 4,
    FOREGROUND_EXIT: 5,
    ABNORMAL_EXIT: 6,
    SYSTEM_EXIT: 7,
    IMU_DATA_REPORT: 8,
    LONG_PRESS: 9,
    LONG_PRESS_RELEASE: 10,
  })
})

test('a missing eventType inside any envelope is a tap', () => {
  assert.equal(map({ sysEvent: {} }), 'select')
  assert.equal(map({ textEvent: {} }), 'select')
  assert.equal(map({ listEvent: {} }), 'select')
  assert.equal(map({ sysEvent: { eventSource: 2 } }), 'select')
  assert.equal(map({ textEvent: { containerID: 2, containerName: 'body' } }), 'select')
  assert.equal(map({ sysEvent: { eventType: null } }), 'select')
  assert.equal(map({ textEvent: { eventType: 0 } }), 'select')
})

test('no envelope is not an action', () => {
  assert.equal(map({}), null)
  assert.equal(map({ jsonData: { eventType: 0 } }), null)
  assert.equal(map({ audioEvent: { audioPcm: new Uint8Array(4) } }), null)
  assert.equal(map({ menuItemClickEvent: {} }), null)
  assert.equal(map({ menuItemClickEvent: { itemID: 0 } }), null)
  assert.equal(mapEvent(null as unknown as EvenHubEvent, false), null)
})

test('explicit types win over the zero-valued click in another envelope', () => {
  assert.equal(map({ sysEvent: { eventType: 3 } }), 'back')
  assert.equal(map({ textEvent: { eventType: 3 } }), 'back')
  assert.equal(map({ listEvent: { eventType: 3 } }), 'back')
  assert.equal(map({ sysEvent: {}, textEvent: { eventType: 3 } }), 'back')
  assert.equal(map({ textEvent: {}, sysEvent: { eventType: 9 } }), 'hold')
  assert.equal(map({ sysEvent: {}, textEvent: { eventType: 2 } }), 'next')
  assert.equal(map({ listEvent: {}, sysEvent: { eventType: 4 } }), 'foreground')
})

test('menu clicks map to menu:<itemID> and win over taps, but not over exits', () => {
  assert.equal(map({ menuItemClickEvent: { itemID: 4 } }), 'menu:4')
  assert.equal(map({ menuItemClickEvent: { itemID: '5' } }), 'menu:5')
  assert.equal(map({ menuItemClickEvent: { itemID: 1 }, sysEvent: {} }), 'menu:1')
  assert.equal(map({ menuItemClickEvent: { itemID: 2 }, sysEvent: { eventType: 3 } }), 'menu:2')
  assert.equal(map({ menuItemClickEvent: { itemID: 2 }, sysEvent: { eventType: 7 } }), 'exitApp')
})

test('exits, holds, releases, IMU and foreground events', () => {
  assert.equal(map({ sysEvent: { eventType: 7 } }), 'exitApp')
  assert.equal(map({ sysEvent: { eventType: 6 } }), 'exitApp')
  assert.equal(map({ textEvent: { eventType: 7 } }), 'exitApp')
  assert.equal(map({ sysEvent: { eventType: 9, eventSource: 1 } }), 'hold')
  assert.equal(map({ sysEvent: { eventType: 10, eventSource: 1 } }), null)
  assert.equal(map({ sysEvent: { eventType: 8, imuData: { x: 1, y: 2, z: 3 } } }), null)
  assert.equal(map({ sysEvent: { eventType: 4 } }), 'foreground')
  assert.equal(map({ sysEvent: { eventType: 5 } }), 'background')
  assert.equal(map({ sysEvent: { eventType: 42 } }), null, 'Unknown types are never taps.')
})

test('swipes map to next/previous and invert swaps them', () => {
  assert.equal(map({ textEvent: { eventType: 2 } }), 'next')
  assert.equal(map({ textEvent: { eventType: 1 } }), 'previous')
  assert.equal(map({ textEvent: { eventType: 2 } }, true), 'previous')
  assert.equal(map({ textEvent: { eventType: 1 } }, true), 'next')
  assert.equal(map({ sysEvent: { eventType: 2 } }), 'next')
  assert.equal(map({ listEvent: { eventType: 1 } }), 'previous')
  assert.equal(map({ sysEvent: { eventType: 3 } }, true), 'back', 'Invert affects swipes only.')
  assert.equal(map({ sysEvent: {} }, true), 'select')
})

test('string spellings of event types are understood', () => {
  assert.equal(map({ sysEvent: { eventType: 'DOUBLE_CLICK_EVENT' } }), 'back')
  assert.equal(map({ textEvent: { eventType: 'SCROLL_BOTTOM' } }), 'next')
  assert.equal(map({ textEvent: { eventType: 'scroll_top_event' } }), 'previous')
  assert.equal(map({ sysEvent: { eventType: '7' } }), 'exitApp')
  assert.equal(map({ sysEvent: { eventType: 'IMU_DATA_REPORT' } }), null)
  assert.equal(map({ sysEvent: { eventType: 'SOMETHING_NEW' } }), null)
})

test('describeEvent reports envelope, type and source only', () => {
  assert.equal(describeEvent(ev({ sysEvent: { eventSource: 2 } })), 'sys:CLICK(omitted)@2')
  assert.equal(describeEvent(ev({ textEvent: { eventType: 2 } })), 'text:SCROLL_BOTTOM')
  assert.equal(describeEvent(ev({ listEvent: { eventType: 0, currentSelectItemIndex: 3 } })), 'list:CLICK#3')
  assert.equal(describeEvent(ev({ menuItemClickEvent: { itemID: 4 } })), 'menu:4')
  assert.equal(describeEvent(ev({ sysEvent: { eventType: 8, imuData: { x: 1.25, y: 2.5, z: 3.75 } } })), 'sys:IMU_DATA_REPORT')
  assert.equal(describeEvent(ev({ sysEvent: { eventType: 3, eventSource: 1 }, textEvent: { eventType: 3 } })), 'sys:DOUBLE_CLICK@1 text:DOUBLE_CLICK')
  assert.equal(describeEvent(ev({ textEvent: { eventType: 42 } })), 'text:type 42')
  assert.equal(describeEvent(ev({})), 'empty')
})

// ---------------------------------------------------------------------------
// Bridge call queue (timeouts, render coalescing) and reconnect redraws

function fakeTimers() {
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
    pending: () => tasks.length,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

/** Attach the handler at once (a rejection seen later would be unhandled): the error, or null on success. */
function outcome(promise: Promise<unknown>): Promise<Error | null> {
  return promise.then(() => null, (error: Error) => error)
}

function queueFixture() {
  const timers = fakeTimers()
  const errors: unknown[] = []
  const late: BridgeCallKind[] = []
  /** `kind:label` of every late answer. */
  const lateLabels: string[] = []
  /** [ok, value] of every late answer. */
  const lateOutcomes: Array<[boolean, unknown]> = []
  let closed = false
  const queue = createBridgeQueue({
    closed: () => closed,
    schedule: timers.schedule,
    onScreenError: error => errors.push(error),
    onLate: (kind, label, ok, value) => {
      late.push(kind)
      lateLabels.push(`${kind}:${label}`)
      lateOutcomes.push([ok, value])
    },
  })
  return { queue, timers, errors, late, lateLabels, lateOutcomes, close() { closed = true } }
}

test('bridge calls run one at a time in order, and a failed call never blocks the next', async () => {
  const { queue, timers, errors } = queueFixture()
  const log: string[] = []
  const first = deferred<string>()
  const a = queue.run('storage', STORAGE_TIMEOUT_MS, () => { log.push('a'); return first.promise })
  const b = outcome(queue.run('screen', SCREEN_TIMEOUT_MS, async () => { log.push('b'); throw new Error('refused') }))
  const c = queue.run('storage', STORAGE_TIMEOUT_MS, async () => { log.push('c'); return 'c' })
  await flushPromises()
  assert.deepEqual(log, ['a'], 'b and c wait for a')
  first.resolve('a')
  assert.equal(await a, 'a')
  assert.equal((await b)?.message, 'refused')
  assert.equal(await c, 'c')
  assert.deepEqual(log, ['a', 'b', 'c'])
  assert.equal(errors.length, 1, 'only the failed screen call is reported')
  assert.equal(timers.pending(), 0, 'every timeout is cleared once its call settles')
})

test('a bridge call that never answers times out, the queue moves on, and a late answer is reported', async () => {
  const { queue, timers, errors, late } = queueFixture()
  const stalled = deferred<boolean>()
  let live: (() => boolean) | null = null
  const hung = outcome(queue.run('screen', SCREEN_TIMEOUT_MS, check => { live = check; return stalled.promise }))
  const exit = queue.run('screen', SCREEN_TIMEOUT_MS, async () => 'exit dialog')
  const read = outcome(queue.run('storage', STORAGE_TIMEOUT_MS, () => new Promise<string>(() => undefined)))
  await flushPromises()
  assert.equal(live!(), true)
  timers.advance(SCREEN_TIMEOUT_MS - 1)
  await flushPromises()
  let settled = false
  void hung.then(() => { settled = true })
  await flushPromises()
  assert.equal(settled, false, 'still waiting just before the timeout')
  timers.advance(1)
  assert.equal((await hung)?.name, 'BridgeTimeoutError')
  assert.equal(live!(), false, 'a timed-out operation is told to stop issuing bridge calls')
  assert.equal(await exit, 'exit dialog', 'the exit dialog is not starved by the hung call')
  await flushPromises()
  timers.advance(STORAGE_TIMEOUT_MS)
  const storageError = await read
  assert.equal(storageError?.name, 'BridgeTimeoutError', 'a storage read that never answers rejects (never reads as absent)')
  assert.equal(errors.length, 1, 'only the screen timeout is reported as a display error')
  assert.deepEqual(late, [])
  stalled.resolve(true)
  await flushPromises()
  assert.deepEqual(late, ['screen'], 'the late answer is reported so the frame can be sent again')
})

test('renders coalesce: a newer frame replaces a queued one, which rejects as superseded', async () => {
  const { queue, errors } = queueFixture()
  const written: string[] = []
  const inFlight = deferred<void>()
  const write = (name: string, gate?: Promise<void>) => async () => {
    written.push(name)
    await gate
  }
  const r1 = outcome(queue.render(SCREEN_TIMEOUT_MS, write('r1', inFlight.promise)))
  await flushPromises()
  assert.deepEqual(written, ['r1'])
  assert.equal(queue.renderPending(), false, 'a started render no longer waits')
  const r2 = outcome(queue.render(SCREEN_TIMEOUT_MS, write('r2')))
  assert.equal(queue.renderPending(), true)
  const r3 = outcome(queue.render(SCREEN_TIMEOUT_MS, write('r3')))
  const exit = outcome(queue.run('screen', SCREEN_TIMEOUT_MS, async () => { written.push('exit') }))
  const r4 = outcome(queue.render(SCREEN_TIMEOUT_MS, write('r4')))
  for (const superseded of [await r2, await r3]) {
    assert.ok(superseded instanceof SupersededRenderError)
    assert.equal(superseded.name, 'SupersededRenderError')
  }
  inFlight.resolve()
  assert.equal(await r1, null)
  assert.equal(await r4, null)
  assert.equal(await exit, null)
  assert.deepEqual(written, ['r1', 'r4', 'exit'], 'only the newest queued frame is written, and exit waits for one render at most')
  assert.deepEqual(errors, [], 'superseded renders are not display failures')
})

test('a render that fails or times out rejects its caller and is reported once', async () => {
  const { queue, timers, errors } = queueFixture()
  const refused = outcome(queue.render(SCREEN_TIMEOUT_MS, async () => { throw new Error('G2 rejected the body update.') }))
  assert.match((await refused)?.message ?? '', /rejected the body/)
  const hung = outcome(queue.render(SCREEN_TIMEOUT_MS, () => new Promise<void>(() => undefined)))
  await flushPromises()
  timers.advance(SCREEN_TIMEOUT_MS)
  assert.equal((await hung)?.name, 'BridgeTimeoutError')
  await flushPromises()
  assert.equal(errors.length, 2)
  assert.equal(queue.renderPending(), false)
})

test('a closed queue rejects without calling the bridge and frees the render slot', async () => {
  const { queue, close } = queueFixture()
  close()
  let called = false
  const read = outcome(queue.run('storage', STORAGE_TIMEOUT_MS, async () => { called = true; return 'x' }))
  const render = outcome(queue.render(SCREEN_TIMEOUT_MS, async () => { called = true }))
  assert.match((await read)?.message ?? '', /closed/)
  assert.match((await render)?.message ?? '', /closed/)
  assert.equal(called, false)
  assert.equal(queue.renderPending(), false)
})

test('a reconnect asks for a full redraw after a disconnect or a failed write, whatever was reported in between', () => {
  const link = createLinkTracker()
  assert.equal(link.connected(), false, 'the first Connected needs no redraw')
  // Disconnected, then a render that resolved anyway (it reported ready), then the real reconnect.
  link.disconnected()
  link.written()
  assert.equal(link.connected(), true)
  assert.equal(link.connected(), false, 'one redraw per reconnect')
  // A render failed while the link looked up (it reported an error), then Connected.
  link.writeFailed()
  assert.equal(link.connected(), true)
  // A failed write that a later frame repaired needs nothing.
  link.writeFailed()
  link.written()
  assert.equal(link.connected(), false)
})

test('a call that settles after its timeout reports how it settled, to its own handler and to onLate (A2, B1)', async () => {
  const { queue, timers, errors, lateLabels, lateOutcomes } = queueFixture()
  const own: Array<[boolean, unknown]> = []
  const report = (ok: boolean, value: unknown) => { own.push([ok, value]) }
  const stored = deferred<boolean>()
  const refused = deferred<boolean>()
  let fail = (_error: Error) => undefined as void
  const failing = new Promise<boolean>((_resolve, reject) => { fail = reject })
  const writes = [
    outcome(queue.run('storage', STORAGE_TIMEOUT_MS, () => stored.promise, 'set', report)),
    outcome(queue.run('storage', STORAGE_TIMEOUT_MS, () => refused.promise, 'set', report)),
    outcome(queue.run('storage', STORAGE_TIMEOUT_MS, () => failing, 'set', report)),
  ]
  for (const write of writes) {
    await flushPromises()
    timers.advance(STORAGE_TIMEOUT_MS)
    assert.equal((await write)?.name, 'BridgeTimeoutError')
  }
  assert.equal(await queue.run('storage', STORAGE_TIMEOUT_MS, async () => true, 'set', report), true)
  assert.deepEqual(own, [], 'an answer in time is no late answer')
  stored.resolve(true)
  refused.resolve(false)
  const error = new Error('setLocalStorage failed')
  fail(error)
  await flushPromises()
  assert.deepEqual(own, [[true, true], [true, false], [false, error]],
    'only a write that answered true stored anything; a late refusal or error changed nothing')
  assert.deepEqual(lateOutcomes, own)
  assert.deepEqual(lateLabels, ['storage:set', 'storage:set', 'storage:set'])
  assert.deepEqual(errors, [])
})

test('page creation waits for storage calls ahead of it, and later calls wait for it at most the hold', async () => {
  const { queue, timers, errors, late } = queueFixture()
  const log: string[] = []
  const read = deferred<string>()
  const reading = queue.run('storage', STORAGE_TIMEOUT_MS, () => { log.push('read'); return read.promise }, 'get')
  const page = deferred<number>()
  const created = queue.hold('screen', 8000, () => { log.push('create'); return page.promise }, 'create')
  const write = queue.run('storage', STORAGE_TIMEOUT_MS, async () => { log.push('write'); return true }, 'set')
  await flushPromises()
  assert.deepEqual(log, ['read'], 'the page is never created while a storage call runs')
  read.resolve('x')
  assert.equal(await reading, 'x')
  await flushPromises()
  assert.deepEqual(log, ['read', 'create'])
  timers.advance(7999)
  await flushPromises()
  assert.deepEqual(log, ['read', 'create'], 'a storage write waits for the page...')
  timers.advance(1)
  assert.equal(await write, true)
  assert.deepEqual(log, ['read', 'create', 'write'], '...for at most the hold')
  let answered = false
  void created.then(() => { answered = true })
  await flushPromises()
  assert.equal(answered, false, 'the caller still waits for the page itself, unbounded')
  page.resolve(0)
  assert.equal(await created, 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(late, [])
  assert.equal(timers.pending(), 0)
})

// ---------------------------------------------------------------------------
// Display state: field-by-field records, invalidation epochs, late answers

const frame = (n: number): GlassesPage => ({ title: `T${n}`, body: `B${n}`, footer: `F${n}` })

function displayFixture() {
  const timers = fakeTimers()
  const errors: string[] = []
  const calls: Array<{ field: FrameField; content: string; answer(ok: boolean): void }> = []
  const queue = createBridgeQueue({
    closed: () => false,
    schedule: timers.schedule,
    onScreenError: (_error, label) => errors.push(label),
    onLate: (kind, label) => { if (kind === 'screen') display.late(label) },
  })
  let frames = 0
  /** onFrame's `newest` flag of every accepted frame. */
  const newest: boolean[] = []
  const display: Display = createDisplay({
    queue,
    schedule: timers.schedule,
    upgrade: (field, content) => new Promise<boolean>(resolve => { calls.push({ field, content, answer: resolve }) }),
    onFrame: flag => {
      frames += 1
      newest.push(flag)
    },
  })
  return {
    display, queue, timers, errors, calls, newest,
    frames: () => frames,
    /** Fields sent from call `from` on. */
    sent: (from = 0) => calls.slice(from).map(call => call.field),
    /** Answer call `index`, then let the frame go on. */
    async answer(index: number, ok = true) {
      calls[index]!.answer(ok)
      await flushPromises()
    },
  }
}

test('a frame records each field once the glasses accept it, and sends only the fields that changed', async () => {
  const f = displayFixture()
  f.display.created(frame(0))
  const first = outcome(f.display.render({ ...frame(0), body: 'B1' }))
  await flushPromises()
  assert.deepEqual(f.sent(), ['body'], 'title and footer are already on the display')
  await f.answer(0)
  assert.equal(await first, null)
  assert.deepEqual(f.display.shown(), { ...frame(0), body: 'B1' })
  // A refused update is tried once more after a short pause; a second refusal fails the frame.
  const refused = outcome(f.display.render(frame(2)))
  await flushPromises()
  await f.answer(1, false)
  assert.deepEqual(f.sent(1), ['body'], 'no retry before the pause')
  f.timers.advance(UPGRADE_RETRY_MS)
  await flushPromises()
  await f.answer(2, false)
  assert.match((await refused)?.message ?? '', /rejected the body/)
  assert.deepEqual(f.display.shown(), { title: 'T0', footer: 'F0' }, 'the refused field is unknown; the others are kept')
  assert.deepEqual(f.errors, ['render'])
  assert.equal(f.frames(), 1)
})

test('each container update is bounded on its own, so a slow but working link never times out a frame', async () => {
  const f = displayFixture()
  f.display.created(frame(0))
  const slow = outcome(f.display.render(frame(1)))
  for (let index = 0; index < 3; index += 1) {
    await flushPromises()
    f.timers.advance(SCREEN_TIMEOUT_MS - 1000) // Each update takes 4 s: 12 s for the whole frame.
    await f.answer(index)
  }
  assert.equal(await slow, null)
  assert.deepEqual(f.sent(), ['body', 'title', 'footer'])
  assert.deepEqual(f.errors, [])
  assert.deepEqual(f.display.shown(), frame(1))
  assert.equal(f.timers.pending(), 0, 'every per-update timer is cleared')
})

test('a redraw asked for while a frame is written resends what was written before or during the invalidation', async () => {
  const f = displayFixture()
  f.display.created(frame(0))
  const first = outcome(f.display.render(frame(1)))
  await flushPromises()
  await f.answer(0) // body
  assert.deepEqual(f.sent(), ['body', 'title'])
  // The G2 reports Connected while the title update is in flight: what it shows is unknown.
  f.display.invalidate()
  const redraw = outcome(f.display.render(frame(1)))
  await f.answer(1) // title, accepted after the invalidation: not known to be shown
  await f.answer(2) // footer, sent after it: shown
  assert.equal(await first, null)
  await flushPromises()
  assert.deepEqual(f.sent(3), ['body'], 'the redraw does not trust what the interrupted frame wrote')
  await f.answer(3)
  await f.answer(4)
  assert.equal(await redraw, null)
  assert.deepEqual(f.sent(3), ['body', 'title'])
  assert.deepEqual(f.display.shown(), frame(1))
})

test('an update that times out and lands during a newer frame makes it resend that field, once per frame', async () => {
  const f = displayFixture()
  f.display.created(frame(0))
  const r11 = outcome(f.display.render(frame(11)))
  await flushPromises()
  f.timers.advance(SCREEN_TIMEOUT_MS) // The body update of page 11 hangs.
  assert.equal((await r11)?.name, 'BridgeTimeoutError')
  assert.deepEqual(f.errors, ['render'])
  assert.deepEqual(f.display.shown(), { title: 'T0', footer: 'F0' })
  const r12 = outcome(f.display.render(frame(12)))
  await flushPromises()
  assert.deepEqual(f.sent(), ['body', 'body'])
  await f.answer(0) // Page 11's body lands after all, maybe over page 12's.
  await f.answer(1)
  await f.answer(2)
  await f.answer(3)
  assert.equal(await r12, null)
  assert.deepEqual(f.sent(2), ['title', 'footer', 'body'], 'page 12 is sent again: only its body, which the late answer may have overwritten')
  // The resend's own update hangs and lands late too: no further resend for the same frame.
  f.timers.advance(SCREEN_TIMEOUT_MS)
  await flushPromises()
  assert.deepEqual(f.errors, ['render', 'render'])
  await f.answer(4)
  await flushPromises()
  assert.equal(f.calls.length, 5, 'a slow link cannot loop on late answers')
  assert.deepEqual(f.display.shown(), {})
  // The next frame the controller asks for resends every field.
  const r13 = outcome(f.display.render(frame(13)))
  await flushPromises()
  await f.answer(5)
  await f.answer(6)
  await f.answer(7)
  assert.equal(await r13, null)
  assert.deepEqual(f.sent(5), ['body', 'title', 'footer'])
})

test('an exit dialog that answers late is never drawn over; the next frame resends every field', async () => {
  const f = displayFixture()
  f.display.created(frame(1))
  const dialog = deferred<boolean>()
  const exit = outcome(f.queue.run('screen', SCREEN_TIMEOUT_MS, async () => {
    if (!(await dialog.promise)) throw new Error('refused')
    f.display.invalidate()
  }, 'exit'))
  await flushPromises()
  f.timers.advance(SCREEN_TIMEOUT_MS)
  assert.equal((await exit)?.name, 'BridgeTimeoutError')
  assert.deepEqual(f.errors, ['exit'])
  dialog.resolve(true) // The OS exit dialog appears now.
  await flushPromises()
  assert.deepEqual(f.calls, [], 'nothing is written over the dialog')
  assert.deepEqual(f.display.shown(), {})
  // The wearer cancels and acts: that frame resends every field.
  const next = outcome(f.display.render(frame(1)))
  await flushPromises()
  await f.answer(0)
  await f.answer(1)
  await f.answer(2)
  assert.equal(await next, null)
  assert.deepEqual(f.sent(), ['body', 'title', 'footer'])
})

test('a late answer after an exit was asked for never draws over the dialog; the app\'s next frame resends every field (B2)', async () => {
  const f = displayFixture()
  f.display.created(frame(1))
  const r2 = outcome(f.display.render(frame(2)))
  await flushPromises()
  assert.deepEqual(f.sent(), ['body'])
  f.timers.advance(SCREEN_TIMEOUT_MS) // Frame 2's body update hangs.
  assert.equal((await r2)?.name, 'BridgeTimeoutError')
  // The display looks frozen, so the wearer double-taps on Home: the exit dialog is asked for.
  f.display.exitRequested()
  const dialog = deferred<boolean>()
  const exit = outcome(f.queue.run('screen', SCREEN_TIMEOUT_MS, async () => {
    if (!(await dialog.promise)) throw new Error('refused')
    f.display.invalidate()
  }, 'exit'))
  await flushPromises()
  await f.answer(0) // Frame 2's body lands late while the exit runs...
  dialog.resolve(true) // ...and the dialog opens.
  assert.equal(await exit, null)
  await flushPromises()
  assert.equal(f.calls.length, 1, 'no recovery frame is queued behind the exit and sent over the dialog')
  assert.deepEqual(f.display.shown(), {})
  // The wearer cancels the dialog and acts: the app's next frame resends every field.
  const next = outcome(f.display.render(frame(3)))
  await flushPromises()
  await f.answer(1)
  await f.answer(2)
  await f.answer(3)
  assert.equal(await next, null)
  assert.deepEqual(f.sent(1), ['body', 'title', 'footer'])

  // An exit the glasses refused opened no dialog: a late answer then sends the newest frame again.
  const g = displayFixture()
  g.display.created(frame(1))
  const r5 = outcome(g.display.render(frame(5)))
  await flushPromises()
  g.timers.advance(SCREEN_TIMEOUT_MS)
  assert.equal((await r5)?.name, 'BridgeTimeoutError')
  g.display.exitRequested()
  const refused = outcome(g.queue.run('screen', SCREEN_TIMEOUT_MS, async () => {
    g.display.exitFailed() // As glasses.ts does when shutDownPageContainer answers false.
    throw new Error('G2 could not open the exit menu.')
  }, 'exit'))
  assert.match((await refused)?.message ?? '', /exit menu/)
  await g.answer(0)
  await g.answer(1)
  await g.answer(2)
  await g.answer(3)
  assert.deepEqual(g.sent(1), ['body', 'title', 'footer'])
  assert.deepEqual(g.display.shown(), frame(5))
})

test('a frame counts as the newest shown only when nothing newer was asked for, also after a late recovery (K2)', async () => {
  const f = displayFixture()
  f.display.created(frame(0))
  const r1 = outcome(f.display.render(frame(1)))
  await flushPromises()
  const r2 = outcome(f.display.render(frame(2))) // Asked for while frame 1 is being written.
  await f.answer(0)
  await f.answer(1)
  await f.answer(2)
  assert.equal(await r1, null)
  assert.deepEqual(f.newest, [false], 'frame 1 is on the display, but frame 2 was asked for since')
  await f.answer(3)
  await f.answer(4)
  await f.answer(5)
  assert.equal(await r2, null)
  assert.deepEqual(f.newest, [false, true])
  // Frame 3's body update times out (its render rejects), then lands; the recovery writes frame 3.
  const r3 = outcome(f.display.render(frame(3)))
  await flushPromises()
  f.timers.advance(SCREEN_TIMEOUT_MS)
  assert.equal((await r3)?.name, 'BridgeTimeoutError')
  await f.answer(6)
  await f.answer(7)
  await f.answer(8)
  await f.answer(9)
  assert.deepEqual(f.sent(6), ['body', 'body', 'title', 'footer'])
  assert.deepEqual(f.newest, [false, true, true], 'the app learns that the frame whose render failed is shown after all')
  assert.deepEqual(f.display.shown(), frame(3))
  assert.deepEqual(f.errors, ['render'])
})
