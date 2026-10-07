import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDLE_RE,
  HOST_RE,
  INVALID_REASONS,
  MAX_INPUT_CHARS,
  MAX_LINES,
  MAX_PASTE_CHARS,
  SHARE_TEXT_MAX_LINES,
  SKIPPED_PREVIEW_CHARS,
  SLUG_RE,
  normalizeHost,
  parseMany,
  parseSubstackInput,
  wwwAlternative,
  type ParsedInput,
} from '../../src/substack/urls'

const pub = (host: string): ParsedInput => ({ kind: 'publication', host })
const post = (host: string, slug: string): ParsedInput => ({ kind: 'post', host, slug })
const postId = (id: number): ParsedInput => ({ kind: 'postId', id })
const handle = (value: string): ParsedInput => ({ kind: 'handle', handle: value })
const search = (query: string): ParsedInput => ({ kind: 'search', query })
const invalid = (reason: string): ParsedInput => ({ kind: 'invalid', reason })
const skipped = (text: string, shown = text): ParsedInput => ({ kind: 'invalid', reason: `Skipped "${shown}". ${INVALID_REASONS.shareText}`, skipped: text })

function check(cases: [string, ParsedInput][]): void {
  for (const [input, expected] of cases) {
    assert.deepEqual(parseSubstackInput(input), expected, `input: ${JSON.stringify(input)}`)
  }
}

test('publication inputs (SPEC 3.6 table)', () => {
  check([
    ['astralcodexten.substack.com', pub('astralcodexten.substack.com')],
    ['https://foo.substack.com/', pub('foo.substack.com')],
    ['www.slowboring.com', pub('www.slowboring.com')],
    ['https://www.slowboring.com', pub('www.slowboring.com')],
    ['  https://www.slowboring.com/about  ', pub('www.slowboring.com')],
    ['HTTPS://Foo.Substack.com/archive?sort=new', pub('foo.substack.com')],
    ['http://foo.substack.com', pub('foo.substack.com')],
    ['foo.substack.com.', pub('foo.substack.com')],
    ['https://open.substack.com/pub/foo', pub('foo.substack.com')],
    ['b\u{fc}cher.de', pub('xn--bcher-kva.de')],
  ])
})

test('IDN top-level domains are accepted after punycoding (C6)', () => {
  const cyrillic = '\u{43f}\u{440}\u{438}\u{43c}\u{435}\u{440}.\u{440}\u{444}' // example.rf in Cyrillic
  check([
    [`https://${cyrillic}/p/post`, post('xn--e1afmkfd.xn--p1ai', 'post')],
    [cyrillic, pub('xn--e1afmkfd.xn--p1ai')],
    ['https://foo.xn--fiqs8s/', pub('foo.xn--fiqs8s')],
  ])
  assert.equal(normalizeHost(cyrillic), 'xn--e1afmkfd.xn--p1ai')
  assert.equal(wwwAlternative(cyrillic), 'www.xn--e1afmkfd.xn--p1ai')
  assert.equal(HOST_RE.test('foo.xn--p1ai'), true)
  assert.equal(HOST_RE.test(`foo.xn--${'a'.repeat(59)}`), true, 'a 63-character TLD label')
  for (const bad of ['foo.xn--', 'foo.xn---', 'foo.xn--p1ai-', 'foo.xn--p1_ai', `foo.xn--${'a'.repeat(60)}`, 'foo.x1', 'foo.1ai']) {
    assert.equal(HOST_RE.test(bad), false, `host: ${bad}`)
  }
})

