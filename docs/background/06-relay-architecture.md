# 06 — How the app gets Substack data (relay architecture)

Research date: 2026-10-06. Probes were made from the owner's Windows PC (residential AT&T, AS7018) with curl/python. No logins or credentials were used. Nothing was modified in `C:/Code/lihkg-reader-for-evenhub` or the target repo. Article text was not stored; only sizes, field names and headers were recorded.

---

## 0. TL;DR

* **Primary:** a small **stateless, GET-only Substack relay Worker** (one ESM file with `export default { fetch }`) that the owner deploys. It allowlists hosts and paths, adds `Access-Control-Allow-Origin: *`, trims Substack JSON to the fields the reader needs, caches at the edge, and returns a stable JSON envelope. The same source builds for **(A) the owner's own Cloudflare Workers account** (`wrangler`, `*.workers.dev`) or **(B) the owner's existing OpenAI "Sites" hosting** (`*.darkdarkb.chatgpt.site`, where the LIHKG relay runs, also on Cloudflare). I recommend A as the default target: it is self-serve from GitHub Actions and has a rate-limit binding. B is fine if the owner prefers it, but only the owner can deploy it from the Codex/ChatGPT Sites tooling.
* **Fallback (opt-in, client-side):** `https://api.rss2json.com/v1/api.json?rss_url=<feed>`. It returns `access-control-allow-origin: *`, works from datacenter IPs against both `*.substack.com` and custom domains, and includes full free-post HTML in `items[].content`. It is limited to the latest 10 items, adds a third party that can see what you read, and has no SLA.
* **Rejected:** r.jina.ai (anonymous use now returns 401 "bad network reputation", even from a residential AT&T IP), corsproxy.io (now needs an API key, free tier is "browser/demos only" and not for production), allorigins (flaky 500/408 responses and reflects arbitrary origins with credentials), codetabs (522).
* **D) Even native network bridge:** **absent** in SDK 0.0.16. The only bridge methods are user/glasses info, `setLocalStorage`/`getLocalStorage`, location, image picker, page containers, audio, IMU and shutdown. `callEvenApp(string)` is generic but undocumented.
* **E) WebView Origin:** **not documented**. The docs say only Chromium (Android) / WKWebView (iOS). Dev builds load from `http://<LAN-IP>:<port>`. So the relay uses `ACAO: *`, no credentials, and simple GETs with no custom headers (so no preflight). `/v1/health` should echo the observed `Origin` so the real value can be learned on a device.
* **Biggest risk:** Substack blocks some datacenter egress for `*.substack.com` (but not for custom domains) — see §1.3. Whether a Worker's egress to Substack is accepted **must be measured right after the first deploy** (there is a `/v1/health?probe=1` route for this). The relay must report blocks honestly and must **not** spoof browsers or rotate IPs. The LIHKG relay on the same Sites/Cloudflare infrastructure got HTTP 403 from LIHKG.
* **HTML→text conversion: client-side (DOMParser).** The relay only trims JSON. After gzip, server-side text conversion would save only about 1.5–2× and would need a hand-written HTMLRewriter text model running under a 10 ms CPU budget.

---

## 1. Evidence

### 1.1 Substack responses (live, 2026-10-06)

`curl -D - -H 'Origin: https://example.org'` against:

| URL | Status | Relevant headers |
|---|---|---|
| `https://on.substack.com/api/v1/archive?sort=new&offset=0&limit=2` | 200 `application/json; charset=utf-8` | `Server: cloudflare`, `CF-Ray`, `Cache-Control: no-cache`, `Set-Cookie: ab_experiment_sampled…; Domain=substack.com`, `ab_testing_id…`, `__cf_bm=…`, **`x-served-by: Substack`**, **`x-cluster: substack`**, `x-service: web`, `x-powered-by: Express`, `x-deploy: a758c95aa2`. **No `Access-Control-Allow-Origin`.** |
| `https://www.astralcodexten.com/api/v1/archive?sort=new&limit=1` (custom domain) | 200 JSON | same set, cookies scoped to the custom domain, **no ACAO** |
| `https://newsletter.pragmaticengineer.com/feed` | 200 `application/xml; charset=utf-8` | `CF-Cache-Status: HIT`, `Age: 1937`, **`x-sub: pragmaticengineer`**, `x-served-by: Substack`, `x-cluster: substack`, **no ACAO** |
| `OPTIONS https://on.substack.com/api/v1/archive?limit=1` + `Access-Control-Request-Method: GET` | 200 | `Allow: GET,HEAD`, **no ACAO/ACAM** → CORS preflight fails too |

This confirms the known fact: a direct WebView fetch fails CORS. `mode:'no-cors'` gives an opaque response, so it is useless. JSONP is not supported.

The User-Agent did not matter from the residential IP. The default curl UA, an empty UA, a missing UA header and `python-requests/2.31.0` all got 200.

Redirect and error behaviour (relevant to relay validation):

* `https://astralcodexten.substack.com/api/v1/archive?limit=1` → **301** `Location: https://www.astralcodexten.com/api/v1/archive?limit=1` (`x-served-by: Substack`, text/plain). Subdomains of publications that have a custom domain redirect to that domain, keeping the path and query.
* `https://slowboring.substack.com/api/v1/posts/<slug>` → 301 → `https://www.slowboring.com/api/v1/posts/<slug>`.
* `https://nonexistent-pub-zzzq.substack.com/...` → **302** to `nonexistentpubzzzq.substack.com` (hyphens stripped), then **404** with an empty body.
* `https://www.slowboring.com/api/v1/posts/does-not-exist-zzz` → **404** `application/json` `{"error":"Post not found","type":"single"}`.
* `https://astralcodexten.com/feed` (apex) → 404 `text/html; charset=iso-8859-1` from a **non-Substack** server (no `x-served-by`). Apex domains are therefore not automatically Substack. The relay must validate every redirect target.
* `https://www.slowboring.com/api/v1/publication` and `/api/v1/publication/public` → **403 "Not authorized"** (text/html). These cannot be used for publication metadata.
* `https://www.slowboring.com/api/v1/homepage_data` → 200 JSON, **184 KB**. Too heavy; avoid it.
* `https://substack.com/api/v1/publication/search?query=zvi&page=0&limit=2` → 200 `{"results":[]}` for every query tried, including "astral codex ten". **This looks broken or neutered.** `https://substack.com/api/v1/top/search?query=zvi` → 200 JSON, **315,901 bytes** (`items[]` of typed groups, e.g. `type:"profileSearchResults"` with `results[].primaryPublication{subdomain,custom_domain,…}`). `https://substack.com/api/v1/search/publications` → 404.
* `https://substack.com/api/v1/user/thezvi/public_profile` → 200 JSON (36 KB). It has `primaryPublication{id,name,subdomain,custom_domain,custom_domain_optional}` and `subscriptions[].publication{subdomain,…}` (13 visible for this user).

