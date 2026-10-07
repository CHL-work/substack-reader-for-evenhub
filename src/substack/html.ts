/**
 * Substack post HTML -> plain reader text for the G2 (SPEC section 7).
 *
 * Input: `body_html` from /api/v1/posts/{slug} or /posts/by-id/{id}, or RSS
 * <content:encoded> (same structure). Ported from research 04-htmlToReaderText.ts.
 *
 * - DOMParser('text/html') yields an inert document: no script runs and
 *   nothing loads. Its nodes are never adopted, imported or appended into the
 *   live DOM; only strings leave this module (C9). innerText is never used.
 * - Blocks are separated by one blank line; list items and multi-part embeds
 *   are tight (a single newline).
 * - The firmware skips ASCII spaces at a line start, so indentation is
 *   U+00A0 and no output line starts with U+0020; runs of spaces collapse (C7).
 * - ASCII-only source: every special glyph is a \u escape (a decoded U+2028
 *   inside a regex literal is a syntax error).
 */

/** Bump whenever the output text can change for the same input and options. */
export const CONVERTER_VERSION = 1

export interface ReaderFootnote {
  /** Label as printed by Substack ("1", "2", ...). */
  label: string
  /** Plain text of the note (paragraphs joined with a newline). */
  text: string
}

export interface ReaderTextResult {
  /** body plus the optional NOTES section; ready for pagination. */
  text: string
  /** Body only (no NOTES section). */
  body: string
  /** Notes referenced from the (possibly paywall-cut) body, in reference order. */
  footnotes: ReaderFootnote[]
  /** Whitespace-separated tokens containing a letter or digit, counted on the body before any paywall note. */
  wordCount: number
  /** True when the post is gated (audience other than 'everyone') or a paywall marker cut the HTML. */
  paywalled: boolean
}

export interface HtmlToReaderTextOptions {
  /** post.audience: 'everyone' | 'only_free' | 'only_paid' | 'founding' | ... (null/undefined = unknown, e.g. RSS). */
  audience?: string | null
  /** post.wordcount (full-post count reported by Substack). An empty body with a positive count is gated. */
  expectedWordCount?: number | null
  /** 'end' (default): [n] markers plus a NOTES section; 'inline': note after its paragraph; 'omit'. */
  footnoteMode?: 'end' | 'inline' | 'omit'
  /** Images without caption or alt: '[Image]' placeholder (default) or dropped. */
  bareImages?: 'placeholder' | 'drop'
  /** Upper-case headings up to this many characters (default 60; 0 disables). */
  uppercaseHeadingMax?: number
  /** Truncate code blocks after N lines (default unlimited). */
  maxCodeLines?: number
  /** Glyph coverage test; production passes `cp => getAdvW(cp) > 0` from @evenrealities/pretext. */
  isCovered?: (cp: number) => boolean
  /** Delete every pictographic emoji (colour legends still become words). */
  stripEmoji?: boolean
}

// ---------------------------------------------------------------------------
// Character normalization
// ---------------------------------------------------------------------------

const NBSP = '\u00A0'
const INDENT = NBSP.repeat(3) // 15 px per nesting level

/** Substitutions for glyphs missing from the G2 fonts or rendered too wide (cn font). */
const CHAR_MAP: Record<string, string> = {
  // dashes and hyphens (U+2010 is a 20 px CJK glyph; U+2011/U+2012 are missing)
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2015': '\u2014', '\u2043': '-',
  '\u2E3A': '\u2014\u2014', '\u2E3B': '\u2014\u2014\u2014', '\uFE58': '-', '\uFE63': '-',
  // quotes and apostrophes missing from evenroster
  '\u201B': '\u2018', '\u201F': '\u201C', '\u02BC': '\u2019', '\u02BB': '\u2018',
  '\u02B9': "'", '\u02BA': '"', '`': "'", '\u00B4': "'", '\u2035': "'",
  // bullets, arrows, marks
  '\u2023': '\u2022', '\u25E6': '\u2022', '\u25AA': '\u2022', '\u25AB': '\u2022', '\u2219': '\u00B7',
  '\u22C5': '\u00B7', '\u25B8': '\u203A', '\u25B9': '\u203A', '\u25BA': '\u203A', '\u25BB': '\u203A',
  '\u27F6': '\u2192', '\u27F5': '\u2190', '\u2794': '\u2192', '\u279C': '\u2192', '\u27A1': '\u2192',
  '\u2B05': '\u2190', '\u2713': '\u221A', '\u2714': '\u221A', '\u2611': '\u221A', '\u2717': '\u00D7',
  '\u2718': '\u00D7', '\u2715': '\u00D7', '\u2716': '\u00D7', '\u274C': '\u00D7', '\u22EE': '\u2026',
  '\u22EF': '\u2026', '\u2024': '.',
  // math and letters
  '\u00B5': '\u03BC', '\u2217': '*', '\u223C': '~', '\u2215': '/', '\u2236': ':',
}
const CHAR_MAP_RE = new RegExp(`[${Object.keys(CHAR_MAP).join('')}]`, 'g')

