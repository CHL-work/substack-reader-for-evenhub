# 04 — Substack post HTML → plain text for Even G2 (conversion spec)

Researcher topic 04. Date of probes: 2026-10-06. All probes were anonymous, read-only GETs (curl, a headless Edge
instance with a throw-away profile, and the Claude built-in browser on `https://substack.com`). No article text is stored
in this file or in the scratchpad beyond short structural fragments.

Deliverables produced next to this file:

| File | What |
|---|---|
| `04-htmlToReaderText.ts` | Reference implementation (DOMParser based), ~520 lines, ASCII-only source (all special glyphs written as `\u` escapes). Transpiles cleanly with TypeScript 5.6 `transpileModule` (0 syntax diagnostics; not full-program type-checked — no lib.dom in that environment). |
| `fixtures/01..06-*.html` + `*.expected.txt` | 6 synthetic fixtures (≤18 lines each) using real Substack class names / `data-attrs`. Options for each fixture are in the first-line comment `<!-- reader-options: {...} -->`. Expected outputs assume `isCovered = cp => getAdvW(cp) > 0` from `@evenrealities/pretext@0.1.4`. Expected files contain literal U+00A0 (NBSP) characters for indentation. |
| `harness04/selftest.html` | Self-contained harness (inlines the TS source, the fixtures and pretext's `font_measure.js`; loads TypeScript 5.6.3 from cdnjs, transpiles in-page, runs every fixture, prints JSON into `<pre id="result">`). Run: `msedge --headless=new --user-data-dir=<tmp> --virtual-time-budget=15000 --dump-dom file:///…/selftest.html`. Rebuild with `raw04/buildharness.py`, run+diff with `raw04/runharness.py`. **All 6 fixtures PASS.** |
| `harness04/htmlToReaderText.js` | The transpiled CommonJS output (for quick injection tests). |
| `raw04/scan.json` | Class/component counts (no text) for 144 recent posts from 20 publications. |

---

## 1. TL;DR (decisions)

1. **Parse with `DOMParser('text/html')` in the WebView — yes.** Verified inert: parsing `<img onerror>`, `<script>`,
   `<iframe>`, `<svg><image>` caused **zero** network requests and no handler execution (same for `<template>`). Never move
   parsed nodes into the live document; walk the tree yourself (never `innerText`).
2. **Same converter for API and RSS.** `body_html` from `/api/v1/posts/{slug}` (or `substack.com/api/v1/posts/by-id/{id}`)
   and RSS `<content:encoded>` are structurally identical (934 vs 934 tags on the same post; only `data-attrs` counters differ).
   Old posts (2021) are re-rendered with the current markup, so one rule set covers the archive.
3. **Most embeds are empty elements whose content lives in the `data-attrs` JSON attribute** (tweets, mentions, galleries,
   digest posts, LaTeX, Spotify, Datawrapper, polls). A textContent-only converter silently loses tweets and @-mentions.
4. **Block model, blank line between blocks; list items tight.** Headings ≤60 chars upper-cased; blockquotes/pullquotes
   `> ` prefix; lists `• – ·` / `1.`; code `[Code: lang]` + lines; images `[Image: caption]` / `[Image]` (runs collapsed to
   `[N images]`); embeds `[Video: YouTube]`, `[Tweet by Name (@user)]` + quoted text, `[Linked post: Title — Pub]`,
   `[Chart: title — description]`, `[Audio: …]`, `[Poll]`, `[Formula: …]`; subscribe widgets / buttons / sponsorships dropped;
   footnotes `[n]` + `NOTES` section (or inline/omit).
5. **Paywall: there is no marker in API/RSS bodies.** Gate on `post.audience !== 'everyone'`; body is silently cut at the
   paywall (ratio of extracted words to `post.wordcount` was 0.29–0.44 on paid previews vs 0.97–1.13 on free posts).
   Footnote anchors survive the cut while their bodies don't → drop dangling markers. RSS paid previews end with
   `<p><a href=…>Read more</a></p>` → treat as cut marker.
6. **Indentation must use U+00A0, not spaces.** The G2 renderer (as modelled by pretext's `measureTextWrap`) skips ASCII
   spaces at the start of every line, including after `\n`. NBSP is in the main font (5 px, same as space).
7. **Glyph coverage**: the firmware chain is `evenroster` (415 glyphs) → `evenroster_crylgrek` (299) → `cn` (24,828 cps via
   ranges) → `evenemoji` (102 glyphs incl. space/NBSP → 100 emoji). Missing glyphs render as a 4 px placeholder. Smart quotes,
   en/em dash, ellipsis, bullet, NBSP, Latin-1/Latin-Ext-A, Vietnamese, Greek, Cyrillic, common math are present. **Missing:
   backtick (U+0060!), U+2011/U+2012 hyphens, all zero-width/format chars, thin/hair/narrow spaces, ✓ ✗, ◦ ▪ ▸ ►, µ (U+00B5),
   ﬁ ligatures, combining marks, U+FFFD, Hebrew/Arabic/Indic/Thai, most emoji (incl. 🚀 ⚠ flags skin-tones VS16).**
   Soft hyphen U+00AD *is* in the `cn` range (7 px visible glyph) → must be stripped. Use pretext's exported
   `getAdvW(cp) > 0` as the runtime coverage test.

---

## 2. Method and sample

- Endpoints: `GET https://<pub>/api/v1/archive?sort=new&limit=N` (metadata only, `body_html: null`) then
  `GET https://<pub>/api/v1/posts/<slug>` (full post incl. `body_html`). Cross-publication single origin:
  `GET https://substack.com/api/v1/posts/by-id/<id>` → `{post, publication, publicationSettings, …}` (also no CORS headers).
- Structural scan (class + `data-component-name` counts only, no text): **144 posts** — astralcodexten, noahpinion,
  natesilver, simonw, dwarkesh, magazine.sebastianraschka, newsletter.pragmaticengineer, lennysnewsletter,
  experimental-history, construction-physics, oneusefulthing, thefp, slowboring, honest-broker, henrikkarlsson,
  understandingai, interconnects, cremieux, jmelliott (pull-quote demo), nsokolsky/reallygoodbusinessideas (table tutorials),
  plus 8 posts from noahpinion's 2021 archive. 131 `newsletter` + 13 `podcast` type; 93 `everyone`, 51 `only_paid`.
- Detailed redacted skeletons (tags/classes/attributes kept, text >30 chars cut to 3 words) for 22 diverse posts:
  ACX "Does Georgism Work? Five Years Later" (14 footnotes, 23 images), ACX "An Open Letter To Steven Pinker On AI" (tweet),
  ACX "Hidden Open Thread 452.5" (paid, no preview), Noahpinion "Roundup #89" (embedded posts, tweets, YouTube, buttons),
  Noahpinion "The second Trump presidency…" (paid preview, digest-post-embed, tweets), Silver Bulletin "Why did Ohio stop
  being a swing state?" (Spotify, YouTube, Datawrapper, subscribe widget) and "How popular is the Iran War?" (callout-block,
  `<script>`, h5), Dwarkesh "Pretraining progress is mostly coming from data" (LaTeX, Datawrapper) and two podcast transcripts,
  Raschka "Language Models for Text Classification" (shiki code blocks, LaTeX, `<sub>`, nested lists), Pragmatic Engineer
  "…Part 2: Windows" (poll, paid preview), Experimental History (mentions, gallery), Simon Willison "Jev introduces…"
  (`<pre><code><code>`, `<br>`, native video), The Free Press (sponsorship, 8 linked posts), Construction Physics reading list
  (`<s>`, paid preview), J.M. Elliott "Block Quotes and Pull Quotes" (`div.pullquote`), two "tables in Substack" tutorials
  (confirmed: tables are Datawrapper embeds or images).
- Live validation: the reference implementation was run on **23 real posts** inside a real Chromium (built-in browser on the
  substack.com origin, fetching `by-id`). Results in §9.

---

## 3. Catalog of structural patterns Substack emits

Frequency = number of the 144 scanned posts containing the pattern.

### 3.1 Plain HTML

| Pattern | Markup observed | Freq | Notes |
|---|---|---|---|
| Paragraph | `<p>` (sometimes every run wrapped in `<span>`: `<p><span>…</span><em><span>…</span></em></p>`) | 144 | Minified: no newlines between blocks. Whitespace inside inline tags is meaningful (`<em>and </em>employee`). Empty `<p></p>` used as spacer (Raschka). |
| Headings | `h1`…`h5` (h6 not seen). Counts: h3 43 posts, h2 33, h4 34, h1 18, h5 7 | — | Level usage is inconsistent across pubs (Noahpinion uses h4 for section heads; Silver uses h5 for small labels). Treat all levels alike. Post title/subtitle are **not** in body_html (`post.title`, `post.subtitle`). |
| Pseudo-heading | `<p><strong>Name</strong></p>` | common in podcasts | Speaker labels in transcripts; render as an ordinary paragraph. |
| Emphasis | `em`, `strong`, rarely `s` (1), `sup` (1), `sub` (1), `u`, `code` | — | No styling on G2 → drop markers. |
| Links | `<a href>` | 92 | Keep text, drop URL. |
| Line break | `<br>` inside `<p>` (12 posts; sponsor blocks, timestamps lists use `<br><br>`) | 12 | → `\n`. |
| Lists | `<ul>/<ol>` > `<li>` > `<p>` (always a `<p>` inside `li`); nesting `li > p + ul` | ul 44, ol 35 | `ol` may carry `start`. Nested lists seen in 3 of 22 skeletons. |
| Blockquote | `<blockquote><p>…</p><p>…</p></blockquote>`; may contain `<ul>` or `<pre>` | 38 | |
| Pull quote | `<div class="pullquote"><p>…</p></div>` | rare (demo post) | Often duplicates nearby text by design, but authors also use it for standalone quotes → keep, render like blockquote. |
| Horizontal rule | `<hr>` | 39 | Often the last element before a subscribe button. |
| Preformatted | `<pre><code><code>…</code></code></pre>` (plain, simonw) and `<div class="highlighted_code_block" data-attrs='{"language":"bash","nodeId":…}' data-component-name="HighlightedCodeBlockToDOM"><pre class="shiki"><code class="language-bash">…` | pre 12 | Text has real `\n`, leading spaces, tabs. |
| Inline code | `<p>… <code>datasette.client.get()</code> …</p>` | 15 | |
| Native tables | **none** — Substack has no table block (confirmed by both table-tutorial posts and 144-post scan) | 0 | Tables arrive as Datawrapper embeds or images. Still handle `<table>` defensively (RSS from non-Substack sources, future editor). |
| Superscript / subscript | `<em>s</em><sub>i</sub>`, `<sup><span>7</span></sup>` | 2 | Math subscripts and manual footnote-like refs. |
| Strikethrough | `<s>…</s>` | 1 | Used for corrections — meaning matters. |
| Entities | Only `&amp;` and `&quot;` (inside data-attrs) observed; typographic chars are literal UTF-8 (’ “ ” — – …) | — | DOMParser decodes all entities. |
| Non-ASCII frequency (22 posts) | ’ 2267, ” 524, “ 520, — 229, é 89, … 72, – 50, ‘ 14, → 11, · 9, thin space 8, hiragana, macrons, ₀, ≥, ZWSP 1, ↑ ↓, 🕒 | — | In the 23-post live run also: 🟢🟤🟡🔴 (chart legends), 📊, 😒. |

### 3.2 Substack components (`data-component-name` → element)

| Component | Element / classes | `data-attrs` keys (observed) | Children / text | Freq |
|---|---|---|---|---|
| `Image2ToDOM` | `div.captioned-image-container > figure > a.image-link.image2.is-viewable-img` (or `div.image-link.image2` when not clickable) `> div.image2-inset > picture > source + img.sizing-normal` + `div.image-link-expand` (buttons + SVG icons) ; `figcaption.image-caption` | on the `img`: `src, srcNoWatermark, fullscreen, imageSize, height, width, resizeWidth, bytes, alt, title, type, href, belowTheFold, topImage, internalRedirect, isProcessing, align, offset` | Caption is inline HTML (may contain links, footnote anchors). `alt` empty in 12/12 checked images; captions present on ~1/3 of images. | 76 |
| Gallery | `div.image-gallery-embed` (no component name) | `gallery: {images:[{type,src}], caption, alt, staticGalleryImage}`, `isEditorNode` | **empty element** | 5 |
| `Twitter2ToDOM` | `div.twitter-embed` | `url, full_text, username, name, profile_image_url, date, photos[], quoted_tweet{full_text,username,name,profile_image_url}, reply_count, retweet_count, like_count, impression_count, expanded_url, video_url, video_preview_media_key, belowTheFold` | **empty element**; `full_text` contains `\n\n`, may contain `&amp;`-style entities and `https://t.co/…` | 12 |
| `Youtube2ToDOM` | `div.youtube-wrap#youtube2-<id> > div.youtube-inner > iframe` | `videoId, startTime, endTime` | no title available | 20 |
| `VimeoToDOM` | `div.vimeo-wrap > div.vimeo-inner > iframe` | `videoId, videoKey, belowTheFold` | | 1 |
| `VideoPlaceholder` | `div.native-video-embed` | `mediaUploadId, duration` | empty | 14 |
| `Spotify2ToDOM` | `iframe.spotify-wrap.podcast` (the iframe *is* the component) | `image, title, subtitle, description, url, belowTheFold, noScroll` | | 1 |
| `EmbeddedPostToDOM` | `div.embedded-post-wrap > a.embedded-post > div.embedded-post-header (img logo, span.embedded-post-publication-name) / div.embedded-post-title-wrapper > div.embedded-post-title / div.embedded-post-body / div.embedded-post-cta-wrapper > span.embedded-post-cta ("Read more") / div.embedded-post-meta` | `id, url, publication_id, embedding_publication_id, publication_name, publication_logo_url, title, truncated_body_text, date, like_count, comment_count, bylines[], utm_campaign, belowTheFold, type, language, source` | has text (other author's excerpt + "Read more" CTA) | 7 |
| Digest post | `div.digest-post-embed` (no component name) | `nodeId, caption, cta, showBylines, showDescription, showImage, size, isEditorNode, title, publishedBylines[], post_date, cover_image, cover_image_alt, canonical_url, section_name, video_upload_id, id, type, reaction_count, comment_count, publication_id, publication_name, publication_logo_url, belowTheFold, youtube_url, show_links, feed_url` | **empty** | 12 |
| `DatawrapperToDOM` | `div.datawrapper-wrap.outer#datawrapper-iframe > iframe.datawrapper-iframe + <script>` | `url, thumbnail_url, thumbnail_url_full, height, title, description, belowTheFold` | contains a `<script>` (resize listener) | 8 |
| `CodeEmbedToDOM` | `div.code-embed > iframe.code-embed-iframe` | `uuid, content_hash, post_id, width, caption, alt` | interactive HTML widget | 4 |
| `LatexBlockToDOM` | `div.latex-rendered` | `persistentExpression` (LaTeX source), `id` | **empty** (rendered client-side) | 3 |
| `PollToDOM` | `div.poll-embed` | `id` only | **empty** (poll body needs another API) | 1 |
| `MentionToDOM` | `span.mention-wrap` (inline) | `name, id, type:"user", url, photo_url, uuid` | **empty** — name only in data-attrs | 6 |
| `FootnoteAnchorToDOM` | `a.footnote-anchor#footnote-anchor-N[href="#footnote-N"]` text `N` (inline, directly after punctuation: `tax.<a>1</a> Although`) | — | | 47 |
| `FootnoteToDOM` | `div.footnote > a.footnote-number#footnote-N[href="#footnote-anchor-N"] + div.footnote-content > p…` at the very end of the body | — | footnote content may have several `<p>`, links, `<em>` | 35 |
| `ButtonCreateButton` | `p.button-wrapper > a.button.primary > span` (rarely `a.button-wrapper`) | `url, text, action, class` — texts seen: "Subscribe now" (`/subscribe?`), "Share" (`?utm_content=share&action=share`) | chrome | 63 |
| `SubscribeWidgetToDOM` | `div.subscription-widget-wrap-editor > div.subscription-widget.show-subscribe > div.preamble > p.cta-caption` + `form.subscription-widget-subscribe > input.email-input + input.button.primary` + `div.fake-input-wrapper` | `url, text, language` | promo caption text ("Thanks for reading…") | 24 |
| `SponsorshipCampaignToDOM` | `div.sponsorship-campaign-embed` | `id, campaignPostId, pub, logline` | empty (ad) | 3 |
| Callout | `div.callout-block[data-callout="true"]` containing h4/h5/p | — | real content (e.g. "Updated October 6") | 9 |
| Podcast posts | `post.type === 'podcast'`; audio is **outside** the body (`post.podcast_url` = `https://api.substack.com/api/v1/audio/upload/<uuid>/src`, `post.podcast_duration` seconds). Body = show notes + YouTube embed + "Timestamps" (`<p>` with `<br>`) + "Transcript" (h3 per chapter, `<p><strong>Speaker</strong></p>` + paragraphs). | | 13 |
| Paywall (web page only) | `div.paywall[data-testid="paywall"][data-component-name="Paywall"]` with `h2.paywall-title`, `div.paywall-cta`… — exists only in the rendered **web page**, outside the body. | | 0 in API/RSS bodies |
| Paywall (editor node) | `div.paywall-jump` / `PaywallToDOM` — **not observed** in anonymous API or RSS (we never see full paid bodies). Handled defensively as a cut marker. | | 0 |
| Not observed in 144 posts (handled generically) | audio embed, Instagram, TikTok, file embed, `captioned-button-wrap`, embedded-publication, community chat, native `<table>`, `<details>` | | |

### 3.3 Paid / gated posts (body behaviour)

| Case | `audience` | `body_html` | Marker? |
|---|---|---|---|
| Free | `everyone` | full | — |
| Paid with free preview (`should_send_free_preview: true`) | `only_paid` | truncated at the paywall point; footnote anchors before the cut remain, all footnote bodies are lost | **none** (ends mid-article, e.g. on a heading) |
| Paid without preview (ACX hidden thread) | `only_paid` | empty / null | — |
| RSS paid item | (no audience in RSS) | preview + trailing `<p><a href="{url}">Read more</a></p>` (per sibling report 03) | the "Read more" paragraph |
| `founding`, `only_free` | (not observed here) | presumably like paid for anonymous readers | assume gated |

---

## 4. Conversion spec

### 4.1 Output model

The converter builds a list of **blocks** `{text, quote, tight, kind}` then serialises:

- Blocks are joined by one blank line (`\n\n`); `tight` blocks (list items after the first, tweet body lines, nested
  embeds) by a single `\n`.
- Between two paragraphs of the same quote level the blank line keeps the rail: `\n>\n` (email style).
- `quote` level n → every line prefixed with `> ` × n.
- Final pass: `\n{3,}` → `\n\n`, trim, trailing ASCII spaces per line removed.
- Result object: `{ text, body, footnotes[], wordCount, paywalled }` (`text` = body + NOTES section).

### 4.2 Inline rules

| Input | Output |
|---|---|
| text node | normalizeChars → collapse `[ \t\n\r\f]+` to one space (NOT `\s`: that would eat NBSP-derived spaces we add later — irrelevant since source NBSP becomes a space first) |
| `em, strong, b, i, u, mark, small, span, a, code, kbd, cite, q, time` | children text only (no `*`, no URL, no backticks — backtick glyph is missing anyway) |
| `br` | `\n` |
| `a.footnote-anchor` | `[N]` if a footnote body with label N exists, else nothing (paywall-cut dangling anchors) |
| `span.mention-wrap` | `data-attrs.name` (no `@`; Substack renders the name) |
| `sup` | all digits → superscript digits `⁰¹²³⁴⁵⁶⁷⁸⁹` (all present in crylgrek); otherwise plain text (so `1<sup>st</sup>` → `1st`) |
| `sub` | all digits → subscript digits `₀…₉` (present); otherwise `_x` (`s<sub>i</sub>` → `s_i`) |
| `s, strike, del` | `~text~` |
| `img`, `picture` inline | nothing |
| `script, style, svg, button, form, input, iframe…` | nothing |

### 4.3 Block rules

| Pattern | Output | Rationale |
|---|---|---|
| `p` | paragraph | |
| `p` with only `<a>Read more</a>` | stop, mark paywalled | RSS paid preview tail |
| `h1`–`h6` | own block; UPPER-CASED if ≤ 60 chars, else as-is | No bold on G2; upper case is the only font-independent emphasis; long headings in caps are hard to read. Alternatives considered: `## ` prefix (cryptic for non-tech users), `■ `/`── x ──` (CJK-width glyphs from the `cn` font, 20 px each, look unknown). Paginator should keep a heading with the next line (avoid a heading as the last line of a page). |
| `blockquote`, `div.pullquote` | children with quote+1 → `> ` per line | `> ` = 15 px; `| ` (10 px) is an alternative; `│` U+2502 is a 20 px CJK glyph. |
| `ul` / `ol` | depth-1 bullets `• ` (14 px); depth 2 `– `; depth 3 `· `; ordered `N. ` honouring `start`; nested levels indented with 3×NBSP per level; extra paragraphs of an item indented 3 NBSP; first item preceded by blank line, others tight | `◦` (U+25E6) is missing from the fonts. |
| `pre` (+ `.highlighted_code_block` language) | `[Code: lang]` / `[Code]` header line, then lines verbatim: tabs → 2 spaces, leading spaces → NBSP, trailing spaces trimmed, chars normalised; optional `maxCodeLines` → `[… N more lines]` | Leading spaces would be eaten by the renderer. |
| `hr` | `* * *` (34 px); drop leading, trailing and consecutive rules | |
| `table` (defensive) | one tight line per row: `• h1: v1 · h2: v2` when a `th` header row exists and ≤4 columns, else `• v1 · v2` | Substack does not emit tables today. |
| `div.callout-block`, `div`, `section`, `figure` without image, unknown containers | transparent (render children) | |
| unknown element with `data-component-name` and no text | `[Embedded content]` | |

### 4.4 Substack component rules

| Component | Output |
|---|---|
| Image (`captioned-image-container`, `figure`, `.image2`, bare `img`) | `[Image: <figcaption text>]`, else `[Image: <alt>]` (alt attr or data-attrs.alt), else `[Image]` (or nothing with `bareImages:'drop'`). Consecutive bare images → `[N images]`. |
| Gallery | `[Gallery: N images — caption]` |
| Tweet | `[Tweet by Name (@user)]` then the tweet text as a quote (`> ` lines, tight); `quoted_tweet` → `> Quoting @user: text`. Decode `&amp; &lt; &gt; &quot; &#39;` in `full_text`, remove all `https://t.co/…`, collapse blank lines. Legacy `div.tweet` without data-attrs → textContent fallback. |
| YouTube / Vimeo / TikTok / native video | `[Video: YouTube]` / `[Video: Vimeo]` / `[Video: TikTok]` / `[Video]` (no titles in data-attrs; oEmbed would need another whitelisted host) |
| Spotify / Apple Podcasts | `[Audio: title — subtitle]` |
| Other audio | `[Audio]` |
| Embedded post, digest post | `[Linked post: <title> — <publication_name>]` (data-attrs first, DOM fallback); excerpt and "Read more" dropped |
| Datawrapper | `[Chart: <title> — <description>]` (title "Created with Datawrapper" treated as empty). **Optional v2:** `GET {url}dataset.csv` on `datawrapper.dwcdn.net` returns TSV with `Access-Control-Allow-Origin: *` (verified) → could render small tables row-wise; requires whitelisting that domain. |
| Code embed | `[Interactive embed: caption]` |
| Poll | `[Poll]` |
| LaTeX block | `[Formula: <latexToText(persistentExpression)>]` — e.g. `lr(N, D/N) = lr₀ · (N/N₀)^a · ((D/N)/((D/N)₀))^b`, `R = c - (q - c)²,`, `R(e) = R_task - λ(e)N_tokens` |
| Mention | name |
| Footnote bodies | collected in a pre-pass, removed from flow; `footnoteMode`: `'end'` (default) → `NOTES` heading + `[N] text` blocks (multi-paragraph notes joined with `\n`); `'inline'` → note block right after the paragraph that references it; `'omit'`. Only referenced notes are listed (in reference order). `footnotes[]` is always returned so the UI can offer an on-demand "notes for this page" view. |
| Buttons (`.button-wrapper`, `.captioned-button-wrap`), subscribe widgets (`.subscription-widget*`), sponsorship, `.image-link-expand`, install-app / community-chat / embedded-publication | dropped |
| Paywall markers (`.paywall`, `.paywall-jump`, `[data-component-name=Paywall|PaywallToDOM]`) | stop processing; `paywalled = true` |
| Gated post (`audience !== 'everyone'`) | append `[Preview ends here. The rest of this post is for paid subscribers.]`, or `[This post is for paid subscribers.]` if empty |

### 4.5 Recommended surrounding text (built by the app, not the converter)

Header page: title, subtitle, `By <publishedBylines[].name> · <date> · <N> min` (wordCount/230). For `type === 'podcast'`
add `Podcast episode · <podcast_duration/60> min (audio not available on glasses)`.

---

## 5. Display arithmetic (pretext 0.1.4 metrics, LIHKG layout)

- Body container in the sibling app: 552×197 at (12,43), padding 4 → **inner 544 × 189 px = 7 lines × 27 px**.
- Measured with the firmware tables: average English prose ≈ **8.5 px/char** → **~54–63 chars/line**, **~380–440 chars
  (~65 words) per 7-line page** (a 378-char sample wrapped to 7 lines at 544 px). An 8,000-word ACX essay ≈ 120+ pages.
- Prefix widths: `> ` 15 px · `| ` 10 · `• ` 14 · `– ` 20 · `· ` 10 · `1. ` 18 · `[1]` 21 · `* * *` 34 · 3×NBSP 15 ·
  `│ ` 25 · `■ ` 25 · `…` 10 vs `...` 15 · `—` 15.
- Break opportunities in pretext's model: only U+0020, `-` (U+002D) and CJK. NBSP is **not** a break → converting source
  NBSP to space keeps wrapping natural.
- Leading U+0020 at the start of any line is skipped (pretext comment: "LVGL does this implicitly") → indentation needs NBSP.
- Every missing glyph is measured as 4 px (firmware placeholder box_w=2 + 2) — invisible chars are NOT zero-width on G2.

---

## 6. Character normalization

### 6.1 Firmware font facts (from `node_modules/@evenrealities/pretext/dist/font_measure.js`, v0.1.4)

| Font | Coverage (code point runs) |
|---|---|
| `evenroster` (415, kerning) | 20–23, 25–5F, 61–7E, A0–A1, AB, B7, BB, BF–D6, D8–F6, F8–107, 10A–16B, 16E–17E, 192, 1A0–1A1, 1AF–1B0, Vietnamese 1EA0–1EF9, 2013–2014, 2018–201A, 201C–201E, 2022, 2026, 2039–203A, 2044 … (`$` 24 and backtick 60 are **not** here) |
| `evenroster_crylgrek` (299, kerning) | 20–40 (incl. `$`), A2–A3, A5–A7, A9, AC, AE, B0–B3, B6, B9, BC–BE, D7, F7, Greek 386–3CF, Cyrillic 401–45F/490–491, ฿, 2020–2022, 2030, 2070, 2074–2079, 2080–2089, ₩ € ₿, ™, ⅛–⅞, arrows 2190–2199, ∂ ∏ ∑ − √ ∞ ∫ ≈ ≠ ≤ ≥ ◊ ◌ |
| `cn` (ranges, default 320 = 20 px) | CJK, kana, Hangul jamo, full-width forms, box drawing 2500–2573, blocks 2581–258F, shapes ■ □ ▲ ▶ ◆ ○ ● ★ ☆, ⇒ ⇔ ∀ ∃ ∇ ∈ ∝ ≡ ⊂…, ①…, plus odd singletons U+00A4, U+00AA, **U+00AD (soft hyphen, 7 px)**, U+00BA, U+2010 (20 px), U+2015, U+2032/2033 primes |
| `evenemoji` (102) | space, NBSP and 100 emoji: ☺ ♥ ✅ ✨ ❤ 🌞 🌸 🌹 🎁 🎂 🎈 🎉 🎊 🎶 👀 👇 👈 👉 👋 👌 👍 👏 👑 💀 💋 💐 💓–💗 💙–💜 💞 💥 💩 💪 💯 💰 🔥 🖤 😀–😒 😔 😘 😚 😜 😞 😡 😢 😩 😬 😭 😱 😳 😴 🙁–🙄 🙈 🙋 🙌 🙏 🤍 🤎 🤔 🤗 🤞 🤣 🤤 🤦 🤩 🤪 🤭 🤷 🥰 🥳 🥴 🥵 🥺 |

pretext's README itself warns results "may be off for characters that are not present in the firmware fonts".

### 6.2 Substitution table (applied to every text node, data-attrs string and code line)

| Input | Present? | Output |
|---|---|---|
| ’ ‘ “ ” ‚ „ ‹ › « » | yes (evenroster) | keep |
| ‛ U+201B, ‟ U+201F | no | ‘ / “ |
| ʼ U+02BC, ʻ U+02BB, ʹ U+02B9, ʺ U+02BA, ´ U+00B4, ‵ U+2035 | no | ’ ‘ ' " ' ' |
| backtick U+0060 | **no** | `'` |
| – U+2013, — U+2014 | yes (15 px) | keep |
| ‐ U+2010 (20 px CJK), ‑ U+2011, ‒ U+2012, ⁃ U+2043, ﹘ ﹣ | no / too wide | `-` |
| ― U+2015 | cn only | — |
| ⸺ ⸻ | no | —— / ——— |
| − U+2212 | yes | keep |
| … U+2026 | yes (10 px) | keep (do not expand `...` either way) |
| ⋮ ⋯ | no | … |
| NBSP U+00A0, U+2000–200A, U+202F, U+205F, U+1680, U+3000, U+0085, U+2028/2029 | NBSP yes, others no | ASCII space (our own indentation NBSPs are added after normalization) |
| soft hyphen U+00AD, ZWSP/ZWNJ/ZWJ/LRM/RLM U+200B–200F, bidi U+202A–202E, U+2060–206F, BOM U+FEFF, CGJ U+034F, ALM U+061C, U+180E, variation selectors FE00–FE0F, keycap U+20E3, tags E0000–E01FF, skin tones 1F3FB–1F3FF, regional indicators 1F1E6–1F1FF | no (or visible) | delete |
| • U+2022, · U+00B7 | yes | keep |
| ‣ ◦ ▪ ▫ | no | • |
| ∙ ⋅ | no | · |
| ▸ ▹ ► ▻ | no | › |
| ⟶ ➔ ➜ ➡ / ⟵ ⬅ | no | → / ← |
| ✓ ✔ ☑ | no | √ (U+221A, crylgrek) |
| ✗ ✘ ✕ ✖ ❌ | no | × |
| µ U+00B5 | no | μ U+03BC |
| ∗ ∼ ∕ ∶ | no | * ~ / : |
| 🔴🟠🟡🟢🔵🟣🟤⚫⚪ 🟥🟧🟨🟩🟦🟪🟫⬛⬜ | no | (red) (orange) … — colour legends are meaningless on a monochrome display |
| ⚠ U+26A0 | no | (!) |
| Anything else not covered (runtime `getAdvW(cp) === 0`) | — | 1) NFKD minus combining marks if the result is covered (ﬁ→fi, Ĉ→C, ⅓→1⁄3, ‼→!!, ⁺→+); 2) Extended_Pictographic → delete (🚀 📊 🕒, ZWJ families); 3) otherwise a run of such chars (incl. spaces between) → `[?]` (Hebrew, Arabic, Devanagari, Thai…) |
| Supported emoji (😀 ❤ 👍 🔥 …) | yes | keep (rendered monochrome; a user setting "strip all emoji" is reasonable) |