test('post inputs, including open.substack.com and share text', () => {
  check([
    ['https://www.slowboring.com/p/my-slug?utm_source=x', post('www.slowboring.com', 'my-slug')],
    ['https://www.slowboring.com/p/my-slug/comments', post('www.slowboring.com', 'my-slug')],
    ['https://foo.substack.com/p/my-slug#footnote-1', post('foo.substack.com', 'my-slug')],
    ['https://foo.substack.com/p/my-slug/', post('foo.substack.com', 'my-slug')],
    ['foo.substack.com/p/my-slug', post('foo.substack.com', 'my-slug')],
    ['http://foo.substack.com/p/my-slug', post('foo.substack.com', 'my-slug')],
    ['https://open.substack.com/pub/foo/p/my-slug', post('foo.substack.com', 'my-slug')],
    ['https://open.substack.com/pub/Foo/p/my-slug?r=abc&utm_campaign=post&utm_medium=web', post('foo.substack.com', 'my-slug')],
    ['Check out this post! https://foo.substack.com/p/my-slug?r=2abc&utm_medium=ios.', post('foo.substack.com', 'my-slug')],
    ['(see https://www.slowboring.com/p/my-slug).', post('www.slowboring.com', 'my-slug')],
    ['\u{201c}A title\u{201d} \u{2014} https://foo.substack.com/p/my-slug', post('foo.substack.com', 'my-slug')],
    ['A title\nhttps://foo.substack.com/p/my-slug\n', post('foo.substack.com', 'my-slug')],
  ])
})

test('post id inputs', () => {
  check([
    ['https://substack.com/home/post/p-218912642', postId(218912642)],
    ['substack.com/@h/p-123', postId(123)],
    ['https://substack.com/@thezvi/p-218912642?utm_source=profile', postId(218912642)],
    ['substack.com/inbox/post/123', postId(123)],
    ['https://www.substack.com/home/post/p-5', postId(5)],
    ['https://substack.com/app-link/post?publication_id=1&post_id=77&token=abc', postId(77)],
  ])
})

test('post ids above the signed 32-bit range Substack accepts are rejected before any request (relay C3)', () => {
  check([
    ['https://substack.com/home/post/p-2147483647', postId(2147483647)],
    ['https://substack.com/home/post/p-2147483648', invalid(INVALID_REASONS.postId)],
    ['https://substack.com/home/post/p-99999999999', invalid(INVALID_REASONS.postId)],
    ['substack.com/inbox/post/4294967296', invalid(INVALID_REASONS.postId)],
  ])
})

test('handle inputs', () => {
  check([
    ['@thezvi', handle('thezvi')],
    ['https://substack.com/@thezvi', handle('thezvi')],
    ['substack.com/@thezvi/notes', handle('thezvi')],
    ['@thezvi.', handle('thezvi')],
    ['https://substack.com/@thezvi.', handle('thezvi')],
  ])
})

test('handles are lowercased: Substack profile lookups are case-sensitive (relay C1)', () => {
  check([
    ['@TheZvi', handle('thezvi')],
    ['https://substack.com/@TheZvi', handle('thezvi')],
    ['substack.com/@The.Zvi_1/notes', handle('the.zvi_1')],
  ])
  assert.deepEqual(parseMany('@TheZvi\n@thezvi'), [handle('thezvi')], 'case variants are one result')
})

test('substack.com without a post or handle asks for a publication link', () => {
  assert.equal(INVALID_REASONS.notPublication, 'Paste a publication link or an @handle')
  check([
    ['substack.com', invalid(INVALID_REASONS.notPublication)],
    ['https://substack.com/', invalid(INVALID_REASONS.notPublication)],
    ['substack.com/profile/123-x', invalid(INVALID_REASONS.notPublication)],
  ])
})

test('search inputs', () => {
  check([
    ['economics newsletter', search('economics newsletter')],
    ['  economics   newsletter  ', search('economics newsletter')],
    ['stratechery', search('stratechery')],
    ['Dr. Who fans', search('Dr. Who fans')],
    ['a', invalid(INVALID_REASONS.searchShort)],
    ['word '.repeat(30), invalid(INVALID_REASONS.searchLong)],
  ])
})

