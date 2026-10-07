/**
 * html.ts in Chromium (DOMParser). Run by scripts/browser-ci.mjs with every
 * network route aborted: any image/iframe/script load attempt fails the run,
 * which proves the parsed documents are inert.
 */
import { getAdvW } from '@evenrealities/pretext'
import { assert, assertEqual, test } from './harness'
import {
  CONVERTER_VERSION,
  htmlToReaderText,
  latexToText,
  normalizeChars,
  type HtmlToReaderTextOptions,
  type ReaderTextResult,
} from '../../src/substack/html'
import { MAX_PAGE_UTF8_BYTES, bodyBox, isReaderPage, normalizeReaderText, paginate } from '../../src/pagination'
import html01 from '../fixtures/html/01-essay-footnotes.html'
import expected01 from '../fixtures/html/01-essay-footnotes.expected.txt'
import html02 from '../fixtures/html/02-images-embeds.html'
import expected02 from '../fixtures/html/02-images-embeds.expected.txt'
import html03 from '../fixtures/html/03-lists-code-math.html'
import expected03 from '../fixtures/html/03-lists-code-math.expected.txt'
import html04 from '../fixtures/html/04-paywalled-preview.html'
import expected04 from '../fixtures/html/04-paywalled-preview.expected.txt'
import html05 from '../fixtures/html/05-glyphs-mentions.html'
import expected05 from '../fixtures/html/05-glyphs-mentions.expected.txt'
import html06 from '../fixtures/html/06-podcast-transcript.html'
import expected06 from '../fixtures/html/06-podcast-transcript.expected.txt'
import html07 from '../fixtures/html/07-nested-lists.html'
import expected07 from '../fixtures/html/07-nested-lists.expected.txt'
import html08 from '../fixtures/html/08-tweets-quoted.html'
import expected08 from '../fixtures/html/08-tweets-quoted.expected.txt'
import html09 from '../fixtures/html/09-gallery-chart-poll.html'
import expected09 from '../fixtures/html/09-gallery-chart-poll.expected.txt'
import html10 from '../fixtures/html/10-chrome-vanishes.html'
import expected10 from '../fixtures/html/10-chrome-vanishes.expected.txt'
import html11 from '../fixtures/html/11-rss-read-more.html'
import expected11 from '../fixtures/html/11-rss-read-more.expected.txt'

const N = '\u00A0'
const PREVIEW_NOTE = '[Preview ends here. The rest of this post is for paid subscribers.]'
const PAID_ONLY_NOTE = '[This post is for paid subscribers.]'
const LEAKS = ['Subscribe now', 'Read more', 'Share', 'Type your email']

/** Production coverage test (src/substack/article.ts uses the same rule). */
const isCovered = (cp: number): boolean => getAdvW(cp) > 0

/** Expected files are LF with one trailing newline. */
const expectedText = (raw: string): string => raw.replace(/\r\n/g, '\n').replace(/\n$/, '')

/** Options from the fixture's first line: <!-- reader-options: {...} --> */
function readerOptions(html: string): HtmlToReaderTextOptions {
  const match = /^<!-- reader-options: (\{.*?\}) -->/.exec(html)
  assert(match, 'fixture must start with <!-- reader-options: {...} -->')
  const parsed: unknown = JSON.parse(match[1] ?? '{}')
  assert(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), 'reader-options must be a JSON object')
  return parsed as HtmlToReaderTextOptions
}

function convert(html: string, extra: HtmlToReaderTextOptions = {}): ReaderTextResult {
  return htmlToReaderText(html, { ...readerOptions(html), isCovered, ...extra })
}