Order: `NFC` → delete invisibles → spaces → map table → colour emoji → coverage fallback (only when `isCovered` is supplied).

---

## 7. DOMParser in the WebView — recommendation and pitfalls

**Use it** (`new DOMParser().parseFromString(html, 'text/html')`, or `<template>.innerHTML` as the sibling LIHKG app does).

- Verified in Chromium: no fetch of `img/srcset/iframe/svg image`, no `onerror`, no `<script>` execution; `d.images.length`
  still reflects the markup. Danger only arises if nodes are adopted into `document` or assigned to a live element's
  `innerHTML` — never do that; the glasses get text only, and the phone UI should also render escaped text.
- `doc.baseURI` = the WebView page URL, so relative `href`s would resolve against the plugin origin; irrelevant because
  links are dropped (if ever needed: `new URL(href, post.canonical_url)`).
- Don't use `innerText` (needs layout; detached documents give textContent semantics anyway) and don't use bare
  `textContent` on the body (loses block boundaries, picks up `<script>` text inside Datawrapper wrappers, misses empty
  data-attrs embeds).
- Skip `script, style, noscript, template, svg, math, button, form, input, select, textarea, source, object, embed,
  canvas, map, link, meta, head, title`; iframes become placeholders; classify embeds *before* skipping iframes
  (Spotify's component element is an `<iframe>`).
- `data-attrs` comes back entity-decoded from `getAttribute`; `JSON.parse` inside try/catch.
- Footnote anchors are `<a>` → handle before generic link flattening.
- Requirements: `String.prototype.normalize`, Unicode property escapes (`\p{M}`, `\p{Extended_Pictographic}`, `\p{L}`),
  regex lookbehind in `latexToText` — Chrome ≥ 64/62; any current Android System WebView / WKWebView (iOS 16.4+ for
  lookbehind) is fine. `Intl.Segmenter` not needed by the converter.
- Performance: 0–16 ms per post on desktop Chromium for 1–355 KB bodies (largest: 17.9k-word transcript 15 ms). Expect
  ~3–5× on a phone WebView; still negligible. Cache the converted text, not the HTML.

---

## 8. Reference implementation summary (`04-htmlToReaderText.ts`)

```ts
export function htmlToReaderText(html: string | null | undefined, opts?: {
  audience?: string | null; expectedWordCount?: number | null;
  footnoteMode?: 'end' | 'inline' | 'omit'; bareImages?: 'placeholder' | 'drop';
  uppercaseHeadingMax?: number /* 60 */; maxCodeLines?: number;
  isCovered?: (cp: number) => boolean /* cp => getAdvW(cp) > 0 */
}): { text: string; body: string; footnotes: { label: string; text: string }[]; wordCount: number; paywalled: boolean }
export function normalizeChars(s: string, isCovered?: (cp: number) => boolean): string
export function latexToText(expr: string): string
```

Structure: footnote pre-pass (collect + remove `div.footnote`) → `renderChildren` (buffers inline content, flushes on
block children) → `renderBlock` (component dispatch by class / data-component-name, then generic HTML) → `renderList` /
`renderCode` / `renderTable` → `cleanup` (hr + bare-image runs) → `serialize` (quote rails, tight joins) → paywall note →
NOTES. `wordCount` = whitespace tokens containing a letter/digit (CJK under-counts; fine for minutes-left).

Integration tips:
- Production call: `htmlToReaderText(post.body_html, { audience: post.audience, expectedWordCount: post.wordcount, isCovered: cp => getAdvW(cp) > 0 })`.
- Then pass `text` to the existing `paginateText()` (LIHKG `pagination.ts`). Its `normalizeReaderText` only collapses
  `\n{3,}` and control chars, so it is compatible; keep its "skip whitespace at page start" behaviour (NBSP is `\s` in JS,
  so an indented continuation line at a page boundary would lose its indent — acceptable).
- Optional improvement: pre-wrap lines yourself with pretext so quote prefixes / hanging indents repeat on every visual
  line (today only the first line of a wrapped paragraph carries `> ` or the list indent).
- The file is ASCII-only on purpose: an editor/tool that decodes `\u` escapes into literal U+2028 inside a regex literal
  produced a JS syntax error during this research — keep escapes.

---

## 9. Validation

### 9.1 Fixtures (headless Edge, TS 5.6.3 transpile, pretext 0.1.4 coverage)

| Fixture | Covers | Result |
|---|---|---|
| 01-essay-footnotes | p/em/strong/a, entity, h2 upper-case, long h3 not upper-cased, 2-paragraph blockquote rail, whitespace collapse, hr, 2 footnotes (one multi-paragraph) → NOTES | PASS |
| 02-images-embeds | captioned image (caption with link + en dash), alt-only image, 2 bare images → `[2 images]`, gallery, tweet (entity, t.co, quoted tweet), YouTube, embedded post, digest post, Spotify iframe, Datawrapper with `<script>`, subscribe widget, Share button, sponsorship, native video | PASS |
| 03-lists-code-math | nested ul (– bullets, NBSP indent), multi-paragraph li, `ol start=3`, inline code, sub/sup digits and letters, `<s>`, shiki block with indentation + backtick, `pre>code>code`, LaTeX block | PASS |
| 04-paywalled-preview | `audience: only_paid`, dangling footnote anchor dropped, poll, h4, `div.paywall-jump` cut (text and orphan footnote after it suppressed) | PASS |
| 05-glyphs-mentions | NBSP, ZWSP, soft hyphen, smart quotes, U+2011/2012, µ, ﬁ, ✓, ▸, supported/unsupported emoji, VS16, skin tone, flag, ZWJ family, colour legend emoji, Ĉ (NFKD fallback), Greek, Cyrillic, CJK, Hebrew → `[?]`, mention, callout-block h5, pullquote | PASS |
| 06-podcast-transcript | show-notes links, YouTube, span-wrapped headings, `<br>` timestamps, empty `<p>`, transcript h3 + bold speaker labels | PASS |
| extra checks | `footnoteMode:'inline'`, `bareImages:'drop'`, `maxCodeLines:2`, no-`isCovered` mode, RSS "Read more" tail → paywalled | as designed |

### 9.2 Live posts (built-in Chromium, `substack.com/api/v1/posts/by-id/{id}`, without `isCovered`)

| Post (type, audience) | API wc | extracted wc | ratio | notes | placeholders |
|---|---|---|---|---|---|
| ACX Georgism (essay) | 8069 | 8111 | 1.01 | 14 | Image 23 |
| ACX Hidden thread (paid, no preview) | 20 | 0 | 0 | 0 | "[This post is for paid subscribers.]" |
| ACX Open Thread 454 | 188 | 182 | 0.97 | 0 | — |
| ACX Pinker letter | 10538 | 10467 | 0.99 | 0 | Image 14, Tweet 1 |
| ACX Specter of Neuralese | 3037 | 2994 | 0.99 | 5 | Image 10 |
| ACX Genji review | 9885 | 9885 | 1.00 | 0 | Image 3 |
| Construction Physics reading list (paid) | 1889 | 716 | 0.38 | 0 | Image 6, Preview ends |
| Dwarkesh pretraining (LaTeX) | 2617 | 2659 | 1.02 | 7 | Chart 7, Formula 1 |
| Dwarkesh Si Sheppard (podcast) | 17070 | 16967 | 0.99 | 0 | Video 1 |
| Dwarkesh John/Beren/Charlie (podcast) | 17917 | 17629 | 0.98 | 0 | Video 1 |
| Experimental History "I like 'em thick" | 3499 | 3490 | 1.00 | 5 | Image 9, Gallery 1 |
| Experimental History loneliness | 3371 | 3354 | 0.99 | 9 | Image 12 |
| Free Press "Rage at Cornell" | 826 | 933 | 1.13 | 0 | Linked post 8, Image 4 |
| J.M. Elliott pull quotes | 1955 | 1960 | 1.00 | 0 | Image 4 |
| Noahpinion Trump (paid preview) | 2933 | 841 | 0.29 | 0 | Image 4, Linked 1, Tweet 4, Preview ends |
| Noahpinion Roundup #89 | 2565 | 2743 | 1.07 | 1 | Image 17, Linked 3, Tweet 1, Video 1 |
| nsokolsky tables | 415 | 421 | 1.01 | 0 | Chart 2 |
| Pragmatic Engineer Windows (paid) | 6718 | 2982 | 0.44 | 0 | Image 14, Poll 1, Preview ends |
| Raschka classifiers (code) | 7934 | 8259 | 1.04 | 0 | Image 39, Linked 3, Video 2, Code 5, Formula 2 |
| RGBI tables | 1030 | 1035 | 1.00 | 0 | Image 10, Chart 1, Linked 1 |
| Silver Iran war | 595 | 651 | 1.09 | 7 | Image 1, Chart 2 |
| Silver Ohio | 1729 | 1724 | 1.00 | 3 | Video 1, Audio 1, Chart 1, Image 2 |
| Simon Willison Jev | 3728 | 3892 | 1.04 | 0 | Image 3, Video 1, Code 1 |

No leftovers of "Subscribe now", "Type your email", "Read more", "Share", "Leave a comment", "Upgrade to paid" in any
output. Longest unbroken token 125 chars (URL in code) — the paginator's hard-break path handles it. Datawrapper titles
were sometimes the literal "Created with Datawrapper" (now filtered).

---

## 10. Sources

- Substack endpoints (live): `https://www.astralcodexten.com/api/v1/posts/does-georgism-work-five-years-later`,
  `https://www.noahpinion.blog/api/v1/posts/roundup-89-it-isnt-x-its-y`, `https://www.noahpinion.blog/feed`,
  `https://substack.com/api/v1/posts/by-id/218257713`, `https://www.natesilver.net/api/v1/posts/why-did-ohio-stop-being-a-swing-state`,
  `https://www.dwarkesh.com/api/v1/posts/pretraining-progress-is-mostly-data`,
  `https://magazine.sebastianraschka.com/api/v1/posts/classifier-history-and-jev`,
  `https://jmelliott.substack.com/api/v1/posts/block-quotes-and-pull-quotes`, `https://datawrapper.dwcdn.net/eRY6E/1/dataset.csv`
  (ACAO `*`), and the other posts listed in §2/§9.
- `@evenrealities/pretext@0.1.4` README + `dist/font_measure.js` / `.d.ts` (local, in the LIHKG repo's node_modules).
- LIHKG reader `src/content.ts` (template-based HTML→text) and `src/pagination.ts` (7-line pages, 544 px, NBSP/whitespace handling).
- Web: Substack table workaround posts (nsokolsky.substack.com, reallygoodbusinessideas.com) confirming no native tables;
  dev.to article on Substack scrapers confirming "paywall status is inferred from `audience`".

---

## 11. Open questions / uncertainties

- Leading-space stripping and NBSP rendering at line start are taken from pretext's model ("LVGL does this implicitly");
  not verified on real G2 hardware. If the firmware keeps leading spaces, NBSP still works.
- How the firmware actually draws missing glyphs (pretext models a 4 px placeholder) and how `cn`-font box-drawing / shape
  glyphs (│ ■ ▶) look on the display — untested; the spec deliberately avoids them.
- Whether the 100 emoji of `evenemoji` render legibly in monochrome; offer a "strip all emoji" setting.
- Paywall markers inside *authorised* full bodies (`paywall-jump` / `PaywallToDOM`) are inferred, not observed (anonymous
  access never returns them). Audiences `founding` / `only_free` were not observed.
- Heading style (UPPER CASE ≤60 chars) and `[Image]` placeholders for caption-less images (~2/3 of images) are UX
  judgements — validate with users; `bareImages:'drop'` and `uppercaseHeadingMax:0` exist as switches.
- Poll contents, YouTube titles and Datawrapper data need extra endpoints/domains (poll API unknown + CORS; YouTube oEmbed;
  `datawrapper.dwcdn.net` has CORS `*` and could be whitelisted).
- Word counts: extracted/API ratio 0.97–1.13 on free posts (placeholders and link-post titles inflate it slightly); a
  `< 0.8` ratio is a usable secondary truncation signal when `audience` is unknown (e.g. RSS without the "Read more" tail).
- The reference TS was transpiled and executed, but not full-program type-checked (no lib.dom in the harness); expect
  minor `strict`-mode typing fixes (e.g. `any` from `data-attrs`) when dropped into the project.
