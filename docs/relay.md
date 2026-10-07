# Relay

`worker/relay.ts` is a stateless, GET-only relay between the plugin and Substack. The plugin needs it because Substack sends no CORS headers and Even Hub plugins can reach only whitelisted origins. It implements relay **protocol 1**.

The same ES module runs on Cloudflare Workers and on OpenAI Sites. Its default export is `{ fetch(request, env, ctx) }`. The rate-limit binding `env.RL` and the Cache API (`caches.default`) are optional. It has no runtime dependencies; it imports only `package.json` (for the version), `app.json` (for the name on its HTML pages) and the shared types in `src/substack/types.ts`.

## Routes

Every route is `GET`. `OPTIONS` answers `204`; any other method answers `405 METHOD_NOT_ALLOWED` with `Allow: GET, OPTIONS`. An unknown path answers `404 NOT_FOUND`.

| Route | Parameters | Upstream request | Edge / client cache (s) | `data` |
| --- | --- | --- | --- | --- |
| `/` and `/privacy` | none | none | client 3600 | HTML landing and privacy pages (CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`) |
| `/v1/health` | `probe=1` (optional) | with `probe=1`, three fixed probes (below) | none (`no-store`) | `{service: 'substack-reader-relay', protocol: 1, revision, origin, probes?}` |
| `/v1/archive` | `host`; `offset` 0 to 5000 (default 0); `limit` (default 12, clamped to 1..20); `sort` `new` or `top` (default `new`) | `https://<host>/api/v1/archive?sort=<s>&search=&offset=<o>&limit=<l>` | 300 / 60 | `ArchivePage {publication, posts, nextOffset}` |
| `/v1/post` | `host` and `slug` | `https://<host>/api/v1/posts/<slug>` | 900 / 300 (404s cached 60 at the edge) | `{post: PostDetail, publication: PubMeta or null}` |
| `/v1/post` | `id` (a positive safe integer) alone | `https://substack.com/api/v1/posts/by-id/<id>` | 900 / 300 (404s cached 60 at the edge) | `{post, publication}`; `meta.host` is the publication's host |
| `/v1/profile` | `handle` (one leading `@` is removed) | `https://substack.com/api/v1/user/<handle>/public_profile` | 3600 / 600 | `Profile {handle, name, primaryPublication, subscriptions}` (public subscriptions only, at most 500) |
| `/v1/search` | `q`, 2 to 100 characters | `https://substack.com/api/v1/top/search?query=<q>` | 3600 / 600 | `{results: PubMeta[]}`, at most 20, deduplicated by id and host |
| `/v1/feed` | `host` | `https://<host>/feed` | 600 / 120 | Raw RSS XML (`application/xml; charset=utf-8`) on success; a JSON error envelope on failure |

Details:

- **Archive paging.** Substack often returns fewer posts than `limit`. `nextOffset` is `offset` plus the number of items Substack returned, and becomes `null` only after an empty page (or past offset 5000). Clients must keep paging until `nextOffset` is `null`, never stop because a page is short.
- **Archive publication.** `publication` comes from `publishedBylines[].publicationUsers[].publication` whose `id` equals the post's `publication_id`.
- **Search.** Results come from `profileSearchResults` items (each result's `primaryPublication`) and from `post` items (their `publication`). Comment items are ignored.
- **Publication host.** A `PubMeta.host` is the publication's `base_url`/`hostname` when Substack sends one; otherwise its custom domain when set and not marked optional; otherwise `<subdomain>.substack.com`.
- **Trimming.** Posts keep `id`, `publication_id`, `slug`, `title` (trimmed), `subtitle`, `post_date`, `audience`, `type`, `wordcount`, `canonical_url`, up to 5 byline names and `podcast_duration`. Post details add `body_html` unchanged. A missing `audience` becomes `unknown`. Any audience other than `everyone` sets `isPaywalled` and `truncated`, because the body may be only a preview. Publication names are trimmed.
- **Feed.** The XML is passed through unchanged after the content-type check; the phone parses it.

## Envelope and headers

Success: `{"ok":true,"meta":{"host","cached","fetchedAt"},"data":...}`. `meta.host` is the final upstream host after allowed redirects; the client stores it, so a publication that moved to a custom domain is updated. `meta.cached` is `true` when the edge cache answered.

Failure: `{"ok":false,"error":{"code","message","retryAfterSeconds?","upstream?":{"status","contentType","challenge"}}}`. `upstream.contentType` is a category (`application/json`, `application/xml`, `text/html`, `text/plain`, `other` or `missing`). Upstream bodies and headers are never passed on.

Every response carries:

- `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Max-Age: 86400` (never `Access-Control-Allow-Credentials`)
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
- `Content-Type` (JSON, XML or HTML)
- `Cache-Control: public, max-age=<client TTL>` on success, `no-store` on errors and on `/v1/health`
- `Retry-After` on every error that has `retryAfterSeconds`

No upstream header (in particular no `Set-Cookie`) is copied.

## Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_HOST`, `INVALID_SLUG`, `INVALID_HANDLE`, `INVALID_QUERY`, `INVALID_PARAM` | Parameter rejected before any upstream request. Also `INVALID_PARAM` when `id` is combined with `host`/`slug`. |
| 403 | `HOST_NOT_SUBSTACK` | The host failed verification, or an upstream response lacked Substack's fingerprint header. |
| 404 | `NOT_FOUND`, `PUBLICATION_NOT_FOUND`, `POST_NOT_FOUND`, `PROFILE_NOT_FOUND` | Unknown route, or Substack has no such publication, post or profile. A redirect from an unknown subdomain to `substack.com` also means `PUBLICATION_NOT_FOUND`. On `/v1/post`, a JSON 404 is `POST_NOT_FOUND` and an empty 404 is `PUBLICATION_NOT_FOUND`. |
| 405 | `METHOD_NOT_ALLOWED` | Not GET or OPTIONS. |
| 429 | `RATE_LIMITED` | Too many requests from this client; see `retryAfterSeconds`. |
| 502 | `UPSTREAM_INVALID`, `UPSTREAM_TOO_LARGE`, `UPSTREAM_ERROR`, `TOO_MANY_REDIRECTS`, `REDIRECT_NOT_ALLOWED` | Wrong content type or unreadable JSON, over the size cap, another non-2xx status, more than 3 redirects, or a redirect the relay will not follow. |
| 503 | `UPSTREAM_BLOCKED`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE` | Substack answered 403 or a Cloudflare challenge; Substack answered 429 (with `retryAfterSeconds`, at most 86400); Substack answered 5xx or could not be reached. `UPSTREAM_UNAVAILABLE` also covers a custom domain that could not be checked because DNS lookups failed. |
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

     A pass is cached for 24 hours and a failure for 1 hour, in memory and in the Cache API. A lookup that fails on the network is not cached and is reported as `UPSTREAM_UNAVAILABLE`.
3. **Fingerprint.** Every upstream response, redirects included, must carry `x-served-by: Substack` or `x-cluster: substack` (case-insensitive), or its body is discarded and the request fails with `HOST_NOT_SUBSTACK`.
4. **Redirects** are handled manually, at most 3 hops. A relative `Location` is resolved against the request URL. The target must be `https:` with no credentials or port, keep the same path, and pass rule 2. Only the host changes; the relay keeps its own path and query.
5. **Honest requests.** GET only, no body, no cookies. The only request headers are `User-Agent: SubstackReaderForEvenHub/<version>` (no URL in it: a URL in the User-Agent makes Substack search return nothing) and `Accept: application/json` (`application/rss+xml, application/xml;q=0.9` for feeds, `application/dns-json` for DNS). Never spoof a browser User-Agent or Referer, rotate IPs or replay Cloudflare cookies.
6. **Size caps**, enforced while streaming: archive 1 MiB, post 4 MiB, profile 1 MiB, search 2 MiB, feed 4 MiB, DNS answers 64 KiB. Each upstream call has a 10 s timeout covering every redirect hop and the body. JSON routes require a JSON content type; the feed route requires `application/rss+xml`, `application/xml` or `text/xml` and a body that starts with `<`.
7. **Rate limiting** per client IP and route, applied after parameter validation (so `400`s never count): the Cloudflare binding `RL` (60 per 60 s, counted per Cloudflare location) when present, otherwise a per-isolate token bucket of 60 per minute. If the binding throws, the local bucket is used. The IP is used only as an in-memory key.
8. **No logs, no storage.** No `console` output, `observability.enabled = false` in `wrangler.toml`, nothing written anywhere except the edge cache.
9. **Edge cache.** Keys are synthetic (`https://relay.cache/p1/v1/...`) and built after validation. Only successful responses and post 404s are cached; 403, 429 and 5xx never are. A response that followed a redirect is cached under both the requested and the final host. On `*.workers.dev` the Cache API is best-effort; it is reliable on a custom domain.

## Health and probes

`GET /v1/health` returns the service name, protocol, `revision` (the Worker variable `REVISION`, or `null`) and `origin`: the request's `Origin` header (at most 128 printable characters), or `null`. Calling it from the Diagnostics panel on a real phone reveals the Even WebView's origin, which Even does not document.

`GET /v1/health?probe=1` also makes three requests and reports only status, content-type category, whether a Cloudflare challenge was shown, and the time taken:

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

### Cloudflare Workers with GitHub Actions (default)

`wrangler.toml` deploys `worker/relay.ts` as `substack-reader-relay` with `workers_dev = true`, observability off, and the `RL` rate-limit binding.

1. Create a Cloudflare API token with **Workers Scripts: Edit** for your account. Make sure the account has a `workers.dev` subdomain; wrangler cannot create one in CI.
2. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Run **Actions → Deploy relay**. It installs the locked dependencies, type-checks, runs the Node unit tests (which include the relay's), then runs `pnpm dlx wrangler@4.148.0 deploy --var "REVISION:<short sha>"`.
4. Set the repository variable `VITE_RELAY_ORIGIN` to the Worker URL (`https://substack-reader-relay.<subdomain>.workers.dev`) and re-run the workflow to get the probe summary, or open `/v1/health?probe=1` yourself.

A custom domain for the Worker (configured in Cloudflare) gives a more stable origin and a working edge cache. Changing the origin later requires a new `.ehpk`.

### Cloudflare Workers from your computer

```powershell
$env:PATH = "C:\Code\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
pnpm dlx wrangler@4.148.0 login
pnpm dlx wrangler@4.148.0 deploy --var REVISION:manual
```

### OpenAI Sites

`pnpm run build` also writes the relay as `dist/server/index.js`, which is the entry point the Sites platform expects. See [.openai/README-sites.md](../.openai/README-sites.md). Sites has no rate-limit binding, so the per-isolate token bucket applies.

### Other hosts

The relay uses only `fetch`, `Request`, `Response`, `AbortController`, `TextDecoder` and an optional `caches`. Any platform that runs an ES module with a `fetch(request, env, ctx)` export (Deno Deploy, Vercel Edge and similar) can host `dist/server/index.js`, which may help if Substack blocks Cloudflare's egress. Behind a platform that does not set `CF-Connecting-IP`, all clients share one rate-limit bucket per route.

## Client contract (src/substack/api.ts)

- Every request is a CORS simple request: `GET`, `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, no custom headers, so there is no preflight.
- The client timeout is 15 s. The client validates input itself and rejects bad hosts, slugs, handles and queries before sending anything. When the build has no relay origin, it fails with `NOT_CONFIGURED` and sends nothing.
- Client-only error codes: `NOT_CONFIGURED`, `NETWORK_ERROR` (including a response that is not a relay envelope), `TIMEOUT` and `ABORTED` (the caller cancelled).
- The archive page size is 12. The client adopts `meta.host` after redirects.
- When adding a bare custom domain such as `example.com` fails with `HOST_NOT_SUBSTACK`, the phone retries `www.example.com` once, because many publications redirect the apex to `www.` without Substack's headers.