const FIXTURES: { name: string; html: string; expected: string }[] = [
  { name: '01-essay-footnotes', html: html01, expected: expectedText(expected01) },
  { name: '02-images-embeds', html: html02, expected: expectedText(expected02) },
  { name: '03-lists-code-math', html: html03, expected: expectedText(expected03) },
  { name: '04-paywalled-preview', html: html04, expected: expectedText(expected04) },
  { name: '05-glyphs-mentions', html: html05, expected: expectedText(expected05) },
  { name: '06-podcast-transcript', html: html06, expected: expectedText(expected06) },
  { name: '07-nested-lists', html: html07, expected: expectedText(expected07) },
  { name: '08-tweets-quoted', html: html08, expected: expectedText(expected08) },
  { name: '09-gallery-chart-poll', html: html09, expected: expectedText(expected09) },
  { name: '10-chrome-vanishes', html: html10, expected: expectedText(expected10) },
  { name: '11-rss-read-more', html: html11, expected: expectedText(expected11) },
]
const fixture = (name: string): { html: string; expected: string } => {
  const found = FIXTURES.find(f => f.name === name)
  assert(found, `missing fixture ${name}`)
  return found
}

const bytes = (s: string): number => new TextEncoder().encode(s).byteLength

/** Output invariants: no chrome leaks, C7 spacing, pagination fixed point, every page fits. */
function checkOutput(label: string, text: string): void {
  for (const leak of LEAKS) assert(!text.includes(leak), `${label}: output leaks ${JSON.stringify(leak)}`)
  assert(!/\n /.test(text), `${label}: an ASCII space follows a newline`)
  assert(!/ \n/.test(text), `${label}: a line ends with an ASCII space`)
  assert(!/ {2}/.test(text), `${label}: a run of ASCII spaces`)
  assert(!/\n{3}/.test(text), `${label}: more than one blank line`)
  assert(!/^\s|\s$/.test(text), `${label}: leading or trailing whitespace`)
  assert(!/\t|\r|[\u0000-\u0008\u000B-\u001F\u007F]/.test(text), `${label}: control characters`)
  assertEqual(normalizeReaderText(text), text, `${label}: output must already be normalized for pagination`)
  for (const lines of [7, 6, 5] as const) {
    const pages = paginate(text, bodyBox(lines))
    assert(pages.length > 0, `${label}: no pages`)
    for (const [index, page] of pages.entries()) {
      assert(isReaderPage(page.text, lines), `${label}: page ${index + 1} overflows ${lines} lines: ${JSON.stringify(page.text.slice(0, 80))}`)
      assert(bytes(page.text) <= MAX_PAGE_UTF8_BYTES, `${label}: page ${index + 1} exceeds the byte cap`)
      assert(!/\n /.test(page.text), `${label}: page ${index + 1} has a space after a newline`)
    }
    // Pagination drops only boundary whitespace: no visible character is lost.
    assertEqual(pages.map(p => p.text).join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), `${label}: pages lose text at ${lines} lines`)
  }
}

test('CONVERTER_VERSION is 2', () => {
  assertEqual(CONVERTER_VERSION, 2) // 2: "Read more" only as the RSS tail, currency codes, ballot boxes
})

for (const { name, html, expected } of FIXTURES) {
  test(`fixture ${name} converts exactly and pages cleanly`, () => {
    const result = convert(html)
    assertEqual(result.text, expected, name)
    checkOutput(name, result.text)
  })
}

test('fixture flags: paywall, footnotes and word counts', () => {
  const r01 = convert(fixture('01-essay-footnotes').html)
  assertEqual(r01.paywalled, false)
  assertEqual(r01.footnotes, [
    { label: '1', text: 'Except on public holidays.' },
    { label: '2', text: 'The notebook is blue.\nIt is also water-stained.' },
  ])
  assertEqual(r01.body, r01.text.slice(0, r01.text.indexOf('\n\nNOTES\n\n')))

  const r04 = convert(fixture('04-paywalled-preview').html)
  assertEqual(r04.paywalled, true)
  assertEqual(r04.footnotes, [], 'a dangling anchor and an orphan note behind the paywall are dropped')
  assertEqual(r04.wordCount, 14)
  assertEqual(r04.body, r04.text)

  const r10 = convert(fixture('10-chrome-vanishes').html)
  assertEqual(r10.paywalled, false)

  const r11 = convert(fixture('11-rss-read-more').html)
  assertEqual(r11.paywalled, true, 'the RSS "Read more" tail is a cut marker even without an audience')
  assertEqual(r11.footnotes, [])
  assertEqual(r11.wordCount, 14)
})