DNS (via DoH `https://cloudflare-dns.com/dns-query?name=<h>&type=CNAME`, `accept: application/dns-json`). These custom domains all CNAME to **`target.substack-custom-domains.com.`**: www.astralcodexten.com, newsletter.pragmaticengineer.com, www.slowboring.com, www.transformernews.ai and writing.antonleicht.me. `*.substack.com` hosts have no CNAME answer. That gives a strong pre-flight check for custom domains.

robots.txt (substack.com and custom domains are identical): `/api/` and `/feed` are **not** disallowed. Disallowed paths include `/action/`, `/publish`, `/sign-in`, `/feed/private`, `/subscribe`, `/p/*/comment/*`, `/inbox/post/*`, `/notes/post/*` and `/embed`.

Substack ToS, Acceptable Use (https://substack.com/tos): it prohibits users who "crawls, scrapes, or spiders any page…" and who "copies or stores any significant portion of the content". **Design implication:** fetch only on demand, one user request at a time. Do not crawl, prefetch whole archives or store content persistently (no KV/D1/R2 for posts). Keep only a short-lived HTTP edge cache. Forward no cookies, so only public and free content is ever served.

### 1.2 Payload sizes (drives the "where to convert HTML" decision)

`/api/v1/posts/<slug>` for one recent free post per publication. `gz` is zlib level 6, roughly what Cloudflare applies to the wire.

| Pub | wordcount | full JSON | JSON gz | `body_html` | stripped text | text gz |
|---|---|---|---|---|---|---|
| astralcodexten | 10,539 | 144,710 | 36,299 | 136,107 | 64,488 | 24,905 |
| pragmaticengineer | 5,062 | 125,810 | 23,723 | 110,369 | 30,860 | 12,439 |
| slowboring | 1,799 | 40,019 | 11,950 | 24,681 | 11,010 | 4,623 |
| on.substack | ~? | 16,705 | — | 11,132 | ~2,088 | — |
| pragmaticengineer, paid post (`audience:"only_paid"`) | 2,889 | 8,823 | 3,426 | 1,339 (truncated preview) | 1,174 | 657 |

* The post JSON has 73 keys. The reader only needs about 10 of them plus `body_html`, which is roughly 94% of the bytes. Trimming fields saves little on posts.
* HTML→text saves about **2× raw / 1.5–2× gzipped** (36 KB → 25 KB; 24 KB → 12 KB). That is small for a phone that already downloads it over HTTPS with gzip.
* Body tag mix (small sample): `div, p, a, picture, source, img, figure, figcaption, svg, polyline, line, button, span, em`. The image-expand buttons and SVG icons are noise that the client drops.
* Paid posts: the JSON has `audience:"only_paid"` and a short truncated `body_html`. The relay never forwards cookies, so it gets the public preview only. The UI must label these "Paid — preview only".
* `/api/v1/archive?sort=new&offset=0&limit=12` for slowboring: **62,582 B raw / 7,657 gz**. Trimmed to `{id,slug,title,subtitle,post_date,audience,type,wordcount,canonical_url,authors[]}` it is **5,122 B raw / 1,572 gz**, about 12× smaller raw and 5× smaller gzipped. Trimming list endpoints is worth it and costs only `JSON.parse` (no DOM). `body_html` is present in archive items but `null`. `type` seen: `newsletter`, `podcast`. `audience` seen: `everyone`, `only_paid`.
* Archive items carry publication metadata. `publishedBylines[i].publicationUsers[j].publication` = `{id, name, subdomain, custom_domain, custom_domain_optional, logo_url, …}`; match on `publication_id === post.publication_id`. So `/v1/archive` can return publication info without another request.
* `/feed`: slowboring 222,357 B raw / 46,458 gz for 20 `<item>`s, each with `<content:encoded>` holding the full free HTML. That is heavier than archive JSON, so use it only as a fallback.

### 1.3 Does Substack block datacenter / Worker egress?

Evidence, strongest first:

1. **GitHub Actions runners (Azure IPs) get 403 on `*.substack.com` but 200 on Substack custom domains.** The issue https://github.com/simonkral1/policy-tracker/issues/94 (2026-10-05) is a weekly Bun `fetch` with UA `SaferAI-Policy-Tracker/0.1 rss-verifier` running on `ubuntu-latest`. All 7 `https://<x>.substack.com/feed` URLs returned **403 `text/html; charset=UTF-8`, ~5.5 KB** (a block page). All 7 Substack custom-domain feeds returned **200**: www.transformernews.ai, www.aipolicyperspectives.com, writing.antonleicht.me, www.hyperdimensional.co, www.dwarkeshpatel.com, newsletter.safe.ai and www.luizasnewsletter.com. I re-verified that the first four send `x-served-by: Substack` and `x-sub:`. The same failure recurs in that repo's issues #75, #77, #81, #84, #87, #89 and #91 (Aug–Sep 2026), so it is persistent.
2. https://github.com/dsa-ntc/dsa-planet/issues/53 (2024-03-03), "Substack blocking GitHub IPs": only Substack feeds returned 403 from Actions, and the same code worked from a home PC. A later comment (2026-08-29) suggests openrss.org.
3. https://github.com/HeyThisIsAndrew/BeUnconventionalHQ/issues/280 (2026-10-05): "the fetch is flaky from those [GitHub Actions] runners". It considers moving the fetch to a Cloudflare Worker or a residential machine, but the root cause is not yet established.
4. https://github.com/conorbronsdon/substack-mcp README: "Substack publications served on a custom domain … sit behind Cloudflare, which can reject non-browser requests with `403 error code: 1010`" (1010 = browser-signature ban). It mitigates this by sending a browser UA and a Referer. That is spoofing, which I do **not** recommend; see §6.
5. https://github.com/NHagar/substack_api: PR #15 (2025-10-30) "Internal call limiting" adds `sleep(2)` after each request "to prevent 429 errors". PR #18 (2025-12-14) is an open idea for handling 429. Substack does rate-limit.
6. **Counter-evidence that datacenter egress can work.** From allorigins' servers (`api.allorigins.win`, behind Cloudflare), fetches of `https://thezvi.substack.com/api/v1/archive?…` (200 JSON), `https://garymarcus.substack.com/feed` (200 XML, 70 KB) and `https://www.slowboring.com/api/v1/archive` (200) all succeeded **today**. rss2json's servers fetched `thezvi.substack.com/feed`, `garymarcus.substack.com/feed` and `www.slowboring.com/feed` (status ok). https://github.com/Noah-Bjorner/SubstackAPI is a Hono app **on Cloudflare Workers** that calls `${pub}/api/v1/archive?sort=…&offset=…&limit=…`, `${pub}/api/v1/posts/${slug}` and `${pub}/feed` with plain `fetch(url)` (no UA), with RSS as a fallback. It was last committed 2025-02 and has no issues filed. So blocking is **selective**: probably IP-reputation/ASN-based on the `substack.com` zone, possibly combined with UA.
7. **Cloudflare-specific facts about Worker → Cloudflare-proxied site (Substack is on Cloudflare).** Cloudflare's HTTP headers reference says every Worker subrequest carries **`CF-Worker: <zone of the Worker>`**. For **cross-zone** subrequests, "the `CF-Connecting-IP` value will be set to the Worker client IP address `2a06:98c0:3600::103`". So Substack's WAF sees every Worker in the world as one IP and can single out Worker traffic with `cf.worker.upstream_zone` (Transform/WAF rules, changelog 2025-06-09). Any per-IP rate limit on Substack's side would be shared with all other Worker users. That is a real **429 risk** and the main reason for edge caching.
8. **Owner's own precedent.** The LIHKG relay on `https://lihkg-reader-evenhub-alpha.darkdarkb.chatgpt.site` (`Server: cloudflare`, `CF-RAY`; I GET'd `/health` → `{"ok":true,"service":"lihkg-reader","protocol":3,"revision":"android-companion-v1","companionConfigured":true}`, `Access-Control-Allow-Origin: *`) received **upstream 403 `text/html`, no `cf-mitigated`** from LIHKG (docs/releases/gateway-diagnostics-2026-09-30.md). Different site, same egress class.

