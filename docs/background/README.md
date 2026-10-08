# Background: research and review records

These files record how v0.1.0 was designed and hardened, between 2026-10-06 and 2026-10-07. They are **point-in-time**: where they disagree with the code or with the current docs (`README.md`, `docs/*.md`), the code and current docs win. They are kept because they hold facts that are expensive to rediscover: live Substack response shapes, Even SDK limits, and why each design choice was made.

| File | What it is |
| --- | --- |
| [01-lihkg-reference-patterns.md](01-lihkg-reference-patterns.md) | What was reused from the owner's sibling project `CHL-work/lihkg-reader-for-evenhub` (private): glasses wrapper, pagination, pack script, CI and test harness, and lessons such as its relay's upstream HTTP 403. |
| [02-even-hub-sdk-and-docs.md](02-even-hub-sdk-and-docs.md) | Even Hub platform research: SDK 0.0.16 API surface and limits, `app.json` schema, `evenhub` CLI, official templates, networking rules, store review rules. |
| [03-substack-api.md](03-substack-api.md) | Live probes of Substack's undocumented endpoints (archive, posts, by-id, search, public profile, feed) with field shapes, paging behaviour, CORS (none), rate limits and terms of service. |
| [04-html-to-text.md](04-html-to-text.md) | Catalogue of Substack's post HTML structures and the conversion rules and glyph table used by `src/substack/html.ts`. |
| [05-g2-reader-ux.md](05-g2-reader-ux.md) | G2 hardware and input facts, other Even Hub reader apps, and the UX that was chosen. |
| [06-relay-architecture.md](06-relay-architecture.md) | Why a relay is needed, hosting options (Cloudflare, OpenAI Sites, third-party proxies, all probed), and the relay contract. |
| [07-v0.1-blueprint-spec.md](07-v0.1-blueprint-spec.md) | The implementation blueprint the code was built from. The corrections below override it, and the review rounds changed a lot after it. |
| [review-round-1.md](review-round-1.md) | 34 findings on the first implementation (30 confirmed, 4 uncertain); all addressed in `247981a`. |
| [review-round-2.md](review-round-2.md) | 19 findings on the round-1 fixes (11 confirmed, 6 uncertain, 2 refuted); fixed in `04c2e0c`. |
| [review-round-3.md](review-round-3.md) | 7 findings on the round-2 fixes (all low); fixed in `228e20f`, whose own review came back clean. |

## Corrections applied over the blueprint

Fact-checkers verified the blueprint's load-bearing claims against live endpoints, the SDK and Even's docs. These corrections were applied when the code was written:

1. **Archive paging.** Substack returns fewer posts than `limit` (25 gives 23). Use `nextOffset = offset + returned` and end only on an empty page. The client asks for 12 and the relay clamps to 1..20.
2. **User-Agent.** The relay sends exactly `SubstackReaderForEvenHub/<version>`, with no URL in it: a `(+https://…)` suffix made Substack search return empty results. It never pretends to be a browser.
3. **Search.** Use `substack.com/api/v1/top/search` and ignore `comment` items. `publication/search` gives empty results for non-browser clients. `profileSearchResults` publications have no `base_url`, so the host is the custom domain or `<subdomain>.substack.com`.
4. **Custom domains.** A CNAME check alone misses apex domains and owner-proxied Cloudflare zones. The relay accepts a CNAME to `target.substack-custom-domains.com`, or A/AAAA records shared with it, or a mapping proof through Substack itself, and requires Substack's fingerprint headers on every response. (Round 1 showed DNS can be spoofed by the attacker's own name server, so custom-domain bodies are also treated as untrusted: a sandbox CSP and `text/plain` for the feed.)
5. **Pack.** `evenhub pack` prints only a WARNING and stamps an older `min_app_version` (2.2.6) when it cannot reach npm. `scripts/pack.mjs` fails on any warning and requires `min_app_version 2.2.10`. Never pass `-c`/`--check`.
6. **Bridge storage.** `getLocalStorage` returns `''` for a missing key; bridge storage is the main copy and `localStorage` a mirror.
7. **Line starts.** Never emit an ASCII space right after a newline; indentation uses NBSP.
8. **Root exit.** The Home double-tap must call `shutDownPageContainer(1)`; Even's review rejects mode 0.
9. **DOMParser.** Parsed documents are inert, but their nodes must never be adopted into the live page.
10. **Events.** Read `sysEvent`, `textEvent` and `listEvent`; resolve explicit event types before treating a missing `eventType` as a tap (CLICK is 0 and protobuf omits it).
11. **Paywall.** Any `audience` other than `everyone` may be truncated.
12. **Name.** "Reader for Substack", package id `com.chlwork.substackreader`, in one constant (`APP_NAME`) plus `app.json`.
