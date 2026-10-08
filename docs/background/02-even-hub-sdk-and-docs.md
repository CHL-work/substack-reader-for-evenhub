# 02 - Official Even Hub platform (state as of 2026-10-06)

Researcher topic: official Even Hub docs, npm package versions, the SDK API surface, official templates, the app.json schema and the CLI.
Method: the docs site is a server-rendered VitePress site. I fetched all 38 pages listed in `https://hub.evenrealities.com/docs/hashmap.json` with curl and saved them as text under `research/raw/docs/*.txt`. I also read the npm registry metadata, read the local SDK/CLI/pretext packages in `C:/Code/lihkg-reader-for-evenhub/node_modules/@evenrealities/`, diffed them against unpkg, and cloned two repos: `even-realities/evenhub-templates` at commit 8cb0135 (2026-08-07) and `even-realities/everything-evenhub` at commit 176999c (2026-07-14). As a secondary, non-official source I read the community notes at `nickustinov/even-g2-notes/docs`.

Raw artifacts (scratchpad):
- `research/raw/docs/*.txt`: text dumps of every docs page, each with its URL in the first line
- `research/raw/{sdk,cli,sim,term}.json`: npm registry documents
- `research/raw/sdk-0.0.14.d.ts`, `sdk-0.0.15.d.ts`, `sdk-0.0.16.d.ts`: from unpkg
- `research/evenhub-templates/`, `research/everything-evenhub/`: shallow clones
- `research/raw/g2notes/*.md`: community notes

---

## 0. TL;DR for the Substack reader

1. **No new networking capability.** Nothing in SDK 0.0.16 (latest, 2026-09-24) bypasses CORS. The `EvenAppMethod` enum has no fetch, http, proxy or request method. Its methods are getUserInfo, getGlassesInfo, set/getLocalStorage, getAppLocation, start/stopAppLocationUpdates, pickImageFromAlbum, captureImageFromCamera, createStartUpPageContainer, rebuildPageContainer, updateImageRawData, textContainerUpgrade, audioControl, imuControl and shutDownPageContainer. The official docs (Networking, updated 2026-06-11) say outright: "If the API is third-party and you can't touch its CORS, proxy through a server you control that sets the right headers - then put that server's domain in the `app.json` whitelist." Substack sends no ACAO header, so **we need a self-hosted CORS proxy, for example a Cloudflare Worker.** The sibling LIHKG project already uses this pattern: `worker/index.ts` sets ACAO `*`, and `scripts/pack.mjs` injects the proxy origin into the `network` whitelist at pack time.
2. **Whitelist format.** One full origin per entry, such as `https://api.example.com`. "Bare hostnames and wildcards aren't supported." The CLI 0.1.14 zod schema does not validate the entry strings (`whitelist: z.array(z.string()).optional().default([])`), so a wildcard would pack fine. The Even App enforces the rule at runtime. HTTPS is required in production. Plain `http://` is "only useful for local dev against a LAN dev server."
3. **Versions.** The local copies are the latest: SDK 0.0.16, CLI 0.1.14, pretext 0.1.4. The simulator is at **0.9.5**, while the template package.json files pin `^0.7.2`. The SDK API surface is identical from 0.0.14 to 0.0.16 (only a doc-comment changes). SDK 0.0.15 and later require **Even App 2.2.10** (`minAppVersion` in npm metadata). SDK 0.0.16 fixes "repeated execution of setTimeout/setInterval callbacks", so pin exactly `0.0.16`.
4. **Reader-relevant limits.** Text content can be 1000 chars on create or rebuild and 2000 chars via `textContainerUpgrade`. The simulator enforces 999 bytes per text container. A full-screen text container holds about 400-500 chars. Line height is fixed at 27 px, so a 288 px screen fits about 10 lines. Lists allow 20 items with 64 chars each (the simulator caps at 63 bytes each). Lists cannot be updated in place and need a page rebuild. A page allows at most 12 containers: 8 text/list plus 4 image. Exactly one container has `isEventCapture: 1`. `containerName` is at most 16 chars.
5. **The official reader template is `text-heavy`.** It pre-paginates with `@evenrealities/pretext`'s `measureTextWrap`, turns pages with `textContainerUpgrade` (flicker-free) into a 576x240 body plus a 576x30 pager strip, and serializes bridge writes through a promise chain. Tap and swipe-down go to the next page, swipe-up to the previous page, and double-tap calls `shutDownPageContainer(1)`.
6. **QA rules that affect design.** The root-page double-tap must call `shutDownPageContainer(1)`, or the app is auto-rejected. The app must not show a black screen on first run. Setup must be remembered across launches. The app must work with the phone locked and the Even App backgrounded (5-minute lock test). The privacy policy must cover every permission and must document the backend domains. `name` must be 20 chars or fewer and must **not contain "Even"**.

---

## 1. Official documentation map (hub.evenrealities.com/docs)

Site: VitePress v2.0.0-alpha.16, server-rendered. There is no llms.txt or sitemap; those paths return the SPA shell. The page list comes from `/docs/hashmap.json`. The `ai-tooling/*` pages in the hashmap render empty; that content moved to `learn/claude-code`.

| Section | Page (URL suffix under /docs/) | Last updated |
|---|---|---|
| Get started | get-started/overview, architecture, quickstart/{index,install-node,install-tools,sign-in,hardware,first-app,templates} | 2026-06..08 |
| Build | build/page-lifecycle (08-25), build/display (08-25), build/design-guidelines (07-10), build/device-apis (08-29), build/contextual-menu (08-25), build/networking (06-11), build/background-lifecycle (06-22) | |
| Test | test/index, test/simulator (08-29), test/local-testing, test/private-testing, test/beta-testing | |
| Ship | ship/packaging (08-29), ship/app-submission (08-07) | |
| Reference | reference/cli (08-20), reference/faq (08-29), reference/glossary, reference/versioning (08-25), reference/changelog (08-29) | |
| Learn | learn/claude-code, learn/videos | |