/** C0/C1 controls other than TAB, LF, FF, CR and NEL (pagination would drop them anyway). */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g

/** Format/invisible characters: soft hyphen (a visible 7 px glyph in the cn font), ZW*, bidi
 *  controls, variation selectors, BOM, keycap, tag characters, skin-tone modifiers, flags. */
const INVISIBLE_RE =
  /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u20E3]|\uDB40[\uDC00-\uDDFF]|\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDDE6-\uDDFF]/g

/** Exotic spaces (and the source's NBSP, FF, NEL, LS, PS) become ASCII spaces: only U+0020 is a
 *  break opportunity in the firmware. Our own indentation NBSPs are added afterwards. */
const SPACES_RE = /[\u000C\u00A0\u0085\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g

/** Colour-coded emoji (chart legends) carry meaning a monochrome display cannot show. */
const EMOJI_WORDS: Record<string, string> = {
  '\u{1F534}': '(red)', '\u{1F7E0}': '(orange)', '\u{1F7E1}': '(yellow)', '\u{1F7E2}': '(green)',
  '\u{1F535}': '(blue)', '\u{1F7E3}': '(purple)', '\u{1F7E4}': '(brown)', '\u{26AB}': '(black)',
  '\u{26AA}': '(white)', '\u{1F7E5}': '(red)', '\u{1F7E7}': '(orange)', '\u{1F7E8}': '(yellow)',
  '\u{1F7E9}': '(green)', '\u{1F7E6}': '(blue)', '\u{1F7EA}': '(purple)', '\u{1F7EB}': '(brown)',
  '\u{2B1B}': '(black)', '\u{2B1C}': '(white)', '\u{26A0}': '(!)',
}
const EMOJI_WORDS_RE = new RegExp(`(?:${Object.keys(EMOJI_WORDS).join('|')})`, 'gu')

/** stripEmoji: every pictograph except typographic symbols that happen to be Extended_Pictographic
 *  (copyright, registered, double exclamation, interrobang, trade mark, the small arrows). */
const EMOJI_STRIP_RE = /(?![\u00A9\u00AE\u203C\u2049\u2122\u2194-\u2199\u21A9\u21AA])\p{Extended_Pictographic}/gu

const MARK_RE = /\p{M}/u
const MARKS_RE = /\p{M}/gu
const PICTOGRAPH_RE = /\p{Extended_Pictographic}/u

/**
 * Normalize one text run for the G2 fonts. Order: NFC, controls, invisibles, spaces, mapping table,
 * colour emoji, optional emoji strip, then (only with `isCovered`) the coverage fallback:
 * NFKD without combining marks when that is covered, else uncovered marks and pictographs vanish,
 * else a run of uncovered characters becomes `[?]`. Whitespace is not collapsed here.
 */
export function normalizeChars(input: string, isCovered?: (cp: number) => boolean, stripEmoji = false): string {
  let s = input.normalize('NFC')
  s = s.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '').replace(SPACES_RE, ' ')
    .replace(CHAR_MAP_RE, ch => CHAR_MAP[ch] ?? ch)
    .replace(EMOJI_WORDS_RE, e => EMOJI_WORDS[e] ?? e)
  if (stripEmoji) s = s.replace(EMOJI_STRIP_RE, '')
  if (!isCovered) return s
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 32 || isCovered(cp)) { out += ch; continue }
    // 1) compatibility decomposition minus combining marks: \uFB01 -> fi, \u0108 -> C, \u207A -> +
    const dec = ch.normalize('NFKD').replace(MARKS_RE, '')
    if (dec && Array.from(dec).every(c => isCovered(c.codePointAt(0) ?? 0))) { out += dec; continue }
    // 2) stray combining marks and unsupported pictographs vanish
    if (MARK_RE.test(ch) || PICTOGRAPH_RE.test(ch)) continue
    // 3) anything else (Hebrew, Arabic, Devanagari, Thai, ...) -> one marker per run
    out += '\u0000'
  }
  return out.replace(/\u0000+(?:\s+\u0000+)*/g, '[?]')
}

