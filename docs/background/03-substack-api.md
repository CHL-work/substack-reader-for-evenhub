# 03 — Reading Substack programmatically (read-only, no login)

Probe date: 2026-10-06 (~23:45–23:52 UTC). Client: curl (Git Bash) on Windows, browser UA
`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/129.0.0.0 Safari/537.36`, `--compressed`,
most requests sent with `Origin: https://example.com` to observe CORS behaviour.
~35 requests to Substack hosts + 1 to r.jina.ai + 1 to api.rss2json.com. No 429s, no challenges from Substack.
Raw probe response HEADERS (and robots.txt) are kept in `research/probe/`; response bodies were deleted after analysis
so no article text is stored.

Publications used: `www.astralcodexten.com` (ACX, pub id 89120, custom domain, mostly free),
`www.slowboring.com` (Slow Boring, pub id 159185, custom domain, mostly paid), `on.substack.com`
(pub id 1, plain subdomain, free), `paulkrugman.substack.com` (subdomain, mixed).

---

## 0. TL;DR

| Need | Best endpoint (no auth) | Notes |
|---|---|---|
| List posts of a pub | `GET {base}/api/v1/archive?sort=new&search=&offset={n}&limit={k}` | JSON array; metadata only (`body_html: null`). `limit=30` honoured; `limit=50` returned 23 on ACX (cap or filtering — unclear). Paginate by offset until `[]`. |
| List posts WITH bodies | `GET {base}/api/v1/posts?limit={k}` (offset also accepted by convention) | Array of full post objects incl. `body_html`. Heavy (~44 KB HTML per post). |
| One post with body | `GET {base}/api/v1/posts/{slug}` | Free: full `body_html`. Paid w/ preview: `body_html` = preview only, cut at paywall, **no marker**. Paid w/o preview: `body_html: null`. |
| One post by numeric id | `GET https://substack.com/api/v1/posts/by-id/{id}` | Returns `{post, publication, publicationSettings, accountBasedPostMeteringEnabled}`; `publication.base_url` gives the canonical host. |
| RSS | `GET {base}/feed` | Latest 20 items, `content:encoded` = full HTML for free posts; paid = preview + trailing `<p><a href="{url}">Read more</a></p>`. Cloudflare-cached. |
| Find pubs | `GET https://substack.com/api/v1/publication/search?query={q}&page={p}&limit={k}` | `{results:[pub...], more:bool}`; `limit` ignored (got 19 for limit=5). `base_url`, `hostname` present. |
| Pub metadata | `window._preloads.pub` in `GET {base}/` HTML, or `publication` in by-id / search / reader-feed results | `/api/v1/publication` → **403 "Not authorized"**. `homepage_data` has no `publication`. |
| User's public subscriptions | `GET https://substack.com/api/v1/user/{handle}/public_profile` | `subscriptions[]` (public only) with `publication{subdomain, custom_domain, ...}`. |
| Recommendations | `GET https://substack.com/api/v1/recommendations/from/{pubId}` | Array; `recommendedPublication{...}`. |
| Anonymous discovery feed | `GET https://substack.com/api/v1/reader/feed` | 200 without auth (logged-out "for-you" feed, mostly notes/comments). |
| Author activity feed | `GET https://substack.com/api/v1/reader/feed/profile/{userId}` | 200 without auth; `items[].post` + `items[].publication` (post `body_html` empty). Cursor pagination. |

**CORS: no `Access-Control-Allow-*` header on ANY Substack response probed (feeds, APIs, HTML, redirects, OPTIONS preflight).** Confirms the brief. The only CORS-enabled path that returned content was `api.rss2json.com` (`access-control-allow-origin: *`).

---

## 1. Per-publication endpoints

`{base}` = `https://<subdomain>.substack.com` or the custom domain (`https://www.astralcodexten.com`).
`https://<subdomain>.substack.com/...` **301-redirects** to the custom domain when one is set, preserving path+query:
```
GET https://astralcodexten.substack.com/api/v1/archive?sort=new&limit=1
-> 301 Location: https://www.astralcodexten.com/api/v1/archive?sort=new&limit=1
```
(A browser cross-origin redirect would still need ACAO on both hops — moot since there is none.)

