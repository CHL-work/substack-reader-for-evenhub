import { measureTextWrap, pxTruncate } from '@evenrealities/pretext'

export const G2_DISPLAY_WIDTH = 576
export const G2_DISPLAY_HEIGHT = 288
export const G2_LINE_HEIGHT = 27
export const G2_TEXT_PADDING = 4
/** Physical line capacity of the body container (the event-capture container). */
export const G2_BODY_LINES = 7

/**
 * Native container geometry is shared with the renderer so pagination cannot
 * drift away from the actual display. Text starts 16 px from each side of the
 * canvas; seven body lines leave room for a one-line title and footer. The SDK
 * exposes no font size or line spacing for text containers (27 px is fixed).
 */
export const G2_LAYOUT = {
  title: { xPosition: 12, yPosition: 4, width: G2_DISPLAY_WIDTH - 24, height: G2_LINE_HEIGHT + 2 * G2_TEXT_PADDING },
  body: { xPosition: 12, yPosition: 43, width: G2_DISPLAY_WIDTH - 24, height: G2_BODY_LINES * G2_LINE_HEIGHT + 2 * G2_TEXT_PADDING },
  footer: { xPosition: 12, yPosition: 249, width: G2_DISPLAY_WIDTH - 24, height: G2_LINE_HEIGHT + 2 * G2_TEXT_PADDING },
} as const

export const READER_BODY_WIDTH = G2_LAYOUT.body.width - 2 * G2_TEXT_PADDING
export const READER_BODY_HEIGHT = G2_LAYOUT.body.height - 2 * G2_TEXT_PADDING

/**
 * Keep a margin below the text-upgrade payload limit (2000 chars), including
 * unusual text whose zero-width or missing glyphs make its measured width tiny.
 * English prose never reaches this cap; it only matters for CJK or emoji runs.
 */
export const MAX_PAGE_UTF8_BYTES = 1800

/** Bump whenever page boundaries can change for the same input text. */
export const PAGINATION_VERSION = 1

const encoder = new TextEncoder()

export interface PaginationBox {
  width: number
  height: number
}

/**
 * One rendered page. `start`/`end` are UTF-16 indices into
 * `normalizeReaderText(source)`, and `text === normalized.slice(start, end)`.
 * Pages never start or end with an ASCII space or newline.
 */
export interface TextPage {
  text: string
  start: number
  end: number
}

/** The reader box for a lines-per-page setting: 544 px wide, `lines` x 27 px tall. */
export function bodyBox(lines: 5 | 6 | 7): PaginationBox {
  return { width: READER_BODY_WIDTH, height: lines * G2_LINE_HEIGHT }
}

/** Trim ASCII spaces and newlines only; NBSP indentation is content. */
function trimAscii(text: string): string {
  return text.replace(/^[ \n]+|[ \n]+$/g, '')
}

/**
 * Normalize formatting only. The firmware (and pretext) skip ASCII spaces at
 * the start of every line, so indentation must use U+00A0; any ASCII space
 * next to a newline is removed and runs of spaces collapse to one. NBSP,
 * variation selectors and ZWJ are kept.
 */
export function normalizeReaderText(source: string): string {
  return trimAscii(source
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n'))
}

// A structural type keeps the fallback compatible with older phone WebViews
// and TypeScript lib lists that do not include ES2022.Intl.
type SegmenterConstructor = new (
  locale: string | undefined,
  options: { granularity: 'grapheme' },
) => { segment(text: string): Iterable<{ segment: string }> }

function textUnits(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
  const units = Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)
    : Array.from(text)

  // A pathological combining sequence must not exceed the bridge payload by
  // itself. Split only that oversized cluster, still preserving surrogate pairs.
  return units.flatMap(unit => encoder.encode(unit).byteLength > MAX_PAGE_UTF8_BYTES ? Array.from(unit) : [unit])
}

const BOUNDARY_SPACE = /^[ \n]+$/
const WORD_CHAR_END = /[\p{Script=Latin}\p{Number}]$/u
const WORD_CHAR_START = /^[\p{Script=Latin}\p{Number}]/u
const BREAK_AFTER = /[^\S\u00A0]|-/u

/**
 * Paginate using the firmware's font metrics, with hard boundaries at Unicode
 * graphemes. Unlike splitting paragraphs on whitespace, this always progresses
 * through a long paragraph, URL or single unbroken token. Empty input yields
 * one empty page so callers always have a valid page index.
 */