const SUP_DIGITS = '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079'
const SUB_DIGITS = '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089'
const toSup = (d: string): string => d.replace(/\d/g, c => SUP_DIGITS[Number(c)] ?? c)
const toSub = (d: string): string => d.replace(/\d/g, c => SUB_DIGITS[Number(c)] ?? c)

// ---------------------------------------------------------------------------
// LaTeX (div.latex-rendered data-attrs.persistentExpression) -> readable text
// ---------------------------------------------------------------------------

const TEX_SYMBOLS: Record<string, string> = {
  cdot: '\u00B7', times: '\u00D7', div: '\u00F7', pm: '\u00B1', leq: '\u2264', le: '\u2264',
  geq: '\u2265', ge: '\u2265', neq: '\u2260', ne: '\u2260', approx: '\u2248', sim: '~',
  equiv: '\u2261', infty: '\u221E', sum: '\u2211', prod: '\u220F', int: '\u222B',
  partial: '\u2202', nabla: '\u2207', propto: '\u221D', in: '\u2208', forall: '\u2200',
  exists: '\u2203', to: '\u2192', rightarrow: '\u2192', leftarrow: '\u2190', Rightarrow: '\u21D2',
  ldots: '\u2026', cdots: '\u2026', dots: '\u2026', degree: '\u00B0', circ: '\u00B0', ell: '\u2113',
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4', epsilon: '\u03B5',
  varepsilon: '\u03B5', zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8', iota: '\u03B9',
  kappa: '\u03BA', lambda: '\u03BB', mu: '\u03BC', nu: '\u03BD', xi: '\u03BE', pi: '\u03C0',
  rho: '\u03C1', sigma: '\u03C3', tau: '\u03C4', phi: '\u03C6', varphi: '\u03C6', chi: '\u03C7',
  psi: '\u03C8', omega: '\u03C9', Gamma: '\u0393', Delta: '\u0394', Theta: '\u0398',
  Lambda: '\u039B', Xi: '\u039E', Pi: '\u03A0', Sigma: '\u03A3', Phi: '\u03A6', Psi: '\u03A8',
  Omega: '\u03A9', log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  max: 'max', min: 'min', lim: 'lim', arg: 'arg', quad: ' ', qquad: ' ',
  // accents and fonts keep the argument only (combining marks are not in the G2 fonts)
  hat: '', bar: '', vec: '', tilde: '', dot: '', ddot: '', overline: '', underline: '',
  widehat: '', widetilde: '', mathbb: '', displaystyle: '', limits: '',
}