Response header fingerprints on every pub host: `x-served-by: Substack`, `x-cluster: substack`, `x-service: web`,
`x-powered-by: Express`, `Server: cloudflare`, feed responses also carry `x-sub: <subdomain>` (e.g. `x-sub: matthewyglesias`
for slowboring.com — the subdomain is not always the brand name). Responses set `ab_testing_id`, `ab_experiment_sampled`, `__cf_bm` cookies.

### 1.1 RSS — `GET {base}/feed`
- `Content-Type: application/xml; charset=utf-8`, gzip, `Cache-Control: no-cache`, weak `ETag`, **`CF-Cache-Status: HIT`, `Age: 349`** (edge-cached a few minutes).
- Channel children: `title, description, link, image, generator, lastBuildDate, atom:link, copyright, language, webMaster, itunes:*, googleplay:*`.
- **20 items** for both ACX and Slow Boring (latest 20 posts, including paid + podcast/thread types).
- Item children: `title, description (=subtitle), link, guid, dc:creator, pubDate, enclosure (cover image), content:encoded`.
- Free posts: `content:encoded` is the **full** body HTML (ACX: 1.8 KB … 487 KB per item; whole feed 1.38 MB decompressed / 268 KB gzip).
- Paid posts: `content:encoded` = free preview HTML (ACX "Hidden Open Thread" 142 chars; Slow Boring paid posts ~4.7–5.7 KB),
  terminated with the **marker**:
  ```html
  <p>
      <a href="https://www.slowboring.com/p/with-a-new-agenda-the-build-america">Read more</a>
  </p>
  ```
  i.e. last element is a `<p>` whose only child is an `<a href>` equal to the item `<link>` with text "Read more" (whitespace-padded).
  Detection heuristic: trailing `<p>\s*<a href="{link}">\s*Read more\s*</a>\s*</p>\s*$`. No `audience` field in RSS, so this marker
  (or cross-checking with archive `audience`) is the only paywall signal in the feed.
- Feed sizes: Slow Boring 222 KB decompressed / 46 KB gzip.

### 1.2 Archive — `GET {base}/api/v1/archive?sort=new&search=&offset=0&limit=N`
- `application/json`, gzip, `Cache-Control: no-cache`, weak ETag, `CF-Cache-Status: MISS/DYNAMIC` (not edge-cached).
- Returns a **bare JSON array** of post objects **without body** (`body_html: null`, `body_json: null`).
- `limit=12` → 12; `offset=12&limit=30` → 30, no overlap (offset pagination works); `limit=50` on ACX → **23** items (most-recent; may be a server cap ~25 with hidden/pinned filtering, or an undocumented max). Safe choice: `limit<=25`, stop when result length is 0.
- `sort=new` (others commonly used by clients: `top`, `search=` with `sort=new`; not probed).
- Sizes: ACX 23 items = 110 KB decompressed / 8.6 KB gzip; Slow Boring 12 items = 62 KB / 7.6 KB.
- Works identically with default curl UA and with an **empty UA** (no UA sniffing observed).
- `truncated_body_text`: **null on ACX**, populated (short plain-text excerpt, 7–283 chars) on Slow Boring and paulkrugman. Not reliable.
- `audience` values seen: `everyone`, `only_paid` (others known to exist: `founding`, `only_free` — not seen). `type` values seen: `newsletter`, `podcast` (also `thread`, `video` exist per brief — not seen).
- `wordcount` is the **full** post wordcount even for paid posts (e.g. 1859 while preview ~5 KB HTML).