test('unsafe schemes, control characters and non-web links are rejected', () => {
  check([
    ['javascript:alert(1)', invalid(INVALID_REASONS.unsafe)],
    ['JavaScript:alert(1)', invalid(INVALID_REASONS.unsafe)],
    ['data:text/html,<b>x</b>', invalid(INVALID_REASONS.unsafe)],
    ['file:///etc/passwd', invalid(INVALID_REASONS.unsafe)],
    ['look javascript:alert(1)', invalid(INVALID_REASONS.unsafe)],
    ['foo\x00.substack.com', invalid(INVALID_REASONS.unsafe)],
    ['foo.substack.com\x07', invalid(INVALID_REASONS.unsafe)],
    ['ftp://foo.substack.com/', invalid(INVALID_REASONS.notHttp)],
    ['blob:https://foo.substack.com/x', invalid(INVALID_REASONS.unsafe)],
    ['(vbscript:msgbox)', invalid(INVALID_REASONS.unsafe)],
  ])
})

test('ordinary words before a colon are text, not unsafe schemes (C3)', () => {
  check([
    ['Big Data: why the hype died https://foo.substack.com/p/big-data', post('foo.substack.com', 'big-data')],
    ['data: privacy', search('data: privacy')],
    ['JavaScript: weekly', search('JavaScript: weekly')],
    ['Case file: the archive', search('Case file: the archive')],
  ])
})

test('IP literals, ports, userinfo and reserved names are rejected', () => {
  check([
    ['https://127.0.0.1/p/x', invalid(INVALID_REASONS.ip)],
    ['127.0.0.1', invalid(INVALID_REASONS.ip)],
    ['https://0x7f.1/', invalid(INVALID_REASONS.ip)],
    ['https://[::1]/', invalid(INVALID_REASONS.ip)],
    ['https://foo.substack.com:8443/', invalid(INVALID_REASONS.port)],
    ['https://foo.substack.com:443/', invalid(INVALID_REASONS.port)],
    ['https://user:pass@foo.substack.com/', invalid(INVALID_REASONS.userinfo)],
    ['https://foo.substack.com@evil.com/', invalid(INVALID_REASONS.userinfo)],
    ['https://foo.substack.com\\@evil.com/', invalid(INVALID_REASONS.userinfo)],
    ['https://localhost/', invalid(INVALID_REASONS.host)],
    ['localhost:3000', invalid(INVALID_REASONS.notPublication)],
    ['https://foo.local/', invalid(INVALID_REASONS.reserved)],
    ['foo.test', invalid(INVALID_REASONS.reserved)],
    ['foo.invalid', invalid(INVALID_REASONS.reserved)],
    ['foo.internal', invalid(INVALID_REASONS.reserved)],
    ['thing.example', invalid(INVALID_REASONS.reserved)],
    ['www.example.com', invalid(INVALID_REASONS.reserved)],
  ])
})

test('path tricks, bad slugs, bad ids and non-publication substack hosts are rejected', () => {
  check([
    ['https://foo.substack.com/p/../../admin', invalid(INVALID_REASONS.path)],
    ['https://foo.substack.com/p/%2e%2e/x', invalid(INVALID_REASONS.path)],
    ['https://foo.substack.com/p/a%2fb', invalid(INVALID_REASONS.slug)],
    ['https://foo.substack.com/p/bad.slug', invalid(INVALID_REASONS.slug)],
    ['a.b.substack.com', invalid(INVALID_REASONS.notSubstack)],
    ['https://email.mg1.substack.com/c/abc', invalid(INVALID_REASONS.notSubstack)],
    ['https://open.substack.com/pub/foo_bar/p/x', invalid(INVALID_REASONS.notSubstack)],
    ['https://substack.com/home/post/p-0123', invalid(INVALID_REASONS.postId)],
    ['https://substack.com/home/post/p-99999999999999999', invalid(INVALID_REASONS.postId)],
    ['@', invalid(INVALID_REASONS.handle)],
    ['@bad handle', invalid(INVALID_REASONS.handle)],
  ])
})

test('length cap, empty input and share text with several links', () => {
  const long = `https://foo.substack.com/p/${'a'.repeat(MAX_INPUT_CHARS)}`
  check([
    [long, invalid(INVALID_REASONS.tooLong)],
    ['', invalid(INVALID_REASONS.empty)],
    ['   ', invalid(INVALID_REASONS.empty)],
    ['https://a.substack.com/p/x and https://b.substack.com/p/y', invalid(INVALID_REASONS.manyLinks)],
  ])
})

