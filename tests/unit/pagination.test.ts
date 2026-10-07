import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import {
  G2_BODY_LINES,
  G2_DISPLAY_HEIGHT,
  G2_DISPLAY_WIDTH,
  G2_LAYOUT,
  G2_LINE_HEIGHT,
  G2_TEXT_PADDING,
  MAX_PAGE_UTF8_BYTES,
  PAGINATION_VERSION,
  READER_BODY_HEIGHT,
  READER_BODY_WIDTH,
  bodyBox,
  isReaderPage,
  menuWindow,
  normalizeReaderText,
  pageIndexForOffset,
  paginate,
  paginateText,
  truncateGlassesLabel,
  type TextPage,
} from '../../src/pagination'

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

function assertFits(page: string, lines = G2_BODY_LINES) {
  assert.ok(measureTextWrap(page, READER_BODY_WIDTH).height <= lines * G2_LINE_HEIGHT, `page overflows ${lines} lines: ${JSON.stringify(page.slice(0, 80))}`)
  assert.ok(bytes(page) <= MAX_PAGE_UTF8_BYTES)
}

// Synthetic English article: numbered paragraphs, NBSP-indented bullets, a long URL.
const PARAGRAPH = 'The quick brown fox jumps over the lazy dog while reading a long newsletter about economics, history and the craft of writing.'
const ARTICLE = Array.from({ length: 60 }, (_, index) => {
  if (index % 7 === 3) return `\u00A0\u00A0\u00A0\u2022 List item ${index} with a few short words`
  if (index === 20) return `See https://example.invalid/${'segment'.repeat(60)}?utm_source=x for details.`
  return `${index}. ${PARAGRAPH}  Extra   spaces \t and a tab.`
}).join('\n\n')

test('G2 text containers keep safe margins, do not overlap and match pagination bounds', () => {
  assert.equal(G2_DISPLAY_WIDTH, 576)
  assert.equal(G2_DISPLAY_HEIGHT, 288)
  const boxes = [G2_LAYOUT.title, G2_LAYOUT.body, G2_LAYOUT.footer]
  for (const box of boxes) {
    assert.ok(box.xPosition >= 12, 'Text must retain the left optical margin.')
    assert.ok(G2_DISPLAY_WIDTH - box.xPosition - box.width >= 12, 'Text must retain the right optical margin.')
    assert.ok(box.yPosition >= 0 && box.yPosition + box.height <= G2_DISPLAY_HEIGHT)
    assert.ok(box.width - 2 * G2_TEXT_PADDING > 0)
    assert.ok(box.height - 2 * G2_TEXT_PADDING >= G2_LINE_HEIGHT)
  }
  for (let index = 1; index < boxes.length; index += 1) {
    assert.ok(boxes[index - 1]!.yPosition + boxes[index - 1]!.height < boxes[index]!.yPosition)
  }
  assert.equal(READER_BODY_WIDTH, 544)
  assert.equal(READER_BODY_WIDTH, G2_LAYOUT.body.width - 2 * G2_TEXT_PADDING)
  assert.equal(READER_BODY_HEIGHT, G2_LAYOUT.body.height - 2 * G2_TEXT_PADDING)
  assert.equal(READER_BODY_HEIGHT, G2_BODY_LINES * G2_LINE_HEIGHT)
  assert.equal(READER_BODY_HEIGHT % G2_LINE_HEIGHT, 0, 'Do not leave a clipped partial text line.')
  assert.equal(G2_LAYOUT.title.height - 2 * G2_TEXT_PADDING, G2_LINE_HEIGHT)
  assert.equal(G2_LAYOUT.footer.height - 2 * G2_TEXT_PADDING, G2_LINE_HEIGHT)
  assert.deepEqual(bodyBox(7), { width: 544, height: 189 })
  assert.deepEqual(bodyBox(6), { width: 544, height: 162 })
  assert.deepEqual(bodyBox(5), { width: 544, height: 135 })
  assert.equal(PAGINATION_VERSION, 1)
})

test('normalizeReaderText collapses spaces, never leaves an ASCII space next to a newline, keeps NBSP', () => {
  assert.equal(
    normalizeReaderText('  Title  \r\n\r\n\r\n  body\ttext  with   gaps \u0007end  '),
    'Title\n\nbody text with gaps end',
  )
  assert.equal(normalizeReaderText('a \n\n\n b'), 'a\n\nb')
  assert.equal(normalizeReaderText('line one \n  indented'), 'line one\nindented')
  assert.equal(normalizeReaderText('\u00A0\u00A0\u00A0item\n'), '\u00A0\u00A0\u00A0item')
  assert.equal(normalizeReaderText('one\rtwo'), 'one\ntwo')
  assert.equal(normalizeReaderText(' \r\n\t'), '')
  const normalized = normalizeReaderText(ARTICLE)
  assert.ok(!/\n /.test(normalized) && !/ \n/.test(normalized) && !/ {2}/.test(normalized))
})

