/**
 * Static HTML for GET / and GET /privacy on the relay. ASCII-only, no
 * scripts, no external resources (served with CSP default-src 'none').
 * The app name comes from app.json so it is defined in one place.
 */
import { name as APP_NAME } from '../app.json'

export const SOURCE_URL = 'https://github.com/CHL-work/substack-reader-for-evenhub'

const STYLE = [
  'body{max-width:680px;margin:6vh auto;padding:0 16px;font:17px/1.6 system-ui,sans-serif;background:#f6f6f3;color:#202020}',
  'h1{font-size:28px;line-height:1.25}h2{font-size:20px;margin-top:28px}a{color:#1d4f73}',
  'code{font-size:15px}ul{padding-left:22px}footer{margin-top:32px;font-size:15px;color:#555}',
  '@media (prefers-color-scheme:dark){body{background:#141414;color:#e6e6e6}a{color:#8cc4ec}footer{color:#aaa}}',
].join('')

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

/** GET / : what this service is. */
export function landingPage(relayHost: string, version: string): string {
  const name = escapeHtml(APP_NAME)
  return page(`${APP_NAME} relay`, `<h1>${name} relay</h1>`
    + `<p>This is the stateless relay used by <strong>${name}</strong>, an Even Hub app that shows public Substack posts on Even Realities G2 glasses.`
    + ' The app cannot fetch Substack directly from the phone, so it asks this relay, which fetches the public page data without cookies or login and returns a trimmed copy.</p>'
    + '<p>There is nothing to use here in a browser. The app calls fixed, read-only endpoints under <code>/v1/</code>.</p>'
    + `<ul><li><a href="/privacy">Privacy</a></li><li><a href="${SOURCE_URL}">Source code and issues</a></li></ul>`
    + `<footer>Relay host ${escapeHtml(relayHost)} &middot; version ${escapeHtml(version)} &middot; ${name} is an independent project and is not affiliated with Substack Inc. or Even Realities.</footer>`)
}

/** GET /privacy : names the relay domain (store review requirement) and what is processed. */
export function privacyPage(relayHost: string): string {
  const name = escapeHtml(APP_NAME)
  const host = escapeHtml(relayHost)
  return page(`${APP_NAME} privacy`, `<h1>${name} privacy</h1>`
    + `<p>${name} is an independent project and is not affiliated with Substack Inc. or Even Realities.</p>`
    + `<h2>The relay at ${host}</h2>`
    + '<ul>'
    + '<li>When you open a list, a post, a profile or a search in the app, the app asks this relay for it. The relay fetches the public Substack data (a publication archive, one post, a public profile, search results or an RSS feed), removes fields the app does not need and returns the rest.</li>'
    + '<li>The relay never sends cookies or logins to Substack, so it only ever sees free posts and the public previews of paid posts.</li>'
    + '<li>It has no accounts, no cookies, no analytics and no request logs, and it stores nothing permanently.</li>'
    + '<li>To reduce load on Substack, responses may be kept in the hosting provider&#39;s short-lived edge cache: lists for up to 5 minutes, posts for up to 15 minutes, profiles and search results for up to 1 hour. The result of checking that a custom domain belongs to Substack is cached for up to 24 hours.</li>'
    + '<li>Your IP address is used only in memory to limit request rates. The relay does not log or store it. The hosting provider (Cloudflare) handles the connection under its own privacy policy.</li>'
    + '<li>Substack receives the relay&#39;s request, not yours. For custom domains the relay asks Cloudflare DNS (cloudflare-dns.com) whether the domain points to Substack.</li>'
    + '</ul>'
    + '<h2>On your phone</h2>'
    + '<p>The app keeps the publications you follow, your saved posts and your reading positions in the Even app&#39;s storage on your phone. Article text is held in memory only while you read and is never stored.</p>'
    + `<h2>Contact</h2><p>Questions and deletion requests: <a href="${SOURCE_URL}/issues">${SOURCE_URL}/issues</a>.</p>`
    + '<p><a href="/">Back</a></p>')
}