Trimmed archive item (ACX, keys complete; values trimmed):
```json
{
  "id": 218568314, "editor_v2": false, "publication_id": 89120,
  "title": "An Open Letter To Steven Pinker On AI", "social_title": "...",
  "search_engine_title": null, "search_engine_description": null,
  "type": "newsletter", "slug": "an-open-letter-to-steven-pinker-on",
  "post_date": "2026-10-06T21:23:06.574Z", "audience": "everyone",
  "podcast_duration": null, "video_upload_id": null, "podcast_upload_id": null,
  "write_comment_permissions": "everyone", "should_send_free_preview": false,
  "free_unlock_required": false, "default_comment_sort": null,
  "canonical_url": "https://www.astralcodexten.com/p/an-open-letter-to-steven-pinker-on",
  "section_id": null, "top_exclusions": [], "pins": [], "is_section_pinned": false,
  "section_slug": null, "section_name": null,
  "reactions": {"❤": 184}, "restacks": 23,
  "restacked_post_id": null, "restacked_post_slug": null, "restacked_pub_name": null, "restacked_pub_logo_url": null,
  "subtitle": "…", "cover_image": "https://substack-post-media.s3.amazonaws.com/public/images/….png",
  "cover_image_is_square": false, "cover_image_is_explicit": false,
  "podcast_url": null, "videoUpload": null, "podcastFields": {"post_id": 218568314, "hide_from_feed": false, "…": "…"},
  "podcast_preview_upload_id": null, "podcastUpload": null, "podcastPreviewUpload": null,
  "voiceover_upload_id": null, "voiceoverUpload": null, "has_voiceover": false,
  "description": "…", "body_json": null, "body_html": null, "has_dynamic_content": false,
  "truncated_body_text": null, "wordcount": 10536, "post_preview_limit": 0, "language": "en",
  "postTags": [], "teaser_post_eligible": true, "postCountryBlocks": [], "headlineTest": null,
  "coverImagePalette": {"Vibrant": {"rgb": [169, "…", "…"], "population": 403}, "…": "…"},
  "publishedBylines": [{
    "id": 12009663, "name": "Scott Alexander", "handle": "astralcodexten",
    "photo_url": "https://substackcdn.com/image/fetch/…", "bio": null,
    "profile_set_up_at": "2021-04-16T05:06:04.745Z", "reader_installed_at": null,
    "publicationUsers": [{"id": 18921, "user_id": 12009663, "publication_id": 89120, "role": "admin",
      "public": true, "is_primary": true,
      "publication": {"id": 89120, "name": "Astral Codex Ten", "subdomain": "astralcodexten",
        "custom_domain": "www.astralcodexten.com", "custom_domain_optional": false,
        "hero_text": "…", "logo_url": "…", "author_id": 12009663, "payments_state": "enabled",
        "homepage_type": "newspaper", "…": "…"}}],
    "is_guest": false, "bestseller_tier": 1000, "status": {"…": "…"}
  }],
  "reaction": null, "reaction_count": 184, "comment_count": 64, "child_comment_count": 30,
  "audio_items": [{"post_id": 218568314, "voice_id": "en-US-OnyxTurboMultilingualNeural",
    "audio_url": "https://substack-video.s3.amazonaws.com/video_upload/post/218568314/tts/….mp3",
    "type": "tts", "status": "completed"}],
  "is_geoblocked": false, "is_editor_preview": false, "hasCashtag": false
}
```
Note: no `publication` object on archive items, but `publishedBylines[].publicationUsers[].publication` contains
`subdomain`/`custom_domain` (may list several pubs for the author — pick the one whose `id == publication_id`).

### 1.3 Single post — `GET {base}/api/v1/posts/{slug}`
Single JSON object (~73 keys). Adds over archive items: `body_html` (string or null), `audience_before_archived`,
`exempt_from_archive_paywall`, `has_shareable_clips`, `is_published`, `live_stream_id`, `meter_type` (e.g. `"none"`),
`next_post_slug`, `previous_post_slug`, `podcast_art_url`, `section_pins`, `show_guest_bios`, `themeVariables`,
`unlockedWithCampaign`, `unlockedWithIP`, `updated_at`, and `hidden` (present on some paid posts, `true`).

