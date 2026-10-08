# 01 — Reusable patterns from `lihkg-reader-for-evenhub` (reference project)

Source inspected (read-only): `C:/Code/lihkg-reader-for-evenhub` at HEAD `f8a6074` ("Record verified Android alpha and Even Hub Beta delivery"), package version `0.4.0`, GitHub `CHL-work/lihkg-reader-for-evenhub`. Research date 2026-10-06.

Target repo `C:/Code/substack-reader-for-evenhub` currently contains only `README.md` (29 bytes: `# substack-reader-for-evenhub`, no trailing newline), one commit `8e8ad30 Initial commit`.

---

## 0. Inventory and dependency versions

Tracked files (excluding `android/`): `.env.example`, `.gitattributes`, `.github/workflows/{ci,release,android,companion-live}.yml`, `.gitignore`, `.openai/hosting.json`, `README.md`, `app.json`, `db/schema.ts`, `docs/*.md`, `docs/releases/*.md`, `drizzle.config.ts`, `drizzle/*`, `index.html`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `public/icon.svg`, `scripts/*.mjs` (+ one `.py`), `src/*.ts` + `src/styles.css`, `tsconfig.json`, `vite.config.ts`, `worker/{index,companion,landing}.ts`, `wrangler.toml`.

Line counts: `src/main.ts` 498, `src/glasses.ts` 199, `src/pagination.ts` 143, `src/storage.ts` 186, `src/api.ts` 205, `src/companion.ts` 189, `src/types.ts` 89, `src/links.ts` 92, `src/content.ts` 18, `src/account.ts` 2, `src/styles.css` 14 (minified-style single lines), `scripts/ci-tests.mjs` 721, `scripts/ui-ci.mjs` 598, `scripts/pack.mjs` 25, `worker/index.ts` 258, `worker/companion.ts` 242.