test('normalizeHost lowercases, strips the trailing dot and punycodes', () => {
  assert.equal(normalizeHost('Foo.Substack.com.'), 'foo.substack.com')
  assert.equal(normalizeHost(' www.slowboring.com '), 'www.slowboring.com')
  assert.equal(normalizeHost('b\u{fc}cher.de'), 'xn--bcher-kva.de')
  for (const bad of ['', 'https://foo.com', 'foo.com/p', 'foo.com:80', 'user@foo.com', '1.2.3.4', '[::1]',
    'localhost', 'foo.local', 'foo.test', 'foo.invalid', 'foo.example', 'example.com', 'foo%2ecom', 'foo..com', '-foo.com', 'foo com']) {
    assert.equal(normalizeHost(bad), null, `host: ${JSON.stringify(bad)}`)
  }
})

test('wwwAlternative offers www. for bare custom domains only', () => {
  assert.equal(wwwAlternative('slowboring.com'), 'www.slowboring.com')
  assert.equal(wwwAlternative('Slowboring.com.'), 'www.slowboring.com')
  assert.equal(wwwAlternative('www.slowboring.com'), null)
  assert.equal(wwwAlternative('foo.substack.com'), null)
  assert.equal(wwwAlternative('substack.com'), null)
  assert.equal(wwwAlternative('localhost'), null)
  assert.equal(wwwAlternative(''), null)
})

test('exported patterns', () => {
  assert.equal(HOST_RE.test('foo.substack.com'), true)
  assert.equal(HOST_RE.test('foo'), false)
  assert.equal(SLUG_RE.test('my-slug_2'), true)
  assert.equal(SLUG_RE.test('-slug'), false)
  assert.equal(HANDLE_RE.test('the.zvi_1'), true)
  assert.equal(HANDLE_RE.test('the zvi'), false)
})

test('parseMany: one result per line, duplicates removed', () => {
  // Five lines, a list: the title directly above its link is still share text (K3).
  assert.deepEqual(parseMany('Great read\nhttps://foo.substack.com/p/my-slug\n\n@thezvi\r\nwww.slowboring.com\nWWW.slowboring.com'), [
    skipped('Great read'),
    post('foo.substack.com', 'my-slug'),
    handle('thezvi'),
    pub('www.slowboring.com'),
  ])
  assert.deepEqual(parseMany('economics\n@thezvi\nsubstack.com'), [
    search('economics'),
    handle('thezvi'),
    invalid(INVALID_REASONS.notPublication),
  ])
  assert.deepEqual(parseMany('javascript:x\njavascript:y'), [invalid(INVALID_REASONS.unsafe), invalid(INVALID_REASONS.unsafe)])
  assert.deepEqual(parseMany('a.substack.com\u{2028}b.substack.com'), [pub('a.substack.com'), pub('b.substack.com')])
  assert.deepEqual(parseMany(''), [])
  assert.deepEqual(parseMany('  \n \n'), [])
})

test('parseMany: text next to a single link is share text, shown as skipped (C4, P9)', () => {
  assert.equal(SHARE_TEXT_MAX_LINES, 3)
  assert.equal(SKIPPED_PREVIEW_CHARS, 40)
  // A title over its link: one result per line, the title is reported, not searched.
  assert.deepEqual(parseMany('Great read\nhttps://foo.substack.com/p/my-slug'), [
    skipped('Great read'),
    post('foo.substack.com', 'my-slug'),
  ])
  // A link and a name: the name is not dropped silently.
  assert.deepEqual(parseMany('https://astralcodexten.substack.com\nMatt Yglesias'), [
    pub('astralcodexten.substack.com'),
    skipped('Matt Yglesias'),
  ])
  // A long blurb and a one-character line: no "too long" / "too short" errors, the blurb is clipped.
  const blurb = `${'word '.repeat(24)}end`
  assert.deepEqual(parseMany(`${blurb}\n!\nhttps://www.slowboring.com/p/an-ai-legislator`), [
    skipped(blurb, 'word word word word word word word word\u{2026}'),
    skipped('!'),
    post('www.slowboring.com', 'an-ai-legislator'),
  ])
  // Words with a colon are not unsafe schemes (C3); whitespace and controls collapse; repeats once.
  assert.deepEqual(parseMany('Data: a primer\nhttps://foo.substack.com/p/big-data\ndata:  A\tPRIMER'), [
    skipped('Data: a primer'),
    post('foo.substack.com', 'big-data'),
  ])
  // Bare domains and @handles next to the link still count.
  assert.deepEqual(parseMany('https://foo.substack.com/p/my-slug\nwww.slowboring.com\n@thezvi'), [
    post('foo.substack.com', 'my-slug'),
    pub('www.slowboring.com'),
    handle('thezvi'),
  ])
  // Single-line share text needs no skipping.
  assert.deepEqual(parseMany('Big Data: why the hype died https://foo.substack.com/p/big-data'), [post('foo.substack.com', 'big-data')])
})

