/** Bounded readers for data already present on anonymous public Substack pages. No script execution. */
import { PUBLIC_HOST_RE } from '../src/substack/types'

const MAX_INPUT = 4 * 1024 * 1024
const MAX_SITEMAP_POSTS = 5001
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,199}$/i
const XML_SPACE = /^[\t\n\r ]*$/
const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9'
const RAW_HTML_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'])

type Json = Record<string, unknown>

export interface PublicPostPage {
  post: Json
  pub: Json
}

function invalid(): never {
  throw new Error('Invalid public Substack page')
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

function bounded(input: string): void {
  if (!input || input.length > MAX_INPUT) invalid()
}

/** Find a tag end without treating a quoted attribute's '>' as markup. */
function tagEnd(input: string, start: number): number {
  let quote = ''
  for (let i = start; i < input.length; i += 1) {
    const c = input[i]
    if (quote) { if (c === quote) quote = '' }
    else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return invalid()
}

/** Attribute names, keeping quoted values intact. HTML callers allow unquoted/boolean attributes. */
function attributes(source: string, xml: boolean): Map<string, string> {
  const out = new Map<string, string>()
  const names = /[A-Za-z_:][A-Za-z0-9_.:-]*/y
  let i = 0
  while (i < source.length) {
    while (i < source.length && /[\t\n\r ]/.test(source[i])) i += 1
    if (i === source.length) break
    names.lastIndex = i
    const match = names.exec(source)
    if (!match) invalid()
    const name = xml ? match[0] : match[0].toLowerCase()
    i += match[0].length
    const afterName = i
    while (i < source.length && /[\t\n\r ]/.test(source[i])) i += 1
    let value = ''
    if (source[i] === '=') {
      i += 1
      while (i < source.length && /[\t\n\r ]/.test(source[i])) i += 1
      const quote = source[i]
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, i + 1)
        if (end < 0) invalid()
        value = source.slice(i + 1, end)
        i = end + 1
      } else {
        if (xml) invalid()
        const start = i
        while (i < source.length && !/[\t\n\r ]/.test(source[i])) i += 1
        if (i === start) invalid()
        value = source.slice(start, i)
      }
    } else {
      if (xml) invalid()
      // The whitespace belongs to the next attribute when this one has no '=' value.
      i = afterName
    }
    if (out.has(name)) invalid()
    if (i < source.length && !/[\t\n\r ]/.test(source[i])) invalid()
    if (xml && value.includes('<')) invalid()
    out.set(name, xml ? xmlText(value) : value)
  }
  return out
}

/** Recognize one entire assignment, then decode its JSON string and JSON value separately. */
function preload(script: string): Json | null {
  const prefix = /^\s*window\._preloads\s*=\s*JSON\.parse\(\s*/.exec(script)
  if (!prefix) return null
  const start = prefix[0].length
  if (script[start] !== '"') invalid()
  let end = start + 1
  for (; end < script.length; end += 1) {
    if (script[end] === '\\') end += 1
    else if (script[end] === '"') break
  }
  if (end >= script.length || !/^\s*\)\s*;?\s*$/.test(script.slice(end + 1))) invalid()
  let root: unknown
  try {
    const encoded: unknown = JSON.parse(script.slice(start, end + 1))
    if (typeof encoded !== 'string') invalid()
    root = JSON.parse(encoded)
  } catch { return invalid() }
  return record(root) ?? invalid()
}

/** Only the exact assignment in an inline script counts; article text and external scripts do not. */
export function parsePublicPost(html: string, expectedSlug: string): PublicPostPage {
  bounded(html)
  if (!SLUG_RE.test(expectedSlug)) invalid()
  const tags = /<([A-Za-z][A-Za-z0-9:-]*)(?=[\t\n\r />])/y
  let found: Json | null = null
  let i = 0
  while (i < html.length) {
    const start = html.indexOf('<', i)
    if (start < 0) break
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      if (end < 0) invalid()
      i = end + 3
      continue
    }
    tags.lastIndex = start
    const tag = tags.exec(html)
    if (!tag) { i = start + 1; continue }
    const name = tag[1].toLowerCase()
    const end = tagEnd(html, start + tag[0].length)
    i = end + 1
    if (name === 'plaintext') break
    if (!RAW_HTML_TAGS.has(name)) continue
    // Search the original string: Unicode lowercasing can change its length (for example U+0130).
    const closingTag = new RegExp(`</${name}(?=[\\t\\n\\r >])`, 'gi')
    closingTag.lastIndex = i
    const closing = closingTag.exec(html)
    if (!closing) invalid()
    const close = closing.index
    if (name === 'script') {
      const attrs = attributes(html.slice(start + tag[0].length, end).replace(/\/\s*$/, ''), false)
      const type = (attrs.get('type') ?? '').trim().toLowerCase()
      if (!attrs.has('src') && ['', 'text/javascript', 'application/javascript', 'module'].includes(type)) {
        const root = preload(html.slice(i, close))
        if (root) {
          if (found) invalid()
          found = root
        }
      }
    }
    i = tagEnd(html, close + name.length + 2) + 1
  }
  const post = record(found?.post)
  const pub = record(found?.pub)
  if (!post || !pub || post.slug !== expectedSlug) invalid()
  if (post.publication_id !== undefined && pub.id !== undefined && post.publication_id !== pub.id) invalid()
  return { post, pub }
}

