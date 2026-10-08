# Privacy

Reader for Substack has no accounts, no login, no cookies, no analytics and no crash reporting. It reads only public Substack data. This page describes what is stored on the phone, what the relay sees, and which third parties are involved. The relay serves a short version of this policy at `https://<relay-origin>/privacy`; use that URL for the Even Hub listing.

## Stored on your phone

The app keeps two small documents in the Even app's plugin storage (the Even bridge's `setLocalStorage`), with a copy in the plugin WebView's `localStorage`. Both stay on the phone and are removed when the plugin is uninstalled.

| Key | Contents |
| --- | --- |
| `sr:prefs:v1` | The publications you follow (name, host, Substack id, date added, whether it feeds Latest), your saved posts and your settings |
| `sr:progress:v1` | Reading positions (post id, character offset, page, a version string, time), recently opened posts (history), ids of posts you finished, and the last opened post |

The WebView's `localStorage` also holds `sr:sync:v1`: two save times that tell which version of the Even app's copy the WebView copy last matched (no content).

A saved post, history entry or "last opened" entry is a reference only: post id, host, slug, title, publication name, publication date, paid flag and word count. **Article text and HTML are never stored.** They are kept in memory while the app runs (up to 10 converted posts, plus the recent posts of a feed fallback) and are gone when the app closes.

You can clear history and positions, or reset everything, in the phone's Settings panel. The Diagnostics panel keeps the last 30 glasses events (envelope, event type, input source and time only, never text) in memory.

## What the relay sees

The app talks to one relay, at the origin shown in the phone's Diagnostics panel and in the package's network permission. For each list, post, profile import or search you open, the relay receives:

- your phone's IP address and the WebView's standard request headers (such as `User-Agent` and `Origin`); the app sends no cookies and no custom headers;
- what you asked for: a publication host, a post slug or id, a Substack `@handle`, or the search text.

The relay:

- **does not log requests** (no logging code; Cloudflare observability is disabled in `wrangler.toml`) and stores nothing permanently;
- uses your IP address (for IPv6, only its first 64 bits) only as an in-memory key to limit request rates (at most 60 requests per minute per route, and 10 per minute for checking a new custom domain, probing Substack or recovering archive pages from public pages); with Cloudflare's rate-limit bindings, Cloudflare counts that key for one minute. On hosts other than Cloudflare the relay does not use your address at all, and everyone shares the same limits;
- fetches the public Substack data with its own honest User-Agent (`SubstackReaderForEvenHub/<version>`) and no cookies, so Substack sees the relay, not you;
- removes fields the app does not need before answering;
- may keep the trimmed answers in the hosting provider's short-lived edge cache, keyed by what was requested and never by who asked: lists up to 5 minutes, posts up to 15 minutes (a "not found" answer for 1 minute), feeds up to 10 minutes, profiles and search results up to 1 hour. The result of checking that a custom domain belongs to Substack is cached for up to 24 hours (a failed check for 1 hour, a domain that does not exist for 10 minutes, and a check that could not finish for 1 minute in memory only);
- echoes your request's `Origin` header back only in its health response, which the app uses for diagnostics.

## Third parties

| Party | Why | What it receives |
| --- | --- | --- |
| Substack | Source of all content | Requests from the relay (public archive, post, profile, search and feed endpoints, plus public sitemaps and article pages for recovery) |
| Cloudflare | Hosts the relay (Workers) and answers DNS-over-HTTPS lookups (`cloudflare-dns.com`) used to verify custom domains | The connection from your phone to the relay, under Cloudflare's own privacy policy; domain names being verified |
| OpenAI Sites | Only if the relay is hosted there instead of Cloudflare | The same as Cloudflare's hosting role |
| Even Realities | Hosts and runs the plugin in the Even app and provides its storage | Whatever the Even app itself collects under Even Realities' policy; the plugin sends it no reading data |
| rss2json (`api.rss2json.com`) | **Off by default.** Only in a build made with `VITE_ENABLE_RSS2JSON_FALLBACK=1`, whose network permission then lists it | If used, your phone would contact it directly, so it would see your IP address and the feed URL of the publication |

The app opens no other sites, loads no remote images or fonts, and never inserts post HTML into its page.

## Paid content

The app never uses a Substack login or cookie. Free posts are shown in full; for paid posts only Substack's public preview is shown.

## Contact

Questions and deletion requests: <https://github.com/CHL-work/substack-reader-for-evenhub/issues>. The relay keeps no per-user data, so there is nothing to delete on the server; data on the phone is removed by uninstalling the plugin or with the reset options in Settings.

This app is not affiliated with Substack Inc. or Even Realities.