Note: the docs changelog and install pages still say "current" SDK 0.0.14 and simulator 0.9.3. They lag npm, which has SDK 0.0.16 and simulator 0.9.5.

### 1.1 Architecture (get-started/architecture)
- The Even Hub Cloud distributes and hosts apps over HTTPS to the phone (Even Realities App, Flutter, with a WebView: Chromium on Android, WKWebView on iOS). The phone talks to the G2 over Bluetooth. "Apart from native scroll handling, no app logic runs on [the glasses]."
- The bridge is injected as `window.EvenAppBridge`. Web-to-glasses calls go through `bridge.callEvenApp(method, params)` and then `flutter_inappwebview.callHandler('evenAppMessage', ...)`. Glasses-to-web events arrive via `window._listenEvenAppMessage(...)`.
- Testing modes: QR sideload (dev server plus `evenhub qr`), Private build (`.ehpk` uploaded to the portal), and the Simulator.
- "PWA as an alternative": you can skip Even Hub distribution entirely, with no packaging and no review.

### 1.2 Networking (build/networking), quoted in substance
- Plugins use `fetch()`, `XMLHttpRequest` and WebSockets from inside the WebView.
- **Gate 1, the Even-side permission check:** the domain must be in the `app.json` `network` permission `whitelist`, and "Anything not in the whitelist is blocked - no traffic generated at all."
- **Gate 2, browser CORS:** the WebView enforces standard CORS, and the server must return `Access-Control-Allow-Origin`.
- "The whitelist is not a CORS bypass."
- Whitelist notes: "One whitelist entry per origin. Use the full origin (`https://api.example.com`) - bare hostnames and wildcards aren't supported." "HTTPS in production. Plain `http://` is only useful for local dev against a LAN dev server."
- Required server headers: `Access-Control-Allow-Origin: *` (or the specific WebView origin). For preflight, reply 204 with `Allow-Methods`, `Allow-Headers` and `Max-Age`. To avoid preflight entirely, use simple GET or POST requests with no custom headers.
- The recommended fix for third-party APIs is to "proxy through a server you control ... then put that server's domain in the app.json whitelist".
- Debug checklist: confirm the whitelist (then repack and re-upload), the ACAO header, the preflight, and a curl comparison.
- FAQ: WebSockets follow the same whitelist rules. Deep links to the system browser are "TBD. Currently no `window.open(url, '_system')` equivalent." There are no push notifications. Network calls are not possible while backgrounded ("WebView is suspended on background; in-flight requests stall").
- The **WebView origin** of a packaged `.ehpk` is not documented. The docs only say to use `*` "or specifically the WebView origin if you can identify it".

### 1.3 Display (build/display)
- The canvas is 576x288 per eye, with the origin at top-left. Colour is 4-bit greyscale shown as green. Black means off.
- Containers are absolutely positioned. "At most 4 image containers and 8 other containers per page." "Exactly one container has `isEventCapture: 1`."
- Shared properties: `xPosition` 0-576, `yPosition` 0-288, `width` 0-576, `height` 0-288, `containerID` (unique), `containerName` (max 16 chars, unique), `isEventCapture` 0/1, and `zOrderIndex` (SDK 0.0.12+, either set on all containers or on none; values must be unique; larger values draw in front).
- Border properties apply to text and list containers only: `borderWidth` 0-5, `borderColor` 0-15, `borderRadius` 0-10 (the name keeps a typo from the protobuf), and `paddingLength` 0-32. There is **no background or fill**.
- **Text container:** plain text, left- and top-aligned. There is no alignment, font-size, bold or italic control.
  - Content limits: `createStartUpPageContainer` 1,000 chars, `textContainerUpgrade` 2,000 chars, `rebuildPageContainer` 1,000 chars.
  - Text wraps at the container width. "If content overflows and the container has `isEventCapture: 1`, the firmware scrolls it." `\n` breaks a line. Unicode works if the glyph is in the firmware font. A full-screen container holds "roughly 400-500 characters". Centering is done by padding with spaces.
  - `textColor` (SDK 0.0.14+) is a brightness level from 0 to 4. On create or rebuild the default is 4. On upgrade, omitting it keeps the current level. Values out of range fail locally with `INVALID_TEXT_BRIGHTNESS`.
  - `textContainerUpgrade` needs matching `containerID` **and** `containerName`; a mismatch silently does nothing. Optional `contentOffset` and `contentLength` allow partial-string updates.
- **List container:** "Native scrollable lists, with scroll highlighting handled in firmware." "Up to 20 items per list. Up to 64 characters per item. No per-item styling, no row-height control, no separators. No in-place updates - changing a list means rebuilding the whole page."
- **Image container:** up to 288x144 per container (the d.ts gives width 20-288 and height 20-144). It is 4-bit greyscale and accepts `number[] | Uint8Array | ArrayBuffer | base64`. Images cannot be sent during create; send them afterwards with `updateImageRawData`. Sends must not run concurrently and are paced at 100 ms (0.0.14+). Data is LZ4-compressed in transit (0.0.12+). The result statuses are `success | imageException | imageSizeInvalid | imageToGray4Failed | sendFailed`.
- **Font:** a single LVGL firmware font. It is not monospaced, and characters outside it are silently dropped. There is no emoji (FAQ), but pretext 0.1.4 added an emoji font table, so the newer firmware may include some.
- Design-guideline patterns: fake buttons use a `>` prefix. Selection is shown by toggling `borderWidth`. Multiple rows are stacked text containers, for example 3 x 96 px. Progress bars use `━ ─ █▇▆▅▄▃▂▁`. The navigation glyphs `▲△▶▷▼▽◀◁`, the selection glyphs `●○ ■□ ★☆` and the box-drawing set all render. "Page flipping: Pre-paginate text at ~400-500 character boundaries, rebuild on scroll events". The text-heavy template instead uses `textContainerUpgrade`, which is better.
- Store icon: 24x24, 1-bit, made of 2x2 blocks, drawn in the portal editor.