test('footnoteMode inline puts each note after its paragraph', () => {
  const { html } = fixture('01-essay-footnotes')
  const result = convert(html, { footnoteMode: 'inline' })
  assertEqual(result.text, [
    'Every town has a bakery that opens before dawn, and ours is no exception.[1] The owner, a former bridge engineer, says the ovens are "just very hot bridges."',
    '',
    '[1] Except on public holidays.',
    '',
    'This post looks at three questions & one answer.',
    '',
    'I. THE OVENS',
    '',
    'She keeps a notebook of every batch since 2009.[2]',
    '',
    '[2] The notebook is blue.',
    'It is also water-stained.',
    '',
    '> Flour is patient. People are not.',
    '>',
    '> That is the whole business.',
    '',
    'Customers line up anyway.',
    '',
    '* * *',
    '',
    'A very long secondary heading that should not be upper-cased because it is long',
    '',
    'The end.',
  ].join('\n'))
  assertEqual(result.footnotes.length, 2)
  checkOutput('01 inline', result.text)
})

test('footnoteMode omit drops markers and the NOTES section', () => {
  const { html, expected } = fixture('01-essay-footnotes')
  const result = convert(html, { footnoteMode: 'omit' })
  assertEqual(result.text, expected.slice(0, expected.indexOf('\n\nNOTES')).replace('[1]', '').replace('[2]', ''))
  assertEqual(result.footnotes.map(f => f.label), ['1', '2'], 'notes stay available for an on-demand view')
  checkOutput('01 omit', result.text)
})

test('bareImages drop removes caption-less images only', () => {
  const { html, expected } = fixture('02-images-embeds')
  assert(expected.includes('[2 images]\n\n'))
  const result = convert(html, { bareImages: 'drop' })
  assertEqual(result.text, expected.replace('[2 images]\n\n', ''))
  checkOutput('02 drop', result.text)
})

test('maxCodeLines truncates long code blocks', () => {
  const { html, expected } = fixture('03-lists-code-math')
  const full = ['[Code: python]', 'def bake(t):', `${N.repeat(4)}if t > 250:`, `${N.repeat(8)}return 'burnt'`, `${N.repeat(4)}return "ok"`].join('\n')
  const cut = ['[Code: python]', 'def bake(t):', `${N.repeat(4)}if t > 250:`, '[\u2026 2 more lines]'].join('\n')
  assert(expected.includes(full))
  const result = convert(html, { maxCodeLines: 2 })
  assertEqual(result.text, expected.replace(full, cut))
  checkOutput('03 maxCodeLines', result.text)
})

test('without isCovered only the static glyph table applies', () => {
  const { html } = fixture('05-glyphs-mentions')
  const result = htmlToReaderText(html, readerOptions(html))
  assertEqual(result.text, [
    'GLYPH CHECK',
    '',
    'Non breaking, zerowidth, softhyphen, \u201Csmart\u201D \u2018quotes\u2019 \u2014 dashes \u2013 and\u2026ellipsis.',
    '',
    'Non-breaking hyphen, figure-dash, micro 5\u03BCm, \uFB01ne ligature, check \u221A done, \u203A pointer.',
    '',
    'Emoji: \u{1F600} ok, \u2764 ok, \u{1F44D} toned, \u{1F680} rocket, flag, \u{1F468}\u{1F469}\u{1F467} family. Legend: (red) GOP, (blue) Dem.',
    '',
    'Scripts: Caf\u00E9, \u0108u, \u0395\u03BB\u03BB\u03AC\u03B4\u03B1, \u041C\u043E\u0441\u043A\u0432\u0430, \u6771\u4EAC, \u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD, done.',
    '',
    'Thanks to Jane Example for the tip.',
    '',
    'UPDATE',
    '',
    'Prices changed.',
    '',
    '> Bake early, bake often.',
  ].join('\n'))
})