**Conclusion.** A Worker relay is likely to work for **custom-domain** publications. It is uncertain for **`*.substack.com`** publications and for `substack.com/api/v1/*` (profile and search). The first deploy must run `/v1/health?probe=1` against one subdomain pub, one custom-domain pub and `substack.com/api/v1/user/<handle>/public_profile`, and record the results. If `*.substack.com` is blocked from the Worker, the options are, in order: (i) the client falls back to rss2json for that publication (opt-in); (ii) host the same relay code somewhere with different egress (Deno Deploy, Vercel/AWS, Fly.io, or the owner's Sites origin if it differs from workers.dev) — the code is portable because it only uses `fetch`/`Request`/`Response`/`caches` with a guard; (iii) an Android-companion-style approach (as LIHKG 0.4.0 did). (iii) is heavy and not recommended for Substack.

### 1.4 Third-party CORS intermediaries (option C), probed with `-H 'Origin: https://example.org'`

| Service | Result | ACAO | Notes |
|---|---|---|---|
| `https://api.allorigins.win/raw?url=<enc>` | 200 for `slowboring.com/api/v1/archive` (10,436 B, body verbatim), `thezvi.substack.com/api/v1/archive`, `garymarcus.substack.com/feed`. **500** for `/get?url=…/feed`; **500** with `Origin: null`; **408** with `Origin: file://` | Reflects the request origin (`https://example.org`, `file://`) and adds `Access-Control-Allow-Credentials: true` | `Cache-Control: public, max-age=300, stale-while-revalidate=86400`. Volunteer-run, no SLA, flaky. Reflecting origins with credentials is poor hygiene. Not recommended. |
| `https://corsproxy.io/?url=<enc>` | **401** `{"error":"A valid API key is required. Get one at https://console.corsproxy.io/"}` | `*` | Pricing page: free = API key, 10,000 req/month, 1 GB, "Browser apps / Demos", no production use, best effort. An API key in an `.ehpk` is extractable (Even FAQ: "Can I commit my API key to the .ehpk? No"). Rejected. |
| `https://api.rss2json.com/v1/api.json?rss_url=<enc feed>` | 200, `{"status":"ok","feed":{url,title,link,author,description,image},"items":[{title,pubDate,link,guid,author,thumbnail,description,content,enclosure,categories}]}`. **10 items**; `content` = full `content:encoded` HTML (23,633 chars for one slowboring post); `description` = short teaser. Works for `*.substack.com` feeds too. 135 KB response | `*` (also for `Origin: null` and `file://`) | `Cache-Control: public, max-age=1800`. Docs: `count`, `order_by` and `order_dir` "api_key is required". JSONP `callback` is supported. The plans page renders client-side, so free-tier daily quotas could not be read (unknown). Third party sees the feed URL + client IP. **Best fallback.** |
| `https://r.jina.ai/<url>` | **401** `AuthenticationRequiredError … "You have been blocked from performing anonymous queries due to bad network reputation (AS7018). Please authenticate."` | Reflects origin + `allow-credentials: true` | Needs a key, which cannot ship in the `.ehpk`. Rejected. |
| `https://api.codetabs.com/v1/proxy/?quest=<url>` | **522** `error code: 522` | — | Down/unreliable. Rejected. |

Fallback usage: rss2json only covers "latest 10 posts of a feed, with full free HTML". There is no archive paging, no single-post-by-slug and no profile/search. It is good enough to keep reading recent posts if the relay is down or blocked.

### 1.5 Even platform facts (options D and E)

* https://hub.evenrealities.com/docs/build/networking (last updated 2026-06-11). Two gates: (1) "Even-side permission check. The destination domain must be in your `app.json` `network` permission `whitelist`… Anything not in the whitelist is blocked - no traffic generated at all." (2) "Browser CORS check. The WebView's browser engine (Chromium on Android, WKWebView on iOS) enforces standard CORS." Also: "One whitelist entry per origin. Use the full origin (`https://api.example.com`) - bare hostnames and wildcards aren't supported." "HTTPS in production. Plain `http://` is only useful for local dev against a LAN dev server." Required header: `Access-Control-Allow-Origin: * # or specifically the WebView origin if you can identify it`. Preflight is only needed for custom headers, JSON bodies or non-GET/POST. "If the API is third-party and you can't touch its CORS, proxy through a server you control that sets the right headers - then put that server's domain in the app.json whitelist."
* FAQ (https://hub.evenrealities.com/docs/reference/faq): `fetch()` to arbitrary URLs is not allowed. The whitelist does not bypass CORS. WebSockets follow the same whitelist. **No network while backgrounded** ("WebView is suspended on background; in-flight requests stall"). `localStorage` survives suspension, kill and update and is cleared on uninstall. No API keys in the `.ehpk`; "Move keys behind a server-side proxy."
* https://hub.evenrealities.com/docs/ship/packaging (2026-08-29): `permissions` is an array of objects; `network` has `whitelist: string[]` (default `[]`); `desc` is 1–300 chars. Hidden files are excluded from the pack by default. The CLI 0.1.14 zod schema (`node_modules/@evenrealities/evenhub-cli/main.js`) confirms `{name:"network", desc: string(1..300), whitelist: string[] default []}`.
* **SDK 0.0.16** (`@evenrealities/even_hub_sdk`, `minAppVersion` 2.2.10) `dist/index.d.ts` `EvenAppMethod`: `getUserInfo, getGlassesInfo, setLocalStorage, getLocalStorage, getAppLocation, start/stopAppLocationUpdates, pickImageFromAlbum, captureImageFromCamera, createStartUpPageContainer, rebuildPageContainer, updateImageRawData, textContainerUpgrade, audioControl, imuControl, shutDownPageContainer`. The generic `callEvenApp(method: EvenAppMethod | string, params?)` exists. **There is no HTTP/proxy/fetch bridge.** The LIHKG project reached the same conclusion (docs/reading-blocker.md, docs/releases/gateway-diagnostics-2026-09-30.md). Option D is **absent**.
* **The WebView origin is undocumented** in the networking, architecture, packaging and FAQ pages. In dev it is the Vite LAN URL (`http://192.168.x.x:5173`). In production it is unknown: it could be `file://` → `Origin: null`, a custom scheme, or an https host. Implications:
  - Use **`Access-Control-Allow-Origin: *`**. It matches every origin including `null` for **non-credentialed** requests. Never combine it with `Access-Control-Allow-Credentials`.
  - The frontend uses `fetch(url, { credentials: 'omit', headers: {} })` with **no custom request headers**, so every call is a CORS "simple request" with no preflight. That saves a round trip on the phone. The relay still answers `OPTIONS` with 204.
  - Never use Origin for authorization. It is unknown and spoofable, and CORS is not auth anyway (the LIHKG docs say the same).
  - `/v1/health` echoes the received `Origin` header (sanitized, ≤128 chars, or `null`) so the owner can learn the real production value from a device.

---

## 2. Option B in detail: the owner's existing "Sites" hosting

Files read: `.openai/hosting.json`, `wrangler.toml`, `worker/index.ts`, `worker/companion.ts`, `docs/deployment.md`, `docs/releases/*.md`, `scripts/package-site.mjs`, `scripts/pack.mjs`, `artifacts/push-site-source.mjs`, `artifacts/site-companion-0.4.0.json`, the `artifacts/site-companion-0.4.0.tar.gz` listing, `package.json`, `vite.config.ts`, `.github/workflows/{ci,release}.yml`, and the snapshot of the Sites skill in `research/sites-skill/` (SKILL.md, scripts/package-site.sh, scripts/prepare-site-build.cjs, and templates/worker-esm-starter from building.tar.gz).

What the owner did:

* **Hosting:** OpenAI "Sites" (`*.<user>.chatgpt.site`), backed by Cloudflare Workers (`Server: cloudflare`, `CF-RAY`). `.openai/hosting.json` = `{"project_id":"appgprj_6aba0c254eb48191a421b1af1ceb7407","d1":"DB","r2":null}`. The `d1` binding was added in 0.4.0 for the encrypted companion mailbox. Origin: `https://lihkg-reader-evenhub-alpha.darkdarkb.chatgpt.site`. Audience `public` (revision 2, explicitly authorized 2026-09-28T07:44:03Z). Deployments: v3 `appgdep_6abaa6cbba248191b83ff01024e1b33a` (2026-09-28), v4 `appgdep_6abd6c5596b481919520200c08f7a92a` (2026-09-30), 0.4.0 `appgdep_6abd92f3c120819186923bdaca36d723`.
* **Worker source:** `worker/index.ts` (+ `companion.ts`, `landing.ts`), an ES module with `export default { async fetch(request, env) {…} }`. It returns JSON envelopes `{ok:true,data}` / `{ok:false,error:{code,message,diagnostics?}}` with CORS `{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store, private','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}`. It has a fixed upstream (`https://lihkg.com/api_v2`), an operation allowlist, `MAX_REQUEST` 8 KiB, `MAX_RESPONSE` 2 MiB read by a streaming `boundedText()`, a 15 s `AbortController` timeout, `redirect:'manual'`, `cache:'no-store'`, and upstream diagnostics (status, normalized content-type, `cf-mitigated: challenge` boolean, bounded `Retry-After`) without echoing raw bodies or headers. These are good patterns to copy.
* **Build:** `package.json` `"build": "tsc --noEmit && vite build && esbuild worker/index.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=dist/server/index.mjs"`. The Vite plugin `reader-build-metadata` emits `dist/build-info.json` = `{version, apiOrigin: process.env.VITE_API_BASE_URL}`.
* **Sites archive:** `scripts/package-site.mjs` requires a clean git tree and checks `hosting.project_id` and `d1`. It copies `dist` → `artifacts/site-companion-staging/dist`, adds `dist/.openai/hosting.json` and `dist/.openai/drizzle/**` (D1 migrations), then runs `tar -czf artifacts/site-companion-0.4.0.tar.gz -C staging dist` and writes `{source sha, archive, sha256, bytes}`. Archive listing: `dist/{index.html,build-info.json,icon.svg,assets/*,server/index.mjs,.openai/hosting.json,.openai/drizzle/0000_*.sql,.openai/drizzle/meta/{_journal.json,0000_snapshot.json}}` (94,015 bytes).
* **Source push:** `artifacts/push-site-source.mjs` reads a short-lived credential JSON from stdin (`{auth_mode:'http_extra_header', token, remote_url, branch}`) and runs `git push <remote_url> HEAD:refs/heads/<branch>` with `http.<origin>/.extraHeader: Authorization: Bearer <token>`, redacting the token. Deployment itself happened through native Sites connector tools (`save_site_version` → `deploy_site_version`; private: `save_version_and_deploy_private`), polled with `get_deployment_status`. **These tools exist only in the owner's Codex/ChatGPT environment. They are not available to Claude Code**, so Claude can prepare the archive but cannot deploy it.
* **Current Sites contract (skill snapshot, Sept 2026):** `prepare-site-build.cjs` treats a project as a *Worker build* unless `hosting.static` is set, and **requires `dist/server/index.js`** (`const entrypoint = isStatic ? … : "dist/server/index.js"`). The worker-esm-starter README says "`dist/server/index.js` is an ES module with a default export containing `fetch(request, env, ctx)`". The LIHKG build emitted `index.mjs` and was deployed successfully, possibly with an older or more lenient pipeline. For a new project, **emit `dist/server/index.js`**. `.openai/hosting.json` may contain only `project_id`, optional `static`, logical `d1`/`r2`, `plugins`/`connectors` and `capabilities`. There is **no rate-limit binding and no custom wrangler config**; runtime values are managed through Sites. Static builds may not have D1/R2/migrations. Hosted Sites have no raw TCP `connect()`. The whole `dist/` is archived, but the LIHKG Worker serves `/` itself, so static-asset serving in Worker mode is unverified. A relay does not need it.

**What a Substack relay on Sites needs**

```
.openai/hosting.json        {"project_id":"<NEW Sites project id>","d1":null,"r2":null}
worker/relay.ts             the relay (export default { fetch(request, env, ctx) })
build: esbuild worker/relay.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=dist/server/index.js
archive: tar -czf artifacts/site-relay-<ver>.tar.gz -C <staging> dist
   dist/server/index.js
   dist/.openai/hosting.json
   (no drizzle — stateless)
```

A new Sites project (new `project_id`) is cleaner than adding routes to the LIHKG project, which would couple two apps and their release cycles. The owner must register it, push the source, save, deploy, and explicitly authorize a `public` audience (the Even WebView is unauthenticated). Pros: the same infrastructure the owner already uses, and no Cloudflare account needed. Cons: deploys require the owner's Codex session; no rate-limit binding; Cache API behaviour under Sites (presumably Workers for Platforms) is unverified; same Cloudflare egress class as the LIHKG relay that LIHKG blocked.

## 3. Option A in detail: the owner's own Cloudflare Worker

* **Free plan limits** (https://developers.cloudflare.com/workers/platform/limits/): 100,000 requests/day (resets 00:00 UTC; beyond that, **Error 1027** and the Worker is bypassed, "fail open"), **10 ms CPU** per HTTP request, 50 subrequests per request, 128 MB memory per isolate, 6 simultaneous outgoing connections waiting for headers, 64 MiB script, no wall-clock limit while the client is connected (`ctx.waitUntil` up to 30 s after the response), Cache API 50 calls per request. Wall time spent waiting on Substack does not count toward CPU. `JSON.parse` of a 150–300 KB body takes about 1–3 ms, which fits.
* **Cache API** (https://developers.cloudflare.com/workers/runtime-apis/cache/): it is per-data-center (not replicated), and "Workers deployed to custom domains have access to functional `cache` operations". It has no effect in the dashboard editor or Playground and is unavailable behind Cloudflare Access. `.workers.dev` is mentioned only for cache-key behaviour of redirects. **Treat caching on `*.workers.dev` as best-effort**, and attach a custom domain if the owner has one. Responses with `Set-Cookie` are never cached, so the relay builds fresh `Response`s and copies no upstream headers. `cache.put` returns 413 if the `Cache-Control` says not to cache, so set `Cache-Control: public, max-age=N` on the stored response.
* **Rate limiting binding** (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): `[[ratelimits]] name="RL" namespace_id="1001" simple={limit=60, period=60}`. `period` must be 10 or 60; the limit is counted per Cloudflare location. Call `env.RL.limit({ key })`.
* **Outbound headers:** a Worker can set `User-Agent` and `Accept`. Cloudflare adds `CF-Worker: <zone>`, and in cross-zone requests `CF-Connecting-IP: 2a06:98c0:3600::103` (shared; see §1.3). Use `redirect:'manual'` so the relay validates each hop.
* **Deploy without local Node:** a GitHub Actions job with `cloudflare/wrangler-action` plus repo secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit) and `CLOUDFLARE_ACCOUNT_ID`. The owner creates these; Claude must not. The result is `https://substack-reader-relay.<account-subdomain>.workers.dev`, which becomes the repository variable `VITE_RELAY_ORIGIN`.

`wrangler.toml` sketch:

```toml
name = "substack-reader-relay"
main = "worker/relay.ts"
compatibility_date = "2026-09-01"
workers_dev = true

[observability]
enabled = false            # no request logging (privacy), mirrors LIHKG

[[ratelimits]]
name = "RL"
namespace_id = "1001"
simple = { limit = 60, period = 60 }
```

The relay code must treat `env.RL` and `globalThis.caches` as **optional**, so the identical bundle runs on Sites (no binding), Cloudflare (binding) or a Node/Vite dev middleware (no `caches`).

---

## 4. Recommended architecture

```
G2 glasses ⇄ (BLE) ⇄ Even app WebView: Substack Reader (.ehpk, Vite/TS)
                         │  fetch GET, credentials:'omit', no custom headers  (simple CORS)
                         ▼
             RELAY  https://<relay-origin>   (whitelisted in app.json)
             - GET only; fixed routes; host+path allowlist; DoH CNAME check
             - fetch Substack with honest UA, redirect:'manual', 10 s timeout, size caps
             - verify x-served-by: Substack; trim JSON; ACAO:*; edge cache
                         │
                         ▼
             Substack: <sub>.substack.com | custom domain | substack.com/api/v1/user/…
   (opt-in fallback, client-side) → https://api.rss2json.com (latest 10 items with full HTML)
```

* Client stores the list of followed publications as canonical hosts in `localStorage`, with an SDK `setLocalStorage` mirror if wanted.
* Client converts `body_html` → G2 text with `DOMParser` (`text/html`), walking block elements and dropping `svg`, `button`, `picture source`, `.image-link-expand`, `script` and `style`. It then paginates with `@evenrealities/pretext`. The same converter handles rss2json `items[].content`, so there is one code path and it is easy to fixture-test.
* No relay → app request ever carries Substack cookies or user identity. Paid posts show the preview plus "paid".

### 4.1 Relay API contract (protocol 1)

Common rules:

* Base: `${VITE_RELAY_ORIGIN}`. All routes are `GET` (plus `OPTIONS` → 204). Any other method → 405.
* Response headers on every response: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Max-Age: 86400`, `Content-Type: application/json; charset=utf-8` (except `/v1/feed`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: public, max-age=<client TTL>` on success and `no-store` on errors. Never `Access-Control-Allow-Credentials`.
* Envelope: success `{ "ok": true, "data": <T>, "meta": { "host": "<canonical host>", "cached": boolean, "fetchedAt": "<ISO>" } }`; error `{ "ok": false, "error": { "code": "<CODE>", "message": "<English, safe>", "retryAfterSeconds"?: number, "upstream"?: { "status": number, "contentType": "application/json"|"application/xml"|"text/html"|"text/plain"|"other"|"missing", "challenge": boolean } } }`. Following LIHKG, never echo upstream bodies or headers.
* `host` param: a lowercase hostname only, no scheme, port, path or userinfo. Regex `^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`; reject IP literals, `localhost`, `*.local`, `*.internal` and `*.test`. The client normalizes user input (a URL, `foo.substack.com`, `@handle`, or `substack.com/@handle`) before calling.

Routes:

| Route | Upstream (fixed) | Cache TTL (edge / client) | `data` shape |
|---|---|---|---|
| `GET /v1/health[?probe=1]` | none; with `probe=1`, one archive `limit=1` fetch each to `on.substack.com` and a fixed custom-domain pub, plus `substack.com/api/v1/user/<fixed handle>/public_profile` (no bodies returned) | none | `{ service:"substack-relay", protocol:1, revision:"<git sha7>", origin:<request Origin or null>, probes?:[{target:"subdomain"|"customDomain"|"substackCom", status:number, contentType, challenge:boolean, ms:number}] }` |
| `GET /v1/archive?host=<h>&offset=<0..5000, default 0>&limit=<1..50, default 12>&sort=<new\|top, default new>` | `https://<h>/api/v1/archive?sort=<s>&offset=<o>&limit=<l>` | 300 s / 60 s | `{ publication: PubMeta \| null, posts: PostSummary[], nextOffset: number \| null }` (`nextOffset = offset+posts.length` if `posts.length === limit`, else `null`) |
| `GET /v1/post?host=<h>&slug=<slug>` | `https://<h>/api/v1/posts/<slug>` | 900 s / 300 s; 404 → 60 s | `{ post: PostDetail }` |
| `GET /v1/profile?handle=<handle>` | `https://substack.com/api/v1/user/<handle>/public_profile` | 3600 s / 600 s | `{ handle, name, photoUrl \| null, primaryPublication: PubMeta \| null, subscriptions: PubMeta[] }` (the user's public, visible subscriptions; useful to "import my follows" without login) |
| `GET /v1/search?q=<2..100 chars>` | `https://substack.com/api/v1/top/search?query=<q>` (315 KB raw → trimmed). `publication/search` currently returns empty results | 3600 s / 600 s | `{ results: PubMeta[] }` (deduped by `host`) |
| `GET /v1/feed?host=<h>` | `https://<h>/feed` | 600 s / 120 s | **raw RSS XML** passthrough, `Content-Type: application/xml; charset=utf-8`, size-capped. Fallback for when `/api/v1/archive` is blocked but `/feed` is not; the client parses with `DOMParser('application/xml')` |

Types:

```ts
type PubMeta = {
  id: number; name: string;            // trimmed (Substack names can have trailing spaces, e.g. "Slow Boring ")
  subdomain: string;                   // e.g. "matthewyglesias"
  customDomain: string | null;         // e.g. "www.slowboring.com" (only if !custom_domain_optional)
  host: string;                        // canonical host to use: customDomain ?? `${subdomain}.substack.com`
  logoUrl: string | null;
};
type PostSummary = {
  id: number; slug: string; title: string; subtitle: string | null;
  postDate: string;                    // ISO from post_date
  audience: 'everyone' | 'only_paid' | 'founding' | 'only_free' | string;
  isPaywalled: boolean;                // audience !== 'everyone'
  type: 'newsletter' | 'podcast' | 'thread' | string;
  wordcount: number | null;
  canonicalUrl: string;
  authors: string[];                   // publishedBylines[].name
};
type PostDetail = PostSummary & {
  bodyHtml: string | null;             // Substack body_html verbatim (client converts); truncated preview when paywalled
  truncated: boolean;                  // isPaywalled && bodyHtml is a preview
};
```

Error codes:

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_HOST`, `INVALID_SLUG` (`^[a-z0-9][a-z0-9_-]{0,199}$`, case-insensitive), `INVALID_HANDLE` (`^[A-Za-z0-9_.-]{1,64}$`), `INVALID_QUERY`, `INVALID_PARAM` | bad input |
| 403 | `HOST_NOT_SUBSTACK` | custom domain failed the DoH CNAME check, or the response lacked `x-served-by: Substack`; the body is discarded |
| 404 | `NOT_FOUND` (unknown route), `PUBLICATION_NOT_FOUND`, `POST_NOT_FOUND`, `PROFILE_NOT_FOUND` | upstream 404 |
| 405 | `METHOD_NOT_ALLOWED` | |
| 429 | `RATE_LIMITED` + `Retry-After` + `retryAfterSeconds` | the relay's own limiter (60/min per client key per location) |
| 502 | `UPSTREAM_INVALID` (non-JSON where JSON was expected, parse failure), `UPSTREAM_TOO_LARGE`, `UPSTREAM_ERROR` (other non-2xx), `TOO_MANY_REDIRECTS`, `REDIRECT_NOT_ALLOWED` | |
| 503 | `UPSTREAM_BLOCKED` (403 html, or `cf-mitigated: challenge`), `UPSTREAM_RATE_LIMITED` (429, with bounded `retryAfterSeconds`), `UPSTREAM_UNAVAILABLE` (5xx) | the client offers the rss2json fallback for `UPSTREAM_BLOCKED` |
| 504 | `UPSTREAM_TIMEOUT` | 10 s abort |
| 500 | `INTERNAL_ERROR` | |

### 4.2 Relay security (preventing an open proxy or SSRF)

1. **No caller-supplied URLs.** The relay builds the upstream URL from validated `host` plus a fixed path template, with query values it formats itself (integers, `new|top`, `encodeURIComponent(q)`).
2. **Host allowlist:**
   * `substack.com` is allowed only for the `/v1/profile` and `/v1/search` templates.
   * `^[a-z0-9-]{1,63}\.substack\.com$` is allowed.
   * For any other host, the relay runs the **DoH check** `GET https://cloudflare-dns.com/dns-query?name=<host>&type=CNAME` (`accept: application/dns-json`). `Answer` must contain a CNAME whose `data` is `target.substack-custom-domains.com.`. The result is cached for 24 h (positive) and 1 h (negative) via the Cache API under a synthetic key. If the check fails → `HOST_NOT_SUBSTACK`.
3. **Response check:** every upstream response must have `x-served-by` equal to `Substack` (case-insensitive) or `x-cluster: substack`. Otherwise the relay discards the body and returns `HOST_NOT_SUBSTACK`. This is defense in depth and also catches apex domains served elsewhere (e.g. `astralcodexten.com`).
4. **Redirects:** `redirect:'manual'`, max 3 hops. Each `Location` must be absolute `https:` and its host must pass step 2. The **pathname must equal** the template's pathname (only the host may change, as in subdomain → custom domain or hyphen normalization). The final host is returned in `meta.host`, and the client replaces its stored host with it.
5. **Method and verb limits:** GET only to Substack (no HEAD/POST), and no request body is forwarded. No cookies are sent; `Set-Cookie` is never copied. Upstream request headers are exactly `User-Agent: SubstackReaderForEvenHub/<version> (+https://github.com/CHL-work/substack-reader-for-evenhub)` and `Accept: application/json` (or `application/rss+xml, application/xml;q=0.9` for the feed).
6. **Size caps** via streaming `boundedText()`, copied from LIHKG: archive 1 MiB, post 4 MiB, profile 1 MiB, search 2 MiB, feed 4 MiB. Over the cap → 502 `UPSTREAM_TOO_LARGE`. The **timeout** is 10 s via `AbortController`.
7. **Content-type checks:** JSON routes require `application/json`; the feed route requires `application/(rss+)?xml|text/xml`.
8. **Rate limiting:** `env.RL?.limit({ key: \`${clientKey}:${route}\` })` where `clientKey = CF-Connecting-IP` (kept in memory only, never logged). Without the binding, a per-isolate token bucket gives best effort. Edge caching is the main protection for Substack.
9. **No logging:** `observability.enabled=false`, no `console.log` of URLs or hosts. No persistent storage of content.
10. **Errors** never include upstream bodies or headers (§4.1).

### 4.3 Caching

The cache key is a synthetic normalized URL, e.g. `https://relay.cache/v1/archive?host=www.slowboring.com&offset=0&limit=12&sort=new`, built after validation and redirect resolution (also store an alias under the pre-redirect host). On a hit, return it with `meta.cached=true`. On a miss, fetch, transform, then `ctx.waitUntil(caches.default.put(key, resp.clone()))` with `Cache-Control: public, max-age=<edge TTL>`. Cache 404 for 60 s; never cache 5xx/403/429. Edge TTLs: archive 300 s, post 900 s, feed 600 s, profile 3600 s, search 3600 s, DoH verdict 86400 s / 3600 s. Guard with `typeof caches !== 'undefined'`. These short, transient TTLs reduce load on Substack (being polite matters because of the shared Worker IP) without becoming a content store.

### 4.4 Where should HTML→text live? **Client-side.**

| | Client `DOMParser` (recommended) | Worker `HTMLRewriter` |
|---|---|---|
| Wire size | post JSON gz 12–36 KB (measured) | text gz 5–25 KB, so a 1.5–2× saving only |
| CPU | phone; trivial | counts against the **10 ms** free-tier CPU; 136 KB HTML is fine but long posts plus structure tracking risk 1102 errors |
| Fidelity | full DOM: headings, lists, blockquotes, footnotes, captions, tables, paragraph breaks for pretext pagination | streaming callbacks only; you must hand-roll a block/inline state machine; no tree queries |
| Reuse | the same code handles the rss2json fallback `items[].content` and RSS `content:encoded` | the fallback would still need a client converter, so two converters |
| Testability | unit-testable in CI with fixtures (jsdom/happy-dom or Playwright) | needs a Workers runtime (`workerd`/miniflare) in CI |
| Change cadence | ships with the `.ehpk` | requires a relay redeploy (owner action on Sites) |

The relay should do the **cheap JSON trimming** (archive 62 KB → 5 KB raw) and leave `bodyHtml` intact. A future `/v1/post?…&format=text` can be added if bandwidth becomes a problem.

### 4.5 Build-time injection of the relay origin (mirrors `lihkg-reader-for-evenhub/scripts/pack.mjs`)

* `.env.example`: `VITE_RELAY_ORIGIN=` with the comment "Public HTTPS origin of the deployed stateless Substack relay; never a credential." The GitHub repository **variable** (not secret) `VITE_RELAY_ORIGIN` feeds CI and release.
* `src/relay.ts`: `const RELAY = String(import.meta.env.VITE_RELAY_ORIGIN || '').trim().replace(/\/+$/, '')`. In dev, if it is empty, use the same-origin path `/relay`, served by a Vite dev middleware that imports `worker/relay.ts` and calls `default.fetch(new Request(...))`. Phone dev builds load from the LAN dev server, so same-origin needs no CORS at all.
* `vite.config.ts` plugin (like `reader-build-metadata`): emit `build-info.json` = `{ version, relayOrigin: process.env.VITE_RELAY_ORIGIN ? new URL(process.env.VITE_RELAY_ORIGIN).origin : '' }`.
* `scripts/pack.mjs`:

```js
const origin = process.env.VITE_RELAY_ORIGIN;
let url; try { url = new URL(origin); } catch { throw new Error('Set VITE_RELAY_ORIGIN to the deployed HTTPS relay origin.'); }
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    /(^|\.)(localhost|example\.(com|net|org)|invalid|test)$/.test(url.hostname)) throw new Error('VITE_RELAY_ORIGIN must be a bare https origin.');
const manifest = JSON.parse(await readFile('app.json', 'utf8'));
const buildInfo = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
if (buildInfo.relayOrigin !== url.origin || buildInfo.version !== manifest.version) throw new Error('Rebuild: origin/version mismatch.');
const whitelist = [url.origin];
if (process.env.ENABLE_RSS2JSON_FALLBACK === '1') whitelist.push('https://api.rss2json.com');
manifest.permissions = [{ name: 'network', desc: 'Loads public Substack posts through the Substack Reader relay' + (whitelist.length > 1 ? ' and, if it is unavailable, the rss2json feed converter.' : '.'), whitelist }];
// copy dist/* except ['server', '.openai', 'worker.mjs', '_appgen_meta'] into artifacts/package, write artifacts/app.json,
// then: node <evenhub-cli main.js> pack artifacts/app.json artifacts/package --sdk-ver 0.0.16 -o artifacts/substack-reader-<ver>.ehpk
```

Keep the template `app.json` with `"permissions": []`, as LIHKG does; the pack step fills it. The `desc` must be ≤300 chars. CI copies LIHKG's "Require deployed API configuration" step under the new variable name. **The `.ehpk` must exclude `dist/server/`.**

### 4.6 Client fallback logic

```
listPosts(host):
  try relay /v1/archive
  on UPSTREAM_BLOCKED|UPSTREAM_UNAVAILABLE|network error:
     try relay /v1/feed (parse XML)                      // different path may be allowed
     if still failing and settings.fallback === 'rss2json' and whitelist has it:
        GET https://api.rss2json.com/v1/api.json?rss_url=<enc https://host/feed>  (10 newest; content = full HTML)
readPost(host, slug):
  relay /v1/post → else (if fallback cached from rss2json/feed) use the item's content
```

Show a clear message naming the failing layer (relay unreachable / Substack blocked the relay / rate limited, retry after N s). The LIHKG project's lesson: do not let a healthy `/health` imply that reading works.

### 4.7 Minimal relay skeleton (for implementers)

```ts
// worker/relay.ts — bundle to dist/server/index.js (Sites) or deploy via wrangler (Cloudflare)
const VERSION = '0.1.0';
const UA = `SubstackReaderForEvenHub/${VERSION} (+https://github.com/CHL-work/substack-reader-for-evenhub)`;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUB_RE = /^[a-z0-9-]{1,63}\.substack\.com$/;
const CUSTOM_TARGET = 'target.substack-custom-domains.com.';
interface Env { RL?: { limit(o: { key: string }): Promise<{ success: boolean }> } }

async function isSubstackHost(host: string, ctx?: ExecutionContext): Promise<boolean> {
  if (!HOST_RE.test(host) || /(^|\.)(localhost|local|internal|test)$/.test(host)) return false;
  if (SUB_RE.test(host)) return true;
  // DoH CNAME check (cache verdict 24h/1h via caches.default when available)
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=CNAME`, { headers: { accept: 'application/dns-json' } });
  if (!r.ok) return false;
  const j = await r.json() as { Answer?: { type: number; data: string }[] };
  return !!j.Answer?.some(a => a.type === 5 && a.data.toLowerCase() === CUSTOM_TARGET);
}

async function upstream(url: URL, accept: string, cap: number, allowSubstackCom = false) {
  for (let hop = 0; hop < 4; hop++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10_000);
    try {
      const res = await fetch(url.toString(), { method: 'GET', redirect: 'manual', signal: ac.signal,
        headers: { 'User-Agent': UA, Accept: accept } });
      if ([301, 302, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const next = new URL(res.headers.get('Location') ?? '', url);
        if (next.protocol !== 'https:' || next.pathname !== url.pathname || !(await isSubstackHost(next.hostname))) throw relayError(502, 'REDIRECT_NOT_ALLOWED');
        url = next; continue;
      }
      const servedBy = (res.headers.get('x-served-by') ?? '').toLowerCase() === 'substack' || (res.headers.get('x-cluster') ?? '').toLowerCase() === 'substack';
      if (!servedBy) { await res.body?.cancel(); throw relayError(403, 'HOST_NOT_SUBSTACK'); }
      return { res, finalHost: url.hostname, text: res.ok ? await boundedText(res.body, cap) : (await res.body?.cancel(), '') };
    } finally { clearTimeout(t); }
  }
  throw relayError(502, 'TOO_MANY_REDIRECTS');
}
// …routes: /v1/health, /v1/archive, /v1/post, /v1/profile, /v1/search, /v1/feed → trim JSON → json(data, ttl)
// export default { async fetch(request: Request, env: Env = {}, ctx?: ExecutionContext) { … } };
```

(`boundedText`, the error mapping and the diagnostics function can be copied nearly verbatim from `lihkg-reader-for-evenhub/worker/index.ts`.)

---

## 5. Option comparison summary

| Option | Works with Even CORS | Reliability | Privacy | Owner effort | Verdict |
|---|---|---|---|---|---|
| A. Own Cloudflare Worker relay | yes (`ACAO:*`) | depends on Substack accepting Worker egress: custom domains likely OK, `*.substack.com` uncertain (§1.3); 100k req/day | the owner's relay sees client IP + pub/slug; no logs | Cloudflare account + API token secret in GH Actions | **Primary** |
| B. Owner's Sites (`*.chatgpt.site`) relay | yes | same egress class as A (Cloudflare); LIHKG precedent 403 (different site) | same as A | new Sites project, deploy from Codex, public audience authorization | **Equivalent alternative**; same code |
| C1. rss2json | yes (`*`) | good today, including `*.substack.com`; 10 items; no SLA; unknown quota | third party sees feed URL + IP | none (add whitelist entry) | **Opt-in fallback** |
| C2. allorigins | reflects origin + credentials | flaky (500/408) | third party | none | no |
| C3. corsproxy.io | needs a key; no production use on the free tier | — | — | — | no |
| C4. r.jina.ai | 401 anonymous | — | — | — | no |
| D. Even native proxy/bridge | n/a | absent in SDK 0.0.16 | — | — | n/a |
| Direct WebView → Substack | **no** (no ACAO, preflight fails) | — | — | — | impossible |

## 6. Ethics and robustness notes

* Use an honest, identifying User-Agent. **Do not** spoof browser UAs or Referers, rotate IPs, or replay `__cf_bm` cookies to get past Cloudflare. The LIHKG project explicitly refused to do this too ("沒有…冒充瀏覽器或繞過挑戰"). If Substack blocks the relay, surface `UPSTREAM_BLOCKED` and offer the fallback.
* Respect `Retry-After` on 429 and propagate it to the client (bounded to ≤ 86400 s).
* No background prefetching. Fetch only what the user opens (the Even WebView cannot use the network in the background anyway).

## 7. Open questions / uncertainties

* Whether Substack accepts requests from Cloudflare Worker egress (`CF-Worker` header, shared `CF-Connecting-IP 2a06:98c0:3600::103`) for `*.substack.com` and `substack.com/api/v1/*`. This needs a measurement right after deploy (`/v1/health?probe=1`).
* Whether Sites (`*.chatgpt.site`) egress differs from plain workers.dev egress. Both are Cloudflare; the Sites internals are unknown.
* Cache API effectiveness on `*.workers.dev` and on Sites/Workers-for-Platforms. The docs guarantee it only on custom domains.
* The real production WebView `Origin` (likely `null`/`file://` or a custom scheme). It is undocumented; learn it via `/v1/health` `origin` echo on a real device. `ACAO:*` covers all of these anyway.
* `substack.com/api/v1/publication/search` returned empty results for every query. `top/search` works but is 316 KB and its result-group schema is undocumented and may change.
* rss2json free-tier daily quota and ToS (the plans page is JS-rendered; I could not read it). Only 10 items without an API key, and a key cannot ship in the `.ehpk`.
* Whether Substack custom domains always CNAME to `target.substack-custom-domains.com` (true for the 5 tested). Apex/A-record setups may exist; such hosts would be rejected unless the response-header check alone is accepted as sufficient.
* Slug charset: the observed slugs are `[a-z0-9-]`. Non-ASCII or uppercase slugs may exist; the regex may need loosening (percent-encode the slug when building the path).
* Whether the Sites pipeline still accepts `dist/server/index.mjs` (LIHKG used it) or now strictly requires `dist/server/index.js` (current skill snapshot). Emit `index.js` to be safe.
* Even whitelist reviewers may question a second domain (rss2json). Keep the fallback behind a build flag (`ENABLE_RSS2JSON_FALLBACK=1`).

## 8. Sources

* Even docs: https://hub.evenrealities.com/docs/build/networking · https://hub.evenrealities.com/docs/reference/faq · https://hub.evenrealities.com/docs/ship/packaging · https://hub.evenrealities.com/docs/get-started/architecture
* SDK typings: `C:/Code/lihkg-reader-for-evenhub/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts` (0.0.16); CLI schema in `…/evenhub-cli/main.js` (0.1.14)
* Cloudflare: https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/runtime-apis/cache/ · https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · https://developers.cloudflare.com/fundamentals/reference/http-headers/ (CF-Worker, CF-Connecting-IP) · https://developers.cloudflare.com/changelog/2025-06-09-transform-rule-subrequest-matching/ · https://developers.cloudflare.com/bots/reference/bot-management-variables/ (O2O/subrequests)
* Substack blocking evidence: https://github.com/simonkral1/policy-tracker/issues/94 · https://github.com/dsa-ntc/dsa-planet/issues/53 · https://github.com/HeyThisIsAndrew/BeUnconventionalHQ/issues/280 · https://github.com/conorbronsdon/substack-mcp · https://github.com/NHagar/substack_api/pull/15 · https://github.com/NHagar/substack_api/pull/18 · https://github.com/Noah-Bjorner/SubstackAPI (src/services/substack.ts)
* Substack ToS: https://substack.com/tos ; robots: https://substack.com/robots.txt
* Third-party proxies: https://api.allorigins.win · https://corsproxy.io/pricing/ · https://rss2json.com/docs · https://r.jina.ai
* Owner reference: `C:/Code/lihkg-reader-for-evenhub/{worker/index.ts, worker/companion.ts, scripts/pack.mjs, scripts/package-site.mjs, artifacts/push-site-source.mjs, .openai/hosting.json, wrangler.toml, docs/deployment.md, docs/reading-blocker.md, docs/releases/gateway-diagnostics-2026-09-30.md, research/sites-skill/**}`