export function latexToText(expr: string): string {
  let s = expr
  s = s.replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, '').replace(/\\\\/g, '; ').replace(/(?<!\\)&/g, ' ')
  s = s.replace(/\\\{/g, '\u0001').replace(/\\\}/g, '\u0002').replace(/\\([%$&_#])/g, '$1')
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|operatorname|textbf|textit|mbox|boldsymbol)\s*\{([^{}]*)\}/g, '$1')
  for (let i = 0; i < 4; i += 1) {
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '\u221A($1)')
  }
  s = s.replace(/\\(?:left|right|bigg?|Bigg?)\s*(\\[{}|]|[()[\]|.])/g, (_m: string, d: string) => (d === '.' ? '' : d.replace('\\', '')))
  s = s.replace(/\\([A-Za-z]+)/g, (_m: string, name: string) => TEX_SYMBOLS[name] ?? name)
  s = s.replace(/\\[,;:! ]/g, ' ')
  const script = (mark: string, inner: string): string => {
    if (/^\d+$/.test(inner)) return mark === '_' ? toSub(inner) : toSup(inner)
    return /^[\p{L}\p{N}]+$/u.test(inner) ? mark + inner : `${mark}(${inner})`
  }
  for (let i = 0; i < 3; i += 1) s = s.replace(/([_^])\{([^{}]*)\}/g, (_m: string, m: string, inner: string) => script(m, inner))
  s = s.replace(/([_^])([\p{L}\p{N}])/gu, (_m: string, m: string, c: string) => script(m, c))
  s = s.replace(/[{}]/g, '').replace(/\u0001/g, '{').replace(/\u0002/g, '}')
  s = s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
  return s.trim()
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

interface Block {
  text: string
  /** blockquote nesting: '> ' prefix per level on every line */
  quote: number
  /** joined to the previous block with '\n' instead of a blank line */
  tight: boolean
  kind?: 'hr' | 'bareImage' | 'list'
}

interface Ctx { quote: number; listDepth: number }

interface State {
  opts: HtmlToReaderTextOptions
  /** normalizeChars with this conversion's coverage and emoji options */
  norm: (s: string) => string
  notes: Map<string, string>
  usedNotes: string[]
  pendingInline: string[]
  cut: boolean
}

type Attrs = Record<string, unknown>

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'button', 'form', 'input', 'select',
  'textarea', 'source', 'object', 'embed', 'canvas', 'map', 'link', 'meta', 'head', 'title',
])
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i',
  'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var', 'wbr', 'label',
])
/** Substack chrome that carries no article content (subscribe, share, buttons, ads, app promos). */
const DROP_SELECTOR = [
  '.subscription-widget-wrap', '.subscription-widget-wrap-editor', '.subscription-widget',
  '.button-wrapper', '.captioned-button-wrap', '.sponsorship-campaign-embed', '.image-link-expand',
  '.install-substack-app-embed', '.community-chat', '.directMessage', '.paywall-cta',
  '.embedded-publication-wrap', '.recommendations', 'a.button',
  '[data-component-name="SponsorshipCampaignToDOM"]', '[data-component-name="SubscribeWidgetToDOM"]',
  '[data-component-name="ButtonCreateButton"]', '[data-component-name="CaptionedButtonToDOM"]',
].join(',')
const PAYWALL_SELECTOR =
  '.paywall, .paywall-jump, [data-component-name="Paywall"], [data-component-name="PaywallToDOM"]'
const BLOCK_DESCENDANTS = 'p,div,ul,ol,pre,blockquote,figure,h1,h2,h3,h4,h5,h6,table'

const isRecord = (v: unknown): v is Attrs => typeof v === 'object' && v !== null
const record = (v: unknown): Attrs => (isRecord(v) ? v : {})
/** A data-attrs value as text: strings as-is, finite numbers stringified, anything else ''. */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')

function dataAttrs(el: Element | null): Attrs {
  const raw = el?.getAttribute('data-attrs')
  if (!raw) return {}
  try { return record(JSON.parse(raw)) } catch { return {} }
}

const collapseWs = (s: string): string => s.replace(/[ \t\n\r\f]+/g, ' ')