### 1.4 Page lifecycle (build/page-lifecycle)
| Method | Purpose | Notes |
|---|---|---|
| `createStartUpPageContainer` | Initial page | Called **exactly once**. Returns 0 success, 1 invalid, 2 oversize, 3 outOfMemory. Optional `menuObject`. |
| `rebuildPageContainer` | Replace the whole page | Full redraw with a brief flicker on hardware. Returns boolean. Omitting `menuObject` clears the custom menu. |
| `textContainerUpgrade` | In-place text update | Flicker-free. Returns boolean. Optional `textColor`. |
| `updateImageRawData` | Image update | Serial calls only. |
| `shutDownPageContainer` | Exit | `1` shows the system exit-confirmation dialog, which is **required on the root page**. `0` exits immediately and is allowed only on internal pages after the user has confirmed. |
| `callEvenApp` | Generic escape hatch | All typed methods wrap it. |

### 1.5 Device APIs and input (build/device-apis)
- Input sources: the G2 temple touchpads and the R1 ring both support press, double press, swipe up, swipe down, long press and release. The IMU is also available.
- Event types (`OsEventTypeList`): `CLICK_EVENT=0`, `SCROLL_TOP_EVENT=1` ("Swipe up / scroll reaches top boundary"), `SCROLL_BOTTOM_EVENT=2`, `DOUBLE_CLICK_EVENT=3`, `FOREGROUND_ENTER_EVENT=4`, `FOREGROUND_EXIT_EVENT=5`, `ABNORMAL_EXIT_EVENT=6`, `SYSTEM_EXIT_EVENT=7`, `IMU_DATA_REPORT=8`, `LONG_PRESS_EVENT=9`, `LONG_PRESS_RELEASE_EVENT=10`. Values 9 and 10 need SDK 0.0.14+ and Even App 2.2.9+.
- Routing per the docs: a text capture container sends `event.textEvent` and a list capture container sends `event.listEvent`. Menu clicks arrive as `event.menuItemClickEvent` and long presses as `event.sysEvent`, whichever container is capturing.
- **Contradictions about routing:**
  - The official templates' README says: "Taps, double-taps and lifecycle events arrive on `sysEvent`; scroll gestures arrive on `textEvent`."
  - The everything-evenhub `handle-input` skill agrees for text containers. For lists it says swipes are handled internally with no event, a single press sends `listEvent.currentSelectItemIndex`, and a double press sends `sysEvent` type 3.
  - The community notes say the simulator sends `sysEvent` for clicks while hardware sends `textEvent` or `listEvent`, and that list `SCROLL_TOP/BOTTOM` fire only at the list boundaries.
  - **Recommendation: handle clicks and double-clicks on all three envelopes**, using the template's `eventTypeOf(envelope)` helper.
- **Protobuf zero omission:** `CLICK_EVENT` (0) arrives with `eventType` `undefined`, and `listEvent.currentSelectItemIndex` is `undefined` for item 0. Resolve the default inside the envelope check, for example `envelope.eventType ?? CLICK_EVENT` applied only when that envelope exists. Never write `event.sysEvent?.eventType ?? CLICK`.
- `eventSource` (`EventSourceType`): 0 = dummy, 1 = right glasses temple, 2 = R1 ring, 3 = left glasses temple. The SDK 0.0.15 README says long-press `sysEvent` keeps `eventSource`. The docs (08-29) say `eventSource` is absent on long press. The README is newer.
- Long press: the OS claims "tap then long press" for its contextual menu, so treat long press as an enhancement only.
- IMU: `imuControl(true, ImuReportPace.P100..P1000)` streams `sysEvent` with `eventType=IMU_DATA_REPORT` and `imuData {x,y,z}` floats. The pace values are "protocol pacing codes, not literal Hz". The FAQ says "A units table is still TBD". **There is no built-in head-tilt gesture.** You would have to derive it from the raw x, y, z values.
- Audio: `audioControl(true, AudioInputSource.Glasses|Phone)` delivers PCM at 16 kHz, s16le, mono, in `audioEvent`. This is irrelevant to the reader.
- Location, album and camera: irrelevant.
- Device info: `getDeviceInfo()` returns a `DeviceInfo {model: g1|g2|ring1, sn, status}` or null. `onDeviceStatusChanged` reports `DeviceStatus {sn, connectType, isWearing, batteryLevel, isCharging, isInCase}`.
- User info: `getUserInfo()` returns `UserInfo {uid, name, avatar, country}`.
- **Local storage:** `setLocalStorage(key, value): Promise<boolean>` and `getLocalStorage(key): Promise<string>`. Values are string-to-string, and a missing key returns an empty string per the plugin skill. There is no remove method, so write `''`. No size limit is documented. The plugin skill gives a chunking example with 50,000 chars per key.
- "What the SDK doesn't expose": no Bluetooth, arbitrary pixels, audio output, text alignment, font control, background colours, per-item list styling, **programmatic scroll position**, animations or glasses camera.

