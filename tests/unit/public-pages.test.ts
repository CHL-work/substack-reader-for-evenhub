import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePublicPost, parseSitemapSlugs } from '../../worker/public-pages'

const HOST = 'synthetic.substack.com'
const ROOT = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
const post = { id: 123, slug: 'older-post', publication_id: 42, post_date: '2025-01-02T00:00:00Z', audience: 'only_paid', hidden: true, body_html: '<p>Synthetic public preview.</p>' }
const pub = { id: 42, subdomain: 'synthetic', name: 'Synthetic publication' }
const assignment = (value: unknown): string => `window._preloads        = JSON.parse(${JSON.stringify(JSON.stringify(value))})`
const page = (value: unknown): string => `<html><script nonce="synthetic">${assignment(value)}</script></html>`
const loc = (value: string): string => `<url><loc>${value}</loc></url>`
const sitemap = (...values: string[]): string => `${ROOT}${values.map(loc).join('')}</urlset>`

test('public post reads the exact public JSON and preserves paid-preview metadata', () => {
  assert.deepEqual(parsePublicPost(page({ post, pub, unrelated: 'discarded' }), post.slug), { post, pub })
  assert.deepEqual(parsePublicPost(`<SCRIPT nonce='a > b'> \n${assignment({ post, pub })};\n</SCRIPT>`, post.slug), { post, pub })
  const escaped = { ...post, body_html: '<p>Quotes " and backslash \\ and \u96fb.</p>' }
  assert.equal(parsePublicPost(page({ post: escaped, pub }), post.slug).post.body_html, escaped.body_html)
  const unicode = { ...post, title: '\u0130stanbul \u96fb\u5b50', body_html: '<p>\u0130 and \u96fb.</p>' }
  assert.deepEqual(parsePublicPost(`<p>\u0130 outside scripts</p>${page({ post: unicode, pub })}`, post.slug), { post: unicode, pub })
})

test('public post ignores markers in article text, comments, raw text and external scripts', () => {
  const fake = assignment({ post: { ...post, slug: 'wrong' }, pub })
  const prefixes = [
    `<p>${fake}</p>`, `<!-- <script>${fake}</script> -->`,
    `<textarea><script>${fake}</script></textarea>`, `<style><script>${fake}</script></style>`,
    `<script src="https://synthetic.invalid/file.js">${fake}</script>`,
    `<script type="application/json">${fake}</script>`,
  ]
  for (const prefix of prefixes) assert.deepEqual(parsePublicPost(prefix + page({ post, pub }), post.slug), { post, pub })
})

test('public post rejects mismatched identity, ambiguous scripts and malformed JSON without execution', () => {
  for (const value of [null, [], { post }, { pub }, { post: { ...post, slug: 'other' }, pub }, { post, pub: { ...pub, id: 43 } }]) {
    assert.throws(() => parsePublicPost(page(value), post.slug))
  }
  const scripts = [
    `${assignment({ post, pub })}; globalThis.publicPageExecuted = true`,
    'window._preloads = JSON.parse(globalThis.publicPageExecuted = true)',
    'window._preloads = JSON.parse("not JSON")',
    'window._preloads = JSON.parse("unterminated)',
    'window._preloads = JSON.parse("{}" + "{}")',
  ]
  for (const script of scripts) assert.throws(() => parsePublicPost(`<script>${script}</script>`, post.slug))
  assert.equal((globalThis as Record<string, unknown>).publicPageExecuted, undefined)
  assert.throws(() => parsePublicPost(page({ post, pub }) + page({ post, pub }), post.slug))
  assert.throws(() => parsePublicPost(page({ post, pub }), '../older-post'))
  assert.throws(() => parsePublicPost(' '.repeat(4 * 1024 * 1024 + 1), post.slug))
})