test('English pages fit every density, carry exact offsets and never start a line with an ASCII space', () => {
  const normalized = normalizeReaderText(ARTICLE)
  for (const lines of [7, 6, 5] as const) {
    const pages = paginate(ARTICLE, bodyBox(lines))
    assert.ok(pages.length > 5, 'The fixture must span many screens.')
    assert.equal(pages[0]!.start, 0)
    assert.equal(pages[pages.length - 1]!.end, normalized.length)
    pages.forEach((page, index) => {
      assert.equal(page.text, normalized.slice(page.start, page.end))
      assert.ok(page.start < page.end)
      assert.ok(!/^[ \n]|[ \n]$/.test(page.text), 'Pages never start or end with ASCII whitespace.')
      assert.ok(!/\n /.test(page.text), 'No ASCII space directly after a newline.')
      assertFits(page.text, lines)
      assert.ok(isReaderPage(page.text, lines))
      const next = pages[index + 1]
      if (next) {
        assert.ok(page.end <= next.start, 'Pages are ordered and do not overlap.')
        assert.match(normalized.slice(page.end, next.start), /^[ \n]*$/, 'Only boundary whitespace lies between pages.')
      }
    })
    assert.deepEqual(paginateText(ARTICLE, bodyBox(lines)), pages.map(page => page.text))
  }
  assert.deepEqual(paginate(ARTICLE), paginate(ARTICLE, bodyBox(7)))
})

test('NBSP list indentation survives a page boundary', () => {
  const item = '\u00A0\u00A0\u00A0\u2022 indented item with several words in it'
  const pages = paginate(Array.from({ length: 40 }, () => item).join('\n'), bodyBox(5))
  assert.ok(pages.length > 2)
  for (const page of pages) assert.ok(page.text.startsWith('\u00A0\u00A0\u00A0\u2022'), JSON.stringify(page.text.slice(0, 12)))
})

test('pageIndexForOffset round-trips and a density change keeps the offset on the shown text', () => {
  const pages7 = paginate(ARTICLE, bodyBox(7))
  const pages5 = paginate(ARTICLE, bodyBox(5))
  pages7.forEach((page, index) => {
    assert.equal(pageIndexForOffset(pages7, page.start), index)
    assert.equal(pageIndexForOffset(pages7, page.start + Math.floor((page.end - page.start) / 2)), index)
    assert.equal(pageIndexForOffset(pages7, page.end - 1), index)
    const target: TextPage = pages5[pageIndexForOffset(pages5, page.start)]!
    assert.ok(target.start <= page.start && page.start < target.end, 'The 5-line page must contain the 7-line page start.')
  })
  assert.ok(pages5.length > pages7.length)
  assert.equal(pageIndexForOffset(pages7, -5), 0)
  assert.equal(pageIndexForOffset(pages7, Number.NaN), 0)
  assert.equal(pageIndexForOffset(pages7, Number.MAX_SAFE_INTEGER), pages7.length - 1)
  assert.equal(pageIndexForOffset([], 10), 0)
})

test('CJK without spaces survives every page boundary and fits G2', () => {
  const text = '\u7E41\u9AD4\u4E2D\u6587\u95B1\u8B80\u6E2C\u8A66\u6C92\u6709\u7A7A\u683C\u4F46\u6BCF\u500B\u5B57\u90FD\u61C9\u8A72\u4FDD\u7559\u3002'.repeat(150)
  const pages = paginateText(text)
  assert.ok(pages.length > 10, 'The fixture must span many screens.')
  assert.equal(pages.join(''), text, 'Page boundaries must not lose or duplicate text.')
  for (const page of pages) {
    assert.ok(page.length > 0)
    assertFits(page)
  }
})