### 1.6 Contextual menu (build/contextual-menu, SDK 0.0.14+, Even App 2.2.9+)
- `menuObject: { menuItems: [{ itemName, itemID }] }` goes on create or rebuild. It allows up to 10 items. `itemName` is at most **32 UTF-8 bytes**. `itemID` is a non-zero uint32 and must be unique. Items render in array order.
- The OS raises the menu on tap-then-long-press. It always includes system slots: Display off, Brightness and "Close <app name>".
- A selection arrives as `event.menuItemClickEvent.itemID`, outside the `isEventCapture` routing. The sequence is `FOREGROUND_ENTER_EVENT(4)`, then `menuItemClickEvent`, then `FOREGROUND_EXIT_EVENT(5)`. **So event 5 does not mean the app left.** Make FOREGROUND_EXIT handlers idempotent.
- Items are fire-and-forget, and labels do not update. `rebuildPageContainer` without `menuObject` clears the menu, so re-send it on every rebuild.
- Validation codes: `TOO_MANY_MENU_ITEMS`, `INVALID_MENU_ITEM_ID`, `DUPLICATE_MENU_ITEM_ID`, `INVALID_MENU_ITEM_NAME`.
- Reader idea: use the menu for "Refresh", "Back to list", "Bookmark" and "Font/brightness".

### 1.7 Background and lifecycle (build/background-lifecycle)
- On iOS the WKWebView keeps running when backgrounded. The Android Chromium WebView "May be suspended under memory pressure", after which in-memory state is lost.
- Per the docs: "`localStorage` | Always survives (persisted to disk)". The FAQ adds that it "survives suspension, kill, and update. Cleared on uninstall." IndexedDB and OPFS work but have undocumented quotas. Storage is sandboxed per `package_id`.
- **Contradiction:** the everything-evenhub `device-features` skill and the community notes both warn that browser localStorage and IndexedDB "do NOT reliably persist across app restarts" in the `.ehpk` WebView. They say to use `bridge.setLocalStorage` as the only reliable persistence. **Recommendation:** treat bridge storage as the source of truth. Mirror to `window.localStorage` only as a cache if desired.
- The everything-evenhub `background-state` skill documents `setBackgroundState` and `onBackgroundRestore` from the SDK. **These do NOT exist in any published SDK 0.0.10 through 0.0.16** (checked with grep on the unpkg d.ts files). Do not rely on them.

### 1.8 Testing (test/*)
| Mode | Hardware | Hot reload | Survives lock | Real .ehpk | Reviewer parity |
|---|---|---|---|---|---|
| Simulator | no | n/a | n/a | no | no |
| Local (QR sideload) | yes | yes | **no** | no | no |
| Private build | yes | no | partial | yes | closer |
| Beta build | yes | no | yes | yes | yes |
- Local testing: run `npm run dev`, then `evenhub qr --url http://<lan-ip>:5173`. Set `server.host: true` and `hmr.host` in Vite. "Some permission prompts are skipped during dev." **It is not documented whether the network whitelist is enforced for QR-sideloaded dev URLs.**
- Private builds are uploaded in the portal under *Private builds*. On the phone, the path is Even Hub tab, then Me, then Apps, then Private builds.
- Beta: Beta group, then Builds, then push to the group. Run the 5-minute lock test.
- Developer Mode: sign in at hub.evenrealities.com/login with the same account, then force-quit and reopen the Even app. A developer section with "Scan QR" appears.
- Device logs appear in the phone app's Developer Mode console.

### 1.9 Submission and QA (ship/app-submission), the reviewer rubric
- States: Draft, Test, Submitted, Released. Updates are fix-forward only, with no rollback. Withdrawing a Submitted build requires contacting support.
- Manifest rules:
  - `package_id` is lowercase reverse-domain with no hyphens or underscores.
  - `edition` must be "202601".
  - `name` is 20 chars or fewer and must not contain "Even" (case-insensitive).
  - `version` is semver x.y.z.
  - `min_sdk_version` is required, and the "current SDK floor" is "0.0.14".
  - Permissions must actually be used.
  - New versions need a non-empty changelog.
- Store listing: the icon and background must be greyscale and legible. Screenshots must come from the simulator screenshot function. The display name must match `app.json` `name`.
- Privacy: the "Privacy policy covers every permission". "Backend service domains, if any, are documented and traceable to the developer". This applies to our proxy.
- First run: no black screens. If setup is needed, show an on-glasses message. Setup is remembered via `localStorage`. CORS must be correct.
- Locked phone: a glasses-launched app renders while the phone is locked. The core flow works with glasses and ring input alone. The app is alive after 2 minutes idle.
- Exit: the root double-tap calls `shutDownPageContainer(1)`. A custom exit UI on the root page is not allowed. After exit, the phone WebView closes, and other apps such as Conversate launch fine.
- Content: no NSFW. Medical and financial advice need a legal flag.
- Release notes: 1-3 lines per supported language.
- Never bundle API keys, because anyone can extract the `.ehpk`.

### 1.10 Versioning (reference/versioning)
- The SDK is pre-1.0, and every release so far is a 0.0.x patch, which can add surface. Production apps should pin exactly.
- `min_sdk_version` is set by hand and gates install and update on older firmware. `min_app_version` is derived by the CLI from the SDK's npm `minAppVersion` and gates opening the plugin. An Even App below the floor is blocked at open, and the user sees "update" on the glasses.
- An `edition` bump is a platform-breaking change. Only "202601" exists.

---

## 2. npm packages (registry read 2026-10-06)