export function paginate(source: string, box: PaginationBox = bodyBox(7)): TextPage[] {
  if (!Number.isFinite(box.width) || box.width < 32 || !Number.isFinite(box.height) || box.height < G2_LINE_HEIGHT) {
    throw new RangeError('The reader box must be at least 32 x 27 pixels.')
  }
  const text = normalizeReaderText(source)
  if (!text) return [{ text: '', start: 0, end: 0 }]

  const units = textUnits(text)
  const offsets = [0]
  const byteOffsets = [0]
  for (const unit of units) {
    offsets.push(offsets[offsets.length - 1]! + unit.length)
    byteOffsets.push(byteOffsets[byteOffsets.length - 1]! + encoder.encode(unit).byteLength)
  }
  const pages: TextPage[] = []
  let start = 0
  while (start < units.length && BOUNDARY_SPACE.test(units[start]!)) start += 1
  while (start < units.length) {
    // Every unit occupies at least one byte, so this is a safe upper bound
    // even for zero-width characters and glyphs missing from the font.
    let low = start + 1
    let high = Math.min(units.length, start + MAX_PAGE_UTF8_BYTES)
    let end = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = text.slice(offsets[start], offsets[middle])
      const bytes = byteOffsets[middle]! - byteOffsets[start]!
      if (bytes <= MAX_PAGE_UTF8_BYTES && measureTextWrap(candidate, box.width).height <= box.height) {
        end = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    // The default box fits all normal glyphs. If one exotic grapheme measures
    // taller than a page, keep it intact and advance instead of dropping text
    // or looping forever. Its firmware rendering remains uncertain.
    if (end === start) end = start + 1

    // Avoid slicing an ordinary word when a nearby natural break costs at
    // most a quarter page (and never more than 32 units).
    if (end < units.length && WORD_CHAR_END.test(units[end - 1]!) && WORD_CHAR_START.test(units[end]!)) {
      const lower = Math.max(start + 1, end - 32, start + Math.floor((end - start) * 0.75))
      for (let boundary = end - 1; boundary >= lower; boundary -= 1) {
        if (BREAK_AFTER.test(units[boundary - 1]!)) {
          end = boundary
          break
        }
      }
    }

    // Exclude trailing boundary whitespace so text === normalized.slice(start, end).
    let last = end
    while (last > start && BOUNDARY_SPACE.test(units[last - 1]!)) last -= 1
    if (last > start) {
      pages.push({ text: text.slice(offsets[start], offsets[last]), start: offsets[start]!, end: offsets[last]! })
    }
    start = end
    // Leading whitespace at a page boundary carries no content and could
    // otherwise waste a whole page on a run of blank lines.
    while (start < units.length && BOUNDARY_SPACE.test(units[start]!)) start += 1
  }
  return pages.length ? pages : [{ text: '', start: 0, end: 0 }]
}

/** Same algorithm as `paginate`, returning page texts only (kept for compatibility). */
export function paginateText(source: string, box: PaginationBox = bodyBox(7)): string[] {
  return paginate(source, box).map(page => page.text)
}

/**
 * Index of the last page whose `start` is at or before `offset` (0 if none).
 * A reading position stored as a character offset therefore survives a change
 * of lines per page or font metrics.
 */
export function pageIndexForOffset(pages: readonly TextPage[], offset: number): number {
  if (!pages.length || !Number.isFinite(offset)) return 0
  let low = 0
  let high = pages.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (pages[middle]!.start <= offset) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * The screenful of a cursor menu that contains `selection`. Screens are fixed
 * pages of `perScreen` items (like LIHKG's menu). `first` and `last` are both
 * inclusive item indices; an empty menu returns { first: 0, last: -1 }, so
 * `items.slice(first, last + 1)` is always the visible window.
 */
export function menuWindow(count: number, selection: number, perScreen: number): { first: number; last: number } {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (total === 0) return { first: 0, last: -1 }
  const size = Number.isFinite(perScreen) ? Math.max(1, Math.floor(perScreen)) : 1
  const selected = Number.isFinite(selection) ? Math.min(total - 1, Math.max(0, Math.floor(selection))) : 0
  const first = Math.floor(selected / size) * size
  return { first, last: Math.min(total, first + size) - 1 }
}

/**
 * A single-line, pixel-fitted label. ASCII whitespace collapses to one space;
 * leading U+00A0 indentation is preserved (list meta lines rely on it).
 */
export function truncateGlassesLabel(source: string): string {
  const normalized = trimAscii(normalizeReaderText(source).replace(/[^\S\u00A0]+/gu, ' '))
  const units = textUnits(normalized)
  const bounded = units.length > 160 ? `${units.slice(0, 160).join('')}...` : normalized
  return pxTruncate(bounded, READER_BODY_WIDTH)
}

/**
 * True when `text` fits `lines` body lines and the byte cap. The renderer uses
 * it (with the physical 7 lines) to reject bodies that would make the firmware
 * scroll the event-capture container internally.
 */
export function isReaderPage(text: string, lines: number = G2_BODY_LINES): boolean {
  return encoder.encode(text).byteLength <= MAX_PAGE_UTF8_BYTES
    && measureTextWrap(text, READER_BODY_WIDTH).height <= lines * G2_LINE_HEIGHT
}