test('sitemap keeps unique public slugs in sitemap order and ignores non-post URLs', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- synthetic -->${ROOT}
    <url><loc>https://${HOST}/archive</loc></url>
    <url><loc>https://${HOST}/p/newer-post</loc><lastmod>2025-01-01</lastmod><changefreq>monthly</changefreq></url>
    <url><loc>https://${HOST}/p/older&#45;post</loc><lastmod>2026-01-01</lastmod><priority>0.5</priority></url>
    ${loc(`https://${HOST}/p/newer-post`)}
  </urlset>`
  assert.deepEqual(parseSitemapSlugs(xml, HOST), ['newer-post', 'older-post'])
})

test('sitemap never returns cross-host, credentialed, port, query, fragment or encoded paths', () => {
  const unsafe = [
    'https://other.substack.com/p/external', `http://${HOST}/p/http`,
    `https://user@${HOST}/p/credentials`, `https://${HOST}:443/p/port`,
    `https://${HOST}/p/query?x=1&amp;y=2`, `https://${HOST}/p/fragment#x`,
    `https://${HOST}/p/%2e%2e`, `https://${HOST}/p/../other`,
    `https://${HOST}/p/back\\slash`, `https://${HOST}/p/path/segment`,
    `https://${HOST}/p/white space`, `https://${HOST}/p/&#x0a;newline`,
  ]
  assert.deepEqual(parseSitemapSlugs(sitemap(...unsafe, `https://${HOST}/p/valid-post`), HOST), ['valid-post'])
  for (const value of unsafe) assert.throws(() => parseSitemapSlugs(sitemap(value), HOST))
})

test('sitemap fails closed for empty/error documents, unsafe XML and malformed structures', () => {
  const good = sitemap(`https://${HOST}/p/valid-post`)
  const invalid = [
    '', '<html>Rate limited</html>', `${ROOT}</urlset>`, sitemap(`https://${HOST}/about`),
    '<urlset><url><loc>https://synthetic.substack.com/p/x</loc></url></urlset>',
    good.replace('</url>', ''), good.replace('</loc>', '</lastmod>'), good + '<urlset/>',
    good.replace('</url>', `<loc>https://${HOST}/p/duplicate-loc</loc></url>`),
    good.replace('<loc>', '<loc extra="x">'), good.replace('<loc>', '<loc><loc>'),
    good.replace('/p/valid-post', '/p/&unknown;'), good.replace('/p/valid-post', '/p/&#0;'),
    good.replace('/p/valid-post', '/p/&#xD800;'), good.replace('/p/valid-post', '/p/&#x110000;'),
    good.replace('</url>', '<![CDATA[anything]]></url>'),
    `<!DOCTYPE urlset [<!ENTITY leak SYSTEM "file:///private">]>${good}`,
    `<?instruction unsafe?>${good}`, `<!-- bad -- comment -->${good}`,
    `<!-- bad--->${good}`, `<?xmlversion="1.0"?>${good}`,
    good.replace('xmlns="', 'xmlns="&unknown;'),
    good.replace('xmlns="', 'xmlns="<'),
    good.replace('</url>', '<unexpected/></url>'),
    good.replace('</url>', '<priority / ></url>'),
    good.slice(0, -1), `${good}not whitespace`,
  ]
  for (const xml of invalid) assert.throws(() => parseSitemapSlugs(xml, HOST))
})

test('sitemap bounds discovery at 5001 posts while still validating the remaining XML', () => {
  const values = Array.from({ length: 5002 }, (_, i) => `https://${HOST}/p/post-${i}`)
  const xml = sitemap(...values)
  const result = parseSitemapSlugs(xml, HOST)
  assert.equal(result.length, 5001)
  assert.equal(result[5000], 'post-5000')
  assert.throws(() => parseSitemapSlugs(xml.replace('</urlset>', '<broken></urlset>'), HOST))
  assert.throws(() => parseSitemapSlugs(' '.repeat(4 * 1024 * 1024 + 1), HOST))
})