/** XML predefined/numeric references only; no DTDs, custom entities or recursive expansion. */
function xmlText(value: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || value.includes(']]>')) invalid()
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  let out = ''
  let start = 0
  for (let i = value.indexOf('&'); i >= 0; i = value.indexOf('&', start)) {
    out += value.slice(start, i)
    const end = value.indexOf(';', i + 1)
    if (end < 0 || end - i > 12) invalid()
    const entity = value.slice(i + 1, end)
    if (Object.hasOwn(named, entity)) out += named[entity]
    else {
      if (!/^#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6})$/.test(entity)) invalid()
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
        || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) invalid()
      out += String.fromCodePoint(code)
    }
    start = end + 1
  }
  return out + value.slice(start)
}

interface XmlNode { name: string; text: string; children: Set<string> }

/** Substack's ordinary URL sitemap, retaining its order (lastmod is not a publication date). */
export function parseSitemapSlugs(xml: string, expectedHost: string): string[] {
  bounded(xml)
  if (!PUBLIC_HOST_RE.test(expectedHost.toLowerCase())) invalid()
  const host = expectedHost.toLowerCase()
  const slugs: string[] = []
  const seen = new Set<string>()
  const stack: XmlNode[] = []
  const tags = /<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\t\n\r />])/y
  let rootSeen = false
  let urls = 0
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  if (xml.startsWith('<?xml', i)) {
    if (!/[\t\n\r ]/.test(xml[i + 5] ?? '')) invalid()
    const end = xml.indexOf('?>', i + 5)
    if (end < 0) invalid()
    const attrs = attributes(xml.slice(i + 5, end), true)
    if (attrs.get('version') !== '1.0' || [...attrs.keys()].some(k => !['version', 'encoding', 'standalone'].includes(k))
      || (attrs.has('encoding') && attrs.get('encoding')?.toLowerCase() !== 'utf-8')
      || (attrs.has('standalone') && !['yes', 'no'].includes(attrs.get('standalone') ?? ''))) invalid()
    i = end + 2
  }
  function closeNode(): void {
    const node = stack.pop() ?? invalid()
    if (node.name === 'url') { if (!node.children.has('loc')) invalid(); urls += 1 }
    if (node.name !== 'loc') return
    const loc = node.text.trim()
    if (!loc) invalid()
    // Do not normalize URLs: URL() would hide an explicit :443 port or dot path segments.
    const match = /^https:\/\/([^/?#]+)\/p\/([a-z0-9][a-z0-9_-]{0,199})$/i.exec(loc)
    if (!match || match[1].toLowerCase() !== host || seen.has(match[2])) return
    if (slugs.length < MAX_SITEMAP_POSTS) { seen.add(match[2]); slugs.push(match[2]) }
  }
  while (i < xml.length) {
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      const content = end < 0 ? '' : xml.slice(i + 4, end)
      if (end < 0 || content.includes('--') || content.endsWith('-') || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) invalid()
      i = end + 3
      continue
    }
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i)
      const value = xmlText(xml.slice(i, end < 0 ? xml.length : end))
      const node = stack[stack.length - 1]
      if (!node || node.name === 'urlset' || node.name === 'url') { if (!XML_SPACE.test(value)) invalid() }
      else {
        node.text += value
        if (node.text.length > (node.name === 'loc' ? 2048 : 128)) invalid()
      }
      i = end < 0 ? xml.length : end
      continue
    }
    // Also rejects DOCTYPE, CDATA, processing instructions, undeclared namespaces and malformed tags.
    tags.lastIndex = i
    const tag = tags.exec(xml)
    if (!tag) invalid()
    const end = tagEnd(xml, i + tag[0].length)
    const closing = tag[1] === '/'
    const name = tag[2]
    const tail = xml.slice(i + tag[0].length, end)
    const selfClosing = !closing && tail.endsWith('/')
    if (closing) {
      if (!XML_SPACE.test(tail) || stack[stack.length - 1]?.name !== name) invalid()
      closeNode()
    } else {
      const attrs = attributes(selfClosing ? tail.replace(/\/\s*$/, '') : tail, true)
      const parent = stack[stack.length - 1]
      if (!parent) {
        if (rootSeen || name !== 'urlset' || attrs.get('xmlns') !== SITEMAP_NAMESPACE) invalid()
        // Substack declares news/xhtml/image/video namespaces even when the map uses none of them.
        // Declarations are data only: extension elements remain unsupported and no URI is fetched.
        for (const [key, value] of attrs) {
          if (key === 'xmlns' || key === 'xsi:schemaLocation') continue
          if (!/^xmlns:[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || key === 'xmlns:xmlns'
            || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\s<>]/.test(value)
            || value === 'http://www.w3.org/2000/xmlns/') invalid()
          if ((key === 'xmlns:xml') !== (value === 'http://www.w3.org/XML/1998/namespace')) invalid()
        }
        if (attrs.has('xmlns:xsi') && attrs.get('xmlns:xsi') !== 'http://www.w3.org/2001/XMLSchema-instance') invalid()
        if (attrs.has('xsi:schemaLocation') && !attrs.has('xmlns:xsi')) invalid()
        rootSeen = true
      } else {
        if (attrs.size > 0) invalid()
        if (parent.name === 'urlset') { if (name !== 'url') invalid() }
        else if (parent.name === 'url') {
          if (!['loc', 'lastmod', 'changefreq', 'priority'].includes(name) || parent.children.has(name)) invalid()
          parent.children.add(name)
        } else invalid()
      }
      stack.push({ name, text: '', children: new Set() })
      if (selfClosing) closeNode()
    }
    i = end + 1
  }
  if (!rootSeen || stack.length || urls === 0 || slugs.length === 0) invalid()
  return slugs
}