| Case | Example | `audience` | `wordcount` | `body_html` | `truncated_body_text` |
|---|---|---|---|---|---|
| Free | ACX `open-thread-454` | everyone | 188 | 1,792 chars, full | `""` |
| Free, long | ACX `an-open-letter-to-steven-pinker-on` | everyone | 10,539 | 135,163 chars, full (response 145 KB / 36 KB gzip) | — |
| Paid, no preview | ACX `hidden-open-thread-4525` | only_paid | 20 | **null** | `""` |
| Paid, with preview | SB `with-a-new-agenda-the-build-america` | only_paid | 1,859 | 5,259 chars = preview only, ends abruptly with last free `<p>`; **no paywall div / marker** in API HTML | 187 chars |

So for the API, paywall detection = `audience !== "everyone"` (or `body_html == null`), not an HTML marker.
`post_preview_limit` was `null`/`0`. The visible web page shows a paywall widget, but the API HTML has none.

### 1.4 Posts list with bodies — `GET {base}/api/v1/posts?limit=3`
`on.substack.com`: 200, bare array of 3 full post objects, each with `body_html` (11 KB / 45 KB / 60 KB) and short
`truncated_body_text` (82–307 chars). 132 KB decompressed / 31 KB gzip for 3 posts. Good for "prefetch N latest with bodies",
but heavy; archive + per-post fetch is lighter for a menu.

### 1.5 Publication metadata
- `GET {base}/api/v1/publication` → **403**, body `Not authorized` (text/html).
- `GET {base}/api/v1/homepage_data` → 200, 325 KB / 55 KB gzip. Keys: `contentBlockData, homeHeroPins, homepageLinks,
  newPosts (23, no body_html), numRecommendations, pinnedPosts, postsForHomeHeroPins, postsByGroupId, recommendations,
  topPosts (9), postExcerpts`. **No `publication` key.**
- `GET {base}/` HTML (on.substack.com: 135 KB) contains `window._preloads = JSON.parse("…")` (double-encoded JSON string).
  `_preloads.pub` has 146 keys incl. `id, name, subdomain, custom_domain, custom_domain_optional, base_url, hostname,
  hero_text, logo_url, author_id, author_name, author_handle, author_photo_url, author_bio, language, payments_state,
  homepage_type, created_at, first_post_date, podcast_enabled, podcast_feed_url, copyright, theme{…}, sections, plans, …`.
  Also `<link rel="alternate" type="application/rss+xml" href="/feed">` and `<link rel="canonical">`.
- `publication` object (149 keys, includes `base_url`) also comes back from `substack.com/api/v1/posts/by-id/{id}`,
  publication search results, and reader-feed items.
- `publicationSettings` (from by-id) includes `block_ai_crawlers` (ACX: `false`), `enable_prev_next_nav`, etc.

---

## 2. Discovery & URL resolution

### 2.1 Search — `GET https://substack.com/api/v1/publication/search?query=economics&page=0&limit=5`
200, `{ "results": [ …19 pubs… ], "more": true }` (limit ignored; 336 KB / 45 KB gzip — results are full 140-key pub objects).
Useful fields per result:
```json
{"id": 377949, "name": "Apricitas Economics", "subdomain": "apricitas",
 "custom_domain": "www.apricitas.io", "custom_domain_optional": false,
 "hostname": "www.apricitas.io", "base_url": "https://www.apricitas.io",
 "author_id": 4569696, "author_name": "Joseph Politano", "author_handle": "josephpolitano",
 "author_photo_url": "…", "logo_url": "…", "hero_text": "…", "language": "en",
 "payments_state": "enabled", "type": "newsletter", "first_post_date": "2021-06-06T14:59:09.465Z",
 "has_posts": true, "freeSubscriberCount": "…", "rankingDetail": "…"}
```
`base_url` = `https://{custom_domain}` when a non-optional custom domain exists, else `https://{subdomain}.substack.com`.

