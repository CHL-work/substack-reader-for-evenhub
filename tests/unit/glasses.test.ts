/**
 * mapEvent / describeEvent live in src/events.ts so this test never loads the
 * SDK runtime; src/glasses.ts re-exports them for the app.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { OsEvent, describeEvent, mapEvent } from '../../src/events'

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
