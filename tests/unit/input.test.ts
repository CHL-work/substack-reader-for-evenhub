import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GESTURE_TIMING, createGestureFilter } from '../../src/input'
import { createFakeClock } from './helpers'

const NO_WRITE = Number.NEGATIVE_INFINITY

test('default timings match the spec', () => {
  assert.deepEqual(DEFAULT_GESTURE_TIMING, {
    sameDirectionMs: 300,
    directionChangeMs: 50,
    postWriteMs: 80,
    tapCooldownMs: 220,
    backDedupeMs: 600,
  })
})

test('a burst of same-direction scrolls turns one page', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  assert.equal(filter.accept('next', NO_WRITE), true)
  clock.advance(50)
  assert.equal(filter.accept('next', NO_WRITE), false)
  clock.advance(249) // 299 ms after the accepted scroll
  assert.equal(filter.accept('next', NO_WRITE), false)
  clock.advance(1) // 300 ms
  assert.equal(filter.accept('next', NO_WRITE), true)
  clock.advance(100)
  assert.equal(filter.accept('next', NO_WRITE), false, 'The window restarts at the last accepted scroll.')
})

test('a scroll within 80 ms of a display write is a phantom', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  const wroteAt = clock.now()
  clock.advance(79)
  assert.equal(filter.accept('next', wroteAt), false)
  assert.equal(filter.accept('previous', wroteAt), false)
  clock.advance(1)
  assert.equal(filter.accept('previous', wroteAt), true, 'A dropped phantom does not start a debounce window.')
})

test('a direction change is accepted after 50 ms', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  assert.equal(filter.accept('next', NO_WRITE), true)
  clock.advance(49)
  assert.equal(filter.accept('previous', NO_WRITE), false)
  clock.advance(1)
  assert.equal(filter.accept('previous', NO_WRITE), true)
  clock.advance(10)
  assert.equal(filter.accept('previous', NO_WRITE), false, 'Same direction again needs 300 ms.')
  clock.advance(50)
  assert.equal(filter.accept('next', NO_WRITE), true)
})

test('back and hold share a 600 ms dedupe window', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  assert.equal(filter.accept('back', NO_WRITE), true)
  clock.advance(100)
  assert.equal(filter.accept('back', NO_WRITE), false)
  assert.equal(filter.accept('hold', NO_WRITE), false)
  clock.advance(499) // 599 ms
  assert.equal(filter.accept('back', NO_WRITE), false)
  clock.advance(1) // 600 ms
  assert.equal(filter.accept('hold', NO_WRITE), true)
})

test('taps have a 220 ms cooldown and do not interfere with other gestures', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  assert.equal(filter.accept('select', NO_WRITE), true)
  assert.equal(filter.accept('next', NO_WRITE), true)
  assert.equal(filter.accept('back', NO_WRITE), true)
  clock.advance(219)
  assert.equal(filter.accept('select', NO_WRITE), false)
  clock.advance(1)
  assert.equal(filter.accept('select', NO_WRITE), true)
  assert.equal(filter.accept('select', clock.now()), false, 'Cooldown still applies.')
  clock.advance(220)
  assert.equal(filter.accept('select', clock.now()), true, 'Taps ignore the post-write phantom window.')
})

test('menu items pass unless the same item repeats within 600 ms', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  assert.equal(filter.accept('menu:2', NO_WRITE), true)
  assert.equal(filter.accept('menu:2', NO_WRITE), false)
  assert.equal(filter.accept('menu:3', NO_WRITE), true)
  clock.advance(600)
  assert.equal(filter.accept('menu:3', NO_WRITE), true)
})

test('reset() clears the scroll debounce but keeps duplicate-delivery guards', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now)
  assert.equal(filter.accept('next', NO_WRITE), true)
  assert.equal(filter.accept('back', NO_WRITE), true)
  assert.equal(filter.accept('select', NO_WRITE), true)
  clock.advance(10)
  assert.equal(filter.accept('next', NO_WRITE), false)
  filter.reset()
  assert.equal(filter.accept('next', NO_WRITE), true, 'The first swipe in a new view is never eaten.')
  assert.equal(filter.accept('back', NO_WRITE), false, 'A duplicated double-tap must not pop a second view.')
  assert.equal(filter.accept('select', NO_WRITE), false)
  const wroteAt = clock.now()
  filter.reset()
  assert.equal(filter.accept('previous', wroteAt), false, 'The phantom window still applies after reset.')
})

test('timings are configurable and invalid values fall back to defaults', () => {
  const clock = createFakeClock()
  const filter = createGestureFilter(clock.now, { sameDirectionMs: 100, postWriteMs: 0, backDedupeMs: Number.NaN })
  assert.equal(filter.accept('next', clock.now()), true)
  clock.advance(100)
  assert.equal(filter.accept('next', NO_WRITE), true)
  assert.equal(filter.accept('back', NO_WRITE), true)
  clock.advance(599)
  assert.equal(filter.accept('back', NO_WRITE), false)
})
