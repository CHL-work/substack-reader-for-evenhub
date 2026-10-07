import type { GlassesAction } from './events'

/**
 * Gesture filter between the SDK events and the app. One physical swipe can
 * emit several SCROLL events, the firmware can emit a phantom SCROLL right
 * after a display update, and double-taps / exits can arrive twice
 * (sys + text envelopes, 50-100 ms apart). Pure: the clock is injected.
 */
export interface GestureFilterOptions {
  /** Minimum gap between two accepted scrolls in the same direction. */
  sameDirectionMs?: number    // 300
  /** Minimum gap before a scroll in the opposite direction is accepted. */
  directionChangeMs?: number  // 50
  /** Scrolls this soon after a successful display write are phantoms. */
  postWriteMs?: number        // 80
  /** Minimum gap between two accepted taps ('select'). */
  tapCooldownMs?: number      // 220
  /** 'back'/'hold' (shared) and identical menu clicks are deduped within this window. */
  backDedupeMs?: number       // 600
}

export interface GestureFilter {
  /**
   * True when the action should reach the app. `lastWriteAt` is the clock
   * time of the last successful textContainerUpgrade (-Infinity if none).
   */
  accept(action: GlassesAction, lastWriteAt: number): boolean
  /**
   * Call on every view change. Clears the scroll debounce so the first swipe
   * in a new view is never eaten. Tap, back and menu dedupe windows are kept
   * on purpose: they guard against duplicate deliveries of one gesture, which
   * would otherwise act twice across the view change (e.g. pop two views).
   */
  reset(): void
}

export const DEFAULT_GESTURE_TIMING: Required<GestureFilterOptions> = {
  sameDirectionMs: 300,
  directionChangeMs: 50,
  postWriteMs: 80,
  tapCooldownMs: 220,
  backDedupeMs: 600,
}

function duration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function createGestureFilter(now: () => number, opts: GestureFilterOptions = {}): GestureFilter {
  const timing: Required<GestureFilterOptions> = {
    sameDirectionMs: duration(opts.sameDirectionMs, DEFAULT_GESTURE_TIMING.sameDirectionMs),
    directionChangeMs: duration(opts.directionChangeMs, DEFAULT_GESTURE_TIMING.directionChangeMs),
    postWriteMs: duration(opts.postWriteMs, DEFAULT_GESTURE_TIMING.postWriteMs),
    tapCooldownMs: duration(opts.tapCooldownMs, DEFAULT_GESTURE_TIMING.tapCooldownMs),
    backDedupeMs: duration(opts.backDedupeMs, DEFAULT_GESTURE_TIMING.backDedupeMs),
  }
  let scrollDirection: 'next' | 'previous' | null = null
  let scrollAt = -Infinity
  let tapAt = -Infinity
  let backAt = -Infinity
  let menuAction: string | null = null
  let menuAt = -Infinity

  return {
    accept(action, lastWriteAt) {
      const t = now()
      if (action === 'next' || action === 'previous') {
        if (Number.isFinite(lastWriteAt) && t - lastWriteAt < timing.postWriteMs) return false
        if (scrollDirection !== null) {
          const gap = t - scrollAt
          if (scrollDirection === action ? gap < timing.sameDirectionMs : gap < timing.directionChangeMs) return false
        }
        scrollDirection = action
        scrollAt = t
        return true
      }
      if (action === 'select') {
        if (t - tapAt < timing.tapCooldownMs) return false
        tapAt = t
        return true
      }
      if (action === 'back' || action === 'hold') {
        if (t - backAt < timing.backDedupeMs) return false
        backAt = t
        return true
      }
      // Contextual menu items are deliberate; only drop an identical repeat.
      if (menuAction === action && t - menuAt < timing.backDedupeMs) return false
      menuAction = action
      menuAt = t
      return true
    },
    reset() {
      scrollDirection = null
      scrollAt = -Infinity
    },
  }
}
