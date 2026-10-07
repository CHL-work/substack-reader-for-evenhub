/**
 * Small, pure formatting helpers for glasses frames and the phone UI.
 * No DOM, no SDK, no environment access.
 */

/** Average silent reading speed used for every minute estimate. */
export const WORDS_PER_MINUTE = 230

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Reading minutes for a word count: max(1, round(words / 230)). */
export function minutesFor(words: number | null | undefined): number {
  if (typeof words !== 'number' || !Number.isFinite(words) || words <= 0) return 1
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}

/**
 * Compact age of a post for one-line list meta: `now`, `5m`, `3h`, `2d`,
 * then `Mar 4` (same year) or `Mar 4, 2023`. Local calendar date. Future
 * timestamps (clock skew, scheduled posts) read as `now`. Invalid input gives ''.
 */
export function relativeDate(iso: string | null | undefined, now: number): string {
  const time = typeof iso === 'string' && iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(time) || !Number.isFinite(now)) return ''
  const age = Math.max(0, now - time)
  if (age < MINUTE) return 'now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`
  if (age < DAY) return `${Math.floor(age / HOUR)}h`
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`
  const date = new Date(time)
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${date.getFullYear()}`
}

/**
 * Whole-percent progress. Anything short of the end never shows 100%, and
 * anything started never shows below 0%.
 */
export function pctString(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  if (fraction >= 1) return '100%'
  return `${Math.min(99, Math.round(fraction * 100))}%`
}