test('stripEmoji deletes pictographs but keeps colour words', () => {
  const { html, expected } = fixture('05-glyphs-mentions')
  const line = 'Emoji: \u{1F600} ok, \u2764 ok, \u{1F44D} toned, rocket, flag, family. Legend: (red) GOP, (blue) Dem.'
  assert(expected.includes(line))
  const result = convert(html, { stripEmoji: true })
  assertEqual(result.text, expected.replace(line, 'Emoji: ok, ok, toned, rocket, flag, family. Legend: (red) GOP, (blue) Dem.'))
  checkOutput('05 stripEmoji', result.text)
})

test('uppercaseHeadingMax 0 keeps heading case', () => {
  const { html, expected } = fixture('06-podcast-transcript')
  const result = convert(html, { uppercaseHeadingMax: 0 })
  assertEqual(result.text, expected
    .replace('TIMESTAMPS', 'Timestamps')
    .replace('TRANSCRIPT', 'Transcript')
    .replace('00:00:00 \u2013 INTRO', '00:00:00 \u2013 Intro'))
})

test('the RSS "Read more" tail ends a body that may be gated and marks it paywalled', () => {
  const tail = '<p>Preview text.</p>\n  <p>\n    <a href="https://x.substack.com/p/y">\n      Read more\n    </a>\n  </p>\n  <!-- end -->\n'
  for (const opts of [{}, { audience: null }, { audience: 'only_paid' }] as HtmlToReaderTextOptions[]) {
    const result = htmlToReaderText(tail, opts)
    assertEqual(result.text, `Preview text.\n\n${PREVIEW_NOTE}`, JSON.stringify(opts))
    assertEqual(result.paywalled, true)
    assertEqual(result.wordCount, 2)
    checkOutput('rss tail', result.text)
  }
  const free = htmlToReaderText(tail, { audience: 'everyone' })
  assertEqual(free.text, 'Preview text.\n\nRead more', 'a known free post keeps its trailing link as text')
  assertEqual(free.paywalled, false)
})

test('a "Read more" link inside the body is content, never a cut (C1)', () => {
  const roundup = '<p>Summary of story A.</p><p><a href="https://nytimes.com/a">Read more</a></p><h3>Story B</h3><p>C.</p>'
  for (const opts of [{ audience: 'everyone' }, {}] as HtmlToReaderTextOptions[]) {
    const result = htmlToReaderText(roundup, opts)
    assertEqual(result.text, 'Summary of story A.\n\nRead more\n\nSTORY B\n\nC.', JSON.stringify(opts))
    assertEqual(result.paywalled, false)
  }
  const list = htmlToReaderText('<ul><li><p>One.</p><p><a href="https://nytimes.com/a">Read more</a></p></li><li><p>Two.</p></li></ul><p>After.</p>', {})
  assertEqual(list.text, `\u2022 One.\n${N.repeat(3)}Read more\n\u2022 Two.\n\nAfter.`)
  assertEqual(list.paywalled, false)
  const nested = htmlToReaderText('<p>Intro.</p><blockquote><p><a href="https://x.substack.com/p/y">Read more</a></p></blockquote>', {})
  assertEqual(nested.text, 'Intro.\n\n> Read more', 'only a top-level last paragraph is the tail')
  assertEqual(nested.paywalled, false)
  const mixed = htmlToReaderText('<p>Text.</p><p><a href="https://x.substack.com/p/y">Read more</a> about it</p>', {})
  assertEqual(mixed.text, 'Text.\n\nRead more about it')
  assertEqual(mixed.paywalled, false)
})