test('emoji clusters, long URLs and mixed paragraphs preserve their content', () => {
  const fixtures = [
    '\u5BB6\u5EAD\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}\u8207\u65D7\u5E5F\u{1F1ED}\u{1F1F0}\u518D\u52A0\u7D44\u5408e\u0301'.repeat(90),
    `https://example.invalid/${'uninterruptedsegment'.repeat(230)}?query=value`,
    'First\r\n\r\nSecond paragraph with punctuation and ordinary words.\n\u7B2C\u4E09\u6BB5\uFF1A\u7E41\u9AD4\u4E2D\u6587\u3002\n\n'.repeat(75),
  ]
  for (const text of fixtures) {
    const normalized = normalizeReaderText(text)
    const pages = paginate(text)
    assert.equal(pages.map(page => page.text).join('').replace(/\s/g, ''), normalized.replace(/\s/g, ''))
    for (const page of pages) {
      assert.equal(page.text, normalized.slice(page.start, page.end))
      assertFits(page.text)
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.text), 'A page may not end with half a surrogate pair.')
      assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text), 'A page may not start with half a surrogate pair.')
    }
  }
  const emojiText = fixtures[0]!
  const boundaries = new Set([0])
  let index = 0
  for (const unit of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emojiText)) {
    index += unit.segment.length
    boundaries.add(index)
  }
  const pages = paginate(emojiText)
  assert.ok(pages.length > 1)
  for (const page of pages) {
    assert.ok(boundaries.has(page.start) && boundaries.has(page.end), 'Grapheme clusters must not be split across pages.')
  }
})

test('invisible or combining text cannot bypass the bridge byte limit; bad input is handled', () => {
  const text = `A${'\u0301'.repeat(5000)}`
  const pages = paginateText(text)
  assert.equal(pages.join(''), text)
  assert.ok(pages.length > 1)
  for (const page of pages) assert.ok(bytes(page) <= MAX_PAGE_UTF8_BYTES)
  assert.deepEqual(paginateText(' \r\n\t'), [''])
  assert.deepEqual(paginate(''), [{ text: '', start: 0, end: 0 }])
  assert.throws(() => paginateText('text', { width: 0, height: READER_BODY_HEIGHT }), RangeError)
  assert.throws(() => paginate('text', { width: READER_BODY_WIDTH, height: Number.NaN }), RangeError)
  assert.throws(() => paginate('text', { width: READER_BODY_WIDTH, height: 20 }), RangeError)
})

test('isReaderPage checks the requested number of lines and the byte cap', () => {
  const six = 'a\nb\nc\nd\ne\nf'
  assert.equal(isReaderPage(six), true)
  assert.equal(isReaderPage(six, 7), true)
  assert.equal(isReaderPage(six, 6), true)
  assert.equal(isReaderPage(six, 5), false)
  assert.equal(isReaderPage(`${'a\n'.repeat(7)}a`), false)
  assert.equal(isReaderPage('\u0301'.repeat(901)), false)
})

test('truncateGlassesLabel fits one line, collapses ASCII whitespace and keeps leading NBSP', () => {
  const long = truncateGlassesLabel('\u9577\u6A19\u984C'.repeat(100))
  assert.ok(getTextWidth(long) <= READER_BODY_WIDTH)
  assert.ok(long.endsWith('...'))
  const english = truncateGlassesLabel(`${PARAGRAPH} ${PARAGRAPH}`)
  assert.ok(getTextWidth(english) <= READER_BODY_WIDTH)
  assert.equal(truncateGlassesLabel('  A \n\n B  '), 'A B')
  const meta = '\u00A0\u00A0\u00A0Pub name \u00B7 2d \u00B7 12 min \u00B7 Paid'
  assert.equal(truncateGlassesLabel(meta), meta)
  assert.equal(truncateGlassesLabel('> Short title'), '> Short title')
})

test('menuWindow returns the fixed screenful that contains the selection', () => {
  assert.deepEqual(menuWindow(0, 0, 4), { first: 0, last: -1 })
  assert.deepEqual(menuWindow(3, 0, 4), { first: 0, last: 2 })
  assert.deepEqual(menuWindow(10, 3, 4), { first: 0, last: 3 })
  assert.deepEqual(menuWindow(10, 4, 4), { first: 4, last: 7 })
  assert.deepEqual(menuWindow(10, 5, 4), { first: 4, last: 7 })
  assert.deepEqual(menuWindow(10, 9, 4), { first: 8, last: 9 })
  assert.deepEqual(menuWindow(10, 99, 4), { first: 8, last: 9 })
  assert.deepEqual(menuWindow(10, -3, 4), { first: 0, last: 3 })
  assert.deepEqual(menuWindow(7, 6, 3), { first: 6, last: 6 })
  assert.deepEqual(menuWindow(5, 2, 0), { first: 2, last: 2 })
})