| Package | Latest | Published | Local (lihkg) | Notes |
|---|---|---|---|---|
| `@evenrealities/even_hub_sdk` | **0.0.16** | 2026-09-24 | 0.0.16 | `engines.node ^20 \|\| >=22`. No deps. `minAppVersion`: 0.0.13 = 2.2.6, 0.0.14 = 2.2.9, 0.0.15 = 2.2.10, 0.0.16 = 2.2.10 |
| `@evenrealities/evenhub-cli` | **0.1.14** | 2026-08-20 | 0.1.14 | bin `evenhub` and `eh`. Deps: commander, zod 4, inquirer, qr-image, qrcode-terminal, js-yaml, open, chalk |
| `@evenrealities/pretext` | **0.1.4** | 2026-04-16 | 0.1.4 | 0.1.4 adds an emoji font |
| `@evenrealities/evenhub-simulator` | **0.9.5** | 2026-09-01 | not installed | Native binaries via optional deps `@evenrealities/sim-{win32,linux,darwin}-{x64,arm64}` |
| `@evenrealities/even-terminal` | 0.10.5 | 2026-09-24 | - | AI coding CLI on glasses; irrelevant |

Other npm search hits (third-party): `@jappyjan/even-better-sdk` 0.0.11, `@even-toolkit/create-even-app` 1.1.5, `@penta2himajin/even-deskless` 0.1.3, `even-sim-recorder`, `even-notifications`, `ocuclaw`.

### SDK changelog (README of 0.0.16)
- 0.0.16: "Fixed repeated execution of `setTimeout` / `setInterval` callbacks." The SDK hooks timers for its background keep-alive (0.0.10 "Enhanced WebView background keep-alive").
- 0.0.15: Raised the minimum Even App to 2.2.10. Long-press and release `sysEvent` keep `eventSource`.
- 0.0.14: Even App 2.2.9. Contextual menu, `menuItemClickEvent`, LONG_PRESS 9/10, `textColor`, audio `direction` and `speakerRole`.
- 0.0.13: Added the minAppVersion metadata, set to 2.2.6.
- 0.0.12: `zOrderIndex`, LZ4 image compression.
- 0.0.11: Location, album, camera, mic source.
- 0.0.10: Background keep-alive.
- 0.0.8: Launch source (`appMenu` or `glassesMenu`). Startup containers raised from 4 to 12. IMU.

### API diff
`diff` shows that unpkg 0.0.16 `dist/index.d.ts` is identical to the local file. The only change from 0.0.15 to 0.0.16 in the d.ts is none. From 0.0.14 to 0.0.15 only one doc comment changed, on `Sys_ItemEvent.eventSource`. **There are no new public methods since 0.0.14.** There is no native fetch proxy, no new storage API and no head-tilt event.

### Simulator changelog highlights
- 0.9.5 (09-01): crash fix under heavy bridge and console traffic.
- 0.9.4: Windows and Linux ARM64 builds.
- 0.9.0 to 0.9.3: `textColor`, long press, context menu, image grayscale matching.
- 0.8.0: `zOrderIndex`, rejects partial or duplicate values.
- 0.7.3: "constraint list item text size to be maximum 63 bytes and 20 items".
- 0.7.1: no scrollbar, capped width and height per container, "text container bytes limit to 999".
- 0.7.0 (first published in 0.7.1): `--automation-port`.
- 0.6.1: unknown property fields are now an error in the simulator, which matters if we pass extra fields. Simulator events hardcode `eventSource=1`, `imuData` is always null, and status events are not emitted.

Simulator CLI: `evenhub-simulator [OPTIONS] [targetUrl]`, with `-c/--config`, `-g/--glow`, `--no-glow`, `-b/--bounce default|spring`, `--list-audio-input-devices`, `--aid`, `--no-aid`, `--print-config-path`, `--automation-port <PORT>`, `--completions <shell>`, `-V` and `-h`.

Automation API on `http://127.0.0.1:<port>`:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/ping` | Health check, returns `pong` |
| GET | `/api/screenshot/glasses` | RGBA PNG at 576x288. A pixel is lit when alpha > 0, and brightness is in the alpha channel |
| GET | `/api/screenshot/webview` | Screenshot of the host webview |
| GET | `/api/console?since_id=N` | Returns `{entries,total}`. Includes `[uncaught]`, `[unhandledrejection]` and `[fetch]` failures |
| DELETE | `/api/console` | Clears the console buffer |
| POST | `/api/input` | JSON body `{action: up\|down\|click\|double_click\|long_press\|long_press_release\|context_menu}` |

Input is ignored until an event-capturing container exists, so wait about 4 s or for a ready log line. There is no shutdown endpoint. Node is not installed on this machine, so the simulator cannot be run here unless Node is installed (`npm i -g`).

---

## 3. Full SDK API surface relevant to a reader (from index.d.ts 0.0.16)

```ts
waitForEvenAppBridge(): Promise<EvenAppBridge>          // await before ANY other call; calls before ready silently no-op
EvenAppBridge.getInstance(): EvenAppBridge
bridge.ready: boolean
bridge.callEvenApp(method: EvenAppMethod | string, params?): Promise<any>

// App
getUserInfo(): Promise<UserInfo>                 // {uid:number,name,avatar,country}
getDeviceInfo(): Promise<DeviceInfo | null>      // {model:'g1'|'g2'|'ring1', sn, status: DeviceStatus}
setLocalStorage(key: string, value: string): Promise<boolean>
getLocalStorage(key: string): Promise<string>    // '' when missing (per skill docs)

