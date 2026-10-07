/**
 * mapEvent / describeEvent, the bridge call queue and the reconnect tracker
 * live in src/events.ts so this test never loads the SDK runtime;
 * src/glasses.ts wires them to the bridge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import {
  OsEvent, SCREEN_TIMEOUT_MS, STORAGE_TIMEOUT_MS, SupersededRenderError, createBridgeQueue, createLinkTracker,
  describeEvent, mapEvent, type BridgeCallKind,
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
  let closed = false
  const queue = createBridgeQueue({
    closed: () => closed,
    schedule: timers.schedule,
    onScreenError: error => errors.push(error),
    onLate: kind => late.push(kind),
  })
  return { queue, timers, errors, late, close() { closed = true } }
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