/** Trim each line, squeeze spaces, drop empty leading/trailing lines. */
function tidy(s: string): string {
  return s.split('\n').map(l => l.replace(/ {2,}/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

function inlineText(node: Node, st: State): string {
  if (node.nodeType === 3) return collapseWs(st.norm((node as Text).data))
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag) || el.matches(DROP_SELECTOR)) return ''
  if (tag === 'br') return '\n'
  if (tag === 'img' || tag === 'picture') return ''
  if (el.classList.contains('footnote-anchor')) {
    const label = (el.textContent || '').trim()
    if (!st.notes.has(label)) return '' // dangling: the body was cut at the paywall
    if (!st.usedNotes.includes(label)) st.usedNotes.push(label)
    if (st.opts.footnoteMode === 'omit') return ''
    if (st.opts.footnoteMode === 'inline') st.pendingInline.push(label)
    return `[${label}]`
  }
  if (el.classList.contains('mention-wrap')) {
    const name = dataAttrs(el).name
    return collapseWs(st.norm(typeof name === 'string' ? name : el.textContent || ''))
  }
  const inner = Array.from(el.childNodes, c => inlineText(c, st)).join('')
  if (tag === 'sup') return /^\d+$/.test(inner.trim()) ? toSup(inner.trim()) : inner
  if (tag === 'sub') return /^\d+$/.test(inner.trim()) ? toSub(inner.trim()) : (inner.trim() ? `_${inner.trim()}` : '')
  if (tag === 's' || tag === 'strike' || tag === 'del') return inner.trim() ? `~${inner}~` : ''
  return inner
}

function isInline(node: Node): boolean {
  if (node.nodeType === 3) return true
  if (node.nodeType !== 1) return false
  const el = node as Element
  if (el.classList.contains('image2') || el.classList.contains('image-link')) return false
  return INLINE_TAGS.has(el.tagName.toLowerCase()) && !el.querySelector(BLOCK_DESCENDANTS)
}

function push(out: Block[], st: State, ctx: Ctx, text: string, extra: Partial<Block> = {}): void {
  const t = tidy(text)
  if (t) out.push({ text: t, quote: ctx.quote, tight: false, ...extra })
  if (st.pendingInline.length) { // footnoteMode 'inline': the note right after its paragraph
    for (const label of st.pendingInline.splice(0)) out.push({ text: noteLine(label, st.notes.get(label) ?? ''), quote: ctx.quote, tight: false })
  }
}

const noteLine = (label: string, text: string): string => (text ? `[${label}] ${text}` : `[${label}]`)

function renderChildren(parent: Node, ctx: Ctx, out: Block[], st: State): void {
  let buf = ''
  const flush = (): void => { if (buf.trim()) push(out, st, ctx, buf); buf = '' }
  for (const child of Array.from(parent.childNodes)) {
    if (st.cut) break
    if (isInline(child)) { buf += inlineText(child, st); continue }
    if (child.nodeType !== 1) continue
    flush()
    renderBlock(child as Element, ctx, out, st)
  }
  flush()
}

function placeholder(out: Block[], st: State, ctx: Ctx, kind: string, detail?: string): void {
  const d = detail ? tidy(collapseWs(st.norm(detail))) : ''
  push(out, st, ctx, d ? `[${kind}: ${d}]` : `[${kind}]`)
}

const joinParts = (parts: string[]): string => parts.map(p => p.trim()).filter(Boolean).join(' \u2014 ')

function renderBlock(el: Element, ctx: Ctx, out: Block[], st: State): void {
  const tag = el.tagName.toLowerCase()
  const cls = el.classList
  const comp = el.getAttribute('data-component-name') || ''

  if (el.matches(PAYWALL_SELECTOR)) { st.cut = true; return }
  if (el.matches(DROP_SELECTOR)) return

  // --- Substack components (checked before SKIP_TAGS: Spotify's component is an <iframe>) ---
  if (cls.contains('captioned-image-container') || tag === 'figure' || cls.contains('image2')
      || tag === 'img' || tag === 'picture') {
    const cap = tidy(Array.from(el.querySelector('figcaption')?.childNodes ?? [], c => inlineText(c, st)).join(''))
    const img = tag === 'img' ? el : el.querySelector('img')
    const alt = (img?.getAttribute('alt') || str(dataAttrs(img).alt)).trim()
    if (!img && !cap) { renderChildren(el, ctx, out, st); return } // <figure> without an image
    if (cap || alt) placeholder(out, st, ctx, 'Image', cap || alt)
    else if (st.opts.bareImages !== 'drop') out.push({ text: '[Image]', quote: ctx.quote, tight: false, kind: 'bareImage' })
    return
  }
  if (cls.contains('image-gallery-embed')) {
    const g = record(dataAttrs(el).gallery)
    const n = Array.isArray(g.images) ? g.images.length : 0
    placeholder(out, st, ctx, 'Gallery', joinParts([n ? `${n} image${n === 1 ? '' : 's'}` : '', str(g.caption)]))
    return
  }
  if (cls.contains('twitter-embed') || comp === 'Twitter2ToDOM' || cls.contains('tweet')) {
    const d = dataAttrs(el)
    const name = str(d.name).trim()
    const user = str(d.username).trim()
    const who = name && user ? `${name} (@${user})` : name || (user ? `@${user}` : '')
    push(out, st, ctx, who ? `[Tweet by ${collapseWs(st.norm(who))}]` : '[Tweet]')
    const clean = (t: string): string => st.norm(t
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s*https?:\/\/t\.co\/\w+/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
    const body = d.full_text != null ? clean(str(d.full_text)) : clean(collapseWs(el.textContent || ''))
    const quoted = { ...ctx, quote: ctx.quote + 1 }
    if (body) push(out, st, quoted, body, { tight: true })
    const q = record(d.quoted_tweet)
    const qText = clean(str(q.full_text))
    if (qText) push(out, st, quoted, `Quoting @${str(q.username).trim() || '?'}: ${qText}`, { tight: true })
    return
  }
  if (cls.contains('embedded-post-wrap') || cls.contains('digest-post-embed')) {
    const d = dataAttrs(el)
    const title = str(d.title) || el.querySelector('.embedded-post-title')?.textContent || ''
    const pub = str(d.publication_name) || el.querySelector('.embedded-post-publication-name')?.textContent || ''
    placeholder(out, st, ctx, 'Linked post', joinParts([title, pub]))
    return
  }
  if (cls.contains('youtube-wrap')) return placeholder(out, st, ctx, 'Video', 'YouTube')
  if (cls.contains('vimeo-wrap')) return placeholder(out, st, ctx, 'Video', 'Vimeo')
  if (cls.contains('tiktok-wrap')) return placeholder(out, st, ctx, 'Video', 'TikTok')
  if (cls.contains('native-video-embed') || tag === 'video') return placeholder(out, st, ctx, 'Video')
  if (cls.contains('instagram')) return placeholder(out, st, ctx, 'Instagram post')
  if (cls.contains('spotify-wrap') || cls.contains('apple-podcast-container')) {
    const d = dataAttrs(el)
    return placeholder(out, st, ctx, 'Audio', joinParts([str(d.title), str(d.subtitle)]))
  }
  if (tag === 'audio' || cls.contains('audio-embed') || /audio/i.test(comp)) return placeholder(out, st, ctx, 'Audio')
  if (cls.contains('datawrapper-wrap')) {
    const d = dataAttrs(el)
    const title = str(d.title)
    // Optional v2: `${d.url}dataset.csv` (datawrapper.dwcdn.net sends ACAO *) could become table rows.
    return placeholder(out, st, ctx, 'Chart', joinParts([/^created with datawrapper$/i.test(title.trim()) ? '' : title, str(d.description)]))
  }
  if (cls.contains('code-embed')) return placeholder(out, st, ctx, 'Interactive embed', str(dataAttrs(el).caption))
  if (cls.contains('poll-embed')) return placeholder(out, st, ctx, 'Poll')
  if (cls.contains('latex-rendered')) {
    const expr = str(dataAttrs(el).persistentExpression) || el.textContent || ''
    return placeholder(out, st, ctx, 'Formula', latexToText(expr))
  }
  if (cls.contains('footnote')) return // collected in the pre-pass
  if (tag === 'iframe') return placeholder(out, st, ctx, 'Embedded content')
  if (SKIP_TAGS.has(tag)) return

  // --- generic HTML ---
  if (/^h[1-6]$/.test(tag)) {
    let t = tidy(Array.from(el.childNodes, c => inlineText(c, st)).join(''))
    const max = st.opts.uppercaseHeadingMax ?? 60
    if (t && max > 0 && t.length <= max) t = st.norm(t.toUpperCase()) // re-check glyphs: 'n with apostrophe' upper-cases to U+02BC N
    return push(out, st, ctx, t)
  }
  if (tag === 'p') {
    // RSS <content:encoded> of a paid post ends with <p><a href="{post url}">Read more</a></p>
    if (el.querySelector('a') && /^read more$/i.test((el.textContent || '').trim())) { st.cut = true; return }
    return renderChildren(el, ctx, out, st) // usually pure inline; tolerates junk
  }
  if (tag === 'blockquote' || cls.contains('pullquote')) {
    return renderChildren(el, { ...ctx, quote: ctx.quote + 1 }, out, st)
  }
  if (tag === 'ul' || tag === 'ol') return renderList(el, ctx, out, st)
  if (tag === 'li') return renderList(el, ctx, out, st, true)
  if (tag === 'pre') return renderCode(el, ctx, out, st)
  if (tag === 'hr') { out.push({ text: '* * *', quote: ctx.quote, tight: false, kind: 'hr' }); return }
  if (tag === 'table') return renderTable(el, ctx, out, st)
  if (comp && !(el.textContent || '').trim()) return placeholder(out, st, ctx, 'Embedded content')
  // div, section, article, callout-block, figure without image, details, ...: transparent
  renderChildren(el, ctx, out, st)
}

const BULLETS = ['\u2022', '\u2013', '\u00B7'] // depth 1, 2, 3 (U+25E6 is missing from the fonts)

function renderList(el: Element, ctx: Ctx, out: Block[], st: State, orphanLi = false): void {
  const depth = ctx.listDepth + 1
  const ordered = el.tagName.toLowerCase() === 'ol'
  const start = Number.parseInt(el.getAttribute('start') ?? '', 10)
  let n = ordered && Number.isFinite(start) ? start : 1
  const items = orphanLi ? [el] : Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'li')
  const pad = INDENT.repeat(depth - 1)
  items.forEach((li, idx) => {
    const marker = ordered ? `${n++}.` : BULLETS[(depth - 1) % BULLETS.length]
    const sub: Block[] = []
    renderChildren(li, { ...ctx, listDepth: depth }, sub, st)
    let first = true
    for (const b of sub) {
      if (b.kind !== 'list') { // the item's own blocks (nested list blocks are already prefixed)
        b.text = b.text.split('\n').map((line, i) =>
          (first && i === 0 ? `${pad}${marker} ` : pad + INDENT) + line).join('\n')
        first = false
      }
      b.kind = 'list'
      b.tight = !(idx === 0 && b === sub[0] && depth === 1) // a blank line only before the list
      out.push(b)
    }
  })
}

function renderCode(el: Element, ctx: Ctx, out: Block[], st: State): void {
  const wrap = el.closest('.highlighted_code_block')
  const lang = collapseWs(st.norm(str(dataAttrs(wrap).language)
    || (el.querySelector('code')?.className.match(/language-([\w+#-]+)/)?.[1] ?? ''))).trim()
  const source = (el.textContent || '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
  let lines = (source ? source.split('\n') : [])
    .map(l => st.norm(l.replace(/\t/g, '  ')).replace(/\s+$/, ''))
    .map(l => l
      .replace(/^ +/, m => NBSP.repeat(m.length)) // keep indentation visible on G2
      .replace(/ {2,}/g, m => `${NBSP.repeat(m.length - 1)} `)) // keep alignment, keep one break opportunity
  const max = st.opts.maxCodeLines
  if (max && max > 0 && lines.length > max) lines = [...lines.slice(0, max), `[\u2026 ${lines.length - max} more lines]`]
  const header = lang && lang !== 'plaintext' ? `[Code: ${lang}]` : '[Code]'
  out.push({ text: [header, ...lines].join('\n').replace(/\n{3,}/g, '\n\n'), quote: ctx.quote, tight: false })
}

function renderTable(el: Element, ctx: Ctx, out: Block[], st: State): void {
  const rows = Array.from(el.querySelectorAll('tr'), tr =>
    Array.from(tr.children, c => tidy(inlineText(c, st)).replace(/\n/g, ' ')))
  if (!rows.length) return
  const header = el.querySelector('tr')?.querySelector('th') ? rows.shift() ?? null : null
  rows.forEach((cells, i) => {
    const text = header && header.length <= 4
      ? cells.map((c, j) => (header[j] ? `${header[j]}: ${c}` : c)).join(' \u00B7 ')
      : cells.join(' \u00B7 ')
    push(out, st, ctx, `\u2022 ${text}`, { tight: i > 0, kind: 'list' })
  })
}

function serialize(blocks: Block[]): string {
  let out = ''
  blocks.forEach((b, i) => {
    const prefix = '> '.repeat(b.quote)
    const text = b.text.split('\n').map(l => (prefix + l).replace(/ +$/, '')).join('\n')
    const prev = blocks[i - 1]
    if (prev) {
      // A blank line between two paragraphs of the same quote keeps its '>' rail (email style).
      const q = Math.min(b.quote, prev.quote)
      out += b.tight ? '\n' : q > 0 ? `\n${'> '.repeat(q).trimEnd()}\n` : '\n\n'
    }
    out += text
  })
  return out
}

/** Collapse runs of bare images; drop leading, trailing and repeated rules. */
function cleanup(blocks: Block[]): Block[] {
  const res: Block[] = []
  for (const b of blocks) {
    const prev = res[res.length - 1]
    if (b.kind === 'hr' && (!prev || prev.kind === 'hr')) continue
    if (b.kind === 'bareImage' && prev?.kind === 'bareImage' && prev.quote === b.quote) {
      const n = (Number.parseInt(prev.text.replace(/\D/g, ''), 10) || 1) + 1
      prev.text = `[${n} images]`
      continue
    }
    res.push(b)
  }
  while (res[res.length - 1]?.kind === 'hr') res.pop()
  return res
}

/** C7 guard: no space at a line edge, no runs of ASCII spaces, at most one blank line. */
function finish(s: string): string {
  return s.replace(/ +\n/g, '\n').replace(/\n +/g, '\n').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const PAID_PREVIEW_NOTE = '[Preview ends here. The rest of this post is for paid subscribers.]'
const PAID_ONLY_NOTE = '[This post is for paid subscribers.]'

export function htmlToReaderText(html: string | null | undefined, opts: HtmlToReaderTextOptions = {}): ReaderTextResult {
  const strip = opts.stripEmoji === true
  const norm = (s: string): string => normalizeChars(s, opts.isCovered, strip)
  const st: State = { opts, norm, notes: new Map(), usedNotes: [], pendingInline: [], cut: false }
  // Inert parse; the document is discarded after its strings are read (C9).
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const root = doc.body
  const base: Ctx = { quote: 0, listDepth: 0 }

  // Pre-pass: footnote bodies (div.footnote > a.footnote-number + div.footnote-content) are
  // collected and removed from the parsed document so they never appear in the body.
  for (const fn of Array.from(root.querySelectorAll('div.footnote'))) {
    const number = fn.querySelector('.footnote-number')
    const label = (number?.textContent || '').trim() || (number?.id || '').replace(/\D/g, '')
    const content = fn.querySelector('.footnote-content') ?? fn
    const sub: Block[] = []
    renderChildren(content, base, sub, { ...st, notes: new Map(), usedNotes: [], pendingInline: [], cut: false })
    if (label) st.notes.set(label, finish(serialize(sub.map(b => ({ ...b, tight: true })))))
    fn.remove()
  }

  const blocks: Block[] = []
  renderChildren(root, base, blocks, st)
  let body = finish(serialize(cleanup(blocks)))

  const wordCount = body.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
  const gated = typeof opts.audience === 'string' && opts.audience !== 'everyone' // C11
  const paywalled = st.cut || gated || (!body && (opts.expectedWordCount ?? 0) > 0)
  if (paywalled) body = body ? `${body}\n\n${PAID_PREVIEW_NOTE}` : PAID_ONLY_NOTE

  const footnotes: ReaderFootnote[] = st.usedNotes.map(label => ({ label, text: st.notes.get(label) ?? '' }))
  let text = body
  if ((opts.footnoteMode ?? 'end') === 'end' && footnotes.length) {
    text += `\n\nNOTES\n\n${footnotes.map(f => noteLine(f.label, f.text)).join('\n\n')}`
  }
  return { text, body, footnotes, wordCount, paywalled }
}