// Glasses UI
createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>  // 0 ok,1 invalid,2 oversize,3 OOM
rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>
textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>
updateImageRawData(d: ImageRawDataUpdate): Promise<ImageRawDataUpdateResult>
shutDownPageContainer(exitMode?: number): Promise<boolean>   // 0 immediate, 1 system confirm dialog
imuControl(isOpen: boolean, reportFrq?: ImuReportPace): Promise<boolean>
audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>

// Events (each returns an unsubscribe fn)
onLaunchSource(cb: (s: 'appMenu' | 'glassesMenu') => void)   // pushed ONCE after load; register early
onDeviceStatusChanged(cb: (s: DeviceStatus) => void)
onEvenHubEvent(cb: (e: EvenHubEvent) => void)
onAppLocationChanged(cb)
```

Container models:
- `CreateStartUpPageContainer` and `RebuildPageContainer` take `{ containerTotalNum (1-12), listObject?: ListContainerProperty[], textObject?: TextContainerProperty[] (max 8), imageObject?: ImageContainerProperty[] (max 4), menuObject?: MenuContainerProperty }`. `widgetId` is injected automatically on create.
- `TextContainerProperty` takes `{ xPosition, yPosition, width, height, borderWidth, borderColor, borderRadius, paddingLength, containerID, containerName, isEventCapture, zOrderIndex?, content, textColor? }`.
- `ListContainerProperty` takes `{ x/y/w/h, border*, paddingLength, containerID, containerName, isEventCapture, zOrderIndex?, itemContainer: ListItemContainerProperty }`.
- `ListItemContainerProperty` takes `{ itemCount (1-20), itemWidth (0 = auto), isItemSelectBorderEn (0/1), itemName: string[] (max 20, at most 64 chars or 63 bytes in the simulator) }`.
- `ImageContainerProperty` takes `{ x, y, width 20-288, height 20-144, containerID, containerName, zOrderIndex? }`.
- `TextContainerUpgrade` takes `{ containerID, containerName, content, contentOffset?, contentLength?, textColor? }`.
- `MenuContainerProperty` is `{ menuItems: MenuItemProperty[] }`, and `MenuItemProperty` is `{ itemName (32 UTF-8 bytes or fewer), itemID (non-zero uint32) }`.

Event model `EvenHubEvent = { listEvent?, textEvent?, sysEvent?, audioEvent?, menuItemClickEvent?, jsonData? }`:
- `List_ItemEvent { containerID?, containerName?, currentSelectItemName?, currentSelectItemIndex?, eventType? }`
- `Text_ItemEvent { containerID?, containerName?, eventType? }`
- `Sys_ItemEvent { eventType?, eventSource?: EventSourceType, imuData?: {x,y,z}, systemExitReasonCode? }`
- `MenuItemClickEvent { itemID? }`

Validation helpers are exported. `validateEvenHubPageContainer(...)` returns `{valid:true}` or `{valid:false, code, message, container?}`. The codes are `MISSING_Z_ORDER_INDEX`, `INVALID_Z_ORDER_INDEX`, `DUPLICATE_Z_ORDER_INDEX`, `TOO_MANY_MENU_ITEMS`, `INVALID_MENU_ITEM_ID`, `DUPLICATE_MENU_ITEM_ID`, `INVALID_MENU_ITEM_NAME` and `INVALID_TEXT_BRIGHTNESS`. `utf8ByteLength(str)` is also exported, which is handy for list items and menu names.

Host error code names: `APP_REQUEST_CREATE_INVAILD_CONTAINER`, `..._OVERSIZE_RESPONSE_CONTAINER`, `..._OUTOFMEMORY_CONTAINER`, `APP_REQUEST_REBUILD_PAGE_FAILD`, `APP_REQUEST_UPGRADE_TEXT_DATA_FAILED`, and others.

Limits summary:

| Limit | Value | Source |
|---|---|---|
| Containers per page | 1-12 total. Text max 8, image max 4. Docs say "4 image + 8 other" | d.ts, docs |
| Event capture | exactly 1 per page | docs |
| containerName | 16 chars or fewer, unique | docs |
| Text content | create/rebuild 1000 chars, upgrade 2000 chars. Simulator: 999 bytes | docs, sim changelog |
| Full-screen capacity | about 400-500 chars, or 10 lines at 27 px line height | docs, pretext |
| List | 20 items, 64 chars per item (simulator 63 bytes), no in-place update | docs, sim |
| Image | 288x144 or smaller, serial sends, 100 ms pacing | docs |
| Menu | 10 items, 32 UTF-8 bytes each, itemID non-zero | docs |
| .ehpk size | practical cap of about 10 MB | FAQ |
| BLE throughput | about 10-30 KB/s | FAQ |

Best-practice notes from the everything-evenhub glasses-ui skill:
- "Serialize all bridge calls, not just images - concurrent render + storage calls can crash the connection".
- "Add a per-call timeout to BLE calls - a single flaky hop can hang ~30s".
- "Debounce persistent state writes - `setLocalStorage` shares the same BLE link". It is unclear whether storage actually goes over BLE, since it lives on the phone, but serializing is cheap.
- "Call `createStartUpPageContainer` exactly once".

---

## 4. Official templates (github.com/even-realities/evenhub-templates @ 8cb0135, 2026-08-07)

| Template | Purpose | Deps |
|---|---|---|
| `minimal` | One full-screen text container. Tap counts, double-tap exits | sdk ^0.0.10, cli ^0.1.12, sim ^0.7.2, vite ^5.4, ts ^5.7 |
| `text-heavy` | **Reader:** pretext pagination with tap or swipe page turns | plus `@evenrealities/pretext` ^0.1.4 |
| `asr` | Mic to STT stub. Needs the `g2-microphone` permission | - |
| `image` | Image container with serial `updateImageRawData` | - |

All templates use `app.json` with `edition 202601`, `min_app_version 2.0.0`, `min_sdk_version 0.0.10`, `permissions: []` and `supported_languages ["en"]`. Their names include "Even Hub ...", which would be rejected at review, so rename. They all use `vite.config.ts` `server: {host:true, port:5173}, build:{target:'esnext'}` and top-level `await`. The scripts are `dev`, `build` (`tsc --noEmit && vite build`), `pack` (`npm run build && evenhub pack app.json dist`) and `simulate` (`evenhub-simulator http://localhost:5173`).