test('gating follows the audience (C11) and empty bodies', () => {
  const none = htmlToReaderText(null, { audience: 'only_paid' })
  assertEqual(none, { text: PAID_ONLY_NOTE, body: PAID_ONLY_NOTE, footnotes: [], wordCount: 0, paywalled: true })

  const founding = htmlToReaderText('<p>Hello there.</p>', { audience: 'founding' })
  assertEqual(founding.text, `Hello there.\n\n${PREVIEW_NOTE}`)
  assertEqual(founding.paywalled, true)
  assertEqual(founding.wordCount, 2)

  const future = htmlToReaderText('<p>Hello there.</p>', { audience: 'some_new_tier' })
  assertEqual(future.paywalled, true)

  const free = htmlToReaderText('<p>Hello there.</p>', { audience: 'everyone' })
  assertEqual(free.text, 'Hello there.')
  assertEqual(free.paywalled, false)

  const unknown = htmlToReaderText('<p>Hello there.</p>', {})
  assertEqual(unknown.paywalled, false, 'an unknown audience (RSS) is not gated by itself')

  const emptyButLong = htmlToReaderText('', { audience: 'everyone', expectedWordCount: 500 })
  assertEqual(emptyButLong.text, PAID_ONLY_NOTE)
  assertEqual(emptyButLong.paywalled, true)

  const empty = htmlToReaderText(undefined, { audience: 'everyone', expectedWordCount: 0 })
  assertEqual(empty, { text: '', body: '', footnotes: [], wordCount: 0, paywalled: false })
})

test('parsing is inert and never touches the live document (C9)', async () => {
  const before = document.documentElement.outerHTML
  const flags = window as unknown as Record<string, unknown>
  const result = htmlToReaderText(
    '<img src="https://inert.invalid/a.png" onerror="window.__htmlPwned = 1">'
      + '<script>window.__htmlPwned = 2</script>'
      + '<iframe src="https://inert.invalid/frame"></iframe>'
      + '<p onclick="window.__htmlPwned = 3">Safe text.</p>',
    {},
  )
  assertEqual(result.text, '[Image]\n\n[Embedded content]\n\nSafe text.')
  await new Promise(resolve => setTimeout(resolve, 100))
  assertEqual(flags.__htmlPwned, undefined)
  assertEqual(document.documentElement.outerHTML, before)
})

test('code blocks keep indentation and alignment with NBSP (C7)', () => {
  const result = htmlToReaderText('<pre><code>\n\nx = 1    # one\n\ty = 2\n</code></pre>', {})
  assertEqual(result.text, `[Code]\nx = 1${N.repeat(3)} # one\n${N.repeat(2)}y = 2`)
  checkOutput('code alignment', result.text)
})

test('lists honour start, nesting and quotes', () => {
  const result = htmlToReaderText('<ol start="-1"><li>a</li><li>b</li></ol><li>orphan</li>', {})
  assertEqual(result.text, '-1. a\n0. b\n\n\u2022 orphan')
})

test('normalizeChars applies the glyph table in order', () => {
  assertEqual(normalizeChars('a\u00ADb\u200Bc\uFE0Fd\u2060e'), 'abcde')
  assertEqual(normalizeChars('a\u2009b\u00A0c\u3000d\u2028e'), 'a b c d e')
  assertEqual(normalizeChars('\u2011\u2012`\u00B5\u2713\u2717\u25E6'), "--'\u03BC\u221A\u00D7\u2022")
  assertEqual(normalizeChars('\u{1F534} up, \u{1F7E2} down, \u26A0\uFE0F careful'), '(red) up, (green) down, (!) careful')
  assertEqual(normalizeChars('a\u0000b\u0007c\u0085d'), 'abc d')
  assertEqual(normalizeChars('e\u0301'), '\u00E9', 'NFC first')
})

test('normalizeChars coverage fallback: decompose, drop, or mark runs', () => {
  const ascii = (cp: number): boolean => cp < 0x80
  assertEqual(normalizeChars('\uFB01ne caf\u00E9', ascii), 'fine cafe')
  assertEqual(normalizeChars('x \u05E9\u05DC \u05D5 y', ascii), 'x [?] y')
  assertEqual(normalizeChars('go\u{1F680}!', ascii), 'go!')
  assertEqual(normalizeChars('a\u0336b', ascii), 'ab', 'a stray combining mark vanishes')
  assertEqual(normalizeChars('\u2014', isCovered), '\u2014')
})