### 2.2 Resolving pasted URLs → (base, slug | id)
| Input form | Probe result | Resolution |
|---|---|---|
| `https://x.substack.com/p/{slug}` | (API 301 → custom domain if any) | base = origin, slug = path seg after `/p/` |
| `https://custom.domain/p/{slug}` | 200 direct | base = origin (verify it's Substack by a successful `/api/v1/posts/{slug}` JSON) |
| `https://substack.com/home/post/p-{id}` | **302** `Location: https://www.astralcodexten.com/p/open-thread-454` | regex `p-(\d+)` → `https://substack.com/api/v1/posts/by-id/{id}` → `post.slug` + `publication.base_url` (or follow the 302) |
| `https://open.substack.com/pub/{sub}/p/{slug}` | **200 HTML** (no HTTP redirect) | parse path → base `https://{sub}.substack.com` (which 301s to custom domain), slug |
| `https://substack.com/@{handle}` | 200 HTML | `GET substack.com/api/v1/user/{handle}/public_profile` → `primaryPublication{subdomain, custom_domain, custom_domain_optional, id, name}` |
| `https://substack.com/@{handle}/p-{id}`, `/inbox/post/{id}` (not probed) | — | same `p-(\d+)`/id regex → by-id |

`GET https://substack.com/api/v1/posts/by-id/218912642` → 200, 7.6 KB gzip: `post` (70 keys, full `body_html` for free),
`publication` (149 keys, `base_url: "https://www.astralcodexten.com"`), `publicationSettings`, `accountBasedPostMeteringEnabled`.

---

## 3. User-level public data (no auth)

### 3.1 `GET https://substack.com/api/v1/user/{handle}/public_profile` → 200 (44 KB / 8 KB gzip)
Top-level keys: `id, name, handle, photo_url, bio, profile_set_up_at, reader_installed_at, tos_accepted_at,
profile_disabled, userLinks[], publicationUsers[], theme, subscriptions[], subscriptionsTruncated, hasGuestPost,
primaryPublication{16 keys}, max_pub_tier, hasPosts, hasActivity, hasLikes, lists[], rough_num_free_subscribers(_int),
rough_num_subscribers(_int), bestseller_tier, followerCount, slug, visibleSubscriptionsCount, isSubscribed, isFollowing,
followsViewer, can_dm, leaderboardRanking, status, …`.
**Yes, it lists the user's PUBLIC subscriptions:** `subscriptions[]` items =
`{id, user_id, visibility:"public", membership_state:"subscribed", type, is_founding, publication{id, name, subdomain,
custom_domain, custom_domain_optional, hero_text, logo_url, author_id, primary_user_id, payments_state, homepage_type,
language, explicit, …, author{}, primaryUser{}, theme{}}}` (14 for the probed handle; `subscriptionsTruncated: false`).
No `base_url` here — derive it. Only subscriptions the user marked public appear; private ones are omitted.
This is the closest no-auth substitute for "my subscriptions": user types their handle.

### 3.2 `GET https://substack.com/api/v1/recommendations/from/{pubId}` → 200 (9.7 KB)
Array of `{id, recommended_publication_id, recommending_publication_id, created_at, updated_at, blurb_active,
description, email_sent_at, list_ids, subscribe_auth_token, recommendedPublication{id, name, subdomain, custom_domain,
custom_domain_optional, hero_text, logo_url, author{}, author_id, payments_state, …}}`. (Ignore `subscribe_auth_token`.)

### 3.3 Feeds / auth-gated endpoints (status only)
| Endpoint | Status (no cookies) | Body |
|---|---|---|
| `substack.com/api/v1/reader/feed` | **200** | `{items[6], originalCursorTimestamp, nextCursor, trackingParameters{tab_id:"for-you",…}}` — generic logged-out feed, mostly `type:"comment"` (notes) |
| `substack.com/api/v1/reader/feed/profile/{userId}` | **200** | `{items[12] (type "post"), originalCursorTimestamp, nextCursor}`; each item `{entity_key:"p-<id>", type, context, post{… body_html ""…}, publication{base_url,…}, …}` |
| `substack.com/api/v1/subscriptions` | **401** | `{"errors":[{"msg":"Please sign in", …}]}` |
| `substack.com/api/v1/notes` | 404 (empty) | wrong path; notes come through reader/feed |
A personalised inbox/feed/subscription list requires a logged-in session cookie — not attempted, and a WebView cannot send another origin's cookies cross-origin anyway.

---

## 4. Behaviour

- **CORS**: grep over all saved Substack response headers (feeds, archive, posts, by-id, search, profile, recs, reader feeds,
  401/403/404 responses, 301/302 redirects): **no `Access-Control-*` header at all**, despite `Origin:` being sent.
  `OPTIONS` preflight to `/api/v1/archive` → `200`, `Allow: GET,HEAD`, no ACA* headers. ⇒ direct `fetch()` from the
  Even Hub WebView will be blocked (response opaque/blocked) unless the host app bypasses CORS.
- **Rate limiting**: none hit in ~35 spaced requests; no `X-RateLimit-*`, `RateLimit-*` or `Retry-After` headers ever.
  Anecdotal reports (e.g. Ghost forum "Substack import 429 error", https://forum.ghost.org/t/substack-import-429-error/21297)
  show 429s when pulling hundreds of posts quickly. Treat 429 as possible; back off exponentially.
- **Caching**: API responses `Cache-Control: no-cache` + weak `ETag` (conditional GET possible); `/feed` is Cloudflare edge-cached
  (`CF-Cache-Status: HIT`, `Age` hundreds–thousands s). `Vary: Accept-Encoding`. Two responses had `Cache-Control: public, max-age=86400`
  (robots.txt).
- **User-Agent**: archive returned byte-identical JSON for browser UA, curl default UA and empty UA. No Cloudflare challenge from
  Substack for any probe.
- **Compression**: gzip on all JSON/XML (`Content-Encoding: gzip`); ratio ~4–13×.
- **Payload sizes** (decompressed / wire):
  - archive 23 items: 110 KB / 8.6 KB; archive 12: 62 KB / 7.6 KB; archive 30: ~? / 15 KB
  - long free post (10.5k words): 145 KB / 36 KB (`body_html` 135 K chars)
  - posts?limit=3: 132 KB / 31 KB
  - feed (20 items): ACX 1.38 MB / 268 KB; Slow Boring 222 KB / 46 KB
  - publication search (19): 336 KB / 45 KB; homepage_data: 325 KB / 55 KB; public_profile: 44 KB / 8 KB
- **Body HTML vocabulary** (tally over 43 bodies): `p, span, a, br, div, em, strong, li, ul, ol, h1–h4, blockquote, hr, figure,
  picture, source, img, figcaption, sup, s`, plus UI chrome **inside image containers**: `button`, `svg`, `polyline`, `line`, `path`
  (`div.captioned-image-container > figure > a.image-link > … div.image-link-expand > button.restack-image/view-image > svg`).
  Classes: `captioned-image-container, image2-inset, image-caption, footnote-anchor, footnote, footnote-number,
  footnote-content, mention-wrap, button-wrapper (CTA buttons), twitter-embed, callout-block, pullquote,
  native-video-embed, image-gallery-embed`. `data-component-name`: `Image2ToDOM, FootnoteAnchorToDOM, FootnoteToDOM,
  MentionToDOM, ButtonCreateButton, Twitter2ToDOM, VideoPlaceholder, FragmentNodeToDOM`; images carry JSON in `data-attrs`.
  A text renderer should drop `button/svg/picture/source`, render `img` as `[image: caption]`, `footnote-anchor` as `[n]`,
  and append `div.footnote` blocks at the end.

---

## 5. CORS-enabled intermediaries (facts only)

| Intermediary | Request | Result |
|---|---|---|
| r.jina.ai | `GET https://r.jina.ai/https://www.astralcodexten.com/p/open-thread-454` (browser UA, Origin header) | **403**, `Cf-Mitigated: challenge`, `<title>Just a moment...</title>` — Cloudflare managed challenge on r.jina.ai itself (not Substack). No ACAO on the 403. Full text not returned to curl. Behaviour from a real WebView unknown; anonymous use may require an API key. |
| api.rss2json.com | `GET https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.slowboring.com%2Ffeed` | **200**, `access-control-allow-origin: *`, `access-control-allow-methods: GET, POST, OPTIONS`, `Cache-Control: public, max-age=1800`. JSON `{status:"ok", feed{url,title,link,author,description,image}, items[10]}`; item keys `title, pubDate, link, guid, author, thumbnail, description, content, enclosure, categories`. `content` = full `content:encoded` for free posts (23–30 KB) and the preview for paid ones (~5 KB, 170 B). Only **10 items** without key; `count`, `order_by`, `order_dir` require `api_key` (https://rss2json.com/docs). Third-party, cached 30 min, free-tier quota not documented on docs page. |

Not probed: generic CORS proxies (corsproxy.io, allorigins) — the brief asked only for the two above.

---

## 6. Legal / ToS / robots

### robots.txt (`https://substack.com/robots.txt`, identical template on custom domains e.g. www.astralcodexten.com/robots.txt)
```
User-agent: BLEXBot      Disallow: /
User-agent: *
Disallow: /action/  /publish  /sign-in  /channel-frame  /session-attribution-frame  /visited-surface-frame
Disallow: /feed/private  /feed/podcast/*/private/*.rss  /subscribe  /lovestack/*  /p/*/comment/*
Disallow: /inbox/post/*  /notes/post/*  /embed
SITEMAP: https://<host>/sitemap.xml, /news_sitemap.xml
```
→ `/api/` and `/feed` are **not** disallowed (only `/feed/private` and private podcast feeds are). Comment pages and `/inbox/post/*` are.

### Terms of Use (https://substack.com/tos, "Last Updated: October 6, 2026")
Section **"Acceptable Use Policy"** — "You also agree that you will not contribute any Post or otherwise use Substack in a manner that:" … includes
- runs "any processes that run or are activated while you are not logged into Substack, or that otherwise interferes with the proper working of Substack (including placing an unreasonable load…)";
- "Crawls," "scrapes," or "spiders" any page, data, or portion of Substack (through use of manual or automated means);
- copies or stores any significant portion of the content on Substack;
- decompiles / reverse engineers or attempts to obtain source code or underlying information.
No mention of RSS. Copyright in posts belongs to the writers ("You understand that we own Substack" refers to the platform).

### Developer API Terms (https://substack.com/api-tos, last updated January 8, 2026)
There is an **official Substack Developer API** (access by application / API key) but its "Authorized Data" is limited to
public creator/publication metadata (name, social URLs, subscriber count, bestseller status, leaderboard, profile summary,
profile/publication URL). **Post bodies are not part of it.** Caching only "as reasonably necessary"; attribution/linking
"where reasonably practicable"; rate limits at Substack's discretion; prohibits replicating Substack's core features.
The `/api/v1/*` endpoints above are the undocumented first-party web-app API — not covered by these terms.

Interpretation notes (not legal advice): RSS `/feed` is the publicly advertised (`<link rel="alternate">`) syndication channel and is
the most defensible source for per-user, on-demand reading; a user-initiated reader that fetches one post at a time and does not
store content is very different from bulk crawling, but the ToS wording ("manual or automated means") is broad.
`publicationSettings.block_ai_crawlers` exists per pub (ACX: false) — an app could honour it.

---

## 7. Sources
- Live probes listed above (2026-10-06).
- https://substack.com/tos ; https://substack.com/api-tos ; https://substack.com/robots.txt
- https://rss2json.com/docs
- https://forum.ghost.org/t/substack-import-429-error/21297 (429 anecdote)
- Unofficial client docs for comparison: https://substack-api.readthedocs.io/ (cookie `connect.sid`-based auth for private data)