### text-heavy/src/main.ts structure
1. Constants: `BODY_W=576`, `BODY_H=240`, `BODY_PAD=4`, `BODY_BORDER=0`. `INNER_W` and `INNER_H` are those values minus padding and border.
2. Runs `pages = paginate(SAMPLE_TEXT, {width: INNER_W, height: INNER_H})` **before** awaiting the bridge.
3. Calls `await waitForEvenAppBridge()`.
4. The `body` text container is `{x0,y0,576x240, pad 4, id 1, name 'body', content pages[0], isEventCapture 1}`. The `pager` text container is `{x0, y250, 576x30, pad 4, id 2, name 'pager', isEventCapture 0}` with the content `"3 / 12 · tap: next · swipe up: prev · double-tap: exit"`.
5. Calls `createStartUpPageContainer({containerTotalNum: 2, textObject: [body, pager]})`.
6. `showPage(i)` chains onto `rendering: Promise`. It calls `textContainerUpgrade` for the body and then for the pager, then mirrors the page into the phone-side DOM (`#mirror`).
7. Event handler:
   - `eventTypeOf(envelope)` returns `envelope.eventType ?? CLICK_EVENT`, or null if the envelope is absent.
   - DOUBLE_CLICK on sys or text calls `shutDownPageContainer(1)`.
   - textType SCROLL_TOP goes to the previous page, and SCROLL_BOTTOM goes to the next page.
   - CLICK on sys or text goes to the next page.
   - SYSTEM_EXIT or ABNORMAL_EXIT on sys runs `cleanup()`, which unsubscribes.
   - It also listens for `beforeunload`.
8. The phone-side companion UI (`#app`) shows a dark-themed mirror of the current page.
9. The README suggests persisting `currentPage` via `bridge.setLocalStorage` before shipping.

### text-heavy/src/paginate.ts
- `LINE_HEIGHT=27` and `maxLines = floor(height/27)`.
- It splits the source on blank lines into paragraphs and measures each with `measureTextWrap(para, width).lineCount`.
- It greedily packs paragraphs, costing one extra line for the blank between paragraphs.
- Paragraphs that are too long are split token-by-token (on `/(\s+)/`) with re-measuring, which is O(n^2) in measure calls and could be slow for very long text. For CJK text with no spaces, `split(/(\s+)/)` yields huge tokens. A reader should add character-level fallback splitting.
- The template does not enforce the 1000 or 2000 char content limits. A 576x240 page fits about 8 lines of about 60-70 Latin chars, which is far below 2000, but dense CJK pages should be checked.

### pretext 0.1.4 API
- `getTextWidth(text): number` returns the width in px with kerning.
- `measureTextWrap(text, maxWidth): {lineCount, height (lineCount*27), lineWidths[]}`. Pass the inner width.
- `pxTruncate(text, maxPx): string` appends `...`. It is useful for list items and headers.
- `getAdvW(cp)` returns the advance in 1/16 px.
- The fallback chain is evenroster, then evenroster_crylgrek, then cn, then evenemoji.
- The 0.1.3 breaking change removed `measureList`, whose rule was "item count x 40px". That rule suggests list rows are about 40 px tall.

---

## 5. app.json manifest schema (ship/packaging plus the CLI 0.1.14 zod schema in main.js)

```jsonc
{
  "package_id": "com.example.substackreader", // regex ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$ ; no hyphens/underscores/uppercase
  "edition": "202601",                     // enum, only value
  "name": "Substack Reader",               // <= 20 chars; review: must NOT contain "Even"
  "version": "0.1.0",                      // ^\d+\.\d+\.\d+$
  "min_app_version": "2.2.10",             // optional; CLI stamps max(declared, SDK floor)
  "min_sdk_version": "0.0.16",             // required string
  "entrypoint": "index.html",              // must exist inside the packed folder
  "permissions": [                          // array of {name, desc(1-300)}; discriminated union on name
    { "name": "network", "desc": "...", "whitelist": ["https://proxy.example.workers.dev"] }
  ],
  "supported_languages": ["en"]            // subset of en,de,fr,es,it,zh,ja,ko (lowercased)
}
```
- Permission names: `network`, `location`, `g2-microphone`, `phone-microphone`, `album`, `camera`. Only `network` takes `whitelist`, which is optional and defaults to `[]`. The CLI does **not** validate entry format, but the docs say to use full origins only, with no wildcards or bare hosts. The asr template comment claims "`evenhub pack` rejects an empty whitelist". This is not true for the CLI 0.1.14 schema, though the portal might reject it. The safe course is to omit the network permission when it is unused.
- The zod object is not `.strict()`, so extra keys such as `description` or `tagline` pass the CLI. The packaging docs mention `tagline` and `description` as places for longer copy.
- `evenhub init` creates the template with `min_app_version 2.2.6`, `min_sdk_version 0.0.7` and example network and location permissions.