test('parseMany: lists with several links or more lines search the plain-text lines below the last link (P9)', () => {
  assert.deepEqual(parseMany('https://a.substack.com\nhttps://b.substack.com\nMatt Yglesias'), [
    pub('a.substack.com'),
    pub('b.substack.com'),
    search('Matt Yglesias'),
  ])
  assert.deepEqual(parseMany('https://a.substack.com\nMatt Yglesias\nNoah Smith\nx'), [
    pub('a.substack.com'),
    search('Matt Yglesias'),
    search('Noah Smith'),
    invalid(INVALID_REASONS.searchShort),
  ])
  // A handle or domain between a name and the links: the name is not a title over a link.
  assert.deepEqual(parseMany('Matt Yglesias\n@thezvi\nhttps://a.substack.com\nhttps://b.substack.com'), [
    search('Matt Yglesias'),
    handle('thezvi'),
    pub('a.substack.com'),
    pub('b.substack.com'),
  ])
})

test('parseMany: share text in longer pastes is skipped, never searched or reported as too long (K3)', () => {
  // Two share texts copied together: each title sits directly above its link.
  assert.deepEqual(parseMany('Why prices rose\nhttps://foo.substack.com/p/prices\n\nThe case for more housing\nhttps://bar.substack.com/p/housing'), [
    skipped('Why prices rose'),
    post('foo.substack.com', 'prices'),
    skipped('The case for more housing'),
    post('bar.substack.com', 'housing'),
  ])
  // A four-line share text: title, a 123-character blurb and an author line over the link.
  const blurb = `${'word '.repeat(24)}end`
  const preview = 'word word word word word word word word\u{2026}'
  assert.deepEqual(parseMany(`Why prices rose\n${blurb}\nBy Writer\nhttps://foo.substack.com/p/prices`), [
    skipped('Why prices rose'),
    skipped(blurb, preview),
    skipped('By Writer'),
    post('foo.substack.com', 'prices'),
  ])
  // Below the last link a blurb is still too long to be a search: skipped, not a "too long" error.
  assert.deepEqual(parseMany(`https://a.substack.com\nhttps://b.substack.com\n${blurb}`), [
    pub('a.substack.com'),
    pub('b.substack.com'),
    skipped(blurb, preview),
  ])
  // Without any link the same line is a search that is too long.
  assert.deepEqual(parseMany(`${blurb}\nMatt Yglesias`), [invalid(INVALID_REASONS.searchLong), search('Matt Yglesias')])
})

test('parseMany caps the number of results and the paste size', () => {
  const lines = Array.from({ length: 60 }, (_, index) => `pub${index}.substack.com`).join('\n')
  const results = parseMany(lines)
  assert.equal(results.length, MAX_LINES)
  assert.deepEqual(results[0], pub('pub0.substack.com'))
  assert.deepEqual(results[MAX_LINES - 1], pub(`pub${MAX_LINES - 1}.substack.com`))
  assert.deepEqual(parseMany('x'.repeat(MAX_PASTE_CHARS + 1)), [invalid(INVALID_REASONS.tooLong)])
})