`package.json` (exact):
```json
{
  "name": "lihkg-reader-for-evenhub", "version": "0.4.0", "private": true, "type": "module",
  "packageManager": "pnpm@10.32.1",
  "scripts": {
    "check": "tsc --noEmit",
    "build": "tsc --noEmit && vite build && esbuild worker/index.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=dist/server/index.mjs",
    "pack": "node scripts/pack.mjs",
    "test:ci": "node scripts/ci-tests.mjs",
    "test:ui:ci": "node scripts/ui-ci.mjs",
    "test:companion:ci": "node scripts/companion-ci.mjs",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": { "@evenrealities/even_hub_sdk": "0.0.16", "@evenrealities/pretext": "0.1.4" },
  "devDependencies": {
    "@evenrealities/evenhub-cli": "0.1.14", "@playwright/test": "1.63.0", "@types/node": "^22.0.0",
    "drizzle-kit": "0.31.9", "drizzle-orm": "0.45.2", "esbuild": "^0.25.0", "typescript": "^5.9.0", "vite": "^6.4.0"
  }
}
```
Lockfile resolves: typescript 5.9.3, vite 6.4.3, esbuild 0.25.12, @types/node 22.20.4, lockfileVersion 9.0.
`pnpm-workspace.yaml`: `allowBuilds:\n  esbuild: true` (pnpm 10 requires explicit approval of esbuild's postinstall).
`.gitattributes`: `* text=auto eol=lf`, `*.ehpk binary`, `*.png binary`.
`.gitignore`: `node_modules/ dist/ artifacts/ .env .env.* !.env.example *.log .wrangler/ coverage/ *.session.json research/` + android build dirs + `*.jks *.keystore`.
`.env.example`: `# Public origin of the deployed, stateless LIHKG gateway; never a credential.\nVITE_API_BASE_URL=`.

`tsconfig.json`: target ES2022, lib [ES2022, DOM, DOM.Iterable], module ESNext, moduleResolution Bundler, strict, skipLibCheck, noEmit, isolatedModules, resolveJsonModule, types [vite/client, node]; include [src, worker, vite.config.ts].

`vite.config.ts`: `base: './'` (relative asset URLs — required because the packaged app is loaded from a local package, not a web root), `build: { target: 'es2022', sourcemap: false }`, plus an inline plugin `reader-build-metadata` whose `generateBundle()` emits `build-info.json` = `{ version (from package.json), apiOrigin: process.env.VITE_API_BASE_URL || '' }`. `pack.mjs` later cross-checks this file.

`index.html`: `<html lang="zh-Hant">`, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `<meta name="theme-color" content="#f7f6f2">`, `<meta name="referrer" content="no-referrer">`, `<title>連登隨讀 · Even G2</title>`, `<div id="app"></div>`, `<script type="module" src="/src/main.ts">`.

`public/icon.svg` (339 bytes, original): 512×512 viewBox, rounded square `rx=112` filled `#272922` (near-black olive), a yellow `#f4ec72` "document page" shape with folded top-right corner (`#b9b455` fold), and three dark horizontal rounded strokes (text lines, last one shorter). Generic "document/reader" glyph — reusable as a template for a Substack icon (e.g. swap palette to Substack orange `#ff6719`), but must be original art; do not use Substack's logo/brand mark (impersonation/branding risk).

`app.json` (template; permissions are deliberately empty and injected at pack time):
```json
{ "package_id": "com.chlwork.lihkgreader", "edition": "202601", "name": "LIHKG Reader Alpha", "version": "0.4.0",
  "min_sdk_version": "0.0.16", "entrypoint": "index.html", "permissions": [], "supported_languages": ["zh", "en"] }
```

---

## 1. Module-by-module reuse assessment (with exact exports)

### 1.1 `src/pagination.ts` — GENERIC, reuse nearly verbatim

Imports `measureTextWrap, pxTruncate` from `@evenrealities/pretext`.

Exports:
```ts
export const G2_DISPLAY_WIDTH = 576
export const G2_DISPLAY_HEIGHT = 288
export const G2_LINE_HEIGHT = 27
export const G2_TEXT_PADDING = 4
export const G2_LAYOUT = {
  title:  { xPosition: 12, yPosition: 4,   width: 552, height: 27 + 8 },        // 552 × 35
  body:   { xPosition: 12, yPosition: 43,  width: 552, height: 7 * 27 + 8 },    // 552 × 197
  footer: { xPosition: 12, yPosition: 249, width: 552, height: 27 + 8 },        // 552 × 35
} as const   // (source writes width as G2_DISPLAY_WIDTH - 24, heights via G2_LINE_HEIGHT/G2_TEXT_PADDING)
export const READER_BODY_WIDTH  = G2_LAYOUT.body.width  - 2 * G2_TEXT_PADDING   // 544
export const READER_BODY_HEIGHT = G2_LAYOUT.body.height - 2 * G2_TEXT_PADDING   // 189 = 7 lines
export const MAX_PAGE_UTF8_BYTES = 1800
export interface PaginationBox { width: number; height: number }
export function normalizeReaderText(source: string): string
export function paginateText(source: string, box?: PaginationBox /* default {READER_BODY_WIDTH, READER_BODY_HEIGHT} */): string[]
export function truncateGlassesLabel(source: string): string
export function isReaderPage(text: string): boolean
```
Behaviour:
- `normalizeReaderText`: CRLF/CR → LF; tab → 2 spaces; strips C0 controls except `\n` (regex `[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]`); collapses 3+ newlines to 2; trim. Preserves variation selectors and ZWJ.
- Internal `textUnits(text)`: uses `Intl.Segmenter('zh-Hant', {granularity:'grapheme'})` if present (structural type cast so older WebViews/TS libs compile), else `Array.from` code points; any grapheme > 1800 UTF-8 bytes is split into code points.
- `paginateText`: throws `RangeError` if box width < 32 or height < 27 or non-finite. Empty → `['']`. For each page: binary search on number of units (upper bound `start + MAX_PAGE_UTF8_BYTES` since every unit ≥1 byte) for the largest prefix where UTF-8 bytes ≤ 1800 AND `measureTextWrap(candidate, box.width).height <= box.height`. If nothing fits, forces 1 unit (never infinite loop). Latin word guard: if the cut falls between two `[\p{Script=Latin}\p{Number}]` chars, search backwards (at most 32 units and not before 75% of the page) for a whitespace or `-` boundary. Page text is `.trim()`ed; leading whitespace units after a boundary are skipped (avoids pages of blank lines). Joined pages reproduce text minus boundary whitespace (CI asserts `pages.join('')` equals input for CJK and whitespace-stripped equality for mixed text).
- `truncateGlassesLabel`: normalize, collapse whitespace to single spaces, cap 160 graphemes with `...`, then `pxTruncate(bounded, READER_BODY_WIDTH)` (544 px, single line).
- `isReaderPage`: bytes ≤ 1800 and measured height ≤ 189. Used by the renderer as a guard.

LIHKG-specific bits to change: Segmenter locale `'zh-Hant'` (use `undefined` or `'en'`; grapheme segmentation is locale-insensitive in practice), comments mentioning Cantonese/forum. Everything else is content-agnostic and is exactly what a Substack article pager needs. For English prose, consider strengthening the word guard (pretext already wraps at spaces inside a page; the guard only matters at page boundaries).

The 1800-byte cap comment: "Keep a margin below the text-upgrade payload limit" — the actual native limit is not documented in SDK 0.0.16 `.d.ts`/README (see open questions). English text at 7 lines × ~544 px is ~400–500 bytes, so the byte cap only bites for CJK/emoji-heavy text.

### 1.2 `src/glasses.ts` — GENERIC, reuse with string/i18n parameterization

Imports from `@evenrealities/even_hub_sdk`: `CreateStartUpPageContainer, DeviceConnectType, OsEventTypeList, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge`; from `./pagination`: `G2_LAYOUT, G2_TEXT_PADDING, isReaderPage, normalizeReaderText, truncateGlassesLabel`.

Exports:
```ts
export type GlassesAction = 'next' | 'previous' | 'select' | 'back' | 'exit'
export interface GlassesStatus { state: 'connecting' | 'ready' | 'disconnected' | 'error' | 'closed'; message: string }
export interface GlassesPage { title: string; /** one page from paginateText() */ body: string; footer: string }
export interface GlassesController {
  render(page: GlassesPage): Promise<void>
  /** Opens the native exit layer; cancellation leaves the reader usable. */
  exit(): Promise<void>
  /** Unsubscribe and reject new writes; does not force-close the native app. */
  dispose(): void
}
export async function connectGlasses(
  onAction: (action: GlassesAction) => void | Promise<void>,
  onStatus?: (status: GlassesStatus) => void,
): Promise<GlassesController>
```
LIHKG-specific parts to replace: the hard-coded `initialPage` (`title: 'LIHKG Reader'`, Chinese body "請先在手機設定書籤及頻道…", footer `'點按選取 | 雙按離開'`), and all Chinese status messages ("正在連接 Even G2…", "Even G2 已連接。", "Even G2 已斷線；請在 Even app 重新連接。", "Even G2 閱讀器已關閉。"). Suggest adding an optional `initialPage` and `messages` parameter. Error messages thrown on native rejection are already English.

Full design is described in §2.

### 1.3 `src/storage.ts` — PATTERN reusable, schema LIHKG-specific

Exports:
```ts
export type { ReaderBookmark, ReaderBookmarkInput, ReaderMenuId, ReaderPreferences, ReadingPosition } from './types'
export const READER_MENU_IDS: readonly ReaderMenuId[]   // ['bookmarks','channels','history','hot','newest','accountbookmarks','accounthistory']
export const DEFAULT_MENU: readonly ReaderMenuId[]      // ['bookmarks','channels','history']
export const MAX_BOOKMARKS = 100, MAX_HISTORY = 100, MAX_CHANNELS = 150
export function createDefaultPreferences(): ReaderPreferences
export function isReaderMenuId(value: unknown): value is ReaderMenuId
export function canonicalThreadUrl(id: string, page = 1): string | null
export function normalizePreferences(input: unknown): ReaderPreferences
export function readPreferences(userId: string): ReaderPreferences
export function savePreferences(userId: string, preferences: ReaderPreferences): boolean
export function recordPosition(preferences: ReaderPreferences, position: ReadingPosition): void
export function upsertBookmark(preferences: ReaderPreferences, input: ReaderBookmarkInput): boolean
export function removeBookmark(preferences: ReaderPreferences, id: string): boolean
export function reorderItem<T>(items: T[], from: number, to: number): boolean      // fully generic
export function moveBookmark(preferences: ReaderPreferences, id: string, delta: number): boolean
export function setSelectedChannels(preferences: ReaderPreferences, ids: readonly string[]): void
export function rememberChannelNames(preferences: ReaderPreferences, channels: readonly Pick<Channel,'id'|'name'>[]): void
export function moveChannel(preferences: ReaderPreferences, id: string, delta: number): boolean
export function setMenu(preferences: ReaderPreferences, ids: readonly ReaderMenuId[]): void
export function moveMenuItem(preferences: ReaderPreferences, id: ReaderMenuId, delta: number): boolean
```
Reusable patterns:
- Storage key namespace `lihkg-reader:<userId>` (`guest` or numeric id); `MAX_SAVED_CHARACTERS = 256000`; read: `try { localStorage.getItem → length cap → JSON.parse → normalizePreferences } catch { defaults }`; save: normalize → stringify → size check → `localStorage.setItem`; returns `false` on any failure so the UI can say "could not save".
- Defensive normalizers: `record(value)`, `text(value, limit)` (strip control chars, trim, slice), `timestamp`, `uniqueItems(value, parse, limit)` (dedupe by `id`, cap), `menuFrom` (dedupe, filter allowlist, never empty → default).
- `schemaVersion: 2` migration that never mutates the input and keeps old fields' order.
- Ordered lists with up/down moves via `reorderItem` (never clamps/wraps).
- Bookmarks: new appends; updating keeps slot and `addedAt`; overflow returns `false` without evicting.
- History: MRU, deduped by id, capped.
LIHKG-specific: numeric ID regex `/^[1-9]\d{0,19}$/`, `canonicalThreadUrl` (`https://lihkg.com/thread/<id>/page/<n>`), channels/channelNames, the 7 menu ids, per-account namespaces. For Substack: IDs become publication host (`<sub>.substack.com` or custom domain) + post slug or numeric post id; "channels" → followed publications; history position = `{pubHost, postId/slug, title, slice, updatedAt}`.

Note: the project uses `window.localStorage` (wrapped in try/catch), NOT the SDK's `bridge.setLocalStorage/getLocalStorage`. Persistence across Even app launches is asserted only in Chromium CI (reload), not documented as device-verified.

### 1.4 `src/content.ts` — GENERIC (HTML → inert text), extend for Substack

```ts
export function postText(html: string): string
export function escapeHtml(value: unknown): string   // & < > " ' → entities
```
`postText`: `document.createElement('template')`, `template.innerHTML = html` (template content is an inert document: no script execution, no resource loads), removes `script,style,iframe,object,embed,form,svg,math,video,audio,source,link,meta,base`; `img` → text `[alt || '圖片／貼圖']`; `br` → `\n`; `blockquote` → wrapped in `\n[引用]\n … \n[/引用]\n`; `p,div,li` get a trailing `\n`; result = `textContent` with NBSP→space, 3+ newlines → 2, trimmed; empty → `'[沒有文字內容]'`. Untrusted markup is never attached to the live DOM.
For Substack body_html: add headings (h1–h6 → own paragraphs, maybe uppercase/marker), `ol/ul li` bullets/numbers, `pre/code`, `figure/figcaption` (caption text), `hr` → separator, drop Substack chrome (subscribe widgets / buttons / share / footnote anchors), and translate placeholder labels to English.

### 1.5 `src/links.ts` — LIHKG-specific; reuse the *validation style* only

`export interface ThreadLink { id: string; page: number }`, `export function parseThreadLink(input: string): ThreadLink | null`. Decodes official `lih.kg` bijective-base short links. Patterns worth copying for a Substack URL parser: input length cap 8192; reject control chars and `javascript:|data:|file:`; require exactly one URL in share text; strip trailing punctuation; explicit `^https://` authority check before `new URL`; reject username/password/port/`#`/`\`; compare original path to normalized `url.pathname` (rejects `..`/`%2e`/`%2f` tricks); strict query allowlist. Never fetch the pasted URL itself—only validated ids go to a fixed API. Note: the owner removed paste-a-link/paste-text reading flows in 0.2.1/0.3.0 because they wanted real browsing, not manual input (see §6.4).

### 1.6 `src/types.ts` — LIHKG-specific; replace

Types: `LihkgSession {token,user_id,device,isPlusUser?}`, `LihkgGuest {device}`, `UserProfile {id,nickname,isPlus,selectedChannelIds}`, `Channel {id,name,selected}`, `ThreadSummary {id,title,author,channelId,replyCount,pageCount,lastReadPage}`, `ThreadList {items,hasMore,page}`, `Post {id,number,author,html,page}`, `ThreadPage {thread,page,pageCount,posts}`, `LihkgOperation = 'profile'|'bookmarks'|'history'|'channels'|'threads'|'thread'`, `ReaderMenuId`, `ReadingPosition {id,title,page,slice,updatedAt}`, `ReaderBookmark {id,title,page,url,addedAt}`, `ReaderBookmarkInput`, `ReaderPreferences {schemaVersion:2, channels: string[]|null, channelNames, history, bookmarks, menu}`.
Shape analogues for Substack: `Publication {host,name}`, `PostSummary {id,slug,title,subtitle,author,date,audience/paywalled,wordcount}`, `PostList {items,hasMore,offset}`, `Article {post, html|text}`.

### 1.7 `src/api.ts` — transport PATTERN reusable; LIHKG operations not

Exports: `class ApiError extends Error { constructor(public readonly code: string, message: string) }`, `isApiConfigured(): boolean`, `apiOrigin(): string | null`, `parseSession(raw: string): LihkgSession`, `class LihkgApi { constructor(session?: LihkgSession|null, companion?: CompanionClient|null|undefined); profile(); channels(); bookmarks(page); history(page); threads(channelId, page, selectedIds?); thread(id, page) }`.
Reusable:
- `configuredBase = String(import.meta.env.VITE_API_BASE_URL || '').trim()`; `isApiConfigured()` requires `https:` and no username/password/search/hash and pathname `/`; `apiOrigin()` returns `new URL(configuredBase).origin`. "No URL, query parameter, or imported session is allowed to choose credential egress."
- Request: `fetch(`${origin}/api/lihkg`, { method:'POST', credentials:'omit', cache:'no-store', redirect:'error', headers:{'Content-Type':'application/json'}, body: JSON.stringify({operation, ...identity, params}), signal })` with `AbortController` 20 s timeout; envelope `{ ok: true, data }` / `{ ok:false, error:{code,message} }`; any non-ApiError → `ApiError('NETWORK_ERROR', …)`; not configured → `ApiError('NOT_CONFIGURED', …)` with "No request was sent."
- Response normalizers `record/number/string/positivePage` that never trust upstream shapes.
LIHKG-specific: guest device id (`lihkg-reader-guest-device-v1`, 40 hex chars), session parsing, `normalizeThread/normalizeList`, LIHKG field names, companion routing.

### 1.8 `src/companion.ts`, `src/account.ts`, `android/`, `worker/companion.ts`, `db/`, `drizzle/` — LIHKG-specific, do not port

`companion.ts`: AES-GCM encrypted mailbox client (pairing code 64 hex, SHA-256 derivations with prefix `lihkg-companion-v1:`, command/poll/ack, 12 s fetch timeout, 65 s poll loop every 2 s, 750 KB response cap). `account.ts`: a `javascript:` bookmarklet that exports LIHKG `localStorage.user/device` as JSON. Not needed for Substack (public RSS/JSON). Mention only as precedent if a phone-side companion ever becomes necessary.

Android summary (one paragraph): `android/` is a separate Java 17 app `com.chlwork.lihkgcompanion` 0.1.0-alpha.1 (minSdk 26, compile/target SDK 35, AGP 8.9.2, Gradle 8.11.1, AndroidX WebKit 1.12.1) created because LIHKG returned HTTP 403 to the cloud gateway. It hosts the real lihkg.com site in a WebView, injects `observer.js` at document start (via `WebViewCompat.addWebMessageListener`/document-start script restricted to `https://lihkg.com`, main frame, per-command nonce) to observe the site's own GET JSON responses, normalizes allowlisted fields, encrypts them and posts them through the D1 mailbox relay to the Even plugin; a user-started `dataSync` foreground service keeps it alive. Signed via GitHub secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`). Physical acceptance still pending at HEAD. Irrelevant for Substack unless Substack also blocks cloud egress and CORS.

### 1.9 `src/main.ts` — architecture PATTERN reusable; content LIHKG-specific

Single-module state machine (no framework). Key reusable ideas:
- Types: `View = 'home'|'channels'|'list'|'reader'` (G2 navigation) and `PhonePanel = 'home'|'menu'|'bookmarks'|'channels'|'browse'|'account'` (phone config) are **independent**; editing settings on phone never replaces what G2 is reading (`configurationChanged()` only refreshes local lists and clamps selection when not in reader).
- Async control: `run(action, target: 'phone'|'glasses')` with flags `busy`, `busyTarget`, `errorTarget`, `error`, `notice`, `retryAction`, and a monotonically increasing `generation` counter; every async step captures `current = generation` and drops results if it changed (abandon-on-navigation). `setPanel()` bumps generation if a phone fetch is in flight.
- While a *phone* fetch is busy, G2 can still page through already-loaded slices (`activate()` special-case).
- Reader model: on open, each post becomes `paginateText(`#${number} ${author}\n\n${postText(html)}`)` slices `{text, postNumber}`; `sliceIndex`; `advance(±1)` moves within slices, else fetches next/previous upstream page (backwards lands on last slice). `rememberPosition()` writes `{id,title,page,slice,updatedAt}` to history on every move, plus on `pagehide` and `visibilitychange→hidden`. Resume uses saved page+slice.
- `onGlassesAction(action)`: `exit` → `glasses.exit()`; `back` → `glassesBack()` (reader→list with selection restored to current item; list→parent; else reset home; also dismisses a glasses error); `select` → `activate()`; `next/previous` → in reader `advance`, else move `selection` clamped to item count (list count + 1 if "load more").
- `menuBody(labels)`: shows 4 items per screen (`Math.floor(selection/4)*4`), each `truncateGlassesLabel(`${selected ? '>' : ' '} ${label}`)`, joined by `'\n\n'` (4 items + 3 blank lines = 7 body lines). Empty → hint text.
- `drawGlasses()`: computes `{title, body, footer}` per view; busy → body `讀取中…`; glasses error → title `暫時未能讀取`, body hint "see phone for details", footer "tap retry · long-press back"; list footer `${selection+1}/${count} · 點按選取 · 長按返回`; reader footer `帖頁 p/P · s/S · #post` or "finished · long-press back"; phone-busy footer override. Always `paginateText(body)[0] || ' '` before render (never send >1 page). Render errors are swallowed because status callback reports them.
- Startup: `drawPhone()` first; then `connectGlasses(onGlassesAction, statusCb).then(c => { glasses = c; drawGlasses() }).catch(() => status 'error' "open from Even Hub to connect G2; phone can still configure")`. Status callback redraws G2 after a disconnected→ready transition.
- Error messages: `messageOf(err)` maps `ApiError.code` → localized message.

---

## 2. G2 rendering design (glasses.ts + pagination.ts + docs/glasses.md)

### 2.1 Container layout

| Container | containerID | containerName | Position (x,y) | Outer size | Inner (text) size | isEventCapture |
|---|---|---|---|---|---|---|
| Title | 1 | `title` | 12, 4 | 552 × 35 | 544 × 27 (1 line) | 0 |
| Body | 2 | `body` | 12, 43 | 552 × 197 | 544 × 189 (7 lines) | **1** |
| Footer | 3 | `footer` | 12, 249 | 552 × 35 | 544 × 27 (1 line) | 0 |

All: `borderWidth: 0`, `paddingLength: 4` (`G2_TEXT_PADDING`), no `textColor` (firmware default brightness 4), no `zOrderIndex` (SDK: either all containers set it or none). 16 px effective side margins (12 + 4). Non-overlapping: title ends y=39, body 43–240, footer 249–284. Line height 27 px fixed by firmware; SDK `TextContainerProperty` has no font size/line spacing field. CI asserts these invariants (margins ≥12, inside canvas, no overlap, body inner height % 27 == 0, title/footer inner height == 27).

Startup call:
```ts
const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 3,
  textObject: [ new TextContainerProperty({...G2_LAYOUT.title, borderWidth:0, paddingLength:4, containerID:1, containerName:'title', isEventCapture:0, content: initial.title}),
                new TextContainerProperty({...G2_LAYOUT.body,  ..., containerID:2, containerName:'body',  isEventCapture:1, content: initial.body}),
                new TextContainerProperty({...G2_LAYOUT.footer,..., containerID:3, containerName:'footer',isEventCapture:0, content: initial.footer}) ],
}))
if (result !== 0) throw new Error(`Even G2 could not create the reader screen (code ${result}).`)
```
SDK 0.0.16 `StartUpPageCreateResult`: `success = 0, invalid = 1, oversize = 2, outOfMemory = 3`. SDK rules (README): call `createStartUpPageContainer` before any other glasses UI op; `containerTotalNum` 1–12; `textObject` max 8; exactly one container with `isEventCapture: 1`; `rebuildPageContainer` returns boolean; optional `menuObject.menuItems` (max 10, unique non-zero `itemID`, `itemName` ≤ 32 UTF-8 bytes) produces `event.menuItemClickEvent` — unused by LIHKG but a possible native contextual menu for a Substack reader. Text brightness `textColor` 0–4.

### 2.2 Updates and the serialized write queue

`render(page)`:
1. Snapshot: `title = truncateGlassesLabel(page.title)`, `body = normalizeReaderText(page.body)`, `footer = truncateGlassesLabel(page.footer)`.
2. `enqueue(async () => { ... })`:
   - Reject with `RangeError('Reader body exceeds one G2 page. Paginate the text before rendering.')` if `!isReaderPage(body)` (bytes ≤ 1800 and height ≤ 189).
   - For fields in order `[['body',2],['title',1],['footer',3]]`: skip if `last?.[field] === snapshot[field]` (diffing against the last fully successful screen); else `await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName: field, content: snapshot[field] || ' ' }))` — note empty string replaced by single space; `false` → throw `Even G2 rejected the ${field} update. Try the page again.` Checks `disposed` between writes.
   - On success: `last = snapshot`; report `ready`.
`enqueue(operation)`:
```ts
const pending = queue.then(async () => { if (disposed) throw new Error('The Even G2 reader is closed.'); await operation() })
queue = pending.catch(error => { last = null; if (!disposed) report('error', errorMessage(error)) })
return pending
```
i.e. one global promise chain; the stored tail always fulfils (so one failed native write never blocks later page turns), while the caller still receives the rejection; any failure invalidates the diff cache (`last = null`) so the next render resends all three fields. Device disconnect/reconnect also sets `last = null`.
`TextContainerUpgrade` also has `contentOffset`/`contentLength` fields (partial updates) — unused.
Status observer calls are wrapped in try/catch so a phone UI bug cannot poison the bridge chain; `onAction` exceptions/rejections are caught and reported as `error` status.

### 2.3 Byte caps and text limits

- Body page ≤ 1800 UTF-8 bytes (`MAX_PAGE_UTF8_BYTES`), chosen as "a margin below the text-upgrade payload limit"; exact native limit is not stated in SDK 0.0.16 typings/README.
- Title/footer: single line via `pxTruncate(…, 544)` after a 160-grapheme pre-cap.
- Menu names (if using `menuObject`): ≤ 32 UTF-8 bytes (SDK-enforced).

### 2.4 Event handling quirks

```ts
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  return envelope ? (envelope.eventType ?? OsEventTypeList.CLICK_EVENT) : null
}
bridge.onEvenHubEvent(event => {
  const sys = eventTypeOf(event.sysEvent), text = eventTypeOf(event.textEvent)
  const has = (t) => sys === t || text === t
  if (has(SYSTEM_EXIT_EVENT) || has(ABNORMAL_EXIT_EVENT)) { dispose(); return }
  if (has(DOUBLE_CLICK_EVENT)) { emit('exit'); return }
  if (has(LONG_PRESS_EVENT)) { emit('back'); return }
  if (has(SCROLL_TOP_EVENT)) { emit('previous'); return }
  if (has(SCROLL_BOTTOM_EVENT)) { emit('next'); return }
  if (has(LONG_PRESS_RELEASE_EVENT) || has(FOREGROUND_ENTER_EVENT) || has(FOREGROUND_EXIT_EVENT) || has(IMU_DATA_REPORT)) return
  if (has(CLICK_EVENT)) emit('select')
})
```
- SDK 0.0.16 `OsEventTypeList`: `CLICK_EVENT=0, SCROLL_TOP_EVENT=1, SCROLL_BOTTOM_EVENT=2, DOUBLE_CLICK_EVENT=3, FOREGROUND_ENTER_EVENT=4, FOREGROUND_EXIT_EVENT=5, ABNORMAL_EXIT_EVENT=6, SYSTEM_EXIT_EVENT=7, IMU_DATA_REPORT=8, LONG_PRESS_EVENT=9, LONG_PRESS_RELEASE_EVENT=10`.
- **CLICK = 0 is the protobuf default and may be omitted** on the wire, so a missing `eventType` is treated as click — but *only* when a `sysEvent` or `textEvent` envelope exists (audio/list/menu-only events are not clicks). Lifecycle and explicit types are checked before the zero-valued click.
- Both `sysEvent` and `textEvent` are inspected because native routing differs by category; SDK ≥0.0.15 delivers long-press/release as `sysEvent` with `eventSource` (`GLASSES_R`, `RING`, `GLASSES_L`) — R1 ring input therefore flows through the same mapping (not device-verified).
- `listEvent` and `menuItemClickEvent` are not handled (no list/menu containers).
- Mapping: tap = select/continue, swipe up (SCROLL_TOP) = previous, swipe down (SCROLL_BOTTOM) = next, long press = back, double tap = exit. Swipe orientation is flagged as needing device verification.

### 2.5 Exit and lifecycle

- `exit()` enqueues `bridge.shutDownPageContainer(1)` — mode 1 shows the native exit confirmation layer (mode 0 = exit immediately). False → throws "Even G2 could not open the exit menu. Double-tap to retry." The controller does NOT dispose on exit(); only a subsequent `SYSTEM_EXIT_EVENT`/`ABNORMAL_EXIT_EVENT` or `pagehide` disposes, so cancelling the exit layer leaves the reader working.
- `dispose()`: idempotent; unsubscribes `onEvenHubEvent` and `onDeviceStatusChanged`, removes `pagehide` listener, reports `closed`; afterwards queued writes reject with "The Even G2 reader is closed."
- `onDeviceStatusChanged`: `DeviceConnectType.Disconnected | ConnectionFailed` → `last = null`, report `disconnected`; `Connected` → `last = null`, report `ready`. (`DeviceConnectType` string enum: `connected`, `disconnected`, `connectionFailed`, plus none/connecting.) The app redraws G2 when transitioning disconnected → ready.
- If startup throws, the subscriptions are torn down and the error rethrown; `main.ts` then shows "open from Even Hub to connect G2; phone can still configure" — the phone UI works in a plain browser too.

### 2.6 SDK bridge facts relevant to stubbing

`waitForEvenAppBridge()` checks for an existing ready bridge (exposed on `window.EvenAppBridge`), otherwise waits for the `evenAppBridgeReady` event, re-checking after 100 ms. Real runtime transport is `window.flutter_inappwebview.callHandler('evenAppMessage', …)`; host pushes arrive via `window._listenEvenAppMessage`. Other bridge APIs: `getUserInfo`, `getDeviceInfo`, `setLocalStorage/getLocalStorage` (host-side key-value storage), `onLaunchSource` (`appMenu`/`glassesMenu`, pushed once after load — register early), `audioControl`, `imuControl`, `updateImageRawData` (image containers: width 20–288, height 20–144), `rebuildPageContainer`. Min Even app for SDK 0.0.16 = 2.2.10 (`minAppVersion` in SDK package.json). 0.0.16 changelog: fixed repeated `setTimeout`/`setInterval` callbacks (SDK ships "shadow-timers" side effects).

Official references the owner used: text-heavy template https://github.com/even-realities/evenhub-templates/tree/main/text-heavy ; SDK d.ts https://unpkg.com/@evenrealities/even_hub_sdk@0.0.16/dist/index.d.ts ; pretext README https://unpkg.com/@evenrealities/pretext@0.1.4/README.md.

Pretext 0.1.4 API: `getTextWidth(text)`, `measureTextWrap(text, maxWidth) → {lineCount, height (= lineCount*27), lineWidths}` (maxWidth = inner width), `pxTruncate(text, maxPx)` (appends `...`), `getAdvW(cp)`; font fallback evenroster → evenroster_crylgrek → cn → evenemoji; breaks at spaces, hyphens, CJK boundaries; warns missing glyphs may differ from firmware.

---

## 3. Phone-side UI patterns

- Rendering: one `root.innerHTML = \`<main>…\`` string template per redraw (`drawPhone()`), all dynamic values through `escapeHtml` (`esc`). Layout: `header.topbar` (brand button `data-action="home"` with square `.brand-icon` glyph + name + `<small>FOR EVEN G2</small>`, `.alpha` pill "ALPHA 0.4.0"), `.device-status` (dot + glasses status message, updated in place by `updateDeviceStatus()` without full redraw), optional back toolbar, `.alert` (role=alert, with Retry / Dismiss buttons), `.notice` (role=status), copy-fallback textarea, `.loading`, `.now-reading` aside ("G2 正在閱讀" + title), panel content, footer.
- Redraw preserves: input drafts, focus and selection range for specific inputs, checkbox state, and `<details id>` open state.
- Event delegation: one `click` listener on root → `closest('button')` → `dataset` switch: `data-action="…"`, `data-panel="…"`, and row actions `data-menu-up/down/remove/add`, `data-bookmark-up/down/remove/add`, `data-channel-up/down/remove/add`, `data-browse-channel`, `data-browse-source`. One `submit` listener for forms (`pair-form`, `login-form`), clearing input values immediately.
- Busy state disables all buttons except a safe allowlist (home, sign-out, copy actions).
- Reorderable list rows: `.config-row` with `<strong>` label and `.row-actions` = `↑` / `↓` (`aria-label` 上移/下移, disabled at ends) + `.quiet.remove` "移除" (last menu item cannot be removed). "Add" options are `.secondary.add-option` "＋ name" buttons. "Reset to default" as `.quiet.full`.
- Panels: Home (connection card, G2 menu preview `<ol id="menu-preview">`, 2-col `.source-grid` of `.source-card` buttons for bookmarks/channels with counts, account card, G2 controls card with "return glasses to main menu"), Menu editor, Bookmarks (with "＋ add" → Browse), Channels (selected list + available add buttons + refresh + reset), Browse (source buttons, then thread rows with "加入書籤"/"已加入書籤" and "load more"), Account.
- Clipboard: `navigator.clipboard.writeText` with fallback that shows a readonly `<textarea id="copy-fallback">` "long-press, select all, copy" — Even WebView clipboard may be denied. No `target="_blank"` links / no navigation away from the plugin (CI asserts the page stays on origin and only one tab exists); external URLs are offered as "copy URL" buttons instead.
- Styling (`src/styles.css`, light theme only, `color-scheme: light`): font stack `Inter, "Noto Sans TC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; text `#242620`; background `#f7f6f2`; `--accent: #f4ec72` (yellow, primary buttons); `--line: #e4e4da`; `--muted: #73766a`; cards white, 1px `--line` border, radius 14px, padding 22px; buttons min-height 46px, radius 10px, weight 650, `.secondary` `#f0f0e9`, `.quiet` transparent; row action buttons 48×48 min; focus ring `3px solid #77742c` offset 3px; `main` max-width 760px, padding `20px 22px max(24px, env(safe-area-inset-bottom))`; h1 `clamp(25px,6vw,35px)`; alert `#fff2e8/#814a22`; notice `#edefdf/#626a3b`; `@media (max-width:380px)` single column + 16px side padding; `prefers-reduced-motion` gate for transitions. No dark mode (a Substack version may want one; Even app is dark-themed).
- Language: UI copy is Traditional Chinese; app.json `supported_languages: ["zh","en"]`.

---

## 4. Build / pack / publish pipeline end to end

### 4.1 Local (owner's rule: compile/package only, no runtime)
`pnpm install --frozen-lockfile` → `pnpm run check` (tsc) → `VITE_API_BASE_URL=https://… pnpm run build` (tsc + vite build → `dist/` incl. `build-info.json`; esbuild bundles `worker/index.ts` → `dist/server/index.mjs`) → `pnpm run pack`.

### 4.2 `scripts/pack.mjs` (exact behaviour)
1. Requires `process.env.VITE_API_BASE_URL` with `https:` protocol, else throws "Set VITE_API_BASE_URL to the deployed HTTPS gateway before building and packaging."
2. Reads `app.json` and `dist/build-info.json`; throws unless `buildInfo.apiOrigin === origin` and `buildInfo.version === manifest.version` ("Rebuild before packaging").
3. **Injects network permission at pack time**: `manifest.permissions = [{ name: 'network', desc: '<human description>', whitelist: [new URL(origin).origin] }]`. (0.1.1 desc: "Read your LIHKG account and posts through the stateless reader gateway."; 0.4.0 desc: "Exchange encrypted reading requests with your paired Android companion; optional legacy gateway access.") The desc is shown on the Hub Store listing "Permissions" section.
4. Staging `artifacts/package` (path-safety check that it is inside `artifacts/`), `rm -rf` then copy everything from `dist/` except `server`, `worker.mjs`, `.openai`, `_appgen_meta` (keeps the Worker out of the .ehpk).
5. Writes `artifacts/app.json`.
6. Resolves CLI bin from `node_modules/@evenrealities/evenhub-cli/package.json` (`bin.evenhub` = `./main.js`) and runs
   `node <cli>/main.js pack artifacts/app.json artifacts/package --sdk-ver 0.0.16 -o artifacts/lihkg-reader-<version>.ehpk` (stdio inherit).
Resulting `.ehpk` sizes: 83,557 B (0.1.1) … 93,390 B (0.4.0).

### 4.3 evenhub-cli 0.1.14 facts (from README + bundled zod schema in main.js)
Commands: `qr` (dev-mode QR for a dev-server URL: `-u/--url`, `-i/--ip`, `-p/--port`, `--path`, `--https/--http`, `-e/--external`, `-s/--scale`, `--clear`), `init` (writes example app.json), `login` (Even account; stores tokens under `%APPDATA%`/XDG config), `pack <json> <project>` (`-o/--output` default `out.ehpk`, `--no-ignore` include dotfiles, `-c/--check` package-id availability via `https://hub.evenrealities.com/api/v1/apps/check`, `--sdk-ver <v>` derive `min_app_version` floor from that SDK's npm `minAppVersion`, `--enforce-manual-version`). Pack contacts the npm registry for `minAppVersion`; on failure falls back to a bundled map with a warning. **There is no upload command**: "An .ehpk cannot currently be opened or run directly. To test one on a device, upload it through the EvenHub site, then open it from the Even app." Base URL override env: `EVENHUB_BASE_URL`/`EVENHUB_API_URL` (default `https://hub.evenrealities.com`).

app.json schema enforced by the CLI (zod):
- `package_id`: `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/` (lowercase letters/digits only per segment, ≥2 segments; no hyphens/underscores).
- `edition`: enum `"202601"`.
- `name`: string max **20** chars.
- `version`: `x.y.z`; `min_app_version` optional `x.y.z` (CLI stamps it).
- `min_sdk_version`: string; `entrypoint`: string.
- `permissions`: array, discriminated by `name` ∈ `g2-microphone, phone-microphone, album, location, network, camera`; each `desc` 1–300 chars; `network` additionally `whitelist: string[]` (default `[]`).
- `supported_languages`: subset of `en, de, fr, es, it, zh, ja, ko`.
(Error text also mentions `tagline` ≤50 and `description` ≤1024 — Hub listing fields.)
Suggested Substack values following the owner's convention: `package_id: "com.chlwork.substackreader"`, `name: "Substack Reader"` (15 chars; ≤20), `edition: "202601"`, `min_sdk_version: "0.0.16"`, `entrypoint: "index.html"`, `supported_languages: ["en"]`.

### 4.4 CI (`.github/workflows/ci.yml`)
Triggers: push, pull_request, workflow_dispatch; `permissions: contents: read`; concurrency `ci-${{ github.workflow }}-${{ github.ref }}` cancel-in-progress; job `check-and-package` on `ubuntu-latest`, timeout 15 min, `env: VITE_API_BASE_URL: ${{ vars.VITE_API_BASE_URL }}` (a public **repository variable**, not a secret). Steps: `actions/checkout@v7` (persist-credentials false) → `actions/setup-node@v7` (node 22, package-manager-cache false) → `pnpm/action-setup@v6` (version 10.32.1) → `pnpm install --frozen-lockfile` → `pnpm run check` → `pnpm run test:ci` → companion tests → inline node script validating `VITE_API_BASE_URL` (must parse, https, no creds/search/hash, path `/`, hostname not `localhost|example.(com|net|org)|invalid|test`, not 127./0.0.0.0/[::1]) → `pnpm run build` → `pnpm exec playwright install --with-deps chromium` → `CI=true pnpm run test:ui:ci` → `node scripts/observer-ci.mjs` → `pnpm run pack` → `actions/upload-artifact@v7` name `evenhub-alpha-package`, path `artifacts/*.ehpk`, `if-no-files-found: error`, retention 14 days.
`release.yml`: on `release: types [published]`, `permissions: contents: write`, checks out `ref: ${{ github.event.release.tag_name }}`, same steps, then `gh release upload "$RELEASE_TAG" artifacts/*.ehpk --clobber` with `GH_TOKEN: ${{ github.token }}`, `GH_REPO`.
`android.yml` and `companion-live.yml` (manual production relay smoke) are LIHKG-specific.
Tag convention: `vX.Y.Z-alpha.N` GitHub **prerelease**; `.ehpk` named `<app>-X.Y.Z.ehpk`.

### 4.5 Publishing to Even Hub (per docs/releases/*, deployment.md, screenshots in ignored `artifacts/`)
1. Publish GitHub prerelease → release workflow attaches `.ehpk`.
2. `node scripts/download-release.mjs vX.Y.Z-alpha.N` (maintainer tool; gets a GitHub token in memory via `git credential fill`, downloads assets through the GitHub API, verifies `asset.digest` sha256 and size, writes `artifacts/<tag>-download-proof.json`). Release notes record size + SHA-256.
3. Developer portal: **https://hub.evenrealities.com** → "My projects" → project (public project page URL pattern `https://hub.evenrealities.com/hub/<package_id>`, e.g. `/hub/com.chlwork.lihkgreader`) → tabs **Builds | Testing group | Store listing**; top-right button **"Upload a build"**. Upload the verified `.ehpk`.
4. A new build starts as **Private** ("Private builds" section). To distribute: click the build's Private badge → choose Beta → **"Promote to Beta"**; the build then shows under "Beta build" as "Published … Beta"; the previous beta automatically becomes Private. Early lesson (0.1.1): forgetting Private→Beta promotion made the tester see an "expired" message.
5. **Testing group** tab: invite testers; the invitation page reads "You are invited. Accept the invitation to join the testing group for <App>" with a QR "Scan to open in Even Realities App". Once a tester is **Active**, later versions require no new QR/invite: tester updates via Even app **Me → Beta tester** (or **My Plugins**). Private invite links/QR codes are never committed.
6. **Store listing** tab: Category (LIHKG used "Lifestyle"), Description (≤1024), Permissions (auto from package desc), Privacy and terms, App icon, Cover and screenshots; a checklist (Personal Information, App icon, Cover and screenshots, App description, Permissions, Privacy and terms) gates **"Submit for review"** for the public catalog. The owner never submitted for public review; Beta only. Each build also has a changelog field (they disclosed known limitations there).
7. Official docs referenced: Private Testing https://hub.evenrealities.com/docs/test/private-testing (developer's own private install of a Private build) and Beta Testing https://hub.evenrealities.com/docs/test/beta-testing (assign build to a group containing testers). Networking https://hub.evenrealities.com/docs/build/networking ; FAQ https://hub.evenrealities.com/docs/reference/faq ; Device APIs https://hub.evenrealities.com/docs/build/device-apis .
8. The Hub portal steps were done by the maintainer in a browser (screenshots `artifacts/evenhub-*.png`); there is no API automation.
Dev-mode alternative (`evenhub qr` → scan to load a LAN dev server in the Even app) exists in the CLI but was never used because of the no-local-runtime rule.

---

## 5. Relay / worker design and lessons

### 5.1 `worker/index.ts` (legacy LIHKG gateway; generic skeleton reusable)
- Export: `export default { async fetch(request: Request, env: CompanionEnv = {}): Promise<Response> }`; routes `/api/companion/*` → `handleCompanion`; otherwise `handle()` wrapped in try/catch mapping `RelayError` → `{ ok:false, error:{ code, message, diagnostics? } }` with its status, unknown → 500 `INTERNAL_ERROR`.
- `GET /` → static landing HTML (`worker/landing.ts` exports `LANDING` string) with headers `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`, nosniff, no-referrer.
- `GET /health` → `{ ok, service: 'lihkg-reader', protocol: 3, revision: 'android-companion-v1', companionConfigured }` (versioned health string used to verify which deployment is live).
- `/api/lihkg`: `OPTIONS` → 204 with CORS; only `POST`, `Content-Type: application/json` (415), `Content-Length` ≤ 8192 (413) **and** streaming cap via `boundedText(body, limit)` that cancels the reader when exceeded (protects when Content-Length absent); JSON parse errors → 400 `INVALID_JSON`.
- CORS/headers constant:
  ```ts
  { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store, private', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
  ```
  (Wildcard origin because the Even WebView origin is not a stable known value; auth/capabilities are in the body, cookies unused.)
- Allowlist: `operation` ∈ fixed set; params validated (`page` integer 1–100000, `id` `^\d{1,20}$`); upstream URL built server-side from a fixed `API = 'https://lihkg.com/api_v2'` — never from client URLs. Custom strict percent-encoding `serialize()`.
- Upstream fetch: `GET`, fixed headers, `cache:'no-store'`, `redirect:'manual'`, 15 s AbortController timeout; response cap 2 MiB streamed; requires JSON content-type.
- Diagnostics (`upstreamDiagnostics`): only bounded categories leave the boundary — `upstreamStatus`, `contentType` ∈ {application/json, text/html, text/plain, other, missing}, `challenge` (= header `cf-mitigated: challenge`), `retryAfterSeconds` (0–86400, from integer or strict HTTP-date), `lihkgErrorCode` (validated integer). Raw headers/body never echoed.
- Error mapping: challenge → 503 `LIHKG_CHALLENGE`; upstream 403 → 503 `LIHKG_ACCESS_DENIED`; 429 → 503 `LIHKG_RATE_LIMITED` (with retry hint); 503 → 503 `LIHKG_UNAVAILABLE`; other non-OK/non-JSON → 502 `UPSTREAM_UNAVAILABLE`; network → 502 `UPSTREAM_NETWORK_ERROR`; rejected bodies are `cancel()`ed unread. No retries.
- No logging, no caching, no cookies, no credential storage.
For Substack this skeleton maps directly onto a read-only proxy: operations like `archive {host, offset, limit, sort}`, `post {host, slug}`, `feed {host}`, `search {query}`; host validation must allow `*.substack.com` plus custom domains (needs a policy: e.g. accept any HTTPS hostname but only request fixed paths `/api/v1/archive`, `/api/v1/posts/<slug>`, `/feed`, and verify Substack-ness by response shape; or restrict to `*.substack.com` and resolve custom domains via the publication API). Add SSRF guards (no IP literals/localhost/private ranges, no ports, no userinfo).

### 5.2 Hosting actually used
- **OpenAI "Sites" hosting** (ChatGPT sites; Codex `sites-hosting` skill — local notes in ignored `research/sites-skill/`). `.openai/hosting.json` = `{ "project_id": "appgprj_6aba0c254eb48191a421b1af1ceb7407", "d1": "DB", "r2": null }` (metadata-only manifest: project id, logical D1/R2 bindings). Origin `https://lihkg-reader-evenhub-alpha.darkdarkb.chatgpt.site`. Build layout expected by Sites: static assets in `dist/` + Worker at `dist/server/index.mjs` (commit 6570b93 "Package gateway in the supported Sites worker layout"). `scripts/package-site.mjs` requires a clean git tree, checks project id + `d1 === 'DB'`, stages `dist` + `dist/.openai/hosting.json` + `dist/.openai/drizzle/` into `artifacts/site-companion-staging`, tars to `artifacts/site-companion-0.4.0.tar.gz`, writes `{source sha, archive, sha256, bytes}` evidence. Deployment was done through the Sites connector (versions 2→5; deployment ids recorded in release notes); audience switched from owner-private to **public** (`access_mode: public`, revision 2, 2026-09-28T07:44:03Z) because the Even WebView cannot pass the Sites sign-in. Sites pushes source to a Sites git remote with a short-lived write credential. **This hosting path is tied to the owner's OpenAI/Codex tooling and is not available to a Claude session.**
- **`wrangler.toml`** exists (`name = "lihkg-reader-evenhub-alpha"`, `main = "worker/index.ts"`, `compatibility_date = "2026-09-01"`, `[observability] enabled = false`) from the very first commit, and `.gitignore` lists `.wrangler/`, but there is no evidence it was ever used to deploy (no `workers.dev` URL, no CI deploy step, no Cloudflare secrets). The Worker code is plain Cloudflare-Workers-compatible ESM (`export default { fetch }`, D1 binding `env.DB`), so `wrangler deploy` would work given a Cloudflare account/API token.
- `VITE_API_BASE_URL` is baked at build time; must equal the pack whitelist origin; changing origin requires a new `.ehpk` (0.1.0 shipped with an *expected* URL that differed from the actual deployed origin → 0.1.1 hotfix).

### 5.3 Lessons learned (LIHKG)
- Cloud egress was refused by the upstream: guest `channels` through the Sites/Cloudflare gateway → upstream **HTTP 403 text/html, no `cf-mitigated` header** (2026-09-30), earlier reported as `LIHKG_CHALLENGE`; a direct request from the research connection also got 403 HTML; a CORS preflight to LIHKG got 403 with no ACAO. `/health` 200 and "gateway reachable" proved nothing about content access. Re-importing credentials did not help. Owner forbade bypasses (no proxy rotation, cookie transfer, UA spoofing, challenge solving).
- They distinguished 403/429/503/challenge only after a dedicated diagnostics release — build diagnostics in from day one.
- Even WebView networking = standard fetch/XHR/WebSocket only; requires exact HTTPS whitelist AND remote CORS; no native HTTP or cookie bridge in SDK 0.0.16; `callEvenApp` generic call doesn't imply undocumented native methods exist. (Consistent with the "known facts" in the brief; no contradicting evidence found.)
- The eventual fix was an Android companion + encrypted relay — heavy (second app, background limits). For Substack, verify early that the chosen relay host's egress IPs get 200 JSON from Substack (`/api/v1/archive`, `/api/v1/posts/<slug>`, `/feed`) before building UI around it; probe from the actual deployed relay, not from a dev machine.

---

## 6. Testing approach and the owner's constraints

### 6.1 Owner constraints (stated repeatedly in README/docs/release notes)
- "按要求不執行本機 runtime 測試或模擬器" — **no local runtime tests, dev servers, browser previews or simulators**; locally only source inspection, dependency install, schema generation, production compile and packaging. All runtime checks run in GitHub Actions with synthetic data. Every test script hard-fails outside CI:
  - `ci-tests.mjs`: `if (process.env.CI !== 'true') throw new Error('These checks run only in remote CI. No local app testing is authorized.')`
  - `ui-ci.mjs`, `observer-ci.mjs`, `companion-client-ci.mjs`: require `CI === 'true' && GITHUB_ACTIONS === 'true'`.
  - `companion-live-ci.mjs`: additionally `GITHUB_EVENT_NAME === 'workflow_dispatch'`.
- No real credentials, no real upstream requests in tests; fixtures are synthetic and labeled.
- Honest status reporting: compile/mock CI/hub publication ≠ working reader; physical G2 items stay unchecked in `docs/alpha-checklist.md` until observed. Release notes record commit SHA, CI run IDs, package size + SHA-256, Hub status/time, tester status.
- No demo/sample content presented as real; no manual "paste text to read" substitute (removed in 0.2.1 at owner's request); no phone "pick post → push to G2" flow (removed in 0.3.0) — the glasses select content from phone-configured menus/bookmarks.
- Privacy: no logging of tokens/content; credentials never in URLs; docs/privacy.md enumerates every stored key and network flow.
- On this machine Node.js is not installed, which is consistent with "CI does the runtime work".

### 6.2 `scripts/ci-tests.mjs` (fixture/unit harness)
- `node:test` (`await test(name, fn)`) + `node:assert/strict`; esbuild `build({ entryPoints: { pagination:'src/pagination.ts', api:'src/api.ts', storage:'src/storage.ts', links:'src/links.ts', worker:'worker/index.ts' }, bundle, format:'esm', platform:'node', target:'node22', outdir: <mkdtemp>, outExtension {'.js':'.mjs'}, define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://relay.example.test') } })`, then dynamic `import(pathToFileURL(...))`; imports `@evenrealities/pretext` directly to independently verify page fit.
- Network control: `denyNetwork()` replaces `globalThis.fetch` with a thrower and counts calls (assert `fetchCalls === 0` for rejected inputs); `stubUpstream(cb)` asserts origin, GET, `redirect:'manual'`, AbortSignal, no Cookie, no token leakage.
- Worker tested by calling `worker.fetch(new Request('https://relay.invalid/api/lihkg', …))` directly.
- `localStorage` shimmed via `Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem, setItem } })` backed by a Map, plus a throwing variant (storage denied/quota).
- `Date.now`/`Math.random` monkeypatched for deterministic vectors; everything restored in `finally`.
- Reusable test cases for a new reader: G2 layout invariants; CJK text with no spaces survives all page boundaries (`pages.join('') === text`) and each page fits (`measureTextWrap(page, 544).height <= 189`, bytes ≤ 1800); emoji/flags/combining clusters not split across pages (checked against `Intl.Segmenter` boundaries); long URL without spaces; CRLF/mixed paragraphs; 5000 combining marks can't bypass byte cap; empty input → `['']`; invalid boxes throw `RangeError`; `truncateGlassesLabel` width ≤ 544; storage bounded/deduped/namespaced/migration/corrupt JSON fallback; reorder never drops.
- Counts at 0.4.0: 28 fixture suites, 8 relay suites (companion-ci with `node:sqlite` `DatabaseSync(':memory:')` wrapped as a D1-compatible adapter running the real Drizzle migrations), 9 WebCrypto client suites, 16 Chromium UI scenarios.

### 6.3 `scripts/ui-ci.mjs` (Playwright, G2 bridge stub)
- Serves the **production** `dist/` with `node:http` on `127.0.0.1:0` (random port), path-traversal-safe, refuses `dist/server/**`, `Cache-Control: no-store`, small mime map. Asserts `build-info.json.apiOrigin` equals the expected production gateway (forces an explicit test update when origin changes).
- `chromium.launch({ headless: true })`; per scenario `browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })`.
- **G2 bridge stub** via `context.addInitScript`:
  ```js
  window.__g2Text = []; window.__g2Pages = []; window.__g2State = {}; window.__g2Event = null;
  const host = {
    _ready: true, ready: true,
    async createStartUpPageContainer(page) { window.__g2Pages.push(page); for (const item of page.textObject || []) window.__g2State[item.containerName] = item.content; window.__g2Text.push(...); return 0; },
    async textContainerUpgrade(page) { window.__g2State[page.containerName] = page.content; window.__g2Text.push(page.content); return true; },
    onEvenHubEvent(callback) { window.__g2Event = callback; return () => { window.__g2Event = null; }; },
    onDeviceStatusChanged() { return () => {}; },
    async shutDownPageContainer() { return true; },
  };
  Object.defineProperty(window, 'EvenAppBridge', { configurable: true, get: () => host, set() {} });
  ```
  ("Keep the SDK's classes/renderer real; provide the native host boundary." The no-op setter stops the SDK's own `init()` from replacing it; `waitForEvenAppBridge()` sees a ready bridge.) Gestures injected with `page.evaluate(type => window.__g2Event({ textEvent: { eventType: type } }), n)` after `expect.poll(() => typeof window.__g2Event).toBe('function')`; e.g. 2 = next, 0 = select, 9 = long-press back. Assertions read `window.__g2State.body/title/footer` and `__g2Pages[0].textObject` geometry (exactly one `isEventCapture === 1`, boxes within 12..564 × 0..288).
- Clipboard stub rejects `writeText` (tests the fallback textarea).
- Seeding: localStorage seeded once per context using a `sessionStorage` flag so `page.reload()` tests real persistence.
- Network: `context.route('**/*')` — same-origin continues; gateway origin `/api/lihkg` (and companion endpoints) fulfilled from in-memory fixtures with CORS headers (OPTIONS → 204); **every other request is recorded as unexpected and aborted** (`blockedbyclient`).
- `scenario(name, options, run)` wrapper asserts after each: no unexpected requests, no `pageerror`s, still on the local origin, only one page/tab; prints `PASS phone UI: <name>`.
- Scenario themes: default menu order + G2 startup geometry; G2 navigation home→channels→list→reader while phone edits settings (G2 body unchanged, no re-fetch); browse → bookmark → reorder → reload persistence → G2 opens saved post; menu add/remove/reorder persistence; removing open bookmark + Back shows updated list; history clear not re-added on pagehide; upstream failure never fabricates content and home doesn't retry; session persistence/abandonment; companion pairing flows.

### 6.4 Product-shape constraints worth carrying over
Phone = configuration surface (menus, bookmarks, followed sources, ordering); glasses = browse + read with tap/swipe/long-press/double-tap; default G2 menu of ordered sources; reading position remembered per item (page + slice); local bookmarks/history capped at 100; no full-text caching ("not an offline content cache"); separate guest/account namespaces; settings editable offline.

---

## 7. Reuse plan summary for `substack-reader-for-evenhub`

| File | Action |
|---|---|
| `src/pagination.ts` | Copy verbatim; change Segmenter locale and comments |
| `src/glasses.ts` | Copy; parameterize `initialPage` + status messages (English) |
| `src/content.ts` | Copy and extend for Substack `body_html` (headings, lists, captions, code, drop widgets), English labels |
| `src/storage.ts` | Rewrite schema (publications, posts, history positions, menu) reusing helpers (`record`, `text`, `uniqueItems`, `reorderItem`, read/save with size cap + migration) |
| `src/types.ts`, `src/api.ts` | Rewrite for Substack; keep `ApiError`, `isApiConfigured/apiOrigin`, fetch options, timeout, envelope |
| `src/main.ts` | Re-implement with same state-machine pattern (independent phone panels vs G2 views, `run()`/generation/retry, `menuBody` 4-per-screen, slice reader with position memory) |
| `src/links.ts` | Replace with strict Substack URL parser (if a "follow publication by URL" input is needed) |
| `src/styles.css`, `index.html` | Copy structure; English `lang="en"`, new title, maybe Substack-ish accent (#ff6719) |
| `vite.config.ts`, `tsconfig.json`, `pnpm-workspace.yaml`, `.gitattributes`, `.gitignore` | Copy as is |
| `scripts/pack.mjs` | Copy; rename output, update permission desc; whitelist = relay origin (and/or Substack hosts if direct fetch were possible — it is not, due to CORS) |
| `scripts/ci-tests.mjs`, `scripts/ui-ci.mjs` | Copy harness (esbuild-bundle + node:test; Playwright + EvenAppBridge stub + route interception), replace LIHKG fixtures with synthetic Substack fixtures |
| `.github/workflows/ci.yml`, `release.yml` | Copy; drop companion steps; keep `vars.VITE_API_BASE_URL` validation |
| `worker/index.ts` | Rewrite as Substack read-only proxy using the same skeleton (CORS constant, bounded bodies, allowlisted ops, diagnostics, no logging); deploy via Cloudflare `wrangler` (or another host) |
| `android/`, `companion.ts`, `account.ts`, `db/`, `drizzle/`, `.openai/` | Do not port |

---

## Open questions / uncertainties
- Exact native payload limit for `textContainerUpgrade` content is undocumented; 1800 bytes is the owner's chosen safety margin.
- Whether `window.localStorage` in the Even app WebView persists across plugin launches/updates on real devices is not documented; SDK offers `bridge.setLocalStorage/getLocalStorage` as an alternative that LIHKG never used.
- Physical G2 behaviour (swipe direction, long-press, ring events, exit-layer cancel, reconnect, font glyph coverage, comfort of 7-line body) was never verified on hardware by the reference project.
- Where to host the Substack relay: the reference used OpenAI Sites (`*.chatgpt.site`), which is not reachable from this toolchain; `wrangler.toml` exists but was never used and needs a Cloudflare account/API token. Whether Substack serves 200 JSON to Cloudflare Worker egress IPs (vs 403/challenge like LIHKG) is unverified.
- The Even Hub upload/promotion is a manual web-portal step requiring the owner's Even account; no CLI upload exists in evenhub-cli 0.1.14.
- `evenhub pack` contacts the npm registry for `minAppVersion` (with bundled fallback); behaviour on a CI runner without npm access only produces a warning.
- Whether the Hub uses the packaged `icon.svg` for the project icon is unclear (portal screenshots show a placeholder icon; the Store listing checklist has a separate "App icon" item).