## 6. evenhub-cli 0.1.14 commands
- The commands found in the bundle are `init`, `qr`, `login` and `pack`. The CLI also installs the bin alias `eh`.
- `evenhub init [-d <dir>] [-o <path>]` writes `app.json`.
- `evenhub qr [-u <url>] [-i <ip>] [-p <port>] [--path <p>] [--https|--http] [-e/--external] [-s/--scale n (default 4)] [--clear]`. It caches the scheme, IP, port and path. Without `--url` it auto-detects the IP and prompts.
- `evenhub login [-e <email>]` logs in with an Even account. Its own changelog says "not super useful at this time". The CLI stores a token with `{email, role, access_token, refresh_token,...}`. **We will not use it.**
- `evenhub pack <app.json> <folder> [-o out.ehpk] [--no-ignore] [-c/--check] [--sdk-ver <v>] [--enforce-manual-version]`.
  - `-c` checks `package_id` availability against hub.evenrealities.com.
  - `--sdk-ver` reads `minAppVersion` from npm. Without it, the CLI uses the **latest** SDK's floor.
  - It falls back to a bundled map when offline. It exits non-zero on failure (0.1.14+).
  - An `.ehpk` is a zip of the built assets plus the manifest, packed through a wasm `ehpk_pack`.
  - "An .ehpk cannot currently be opened or run directly". To test one, upload it to the portal.
- Shell completion: `evenhub --completion-bash|--completion-zsh|--completion-fish`.
- The sibling CI pattern runs `node node_modules/@evenrealities/evenhub-cli/main.js pack artifacts/app.json artifacts/package --sdk-ver 0.0.16 -o artifacts/<name>-<ver>.ehpk`.

## 7. Implications and recommendations for the Substack reader
1. **Architecture:** Use a WebView plugin plus our own HTTPS CORS proxy, such as a Cloudflare Worker that is GET-only, allowlists Substack hosts, strips cookies, and returns JSON or sanitized text with `Access-Control-Allow-Origin: *`. Put the proxy origin, and only that origin, in `network.whitelist`. Use simple GET requests with no custom headers so there is no preflight. Document the proxy domain in the privacy policy.
2. **Pin versions:** `@evenrealities/even_hub_sdk` 0.0.16 exact, `min_sdk_version` "0.0.16", and pack with `--sdk-ver 0.0.16`, which stamps `min_app_version` 2.2.10. Use `@evenrealities/pretext` 0.1.4 and `@evenrealities/evenhub-cli` 0.1.14 as devDependencies. Optionally add `@evenrealities/evenhub-simulator` 0.9.5.
3. **Screens:**
   - Publication or post list: a list container with up to 20 items. Truncate titles with `pxTruncate`, keep them at 63 UTF-8 bytes or fewer, and paginate the list with "More..." or "Back" items. A click arrives via `listEvent.currentSelectItemIndex`, where `?? 0` is needed for item 0. Note that the docs say 64 chars, but `utf8ByteLength` is safer.
   - Article reader: a body text container plus a pager or status strip. Paginate with pretext at 27 px lines. Turn pages with `textContainerUpgrade`, which allows up to 2000 chars, though a page will be far smaller.
   - Switching between the list and the reader requires `rebuildPageContainer`, with a 1000-char limit per text container on rebuild. Re-send `menuObject` on every rebuild.
4. **Input:** handle click and double-click on sysEvent, textEvent and listEvent. Make the root page's double-tap call `shutDownPageContainer(1)`. An inner page's double-tap should go back. Long press is an optional enhancement.
5. **Persistence:** store the subscribed publications, the read position per post and settings in `bridge.setLocalStorage` as JSON strings. Serialize and debounce the writes. Optionally mirror to `window.localStorage`.
6. **First run:** show an on-glasses instruction such as "Add a publication in the phone app". Never show a black screen. Handle offline and proxy errors with on-glasses messages.
7. **Lifecycle:** on Android, assume a cold start. Restore from bridge storage. Treat FOREGROUND_EXIT as possibly just the menu overlay.
8. **Store and QA:** do not use "Even" in the name. Make a greyscale icon on 2x2 blocks. Take screenshots from the simulator.

## 8. Contradictions and doc drift found
- The docs changelog and install pages list SDK 0.0.14 and simulator 0.9.3 as current. npm has SDK 0.0.16 and simulator 0.9.5. The submission rubric says the "Current SDK floor: 0.0.14".
- The docs say text and list clicks route to `textEvent` or `listEvent`. The templates and skills say taps and double-taps route to `sysEvent`. The community notes say the simulator uses sys and hardware uses text or list.
- On browser `localStorage` persistence, the official docs say "always survives". The official plugin skill and the community notes say it is unreliable and recommend bridge storage.
- On list scroll events, the docs mention a SCROLL_TOP/BOTTOM "boundary". The skill says lists emit no scroll events. The community notes say they fire only at the boundaries.
- On `eventSource` for long press, the docs say it is absent. The SDK 0.0.15 README says it is preserved.
- `setBackgroundState` and `onBackgroundRestore` appear in the official Claude skill but in no published SDK.
- The asr template says pack rejects an empty whitelist, but the CLI schema allows `[]`.
- List item limits: 64 chars (docs) versus 63 bytes (simulator).
- Text limits: chars (docs) versus 999 bytes (simulator).
- The CLI README lists `login`, but the docs CLI reference omits it.
- The CLI README says `--http` means "Use HTTP instead of HTTPS", implying an HTTPS default. The docs say HTTP is the default.
- **No evidence was found that contradicts** the "whitelist plus CORS" requirement. The sibling LIHKG reader is consistent with it, using a Worker with ACAO `*` and injecting the whitelist at pack time.