test('normalizeChars spells out currency signs and ballot boxes the fonts lack (C5)', () => {
  const signs: [string, string][] = [
    ['\u20B9', 'INR'], ['\u20BD', 'RUB'], ['\u20BA', 'TRY'], ['\u20B4', 'UAH'], ['\u20A6', 'NGN'], ['\u20B1', 'PHP'],
    ['\u20AB', 'VND'], ['\u20B8', 'KZT'], ['\u20AA', 'ILS'], ['\u20BC', 'AZN'], ['\u20BE', 'GEL'], ['\u20A1', 'CRC'],
    ['\u20B2', 'PYG'], ['\u20B5', 'GHS'], ['\u20AD', 'LAK'], ['\u20AE', 'MNT'],
  ]
  for (const [sign, code] of signs) {
    assertEqual(getAdvW(sign.codePointAt(0) ?? 0), 0, `${code}: the sign is missing from the fonts`)
    assertEqual(normalizeChars(`${sign}5`, isCovered), `${code} 5`)
  }
  assertEqual(normalizeChars('costs \u20B9500, \u20BD 90 or 200\u20B4.', isCovered), 'costs INR 500, RUB 90 or 200 UAH.')
  assertEqual(normalizeChars('\u20B9500'), 'INR 500', 'part of the static table')
  assertEqual(normalizeChars('\u20AC5 \u20A95 $5', isCovered), '\u20AC5 \u20A95 $5', 'covered signs stay')
  for (const box of ['\u2610', '\u2611', '\u2612', '\u2666', '\u27A4']) assertEqual(getAdvW(box.codePointAt(0) ?? 0), 0)
  assertEqual(normalizeChars('\u2610 Buy flour / \u2612 Proof dough / \u2611 Bake', isCovered), '[ ] Buy flour / [x] Proof dough / [\u221A] Bake')
  assertEqual(normalizeChars('4\u2666 \u27A4 next', isCovered), '4\u25C6 \u2192 next')
  const article = htmlToReaderText('<ul><li>\u2610 Buy flour</li><li>\u2612 Proof dough</li></ul><p>Rent: \u20B912,000.</p>', { isCovered })
  assertEqual(article.text, '\u2022 [ ] Buy flour\n\u2022 [x] Proof dough\n\nRent: INR 12,000.')
  checkOutput('C5 glyphs', article.text)
})

test('normalizeChars stripEmoji keeps typographic symbols', () => {
  assertEqual(normalizeChars('ok \u{1F600}\u2764\uFE0F \u00A9 2026\u2122', undefined, true), 'ok  \u00A9 2026\u2122')
  assertEqual(normalizeChars('\u{1F534} GOP', undefined, true), '(red) GOP')
})

test('latexToText renders common expressions', () => {
  assertEqual(
    latexToText('lr(N, D/N) = lr_0 \u00B7 (N/N_0)^a \\cdot \\left( \\frac{D/N}{(D/N)_0} \\right)^b'),
    'lr(N, D/N) = lr\u2080 \u00B7 (N/N\u2080)^a \u00B7 ((D/N)/((D/N)\u2080))^b',
  )
  assertEqual(latexToText('R = c - (q - c)^2,'), 'R = c - (q - c)\u00B2,')
  assertEqual(latexToText('R(e) = R_{\\text{task}} - \\lambda(e)N_{\\text{tokens}} '), 'R(e) = R_task - \u03BB(e)N_tokens')
  assertEqual(latexToText('\\sqrt{x^2 + y^2} \\cdot \\pi'), '\u221A(x\u00B2 + y\u00B2) \u00B7 \u03C0')
  assertEqual(latexToText('T_{\\text{final}} = T_0 \\cdot e^{-kt} + \\frac{a}{b}'), 'T_final = T\u2080 \u00B7 e^(-kt) + (a)/(b)')
})

test('latexToText: alignment & becomes a space, escaped \\& stays (C2: no lookbehind)', () => {
  assertEqual(latexToText('\\begin{cases} 1 & x > 0 \\\\ 0 & \\text{R\\&D} \\end{cases}'), '1 x > 0 ; 0 R&D')
  assertEqual(latexToText('a&&b \\&& c'), 'a b & c')
  assertEqual(latexToText('\\\\&x'), '; x', 'a line break before & is not an escape')
})
