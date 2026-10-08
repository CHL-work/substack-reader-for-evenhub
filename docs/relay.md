# Relay

`worker/relay.ts` is a stateless, GET-only relay between the plugin and Substack. The plugin needs it because Substack sends no CORS headers and Even Hub plugins can reach only whitelisted origins. It implements relay **protocol 1**.

The same ES module runs on Cloudflare Workers and on OpenAI Sites. Its default export is `{ fetch(request, env, ctx) }`. The rate-limit binding `env.RL` and the Cache API (`caches.default`) are optional. It has no external runtime dependencies; `worker/public-pages.ts` parses public page data without evaluating scripts or rendering HTML.

## Routes

Every route is `GET`. `OPTIONS` answers `204`; any other method answers `405 METHOD_NOT_ALLOWED` with `Allow: GET, OPTIONS`. An unknown path answers `404 NOT_FOUND`.

| Route | Parameters | Upstream request | Edge / client cache (s) | `data` |
| --- | --- | --- | --- | --- |
| `/` and `/privacy` | none | none | client 3600 | HTML landing and privacy pages (CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`) |
| `/v1/health` | `probe=1` (optional) | with `probe=1`, three fixed probes (below), at most one round per minute | none (`no-store`) | `{service: 'substack-reader-relay', protocol: 1, revision, origin, probes?}` |
| `/v1/archive` | `host`; `offset` 0 to 5000 (default 0); `limit` (default 12, clamped to 1..20); `sort` `new` or `top` (default `new`); optional `source=sitemap` | API archive; public sitemap/article pages on recovery or explicit sitemap source | 300 / 60 | `ArchivePage {publication, posts, nextOffset, source?}` |
| `/v1/post` | `host` and `slug` | `https://<host>/api/v1/posts/<slug>` | 900 / 300 (404s cached 60 at the edge) | `{post: PostDetail, publication: PubMeta or null}` |
| `/v1/post` | `id` (an integer from 1 to 2147483647, the range Substack's by-id endpoint accepts) alone | `https://substack.com/api/v1/posts/by-id/<id>` | 900 / 300 (404s cached 60 at the edge) | `{post, publication}`; `meta.host` is the publication's host |
| `/v1/profile` | `handle` (one leading `@` is removed, then it is lowercased: Substack's lookup is case-sensitive and handles are lowercase) | `https://substack.com/api/v1/user/<handle>/public_profile` | 3600 / 600 | `Profile {handle, name, primaryPublication, subscriptions}` (public subscriptions only, at most 500) |
| `/v1/search` | `q`, 2 to 100 characters | `https://substack.com/api/v1/top/search?query=<q>` | 3600 / 600 | `{results: PubMeta[]}`, at most 20, deduplicated by id and host |
| `/v1/feed` | `host` | `https://<host>/feed` | 600 / 120 | Raw RSS XML served as `text/plain; charset=utf-8` on success; a JSON error envelope on failure |

Details:

- **Archive paging.** Substack often returns fewer posts than `limit`. For the API, `nextOffset` is `offset` plus the number of items Substack returned, and becomes `null` only after an empty page (or past offset 5000). Clients must keep paging until `nextOffset` is `null`, never stop because a page is short.
- **Public archive recovery (v0.1.2).** A blocked/rate-limited/unavailable first API page (`offset=0`, `sort=new`) falls back to the verified host's `/sitemap.xml`, then fetches at most four selected `/p/<slug>` pages concurrently. It returns `source: 'sitemap'` with the usual summaries and `nextOffset`. Clients must send `source=sitemap` on subsequent pages; this skips the API and preserves the sitemap sequence even if the API recovers. Refresh starts again without a source. Sitemap and API offsets are never mixed automatically mid-list. `source=sitemap` requires `sort=new`; other sources are invalid.
- **Deployment switch.** `PUBLIC_ARCHIVE_FALLBACK=0` disables only automatic first-page sitemap recovery. Explicit `source=sitemap` remains available, and public-page post recovery is unchanged. This is set in `wrangler.toml` because the current Cloudflare egress can read this publisher's first four public pages but gets 429 for selected older pages. Keeping the API error allows the client to recover all 20 recent RSS posts instead of shrinking its list to four. Enable automatic recovery only after both initial and older pages work from the chosen host. Existing first-page edge cache entries can take five minutes to expire after changing this setting.
- **Public page parsing.** Sitemap order is preserved as supplied by Substack; `lastmod` is never used as publication date. Titles, IDs, audiences and actual `post_date` come from the selected public pages' JSON preloads. Archive replies discard article bodies. A failed hydration fails the whole page, preserving its offset for retry; only reaching the known sitemap end ends paging. `/v1/post?host=&slug=` can likewise recover via its public article page after an eligible API failure. Numeric IDs do not use this recovery. Only public paid previews are returned. If automatic recovery fails, the original API error/Retry-After is preserved so RSS recovery can still run.
- **Recovery bounds.** Sitemap XML is capped at 1 MiB, each HTML page at 4 MiB, with the normal host/redirect/fingerprint checks and one shared 10-second deadline across API plus recovery. At most 5001 unique sitemap post slots are retained. Uncached public archive recovery has its own strict 10/minute budget. No scripts execute, cookies are never sent, and raw sitemap/page HTML is not cached; only the usual trimmed answers use the existing short edge cache.
- **Archive publication.** `publication` comes from `publishedBylines[].publicationUsers[].publication` whose `id` equals the post's `publication_id`. When no item has such a byline (staff and guest bylines often name no publication, or another one), the first byline publication whose host is the final upstream host is used; otherwise it is `null`. The same rule gives `/v1/post?host=&slug=` its `publication`.
- **Search.** Results come from `profileSearchResults` items (each result's `primaryPublication`) and from `post` items (their `publication`). Comment items are ignored.
- **Publication host.** A `PubMeta.host` is the publication's `base_url`/`hostname` when Substack sends one; otherwise its custom domain when set and not marked optional; otherwise `<subdomain>.substack.com`.
- **Trimming.** Posts keep `id`, `publication_id`, `slug`, `title` (trimmed), `subtitle`, `post_date`, `audience`, `type`, `wordcount`, `canonical_url`, up to 5 byline names and `podcast_duration`. Post details add `body_html` unchanged. A missing `audience` becomes `unknown`. Any audience other than `everyone` sets `isPaywalled` and `truncated`, because the body may be only a preview. Publication names are trimmed.
- **Feed.** The XML is passed through unchanged after the content-type check and a check that the document element is `<rss>`, preceded only by an XML declaration, comments and whitespace (so no `xml-stylesheet` instruction and no DOCTYPE). It is served as `text/plain` under the sandbox CSP, so a browser that opens the URL never renders upstream markup on the relay's origin; the phone parses it with `DOMParser`.

## Envelope and headers

Success: `{"ok":true,"meta":{"host","cached","fetchedAt"},"data":...}`. `meta.host` is the final upstream host after allowed redirects; the client stores it, so a publication that moved to a custom domain is updated. `meta.cached` is `true` when the edge cache answered.

Failure: `{"ok":false,"error":{"code","message","retryAfterSeconds?","upstream?":{"status","contentType","challenge"}}}`. `upstream.contentType` is a category (`application/json`, `application/xml`, `text/html`, `text/plain`, `other` or `missing`). Upstream bodies and headers are never passed on.

Every response carries:

- `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Max-Age: 86400` (never `Access-Control-Allow-Credentials`)
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
- `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'` (the two HTML pages carry their own CSP instead); `fetch()` callers are unaffected, and nothing the relay returns can run script on its origin
- `Content-Type` (JSON, plain text for the feed, or HTML)
- `Cache-Control: public, max-age=<client TTL>` on success, `no-store` on errors and on `/v1/health`
- `Retry-After` on every error that has `retryAfterSeconds`

No upstream header (in particular no `Set-Cookie`) is copied.

## Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_HOST`, `INVALID_SLUG`, `INVALID_HANDLE`, `INVALID_QUERY`, `INVALID_PARAM` | Parameter rejected before any upstream request. Also `INVALID_PARAM` when `id` is combined with `host`/`slug`. |
| 403 | `HOST_NOT_SUBSTACK` | The host failed verification (including a domain that does not exist, has no addresses or does not answer HTTPS, and a host that refused the check without Substack's fingerprint), or an upstream response lacked Substack's fingerprint header. |
| 404 | `NOT_FOUND`, `PUBLICATION_NOT_FOUND`, `POST_NOT_FOUND`, `PROFILE_NOT_FOUND` | Unknown route, or Substack has no such publication, post or profile. A redirect from an unknown subdomain to `substack.com` also means `PUBLICATION_NOT_FOUND`. On `/v1/post`, a JSON 404 is `POST_NOT_FOUND` and an empty 404 is `PUBLICATION_NOT_FOUND`. |
| 405 | `METHOD_NOT_ALLOWED` | Not GET or OPTIONS. |
| 429 | `RATE_LIMITED` | Too many requests from this client (or too many custom-domain mapping proofs that did not pass, or health probes); see `retryAfterSeconds`. |
| 502 | `UPSTREAM_INVALID`, `UPSTREAM_TOO_LARGE`, `UPSTREAM_ERROR`, `TOO_MANY_REDIRECTS`, `REDIRECT_NOT_ALLOWED` | Wrong content type or unreadable JSON, over the size cap, another non-2xx status, more than 3 redirects, or a redirect the relay will not follow. |
| 503 | `UPSTREAM_BLOCKED`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE` | Substack answered 403 or a Cloudflare challenge; Substack answered 429 (with `retryAfterSeconds`, at most 86400); Substack answered 5xx or could not be reached. `UPSTREAM_BLOCKED` also covers a custom-domain mapping proof that Substack refused (a 401, 403 or challenge from `S.substack.com`, or from the host with Substack's fingerprint; with `upstream`); `UPSTREAM_UNAVAILABLE` also covers a custom domain that could not be checked: a DNS lookup failed and the proof did not pass, or the proof timed out or met 429 or 5xx. |
| 504 | `UPSTREAM_TIMEOUT` | Substack did not answer within 10 s. |
| 500 | `INTERNAL_ERROR` | Unexpected relay failure. |

The 403, 429 and 5xx mappings apply even when the upstream response lacks Substack's fingerprint header (block pages often do). The body is discarded either way.

## Security rules

These rules keep the relay from becoming an open proxy. Do not relax them.

1. **Callers never supply URLs.** Each upstream URL is built from a validated parameter and a fixed path template.
2. **Host allowlist**, checked before the first request and again for every redirect target:
   - A single-label `<name>.substack.com` host passes.
   - `substack.com` itself passes only for the by-id, profile and search templates. `www.substack.com`, `open.substack.com` and multi-label `*.substack.com` hosts are never publications.
   - IP literals, ports, and names ending in `.localhost`, `.local`, `.internal`, `.test`, `.invalid`, `.example`, `.onion` or `.arpa` are rejected.
   - Any other host is a **custom domain** and must pass one of three checks:
     1. DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`, `type=CNAME`) shows a CNAME to `target.substack-custom-domains.com.`;
     2. the host's A/AAAA records share an address with `target.substack-custom-domains.com` (apex domains with CNAME flattening), or its A answer contains a CNAME chain ending at that target;
     3. a mapping proof: `https://<host>/api/v1/archive?sort=new&offset=0&limit=1` answers Substack JSON (with the fingerprint header) that names a publication whose `custom_domain` is the host (or its `www.` variant) and whose subdomain is `S`, **and** `https://S.substack.com/api/v1/archive?...` redirects to exactly that host.

     The checks run in that order. When the host's A and AAAA answers are definitive but contain no address (NXDOMAIN, or a CNAME to a name without addresses), nothing can serve it, so it fails without any request to the host. The mapping proof is the only request to a host the caller chose, so it first takes a token from the client's strict budget (rule 7); a proof that passes gives it back.

     A pass is cached for 24 hours and a failure for 1 hour, in memory and in the Cache API. Two failures are kept shorter. When nothing serves the host (no addresses; or definitive DNS and a proof request refused on connection or TLS, or answered by a Cloudflare `530`), the failure lasts 10 minutes, so a newly configured domain is seen soon. When the host itself refuses the proof's first request (401, 403 or a challenge) without Substack's fingerprint, the refusal comes from another site's firewall (for example an apex whose `www.` alone is on Substack), so it is `HOST_NOT_SUBSTACK` for 60 seconds and the phone's `www.` retry (when adding a bare domain) runs.

     An inconclusive check is remembered for 60 seconds in memory only and never written to the Cache API. A DNS lookup that failed (when the proof does not pass), or a proof that timed out or met 429 or another 5xx, is reported as `UPSTREAM_UNAVAILABLE`. Substack refusing the proof (a 401, 403 or challenge from `S.substack.com`, or from the host with Substack's fingerprint) is reported as `UPSTREAM_BLOCKED`, never as a cached `HOST_NOT_SUBSTACK`. In memory, passes are kept apart from failures (up to 2,000 hosts each, least recently used evicted first), so a stream of cheap failing hosts cannot push out verified ones.
3. **Fingerprint.** Every upstream response, redirects included, must carry `x-served-by: Substack` or `x-cluster: substack` (case-insensitive), or its body is discarded and the request fails with `HOST_NOT_SUBSTACK`.
4. **Redirects** are handled manually, at most 3 hops. A relative `Location` is resolved against the request URL. The target must be `https:` with no credentials or port, keep the same path, and pass rule 2. Only the host changes; the relay keeps its own path and query.
5. **Honest requests.** GET only, no body, no cookies. The only request headers are `User-Agent: SubstackReaderForEvenHub/<version>` (no URL in it: a URL in the User-Agent makes Substack search return nothing) and `Accept: application/json` (`application/rss+xml, application/xml;q=0.9` for feeds, `application/dns-json` for DNS). Never spoof a browser User-Agent or Referer, rotate IPs or replay Cloudflare cookies.
6. **Size caps**, enforced while streaming: archive 1 MiB, post 4 MiB, profile 1 MiB, search 2 MiB, feed 4 MiB, DNS answers 64 KiB. Each upstream call has a 10 s timeout covering every redirect hop and the body. JSON routes require a JSON content type; the feed route requires `application/rss+xml`, `application/xml` or `text/xml` and an `<rss>` document element (see Feed above).
7. **Rate limiting** per client and route, applied after parameter validation (so `400`s never count): the Cloudflare binding `RL` (60 per 60 s, counted per Cloudflare location) when present, otherwise a per-isolate token bucket of 60 per minute. Costly work also takes a token from a strict budget under its own route key: each custom-domain mapping proof (`verify`) and each `/v1/health?probe=1` (`health-probe`), through the binding `RL_STRICT` (10 per 60 s) or a per-isolate bucket of 10 per minute. If a binding throws, the local bucket is used.
   - **Only proofs that do not pass cost budget.** A mapping proof takes its token before it runs, so a burst of proofs never exceeds the budget. A proof that passes gives the token back as a per-isolate credit (at most a budget's worth per client) that pays for that client's next proof, because `RL_STRICT` cannot refund. A reader following many custom domains that only the proof can verify is therefore never limited on a cold isolate, while hosts that are not Substack's still are. Charging only hosts without a stored verdict would not help: on `*.workers.dev` the Cache API may store nothing, so a cold isolate has no stored verdicts at all.
   - Concurrent requests for one host share one verification. If the client that started it is over its strict budget, the others retry under their own budget instead of receiving its `429`.
   - **The client key** is the `CF-Connecting-IP` header only when the request carries Cloudflare's `request.cf` object, i.e. it came through Cloudflare's edge, which sets that header. An IPv6 address is reduced to its /64 (`2001:db8:1:2::/64`), because one subscriber usually holds a whole /64. On any other platform a client could choose the header's value, so the relay ignores it and all clients share one key (`shared`) per route.
   - The IP is used only as an in-memory key.
8. **No logs, no storage.** No `console` output, `observability.enabled = false` in `wrangler.toml`, nothing written anywhere except the edge cache.
9. **Edge cache.** Keys are synthetic, live under the relay's own request origin (`https://<relay host>/__relay-cache/p1/v1/...`, so honest relays at different origins never read each other's entries) and are built after validation. Only successful responses, post 404s and custom-domain pass/fail verdicts are cached; 403, 429, 5xx and inconclusive verdicts never are. A stored verdict whose expiry is later than the relay ever sets (24 h for a pass, 1 h for a failure) is ignored. A response that followed a redirect is cached under both the requested and the final host. On `*.workers.dev` the Cache API is best-effort; it is reliable on a custom domain.
   - **Entries are not authenticated.** Code that can write to the same cache under the relay's hostname could plant a verdict or a response, and the relay would trust it (the expiry bound is only a sanity check). This is acceptable on a dedicated Cloudflare account: the cache belongs to the relay's own zone or `workers.dev` subdomain, and only this Worker writes to it. Do not deploy the relay where untrusted code shares its cache; on such a host, sign the entries (an HMAC with a Worker secret) first.

## Health and probes

`GET /v1/health` returns the service name, protocol, `revision` (the Worker variable `REVISION`, or `null`) and `origin`: the request's `Origin` header (at most 128 printable characters), or `null`. Calling it from the Diagnostics panel on a real phone reveals the Even WebView's origin, which Even does not document.

`GET /v1/health?probe=1` also makes three requests and reports only status, content-type category, whether a Cloudflare challenge was shown, and the time taken. Each isolate runs at most one round per minute: a later call within that minute gets the same results with `meta.cached: true`. Each call also takes a token from the strict budget (rule 7).

| Probe | Request |
| --- | --- |
| `subdomain` | `https://on.substack.com/api/v1/archive?sort=new&offset=0&limit=1` |
| `customDomain` | `https://www.slowboring.com/api/v1/archive?sort=new&offset=0&limit=1` |
| `substackCom` | `https://substack.com/api/v1/top/search?query=substack` |

How to read the result:

- All `200`: the relay's network can reach every kind of Substack host.
- `403` with `text/html` (or `challenge: true`) for `subdomain` or `substackCom`: Substack blocks this host's egress for those hosts. Custom-domain publications may still work. Options: move the same bundle to a host with different egress (see the deployment options below), or accept the gap. The app shows "Substack refused the reader service" for those publications and tries the feed route.
- `429`: Substack is rate-limiting. Cloudflare Workers share outgoing addresses, so this can happen without heavy use of your own relay.
- `status: 0`: the request failed on the network or timed out.

The **Deploy relay** workflow runs this probe once after each deploy when `VITE_RELAY_ORIGIN` is set, and writes the table to the job summary.

## Deployment options

### Current deployment (2026-10-08)

The account's relay is live at `https://substack-reader-relay.chihin-lau-work.workers.dev`. Both GitHub deployment secrets and `VITE_RELAY_ORIGIN` are configured. The [current deployment](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37814548333) succeeded at revision `6b3507f`; a direct health check confirmed protocol 1 and that revision. All three API probes still returned upstream HTTP 429. At 17:12 UTC, a direct archive request for `andrewhclu.substack.com` returned `UPSTREAM_RATE_LIMITED` (503 envelope, upstream 429), and its RSS returned 200 with 20 items. `PUBLIC_ARCHIVE_FALLBACK=0` preserves the RSS recovery list instead of returning just four accessible public pages.

This is partial upstream availability. Version 0.1.2 is Published Beta in the [Even Hub project](https://hub.evenrealities.com/hub/com.chlwork.substackreader); the deployed code passed [CI](https://github.com/CHL-work/substack-reader-for-evenhub/actions/runs/37814056599). Public article recovery and explicit sitemap pagination are implemented, but selected older pages still return 429 from Cloudflare. The owner's older-post issue is not fully fixed. Search, profile imports and numeric post IDs still depend on the API. The optional third-party rss2json service remains disabled. The owner reports using the app with two publications; hardware retesting of this update is pending. A hosting choice is pending, and another host must be verified before it is presented as a solution. See [HANDOFF.md](HANDOFF.md) for probe evidence and cleanup. The account token has Workers Scripts Write only and expires January 6, 2027; replace the GitHub secret before the next deployment after expiry. Expiry does not stop the already deployed Worker.

### Cloudflare Workers with GitHub Actions (default)

`wrangler.toml` deploys `worker/relay.ts` as `substack-reader-relay` with `workers_dev = true`, observability off, and the `RL` and `RL_STRICT` rate-limit bindings. Wrangler is an exact devDependency (`wrangler` 4.148.0, locked in `pnpm-lock.yaml`), so the deploy never resolves a fresh dependency tree while the API token is in its environment.

1. Create a Cloudflare API token with **Workers Scripts: Edit** for your account. Make sure the account has a `workers.dev` subdomain; wrangler cannot create one in CI.
2. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Run **Actions → Deploy relay**. It installs the locked dependencies, type-checks, runs the Node unit tests (which include the relay's), then runs `pnpm exec wrangler deploy --var "REVISION:<short sha>"`.
4. Set the repository variable `VITE_RELAY_ORIGIN` to the Worker URL (`https://substack-reader-relay.<subdomain>.workers.dev`) and re-run the workflow to get the probe summary, or open `/v1/health?probe=1` yourself.

A custom domain for the Worker (configured in Cloudflare) gives a more stable origin and a working edge cache. Changing the origin later requires a new `.ehpk`.

### Cloudflare Workers from your computer

```powershell
$env:PATH = "C:\Code\substack-reader-for-evenhub\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler deploy --var REVISION:manual
```

### OpenAI Sites

`pnpm run build` also writes the relay as `dist/server/index.js`, which is the entry point the Sites platform expects. See [.openai/README-sites.md](../.openai/README-sites.md). Sites has no rate-limit binding, so the per-isolate token buckets apply. If Sites requests carry no Cloudflare `request.cf` object, all clients share one bucket per route (rule 7).

### Other hosts

The relay uses only `fetch`, `Request`, `Response`, `AbortController`, `TextDecoder` and an optional `caches`. Any platform that runs an ES module with a `fetch(request, env, ctx)` export (Deno Deploy, Vercel Edge and similar) can host `dist/server/index.js`, which may help if Substack blocks Cloudflare's egress. Off Cloudflare (no `request.cf`), the relay ignores `CF-Connecting-IP`, which any client could set there, so all clients share one rate-limit bucket per route in each isolate (60 per minute; 10 per minute for mapping proofs and probes).

## Client contract (src/substack/api.ts)

- Every request is a CORS simple request: `GET`, `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, no custom headers, so there is no preflight.
- The client timeout is 15 s. The client validates input itself and rejects bad hosts, slugs, handles, post ids (above 2147483647) and queries before sending anything; handles are lowercased like the relay does. When the build has no relay origin, it fails with `NOT_CONFIGURED` and sends nothing.
- `/v1/feed` answers `text/plain`; the client accepts any non-JSON success body as the feed XML and parses it as `application/xml`.
- Client-only error codes: `NOT_CONFIGURED`, `NETWORK_ERROR` (including a response that is not a relay envelope), `TIMEOUT` and `ABORTED` (the caller cancelled).
- The archive page size is 12. The client adopts `meta.host` after redirects.
- When adding a bare custom domain such as `example.com` fails with `HOST_NOT_SUBSTACK`, the phone retries `www.example.com` once, because many publications redirect the apex to `www.` without Substack's headers.
