/**
 * Phone UI and glasses flows in real Chromium (SPEC section 8.1, ui-ci).
 * Remote CI only: the project owner's rule forbids local servers, browsers
 * and app tests. The production bundle is built with Vite's JS API, served
 * from 127.0.0.1, and driven with Playwright. Only two boundaries are
 * replaced: the native Even app bridge (an EvenAppBridge stub injected before
 * the app loads) and the relay (https://relay.ci.invalid answered from the
 * synthetic fixtures in tests/fixtures/ui). Every other non-local request is
 * recorded, aborted and fails the scenario. No Substack traffic, no hardware.
 */
if (process.env.CI !== 'true') {
  throw new Error('Phone UI checks run only in remote CI. Local tests, servers and browsers are not authorized.')
}

const { default: assert } = await import('node:assert/strict')
const { createServer } = await import('node:http')
const { mkdtemp, readFile, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const path = await import('node:path')
const { fileURLToPath } = await import('node:url')
const { annotateFailure } = await import('./ci-annotate.mjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const RELAY = 'https://relay.ci.invalid'
const fixtures = JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'ui', 'relay.json'), 'utf8'))

// Glyphs in glasses frames, built from code points so this file stays ASCII.
const MIDDOT = String.fromCharCode(0xb7)
const TIMES = String.fromCharCode(0xd7)
const DOT = ` ${MIDDOT} `
const PREFS_KEY = 'sr:prefs:v1'
const PROGRESS_KEY = 'sr:progress:v1'
const BRIDGE_PREFIX = 'ci-bridge:'
const MENU_NAMES = ['Home', 'Save for later', 'Next post', 'Restart post', 'Refresh']
const ALPHA = 'alpha.substack.com'
const ALPHA_TITLES = ['First synthetic essay', 'Second synthetic essay', 'Members only preview']
const FEED_BODY_MARKER = 'rssci-body'

// ---------------------------------------------------------------------------
// Build (Vite JS API) and serve

const workDir = await mkdtemp(path.join(tmpdir(), 'substack-reader-ui-'))
const { build } = await import('vite')

async function buildApp(name, relayOrigin) {
  const outDir = path.join(workDir, name)
  process.env.VITE_RELAY_ORIGIN = relayOrigin
  process.env.VITE_ENABLE_RSS2JSON_FALLBACK = ''
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    mode: 'production',
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  })
  const info = JSON.parse(await readFile(path.join(outDir, 'build-info.json'), 'utf8'))
  assert.equal(info.relayOrigin, relayOrigin, `The ${name} build must embed relay origin ${JSON.stringify(relayOrigin)}.`)
  return outDir
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

async function serve(dir) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      const file = path.resolve(dir, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!file.startsWith(`${dir}${path.sep}`)) {
        response.writeHead(404).end()
        return
      }
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

// ---------------------------------------------------------------------------
// Synthetic relay (protocol 1 envelopes)

/** Numbered tokens instead of prose: unique, so page offsets can be checked exactly. */
function bodyHtml(post) {
  let token = 0
  const paragraphs = []
  for (let p = 0; p < post.paragraphs; p += 1) {
    const words = []
    for (let w = 0; w < 30; w += 1) {
      token += 1
      words.push(`t${String(token).padStart(4, '0')}`)
    }
    paragraphs.push(`<p>${words.join(' ')}</p>`)
  }
  return paragraphs.join('\n')
}

/** RSS carries recent summaries and inert HTML strings, including a paid-preview tail. */
function feedXml(host, posts = fixtures.posts.filter(post => post.host === host).slice(0, fixtures.archivePageCap)) {
  const xml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const pub = fixtures.publications[host]
  const items = posts.map(post => {
    const link = `https://${host}/p/${post.slug}`
    const body = `<p data-rss-ci-payload="body">${FEED_BODY_MARKER}</p><script data-rss-ci-payload="script">window.__rssCiExecuted = true</script>`
      + bodyHtml(post) + (post.audience === 'everyone' ? '' : `<p><a href="${link}">Read more</a></p>`)
    return `<item><title>${xml(post.title)}</title><link>${xml(link)}</link><pubDate>${xml(post.postDate)}</pubDate>`
      + `<description>${xml(post.subtitle)}</description><dc:creator>${xml(post.authors.join(', '))}</dc:creator>`
      + `<content:encoded><![CDATA[${body}]]></content:encoded></item>`
  }).join('')
  return `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">`
    + `<channel><title>${xml(pub.name)} RSS</title>${items}</channel></rss>`
}

function summary(post) {
  const pub = fixtures.publications[post.host]
  return {
    id: post.id,
    publicationId: pub.id,
    slug: post.slug,
    title: post.title,
    subtitle: post.subtitle,
    postDate: post.postDate,
    audience: post.audience,
    isPaywalled: post.audience !== 'everyone',
    type: post.type,
    wordcount: post.wordcount,
    canonicalUrl: `https://${post.host}/p/${post.slug}`,
    authors: post.authors,
    podcastDurationSec: null,
  }
}

function ok(data, host) {
  return { ok: true, meta: { host, cached: false, fetchedAt: new Date().toISOString() }, data }
}

function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } }
}

function relayReply(url, request) {
  const q = url.searchParams
  switch (url.pathname) {
    case '/v1/health':
      return [200, ok({
        service: 'substack-reader-relay',
        protocol: 1,
        revision: 'ci',
        origin: request.headers().origin ?? null,
        probes: [
          { target: 'subdomain', status: 200, contentType: 'application/json', challenge: false, ms: 21 },
          { target: 'customDomain', status: 200, contentType: 'application/json', challenge: false, ms: 34 },
          { target: 'substackCom', status: 403, contentType: 'text/html', challenge: true, ms: 18 },
        ],
      }, 'relay.ci.invalid')]
    case '/v1/archive': {
      const host = q.get('host') ?? ''
      if (fixtures.notSubstackHosts.includes(host)) return [403, failure('HOST_NOT_SUBSTACK', 'That site is not a Substack publication.')]
      const pub = fixtures.publications[host]
      if (!pub) return [404, failure('PUBLICATION_NOT_FOUND', 'No Substack publication at that address.')]
      const offset = Number(q.get('offset'))
      const limit = Number(q.get('limit'))
      assert.ok(Number.isInteger(offset) && offset >= 0 && offset <= 5000, `archive offset ${q.get('offset')}`)
      assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 20, `archive limit ${q.get('limit')}`)
      // Substack returns fewer posts than requested (C1); only an empty page ends the list.
      const posts = fixtures.posts.filter(post => post.host === host)
        .slice(offset, offset + Math.min(limit, fixtures.archivePageCap)).map(summary)
      return [200, ok({ publication: pub, posts, nextOffset: posts.length ? offset + posts.length : null }, host)]
    }
    case '/v1/post': {
      if (fixtures.notSubstackHosts.includes(q.get('host') ?? '')) return [403, failure('HOST_NOT_SUBSTACK', 'That site is not a Substack publication.')]
      const post = q.has('id')
        ? fixtures.posts.find(item => String(item.id) === q.get('id'))
        : fixtures.posts.find(item => item.host === q.get('host') && item.slug === q.get('slug'))
      if (!post) return [404, failure('POST_NOT_FOUND', 'That post was not found.')]
      return [200, ok({
        post: { ...summary(post), bodyHtml: bodyHtml(post), truncated: post.audience !== 'everyone' },
        publication: fixtures.publications[post.host],
      }, post.host)]
    }
    case '/v1/feed': {
      const host = q.get('host') ?? ''
      if (!fixtures.publications[host]) return [404, failure('PUBLICATION_NOT_FOUND', 'No feed at that address.')]
      return [200, feedXml(host), 'application/rss+xml; charset=utf-8']
    }
    case '/v1/profile': {
      const profile = fixtures.profiles[q.get('handle') ?? '']
      if (!profile) return [404, failure('PROFILE_NOT_FOUND', 'No Substack profile with that handle.')]
      return [200, ok({
        handle: profile.handle,
        name: profile.name,
        primaryPublication: fixtures.publications[profile.primary] ?? null,
        subscriptions: profile.subscriptions.map(host => fixtures.publications[host]),
      }, 'substack.com')]
    }
    case '/v1/search': {
      const hosts = fixtures.searches[(q.get('q') ?? '').toLowerCase()] ?? []
      return [200, ok({ results: hosts.map(host => fixtures.publications[host]) }, 'substack.com')]
    }
    default:
      return [404, failure('NOT_FOUND', 'Unknown route.')]
  }
}

const CORS_JSON = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

// ---------------------------------------------------------------------------
// Bridge stub (runs in the page before the app)

function installBridge({ seed, bridgeOnly, failReads }) {
  const BRIDGE = 'ci-bridge:'
  window.__g2Pages = []
  window.__g2State = {}
  window.__g2Writes = []
  window.__g2Shutdown = []
  window.__g2Event = null
  window.__g2Device = null
  window.__g2Launch = null
  window.__g2LastWrite = -Infinity
  window.__g2LastSent = {}
  window.__rssCiInserted = false
  // Catch transient adoption too: a later redraw must not hide unsafe feed HTML insertion.
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('[data-rss-ci-payload]') || node.querySelector('[data-rss-ci-payload]'))) {
          window.__rssCiInserted = true
        }
      }
    }
  }).observe(document, { childList: true, subtree: true })
  // failReads: the first N bridge storage reads fail (the Even app did not answer).
  window.__g2FailReads = failReads
  window.__g2FailedReads = 0
  window.__g2FirstRunAfter = null
  // Keep the SDK's classes real; replace only the native host boundary.
  const host = {
    _ready: true,
    ready: true,
    async createStartUpPageContainer(page) {
      const copy = JSON.parse(JSON.stringify(page))
      window.__g2Pages.push(copy)
      for (const item of copy.textObject || []) window.__g2State[item.containerName] = item.content
      window.__g2LastWrite = performance.now()
      return 0
    },
    async textContainerUpgrade(update) {
      window.__g2State[update.containerName] = update.content
      window.__g2Writes.push({ name: update.containerName, content: update.content })
      window.__g2LastWrite = performance.now()
      return true
    },
    onEvenHubEvent(callback) {
      window.__g2Event = callback
      return () => { if (window.__g2Event === callback) window.__g2Event = null }
    },
    onDeviceStatusChanged(callback) {
      // Scenarios call it with { connectType: 'disconnected' | 'connected' | ... } (DeviceConnectType values).
      window.__g2Device = callback
      return () => { if (window.__g2Device === callback) window.__g2Device = null }
    },
    onLaunchSource(callback) {
      window.__g2Launch = callback
      return () => { if (window.__g2Launch === callback) window.__g2Launch = null }
    },
    async getLocalStorage(key) {
      if (window.__g2FailReads > 0) {
        window.__g2FailReads -= 1
        window.__g2FailedReads += 1
        throw new Error('ci: bridge storage read failed')
      }
      return sessionStorage.getItem(BRIDGE + key) ?? ''
    },
    async setLocalStorage(key, value) {
      sessionStorage.setItem(BRIDGE + key, String(value))
      return true
    },
    async shutDownPageContainer(mode) {
      window.__g2Shutdown.push(mode)
      return true
    },
  }
  Object.defineProperty(window, 'EvenAppBridge', { configurable: true, get: () => host, set() {} })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { async writeText() { throw new DOMException('Clipboard denied by fixture', 'NotAllowedError') } },
  })
  // Seed once per tab, so a reload really tests persistence (bridge copy lives in sessionStorage).
  // bridgeOnly: the WebView lost its localStorage copy; only bridge storage has the library.
  if (seed && !sessionStorage.getItem('ci-seeded')) {
    for (const [key, value] of Object.entries(seed)) {
      if (!bridgeOnly) localStorage.setItem(key, value)
      sessionStorage.setItem(BRIDGE + key, value)
    }
  }
  sessionStorage.setItem('ci-seeded', '1')
  // How many bridge reads had failed when the phone first showed an empty library ("Get started").
  if (failReads > 0) {
    new MutationObserver(() => {
      if (window.__g2FirstRunAfter === null && document.querySelector('#app')?.textContent?.includes('Get started')) {
        window.__g2FirstRunAfter = window.__g2FailedReads
      }
    }).observe(document, { childList: true, subtree: true })
  }
  /**
   * Deliver one glasses event, spaced like a human would: the app's gesture
   * filter drops same-direction scrolls within 300 ms, scrolls within 80 ms of
   * a display write, taps within 220 ms and back/hold within 600 ms.
   */
  window.__g2Send = async (event, kind) => {
    const gaps = { scroll: 360, select: 280, back: 700, menu: 700 }
    for (;;) {
      const now = performance.now()
      let wait = (window.__g2LastSent[kind] ?? -Infinity) + (gaps[kind] ?? 0) - now
      if (kind === 'scroll') wait = Math.max(wait, window.__g2LastWrite + 150 - now)
      if (!(wait > 0)) break
      await new Promise(resolve => setTimeout(resolve, wait))
    }
    if (typeof window.__g2Event !== 'function') throw new Error('The app has no glasses event listener.')
    window.__g2LastSent[kind] = performance.now()
    window.__g2Event(event)
  }
}

// ---------------------------------------------------------------------------
// Scenario harness

let browser
let expect
let configured
let unconfigured
let passed = 0
const failures = []
const failureDetails = []

async function openPhone(options = {}) {
  const origin = options.unconfigured ? unconfigured.origin : configured.origin
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const fixture = { context, page: null, origin, unexpected: [], pageErrors: [], relayRequests: [], override: options.override ?? null }
  await context.addInitScript(installBridge, { seed: options.seed ?? null, bridgeOnly: options.bridgeOnly === true, failReads: options.failReads ?? 0 })
  await context.route('**/*', async route => {
    const request = route.request()
    let url
    try {
      url = new URL(request.url())
    } catch {
      fixture.unexpected.push(`unparsable ${request.url()}`)
      await route.abort('blockedbyclient')
      return
    }
    if (url.origin === origin) {
      await route.continue()
      return
    }
    if (url.origin !== RELAY || options.unconfigured) {
      fixture.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    try {
      assert.equal(request.method(), 'GET', 'The relay is GET only.')
      const headers = request.headers()
      assert.equal(headers.cookie, undefined, 'Relay requests must not carry cookies.')
      assert.equal(headers.authorization, undefined, 'Relay requests must not carry credentials.')
      fixture.relayRequests.push(`${url.pathname}${url.search}`)
      const [status, body, contentType = CORS_JSON['Content-Type']] = fixture.override?.(url) ?? relayReply(url, request)
      await route.fulfill({ status, headers: { ...CORS_JSON, 'Content-Type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    } catch (error) {
      fixture.unexpected.push(`relay fixture: ${error instanceof Error ? error.message : String(error)}`)
      await route.fulfill({ status: 500, headers: CORS_JSON, body: JSON.stringify(failure('INTERNAL_ERROR', 'Fixture failure.')) })
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => fixture.pageErrors.push(error.stack || error.message))
  fixture.page = page
  await page.goto(origin, { waitUntil: 'load' })
  // waitReady: false lets a scenario act before the glasses phase (it then calls ready() itself).
  if (options.waitReady !== false) await ready(page, options.readyTimeout)
  return fixture
}

/** The app connected to the stub bridge, attached bridge storage and drew its first frame. */
async function ready(page, timeout = 15_000) {
  await expect(page.locator('#app[data-phase="glasses"]')).toHaveCount(1, { timeout })
}

async function verifyInvariants(fixture) {
  const { page } = fixture
  assert.deepEqual(fixture.unexpected, [], 'Every external request must be relay fixture traffic.')
  assert.deepEqual(fixture.pageErrors, [], 'The app must not throw uncaught errors.')
  assert.equal(new URL(page.url()).origin, fixture.origin, 'The user must stay in the plugin.')
  assert.equal(fixture.context.pages().length, 1, 'No action may open another tab.')
  await expect(page.locator('[data-rss-ci-payload]')).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.__rssCiInserted), false, 'Feed nodes never enter the live phone DOM, even briefly.')
  assert.equal(await page.evaluate(() => window.__rssCiExecuted === true), false, 'Feed scripts never execute in the phone.')
  const pages = await page.evaluate(() => window.__g2Pages)
  assert.equal(pages.length, 1, 'createStartUpPageContainer runs exactly once per load (never rebuilt).')
  const boxes = pages[0].textObject ?? []
  assert.equal(boxes.length, 3)
  assert.equal(boxes.filter(box => box.isEventCapture === 1).length, 1, 'Exactly one container captures input.')
  for (const box of boxes) {
    assert.ok(box.xPosition >= 0 && box.xPosition + box.width <= 576, `${box.containerName} fits horizontally`)
    assert.ok(box.yPosition >= 0 && box.yPosition + box.height <= 288, `${box.containerName} fits vertically`)
  }
  for (const key of [PREFS_KEY, PROGRESS_KEY]) {
    const stored = await page.evaluate(([k, prefix]) => [localStorage.getItem(k) ?? '', sessionStorage.getItem(prefix + k) ?? ''], [key, BRIDGE_PREFIX])
    for (const value of stored) {
      assert.ok(!/t0\d{3}/.test(value), `${key} must never contain article text.`)
      assert.ok(!value.includes(FEED_BODY_MARKER) && !value.includes('data-rss-ci-payload') && !value.includes('bodyHtml'), `${key} must never contain feed HTML or body text.`)
      assert.ok(value.length < 48_000, `${key} stays below 48k characters.`)
    }
  }
}

async function scenario(name, options, run) {
  let fixture = null
  try {
    fixture = await openPhone(options)
    await run(fixture)
    await verifyInvariants(fixture)
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    const detail = [`FAIL ${name}`, String(error instanceof Error ? error.stack : error)]
    if (fixture) {
      detail.push(`unexpected: ${JSON.stringify(fixture.unexpected)}`)
      detail.push(`page errors: ${JSON.stringify(fixture.pageErrors)}`)
      detail.push(`relay requests: ${JSON.stringify(fixture.relayRequests)}`)
      try {
        detail.push(`glasses: ${JSON.stringify(await fixture.page.evaluate(() => window.__g2State))}`)
      } catch { /* The page may be gone. */ }
    }
    console.log(detail.join('\n').replace(/^/gm, '    ').trimStart())
    failureDetails.push(detail.join('\n'))
  } finally {
    await fixture?.context.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Helpers

const EVENTS = {
  select: [{ textEvent: { eventType: 0 } }, 'select'],
  tap: [{ sysEvent: { eventSource: 1 } }, 'select'], // CLICK with the type omitted on the wire
  next: [{ textEvent: { eventType: 2 } }, 'scroll'],
  previous: [{ textEvent: { eventType: 1 } }, 'scroll'],
  back: [{ textEvent: { eventType: 3 } }, 'back'],
  hold: [{ sysEvent: { eventType: 9 } }, 'back'],
}

async function g2(page, name) {
  const [event, kind] = EVENTS[name]
  await page.evaluate(([e, k]) => window.__g2Send(e, k), [event, kind])
}

const g2Field = (page, field) => page.evaluate(name => window.__g2State[name] ?? '', field)

async function expectBody(page, text) {
  await expect.poll(() => g2Field(page, 'body'), { message: `glasses body contains ${JSON.stringify(text)}` }).toContain(text)
}

async function expectFooter(page, pattern) {
  await expect.poll(() => g2Field(page, 'footer'), { message: `glasses footer matches ${pattern}` }).toMatch(pattern)
}

function pageNumbers(footer) {
  const match = /^(\d+)\/(\d+)/.exec(footer)
  assert.ok(match, `reader footer ${JSON.stringify(footer)}`)
  return { page: Number(match[1]), total: Number(match[2]) }
}

function tokens(text) {
  return [...text.matchAll(/t(\d{4})/g)].map(match => Number(match[1]))
}

/** A reader page footer (`3/41 . 29% . ~9 min left`), never a list footer (`1/4 . Tap read`). */
const readerFooter = page => new RegExp(`^${page}/\\d+${DOT}\\d+%`)

async function expectField(page, field, value) {
  await expect.poll(() => g2Field(page, field), { message: `glasses ${field} is ${JSON.stringify(value)}` }).toBe(value)
}

/** Home -> Publications -> Alpha Notes posts list (Alpha must be the only publication). */
async function openAlphaList(page) {
  await expectBody(page, '> Latest')
  await g2(page, 'next')
  await expectBody(page, '> Publications (1)')
  await g2(page, 'select')
  await expectBody(page, '> Alpha Notes')
  await g2(page, 'select')
  await expectBody(page, `> ${ALPHA_TITLES[0]}`)
}

async function openAlphaPost(page, index) {
  await openAlphaList(page)
  for (let i = 1; i <= index; i += 1) {
    await g2(page, 'next')
    await expectBody(page, `> ${ALPHA_TITLES[i]}`)
  }
  await g2(page, 'select')
  await expectFooter(page, readerFooter(1))
}

function prefsSeed({ publications, saved = [], settings = {} }) {
  return JSON.stringify({ schemaVersion: 1, savedAt: 1000, publications, saved, settings })
}

const ALPHA_PUB = { id: 1001, name: 'Alpha Notes', host: ALPHA, addedAt: 1, inLatest: true }
const SEED_ALPHA = { [PREFS_KEY]: prefsSeed({ publications: [ALPHA_PUB] }) }

const storedDoc = (page, key) => page.evaluate(([k, prefix]) => ({
  local: JSON.parse(localStorage.getItem(k) || 'null'),
  bridge: JSON.parse(sessionStorage.getItem(prefix + k) || 'null'),
}), [key, BRIDGE_PREFIX])

const rowValues = (page, selector, attribute) => page.locator(selector).evaluateAll((rows, name) => rows.map(row => row.getAttribute(name)), attribute)

async function openTab(page, panel) {
  await page.locator(`.tabs [data-panel="${panel}"]`).click()
  await expect(page.locator(`[data-testid="panel-${panel}"]`)).toHaveCount(1)
}

async function addInput(page, text) {
  await openTab(page, 'publications')
  await page.locator('#add-input').fill(text)
  await page.locator('[data-testid="add-submit"]').click()
  await expect(page.locator('[data-testid="add-result"][data-kind="pending"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="busy"]')).toHaveCount(0)
}

// ---------------------------------------------------------------------------
// Scenarios

try {
  const playwright = await import('@playwright/test')
  expect = playwright.expect
  configured = await serve(await buildApp('configured', RELAY))
  unconfigured = await serve(await buildApp('unconfigured', ''))
  browser = await playwright.chromium.launch({ headless: true })

  await scenario('1 first run shows the setup frame; root double-tap opens the exit dialog', {}, async ({ page, relayRequests }) => {
    const [created] = await page.evaluate(() => window.__g2Pages)
    const text = Object.fromEntries(created.textObject.map(box => [box.containerName, box.content]))
    assert.equal(text.title, 'Reader for Substack')
    assert.ok(text.body.startsWith('No publications yet.'), 'The initial page is the setup frame (no black screen).')
    assert.equal(text.footer, `2${TIMES}tap exit`)
    assert.deepEqual((created.menuObject?.menuItems ?? []).map(item => item.itemName), MENU_NAMES)
    assert.deepEqual((created.menuObject?.menuItems ?? []).map(item => item.itemID), [1, 2, 3, 4, 5])
    await expectBody(page, 'No publications yet.')
    await expect(page.locator('[data-testid="glasses-status"]')).toHaveAttribute('data-state', 'ready')
    await expect(page.locator('[data-testid="mirror-body"]')).toContainText('No publications yet.')
    await expect(page.locator('[data-testid="relay-missing"]')).toHaveCount(0)
    await expect(page.locator('a[href], [target]')).toHaveCount(0)
    await g2(page, 'back')
    await expect.poll(() => page.evaluate(() => window.__g2Shutdown)).toEqual([1])
    assert.deepEqual(relayRequests, [], 'First run makes no requests.')
  })

  await scenario('2 add by URL and apex custom domain (www retry); survives reload and lands in bridge storage', {}, async ({ page, relayRequests }) => {
    await addInput(page, `https://${ALPHA}/\ngammaletters-ci.com`)
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA, 'www.gammaletters-ci.com'])
    // A full archive page, so the relay can name the publication from post bylines.
    assert.deepEqual(relayRequests, [
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`,
      '/v1/archive?host=gammaletters-ci.com&offset=0&limit=12&sort=new',
      '/v1/archive?host=www.gammaletters-ci.com&offset=0&limit=12&sort=new',
    ])
    await expect(page.locator('[data-testid="add-result"][data-kind="message"]')).toHaveCount(2)
    await expectBody(page, 'Publications (2)')
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).bridge?.publications?.map(pub => pub.host))
      .toEqual([ALPHA, 'www.gammaletters-ci.com'])
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await openTab(page, 'publications')
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA, 'www.gammaletters-ci.com'])
    await expectBody(page, 'Publications (2)')
    assert.equal(relayRequests.length, 3, 'Reload must not re-validate publications.')
  })

  await scenario('2b rate-limited API: RSS follows a URL, browses recent summaries, saves and reads after reload', {
    override: url => ['/v1/archive', '/v1/post'].includes(url.pathname)
      ? [429, failure('UPSTREAM_RATE_LIMITED', 'Substack is temporarily rate limited.', { retryAfterSeconds: 41 })]
      : null,
  }, async ({ page, relayRequests }) => {
    await addInput(page, `https://${ALPHA}/`)
    await expect(page.locator('[data-testid="add-result"][data-kind="message"]')).toContainText('Following Alpha Notes RSS')
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
    await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
    await expect(page.locator('[data-post-row]')).toHaveCount(3)
    await expect(page.locator('[data-testid="busy"]')).toHaveCount(0)
    assert.deepEqual(await page.locator('[data-post-row] strong').allTextContents(), ALPHA_TITLES)
    await expect(page.locator('[data-testid="browse-more"]')).toHaveCount(0)
    await expect(page.locator('#app')).not.toContainText(FEED_BODY_MARKER)
    await expect(page.locator('[data-rss-ci-payload]')).toHaveCount(0)
    await page.locator('[data-post-row] [data-action="toggle-save"]').first().click()
    await expect(page.locator('[data-post-row] [data-action="toggle-save"]').first()).toHaveAttribute('aria-pressed', 'true')
    for (const copy of ['local', 'bridge']) {
      await expect.poll(async () => (await storedDoc(page, PREFS_KEY))[copy]?.saved?.map(ref => ref.slug)).toEqual(['first-synthetic-essay'])
      const prefs = (await storedDoc(page, PREFS_KEY))[copy]
      assert.ok(prefs.saved[0].postId < 0, 'RSS saves its stable synthetic id with a host and slug.')
      assert.equal(prefs.saved[0].host, ALPHA)
      assert.equal(prefs.publications[0].name, 'Alpha Notes RSS')
      assert.ok(!JSON.stringify(prefs).includes(FEED_BODY_MARKER), 'Saving keeps references, never feed bodies.')
    }
    const initialRequests = [
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, `/v1/feed?host=${ALPHA}`,
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, `/v1/feed?host=${ALPHA}`,
    ]
    assert.deepEqual(relayRequests, initialRequests)
    assert.equal(await page.evaluate(() => window.__rssCiInserted), false, 'Add and Browse never adopt feed HTML.')
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await openTab(page, 'saved')
    assert.deepEqual(await rowValues(page, '[data-saved-row]', 'data-saved-row'), [`${ALPHA}/first-synthetic-essay`])
    assert.deepEqual(relayRequests, initialRequests, 'Reload does not eagerly fetch bodies.')
    await g2(page, 'next')
    await g2(page, 'next')
    await expectBody(page, '> Saved (1)')
    await g2(page, 'select')
    await expectBody(page, `> ${ALPHA_TITLES[0]}`)
    await g2(page, 'select')
    await expectFooter(page, readerFooter(1))
    await expect(page.locator('[data-testid="now-reading"]')).toContainText(ALPHA_TITLES[0])
    await g2(page, 'next')
    await expectFooter(page, readerFooter(2))
    await g2(page, 'next')
    await expectFooter(page, readerFooter(3))
    const shown = await page.evaluate(() => window.__g2Writes.filter(write => write.name === 'body').map(write => write.content).join('\n'))
    assert.ok(shown.includes(FEED_BODY_MARKER), 'The cold Saved reference reads actual RSS body text on the glasses.')
    assert.match(shown, /t0\d{3}/)
    assert.deepEqual(relayRequests, [...initialRequests, `/v1/post?host=${ALPHA}&slug=first-synthetic-essay`, `/v1/feed?host=${ALPHA}`])
    await expect.poll(async () => (await storedDoc(page, PROGRESS_KEY)).bridge?.history?.map(ref => ref.slug)).toEqual(['first-synthetic-essay'])
  })

  const twentyFeedPosts = Array.from({ length: 20 }, (_, index) => ({
    ...fixtures.posts[0],
    id: 8001 + index,
    slug: `rss-item-${index + 1}`,
    title: `RSS item ${String(index + 1).padStart(2, '0')}`,
    subtitle: null,
    paragraphs: 4,
  }))
  await scenario('2b2 a 20-item RSS feed remains browsable, saveable and readable beyond the first four posts', {
    seed: SEED_ALPHA,
    override: url => ['/v1/archive', '/v1/post'].includes(url.pathname)
      ? [503, failure('UPSTREAM_RATE_LIMITED', 'Substack API is temporarily rate limited.')]
      : url.pathname === '/v1/feed' ? [200, feedXml(ALPHA, twentyFeedPosts), 'application/rss+xml; charset=utf-8'] : null,
  }, async ({ page, relayRequests }) => {
    await openTab(page, 'publications')
    await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
    await expect(page.locator('[data-post-row]')).toHaveCount(20)
    assert.deepEqual(await page.locator('[data-post-row] strong').allTextContents(), twentyFeedPosts.map(post => post.title))
    for (const index of [4, 19]) {
      const row = page.locator('[data-post-row]').nth(index)
      await expect(row).toContainText(twentyFeedPosts[index].title)
      await row.locator('[data-action="toggle-save"]').click()
      await expect(row.locator('[data-action="toggle-save"]')).toHaveAttribute('aria-pressed', 'true')
    }
    for (const copy of ['local', 'bridge']) {
      await expect.poll(async () => (await storedDoc(page, PREFS_KEY))[copy]?.saved?.map(ref => ref.slug))
        .toEqual(['rss-item-5', 'rss-item-20'])
    }
    await openTab(page, 'saved')
    assert.deepEqual(await rowValues(page, '[data-saved-row]', 'data-saved-row'), [`${ALPHA}/rss-item-5`, `${ALPHA}/rss-item-20`])
    await expectBody(page, '> Latest')
    await g2(page, 'next')
    await expectBody(page, '> Publications (1)')
    await g2(page, 'select')
    await expectBody(page, '> Alpha Notes')
    await g2(page, 'select')
    for (let index = 0; index < twentyFeedPosts.length; index += 1) {
      if (index > 0) await g2(page, 'next')
      await expectBody(page, `> ${twentyFeedPosts[index].title}`)
      await expectFooter(page, new RegExp(`^${index + 1}/\\d+${DOT}Tap read`))
      if (index !== 4 && index !== 19) continue
      await g2(page, 'select')
      await expectFooter(page, readerFooter(1))
      await expect(page.locator('[data-testid="now-reading"]')).toContainText(twentyFeedPosts[index].title)
      await g2(page, 'next')
      await expectFooter(page, readerFooter(2))
      assert.match(await g2Field(page, 'body'), /t0\d{3}/, 'The selected later RSS item contains readable article text.')
      await g2(page, 'back')
      await expectBody(page, `> ${twentyFeedPosts[index].title}`)
    }
    assert.deepEqual(relayRequests, [
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, `/v1/feed?host=${ALPHA}`,
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, `/v1/feed?host=${ALPHA}`,
    ], 'Scrolling through all 20 RSS items and reading later items uses their in-memory bodies.')
  })

  const sitemapPosts = twentyFeedPosts.slice(0, 8).map((post, index) => ({
    ...post, id: 9001 + index, slug: `catalog-item-${index + 1}`, title: `Catalog item ${String(index + 1).padStart(2, '0')}`,
  }))
  await scenario('2b3 sitemap pages load beyond four posts on phone and glasses and keep the cursor source', {
    seed: SEED_ALPHA,
    override: url => {
      if (url.pathname === '/v1/archive') {
        const offset = Number(url.searchParams.get('offset'))
        if (offset > 0 && url.searchParams.get('source') !== 'sitemap') {
          return [503, failure('UPSTREAM_INVALID', 'An older sitemap page must retain its source.')]
        }
        const posts = sitemapPosts.slice(offset, offset + 4).map(summary)
        return [200, ok({ publication: fixtures.publications[ALPHA], posts, nextOffset: offset + posts.length < sitemapPosts.length ? offset + posts.length : null, source: 'sitemap' }, ALPHA)]
      }
      if (url.pathname === '/v1/post') {
        const post = sitemapPosts.find(item => item.slug === url.searchParams.get('slug'))
        if (post) return [200, ok({ post: { ...summary(post), bodyHtml: bodyHtml(post), truncated: false }, publication: fixtures.publications[ALPHA] }, ALPHA)]
      }
      return null
    },
  }, async ({ page, relayRequests }) => {
    await openTab(page, 'publications')
    await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
    await expect(page.locator('[data-post-row]')).toHaveCount(4)
    await page.locator('[data-testid="browse-more"]').click()
    await expect(page.locator('[data-post-row]')).toHaveCount(8)
    assert.deepEqual(await page.locator('[data-post-row] strong').allTextContents(), sitemapPosts.map(post => post.title))
    await expect(page.locator('[data-testid="browse-more"]')).toHaveCount(0)
    await page.locator('[data-post-row]').nth(4).locator('[data-action="toggle-save"]').click()
    for (const copy of ['local', 'bridge']) {
      await expect.poll(async () => (await storedDoc(page, PREFS_KEY))[copy]?.saved?.map(ref => ref.postId)).toEqual([9005])
      const prefs = (await storedDoc(page, PREFS_KEY))[copy]
      assert.equal(prefs.saved[0].slug, 'catalog-item-5')
      assert.equal(JSON.stringify(prefs).includes('sitemap'), false, 'The archive cursor source is never stored in library metadata.')
    }
    await openTab(page, 'publications')
    await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
    await expect(page.locator('[data-post-row]')).toHaveCount(4)
    assert.equal(relayRequests[2], `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, 'Reopening Browse lets the relay choose the source again.')

    await expectBody(page, '> Latest')
    await g2(page, 'next')
    await g2(page, 'select')
    await expectBody(page, '> Alpha Notes')
    await g2(page, 'select')
    await expectBody(page, '> Catalog item 01')
    for (let index = 0; index < 4; index += 1) await g2(page, 'next')
    await expectFooter(page, new RegExp(`^5/5${DOT}Tap load`))
    await g2(page, 'select')
    await expectBody(page, '> Catalog item 05')
    await expectFooter(page, new RegExp(`^5/8${DOT}Tap read`))
    await g2(page, 'select')
    await expectFooter(page, readerFooter(1))
    await expect(page.locator('[data-testid="now-reading"]')).toContainText('Catalog item 05')
    await g2(page, 'next')
    await expectFooter(page, readerFooter(2))
    assert.match(await g2Field(page, 'body'), /t0\d{3}/)
    assert.deepEqual(relayRequests, [
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`,
      `/v1/archive?host=${ALPHA}&offset=4&limit=12&sort=new&source=sitemap`,
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`,
      `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`,
      `/v1/archive?host=${ALPHA}&offset=4&limit=12&sort=new&source=sitemap`,
      `/v1/post?host=${ALPHA}&slug=catalog-item-5`,
    ])
  })

  for (const feedFailure of ['request', 'malformed']) {
    await scenario(`2c ${feedFailure} feed failure preserves the archive error for add and Browse`, {
      seed: SEED_ALPHA,
      override: url => url.pathname === '/v1/archive'
        ? [429, failure('UPSTREAM_RATE_LIMITED', 'Original archive throttling.', { retryAfterSeconds: 41, upstream: { status: 429, contentType: 'text/html', challenge: false } })]
        : url.pathname === '/v1/feed'
          ? feedFailure === 'request' ? [503, failure('UPSTREAM_UNAVAILABLE', 'Different feed failure.')]
            : [200, '<rss><channel>', 'application/rss+xml; charset=utf-8']
          : null,
    }, async ({ page, relayRequests }) => {
      await addInput(page, `https://${ALPHA}/`)
      const result = page.locator('[data-testid="add-result"][data-kind="error"]')
      await expect(result).toContainText('UPSTREAM_RATE_LIMITED')
      await expect(result).toContainText('Original archive throttling.')
      await expect(result).toContainText('HTTP 429')
      await expect(result).toContainText('Try again in 41 s.')
      await expect(result).not.toContainText('Different feed failure.')
      assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
      await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
      const alert = page.locator('[data-testid="phone-alert"]')
      await expect(alert).toContainText('UPSTREAM_RATE_LIMITED')
      await expect(alert).toContainText('Original archive throttling.')
      await expect(alert).toContainText('Try again in 41 s.')
      await expect(page.locator('[data-testid="phone-retry"]')).toBeEnabled()
      await expect(page.locator('[data-post-row]')).toHaveCount(0)
      assert.deepEqual(relayRequests, [
        `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, `/v1/feed?host=${ALPHA}`,
        `/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`, `/v1/feed?host=${ALPHA}`,
      ])
    })
  }

  const rejectedArchive = { code: 'RATE_LIMITED', status: 429 }
  await scenario('2d relay limits and validation failures never trigger a feed request on add or Browse', {
    seed: SEED_ALPHA,
    override: url => url.pathname === '/v1/archive'
      ? [rejectedArchive.status, failure(rejectedArchive.code, 'Request rejected before reading Substack.')]
      : null,
  }, async ({ page, relayRequests }) => {
    for (const [code, status] of [['RATE_LIMITED', 429], ['INVALID_HOST', 400], ['HOST_NOT_SUBSTACK', 403], ['PUBLICATION_NOT_FOUND', 404]]) {
      rejectedArchive.code = code
      rejectedArchive.status = status
      await addInput(page, `https://${ALPHA}/`)
      await expect(page.locator('[data-testid="add-result"][data-kind="error"] .code')).toHaveText(code)
      await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
      await expect(page.locator('[data-testid="phone-alert"] .code')).toHaveText(code)
      await expect(page.locator('[data-post-row]')).toHaveCount(0)
    }
    assert.deepEqual(relayRequests, Array(8).fill(`/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`))
  })

  await scenario('3 import from an @handle with checkboxes', {}, async ({ page, relayRequests }) => {
    await addInput(page, '@ci_reader')
    const card = page.locator('[data-testid="add-result"][data-kind="profile"]')
    await expect(card).toContainText('CI Reader (@ci_reader)')
    assert.deepEqual(await rowValues(page, 'input[data-pick]', 'value'), [ALPHA, 'beta.substack.com', 'delta.substack.com'])
    await expect(card.locator('[data-action="follow-selected"]')).toBeDisabled()
    await card.locator('input[data-pick][value="beta.substack.com"]').check()
    await card.locator('input[data-pick][value="delta.substack.com"]').check()
    await expect(card.locator('[data-action="follow-selected"]')).toHaveText('Follow selected (2)')
    await card.locator('[data-action="follow-selected"]').click()
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), ['beta.substack.com', 'delta.substack.com'])
    await expect(page.locator(`input[data-pick][value="beta.substack.com"]`)).toBeDisabled()
    await expect(page.locator(`input[data-pick][value="${ALPHA}"]`)).not.toBeChecked()
    assert.deepEqual(relayRequests, ['/v1/profile?handle=ci_reader'])
    await expectBody(page, 'Publications (2)')
  })

  await scenario('4 search by name and Follow', {}, async ({ page, relayRequests }) => {
    await addInput(page, 'Beta Weekly')
    assert.deepEqual(await rowValues(page, '[data-search-host]', 'data-search-host'), ['beta.substack.com', 'epsilon.substack.com'])
    await page.locator('[data-search-host="beta.substack.com"] [data-action="follow"]').click()
    await expect(page.locator('[data-testid="notice"]')).toContainText('Following Beta Weekly')
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), ['beta.substack.com'])
    await expect(page.locator('[data-search-host="beta.substack.com"] button')).toBeDisabled()
    await expect(page.locator('[data-search-host="epsilon.substack.com"] [data-action="follow"]')).toBeEnabled()
    assert.deepEqual(relayRequests, ['/v1/search?q=Beta+Weekly'])
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).local?.publications?.map(pub => pub.host)).toEqual(['beta.substack.com'])
  })

  await scenario('4b post links offer Follow and Save for glasses (host/slug and post id)', {}, async ({ page, relayRequests }) => {
    await addInput(page, `https://${ALPHA}/p/second-synthetic-essay\nhttps://substack.com/home/post/p-5001`)
    const cards = page.locator('[data-testid="add-result"][data-kind="post"]')
    await expect(cards).toHaveCount(2)
    assert.deepEqual(relayRequests, [`/v1/post?host=${ALPHA}&slug=second-synthetic-essay`, '/v1/post?id=5001'])
    const second = page.locator('[data-kind="post"][data-post-id="5002"]')
    await second.locator('[data-action="save-post"]').click()
    await expect(page.locator('[data-kind="post"][data-post-id="5002"] [data-action="save-post"]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-kind="post"][data-post-id="5002"] [data-action="follow"]').click()
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
    await expect(page.locator('[data-kind="post"][data-post-id="5001"] [data-action="follow"]')).toHaveCount(0)
    await expectBody(page, 'Saved (1)')
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).bridge?.saved?.map(ref => ref.postId)).toEqual([5002])
  })

  await scenario('4c a post link on an apex custom domain is retried on www', {}, async ({ page, relayRequests }) => {
    await addInput(page, 'https://gammaletters-ci.com/p/gamma-opening-letter')
    const card = page.locator('[data-testid="add-result"][data-kind="post"][data-post-id="7001"]')
    await expect(card).toContainText('Gamma opening letter')
    assert.deepEqual(relayRequests, [
      '/v1/post?host=gammaletters-ci.com&slug=gamma-opening-letter',
      '/v1/post?host=www.gammaletters-ci.com&slug=gamma-opening-letter',
    ])
    await card.locator('[data-action="follow"]').click()
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), ['www.gammaletters-ci.com'])
  })

  await scenario('4d share text: the title next to a link is shown as skipped, never searched; the link is followed', {}, async ({ page, relayRequests }) => {
    await addInput(page, `A great essay on synthetic notes\nhttps://${ALPHA}/`)
    const cards = page.locator('[data-testid="add-result"]')
    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toHaveAttribute('data-kind', 'message')
    await expect(cards.first()).toContainText('A great essay on synthetic notes')
    await expect(cards.first()).toContainText('Text next to a link is read as share text.')
    await expect(page.locator('[data-testid="add-result"][data-kind="invalid"]')).toHaveCount(0)
    assert.deepEqual(relayRequests, [`/v1/archive?host=${ALPHA}&offset=0&limit=12&sort=new`])
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
  })

  await scenario('4e blocked post URL uses an RSS preview; numeric ids and missing feed slugs keep the original error', {
    override: url => url.pathname === '/v1/post'
      ? [503, failure('UPSTREAM_BLOCKED', 'Original post API block.')]
      : null,
  }, async ({ page, relayRequests }) => {
    await addInput(page, `https://${ALPHA}/p/members-only-preview`)
    const card = page.locator('[data-testid="add-result"][data-kind="post"]')
    await expect(card).toContainText('Members only preview')
    await expect(card).toContainText('Alpha Notes RSS')
    await expect(card).toContainText('Paid')
    await expect(page.locator('#app')).not.toContainText(FEED_BODY_MARKER)
    await expect(page.locator('[data-rss-ci-payload]')).toHaveCount(0)
    await card.locator('[data-action="save-post"]').click()
    await card.locator('[data-action="follow"]').click()
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).bridge?.saved?.map(ref => ({ slug: ref.slug, isPaywalled: ref.isPaywalled })))
      .toEqual([{ slug: 'members-only-preview', isPaywalled: true }])
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
    await addInput(page, 'https://substack.com/home/post/p-5001')
    await expect(page.locator('[data-testid="add-result"][data-kind="error"]')).toContainText('UPSTREAM_BLOCKED')
    await addInput(page, `https://${ALPHA}/p/older-synthetic-note`)
    await expect(page.locator('[data-testid="add-result"][data-kind="error"]')).toContainText('Original post API block.')
    assert.deepEqual(relayRequests, [
      `/v1/post?host=${ALPHA}&slug=members-only-preview`, `/v1/feed?host=${ALPHA}`,
      '/v1/post?id=5001',
      `/v1/post?host=${ALPHA}&slug=older-synthetic-note`, `/v1/feed?host=${ALPHA}`,
    ])
  })

  await scenario('5 full glasses navigation: reader 2/N, back keeps the selection, root double-tap exits with mode 1', { seed: SEED_ALPHA }, async ({ page }) => {
    await expectBody(page, '> Latest')
    await g2(page, 'next')
    await expectBody(page, '> Publications (1)')
    await g2(page, 'tap')
    await expectBody(page, '> Alpha Notes')
    await expectField(page, 'title', 'Publications')
    await expectField(page, 'footer', `1/1${DOT}Tap open${DOT}2${TIMES}tap back`)
    await g2(page, 'select')
    await expectBody(page, `> ${ALPHA_TITLES[0]}`)
    await expectField(page, 'title', 'Alpha Notes')
    // 3 posts on the first page (fewer than requested) plus the "Load older posts" row.
    await expectField(page, 'footer', `1/4${DOT}Tap read${DOT}2${TIMES}tap back`)
    await g2(page, 'next')
    await expectBody(page, `> ${ALPHA_TITLES[1]}`)
    await g2(page, 'select')
    await expectFooter(page, readerFooter(1))
    await expectField(page, 'title', `Alpha Notes${DOT}${ALPHA_TITLES[1]}`)
    await expectBody(page, ALPHA_TITLES[1])
    await g2(page, 'next')
    await expectFooter(page, readerFooter(2))
    const footer = await g2Field(page, 'footer')
    await expect(page.locator('[data-testid="mirror-footer"]')).toHaveText(footer)
    await expect(page.locator('[data-testid="now-reading"]')).toContainText(ALPHA_TITLES[1])
    await g2(page, 'back')
    await expectBody(page, `> ${ALPHA_TITLES[1]}`)
    await expectField(page, 'title', 'Alpha Notes')
    await expect(page.locator('[data-testid="now-reading"]')).toHaveCount(0)
    await g2(page, 'hold')
    await expectBody(page, '> Alpha Notes')
    await g2(page, 'back')
    await expectBody(page, '> Publications (1)')
    assert.deepEqual(await page.evaluate(() => window.__g2Shutdown), [])
    await g2(page, 'back')
    await expect.poll(() => page.evaluate(() => window.__g2Shutdown)).toEqual([1])
  })

  await scenario('6 read to page 3, reload, glassesMenu launch resumes at page 3', { seed: SEED_ALPHA }, async ({ page, relayRequests }) => {
    await openAlphaPost(page, 0)
    await g2(page, 'next')
    await expectFooter(page, readerFooter(2))
    await g2(page, 'next')
    await expectFooter(page, readerFooter(3))
    const body = await g2Field(page, 'body')
    const { total } = pageNumbers(await g2Field(page, 'footer'))
    await expect.poll(async () => (await storedDoc(page, PROGRESS_KEY)).bridge?.positions?.find(item => item.postId === 5001)?.page, { timeout: 10_000 }).toBe(2)
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await expectBody(page, `Continue: ${ALPHA_TITLES[0]}`)
    await expect.poll(() => page.evaluate(() => typeof window.__g2Launch)).toBe('function')
    await page.evaluate(() => window.__g2Launch('glassesMenu'))
    await expectFooter(page, new RegExp(`^3/${total}${DOT}\\d+%`))
    assert.equal(await g2Field(page, 'body'), body)
    assert.equal(relayRequests.filter(item => item.startsWith('/v1/post?')).length, 2)
    await g2(page, 'back')
    await expectBody(page, `> Continue: ${ALPHA_TITLES[0]}`)
  })

  await scenario('7 paywalled post shows the preview, then the paid end card; its tap loads the next archive page', { seed: SEED_ALPHA }, async ({ page, relayRequests }) => {
    await openAlphaPost(page, 2)
    await expectBody(page, `[Paid post${DOT}free preview only]`)
    const seen = []
    for (let i = 0; i < 12; i += 1) {
      const footer = await g2Field(page, 'footer')
      if (footer.startsWith('End')) break
      seen.push(await g2Field(page, 'body'))
      const { page: current } = pageNumbers(footer)
      await g2(page, 'next')
      await expect.poll(() => g2Field(page, 'footer')).not.toBe(footer)
      assert.ok(current < 12, 'The preview is short.')
    }
    const footer = await g2Field(page, 'footer')
    assert.match(footer, new RegExp(`^End${DOT}(\\d+)/\\1$`))
    assert.ok((await g2Field(page, 'body')).startsWith('The free preview ends here.'))
    // The note may wrap across a page boundary; compare with whitespace collapsed.
    assert.ok(seen.join(' ').replace(/\s+/g, ' ').includes('[Preview ends here. The rest of this post is for paid subscribers.]'))
    // Tap on the end card of the last loaded post: the list still has a "Load older posts" row,
    // so the next archive page is loaded and its first post opens in place of this one.
    await g2(page, 'select')
    await expectField(page, 'title', `Alpha Notes${DOT}Older synthetic note`)
    await expectFooter(page, readerFooter(1))
    assert.ok(relayRequests.includes(`/v1/archive?host=${ALPHA}&offset=3&limit=12&sort=new`), JSON.stringify(relayRequests))
    await g2(page, 'back')
    await expectBody(page, '> Older synthetic note')
  })

  const blocked = { blockPosts: true }
  await scenario('8 relay UPSTREAM_BLOCKED: glasses error frame, phone alert with Retry, then success', {
    seed: SEED_ALPHA,
    override: url => (blocked.blockPosts && ['/v1/post', '/v1/feed'].includes(url.pathname)
      ? [503, failure('UPSTREAM_BLOCKED', 'Substack refused the reader service.', { upstream: { status: 403, contentType: 'text/html', challenge: false } })]
      : null),
  }, async ({ page, relayRequests }) => {
    await openAlphaList(page)
    await g2(page, 'select')
    await expectBody(page, 'Substack refused the reader service.\nTry again later.')
    await expectFooter(page, new RegExp(`^Tap retry${DOT}2${TIMES}tap back$`))
    const alert = page.locator('[data-testid="glasses-alert"]')
    await expect(alert).toContainText('UPSTREAM_BLOCKED')
    blocked.blockPosts = false
    await page.locator('[data-testid="glasses-retry"]').click()
    await expectFooter(page, readerFooter(1))
    await expect(alert).toHaveCount(0)
    await expect(page.locator('[data-testid="now-reading"]')).toContainText(ALPHA_TITLES[0])
    assert.equal(relayRequests.filter(item => item.startsWith('/v1/post?')).length, 2)
    await page.locator('[data-panel="diagnostics"]').click()
    await expect(page.locator('[data-testid="last-error"]')).toContainText('UPSTREAM_BLOCKED')
  })

  await scenario('9 two SCROLL_BOTTOM events within 50 ms turn one page', { seed: SEED_ALPHA }, async ({ page }) => {
    await openAlphaPost(page, 0)
    const writesBefore = await page.evaluate(() => window.__g2Writes.filter(write => write.name === 'body').length)
    await page.evaluate(async () => {
      await window.__g2Send({ textEvent: { eventType: 2 } }, 'scroll')
      await new Promise(resolve => setTimeout(resolve, 20))
      window.__g2Event({ textEvent: { eventType: 2 } })
    })
    await expectFooter(page, readerFooter(2))
    await page.waitForTimeout(700)
    assert.match(await g2Field(page, 'footer'), readerFooter(2))
    assert.equal(await page.evaluate(() => window.__g2Writes.filter(write => write.name === 'body').length), writesBefore + 1)
  })

  await scenario('10 phone remote buttons drive the glasses', { seed: SEED_ALPHA }, async ({ page }) => {
    await page.locator('[data-testid="remote-toggle"]').click()
    await expect(page.locator('[data-testid="remote-back"]')).toBeDisabled()
    await page.locator('[data-testid="remote-next"]').click()
    await expectBody(page, '> Publications (1)')
    await expect(page.locator('[data-testid="mirror-body"]')).toContainText('> Publications (1)')
    await page.locator('[data-testid="remote-select"]').click()
    await expectBody(page, '> Alpha Notes')
    await page.locator('[data-testid="remote-select"]').click()
    await expectBody(page, `> ${ALPHA_TITLES[0]}`)
    await page.locator('[data-testid="remote-select"]').click()
    await expectFooter(page, readerFooter(1))
    await page.locator('[data-testid="remote-next"]').click()
    await expectFooter(page, readerFooter(2))
    await expect(page.locator('[data-testid="mirror-footer"]')).toHaveText(await g2Field(page, 'footer'))
    await page.locator('[data-testid="remote-previous"]').click()
    await expectFooter(page, readerFooter(1))
    await page.locator('[data-testid="remote-back"]').click()
    await expectBody(page, `> ${ALPHA_TITLES[0]}`)
    await page.locator('[data-testid="remote-back"]').click()
    await expectBody(page, '> Alpha Notes')
    await page.locator('[data-testid="remote-back"]').click()
    await expectBody(page, '> Publications (1)')
    await expect(page.locator('[data-testid="remote-back"]')).toBeDisabled()
    assert.deepEqual(await page.evaluate(() => window.__g2Shutdown), [], 'The phone remote never opens the exit dialog.')
  })

  await scenario('11 changing lines per page from 7 to 5 keeps the reading offset', { seed: SEED_ALPHA }, async ({ page }) => {
    await openAlphaPost(page, 0)
    await g2(page, 'next')
    await expectFooter(page, readerFooter(2))
    await g2(page, 'next')
    await expectFooter(page, readerFooter(3))
    const before = await g2Field(page, 'body')
    const { total: total7 } = pageNumbers(await g2Field(page, 'footer'))
    const first = tokens(before)[0]
    assert.ok(first > 0, 'Page 3 starts inside the numbered body text.')
    await openTab(page, 'settings')
    await page.locator('[data-action="set"][data-key="linesPerPage"][data-value="5"]').click()
    await expect(page.locator('[data-action="set"][data-key="linesPerPage"][data-value="5"]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => pageNumbers(await g2Field(page, 'footer')).total).toBeGreaterThan(total7)
    const after = await g2Field(page, 'body')
    assert.ok(tokens(after).includes(first), `The 5-line page shows the first word of the old page (t${first}).`)
    assert.ok(after.split('\n').length <= 5, 'A 5-line page has at most 5 lines.')
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).bridge?.settings?.linesPerPage).toBe(5)
  })

  await scenario('12 settings persist across reload and apply to the glasses', { seed: SEED_ALPHA }, async ({ page }) => {
    await openTab(page, 'settings')
    await page.locator('[data-action="set"][data-key="invertSwipe"]').click()
    await page.locator('[data-action="set"][data-key="footnotes"][data-value="inline"]').click()
    await page.locator('[data-action="set"][data-key="tapInReader"][data-value="none"]').click()
    await page.locator('[data-action="home-item"][data-item="history"]').click()
    await page.locator('[data-action="latest-max"][data-delta="1"]').click()
    await expect(page.locator('[data-testid="latest-max"]')).toHaveText('11')
    const expected = { invertSwipe: true, footnotes: 'inline', tapInReader: 'none', homeItems: ['latest', 'publications', 'saved', 'history'], latestMaxPublications: 11 }
    const pick = settings => settings && Object.fromEntries(Object.keys(expected).map(key => [key, settings[key]]))
    await expect.poll(async () => pick((await storedDoc(page, PREFS_KEY)).bridge?.settings)).toEqual(expected)
    await expect.poll(async () => pick((await storedDoc(page, PREFS_KEY)).local?.settings)).toEqual(expected)
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await openTab(page, 'settings')
    await expect(page.locator('[data-action="set"][data-key="invertSwipe"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-action="set"][data-key="footnotes"][data-value="inline"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-action="set"][data-key="tapInReader"][data-value="none"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="latest-max"]')).toHaveText('11')
    assert.deepEqual(await rowValues(page, '[data-home-row]:not([data-hidden])', 'data-home-row'), expected.homeItems)
    await expectBody(page, 'History')
    // Inverted: SCROLL_TOP moves the cursor down.
    await expectBody(page, '> Latest')
    await g2(page, 'previous')
    await expectBody(page, '> Publications (1)')
  })

  await scenario('12b browse an archive: Save for glasses, Copy link fallback, Load older; Saved reorder persists', { seed: SEED_ALPHA }, async ({ page, relayRequests }) => {
    await openTab(page, 'publications')
    await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
    await expect(page.locator('[data-post-row]')).toHaveCount(3)
    await page.locator('[data-testid="browse-more"]').click()
    await expect(page.locator('[data-post-row]')).toHaveCount(4)
    await page.locator('[data-testid="browse-more"]').click()
    await expect(page.locator('[data-testid="browse-more"]')).toHaveCount(0)
    await expect(page.locator('[data-post-row]')).toHaveCount(4)
    assert.deepEqual(relayRequests, [0, 3, 4].map(offset => `/v1/archive?host=${ALPHA}&offset=${offset}&limit=12&sort=new`))
    await page.locator('[data-post-row="5002"] [data-action="toggle-save"]').click()
    await expect(page.locator('[data-post-row="5002"] [data-action="toggle-save"]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-post-row="5001"] [data-action="toggle-save"]').click()
    await expect(page.locator('[data-post-row="5001"] [data-action="toggle-save"]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-post-row="5003"] [data-action="copy-link"]').click()
    await expect(page.locator('#copy-fallback')).toHaveValue(`https://${ALPHA}/p/members-only-preview`)
    await openTab(page, 'saved')
    assert.deepEqual(await rowValues(page, '[data-saved-row]', 'data-saved-row'), ['#5002', '#5001'])
    await page.locator('[data-action="saved-up"][data-key="#5001"]').click()
    assert.deepEqual(await rowValues(page, '[data-saved-row]', 'data-saved-row'), ['#5001', '#5002'])
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).bridge?.saved?.map(ref => ref.postId)).toEqual([5001, 5002])
    await expectBody(page, 'Saved (2)')
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await openTab(page, 'saved')
    assert.deepEqual(await rowValues(page, '[data-saved-row]', 'data-saved-row'), ['#5001', '#5002'])
    await g2(page, 'next')
    await g2(page, 'next')
    await expectBody(page, '> Saved (2)')
    await g2(page, 'select')
    await expectBody(page, `> ${ALPHA_TITLES[0]}`)
    await expectField(page, 'title', 'Saved')
    await openTab(page, 'settings')
    await page.locator('[data-panel="diagnostics"]').click()
    await page.locator('[data-testid="check-relay"]').click()
    await expect(page.locator('[data-testid="health"]')).toContainText('substack-reader-relay')
    await expect(page.locator('[data-testid="event-log"]')).toContainText('text:SCROLL_BOTTOM')
  })

  await scenario('12b2 blocked older archive page keeps existing rows and never substitutes recent RSS posts', {
    seed: SEED_ALPHA,
    override: url => url.pathname === '/v1/archive' && url.searchParams.get('offset') !== '0'
      ? [503, failure('UPSTREAM_UNAVAILABLE', 'Older posts are temporarily unavailable.')]
      : null,
  }, async ({ page, relayRequests }) => {
    await openTab(page, 'publications')
    await page.locator(`[data-action="browse"][data-host="${ALPHA}"]`).click()
    await expect(page.locator('[data-post-row]')).toHaveCount(3)
    await page.locator('[data-testid="browse-more"]').click()
    await expect(page.locator('[data-testid="phone-alert"]')).toContainText('UPSTREAM_UNAVAILABLE')
    assert.deepEqual(await rowValues(page, '[data-post-row]', 'data-post-row'), ['5001', '5002', '5003'])
    await expect(page.locator('[data-testid="browse-more"]')).toBeEnabled()
    assert.deepEqual(relayRequests, [0, 3].map(offset => `/v1/archive?host=${ALPHA}&offset=${offset}&limit=12&sort=new`))
  })

  await scenario('12c browser copy lost: the first glasses frame and the phone show the bridge library', { seed: SEED_ALPHA, bridgeOnly: true }, async ({ page, relayRequests }) => {
    const [created] = await page.evaluate(() => window.__g2Pages)
    const text = Object.fromEntries(created.textObject.map(box => [box.containerName, box.content]))
    assert.ok(text.body.includes('Publications (1)'), `The first frame is Home from bridge storage, not the setup frame: ${JSON.stringify(text.body)}`)
    await expectBody(page, '> Latest')
    await g2(page, 'next')
    await expectBody(page, '> Publications (1)')
    await expect(page.locator('[data-testid="library-loading"]')).toHaveCount(0)
    await openTab(page, 'publications')
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
    // The browser mirror is refreshed from the bridge; the bridge copy is not rewritten.
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).local?.publications?.map(pub => pub.host)).toEqual([ALPHA])
    assert.equal((await storedDoc(page, PREFS_KEY)).bridge?.savedAt, 1000)
    assert.deepEqual(relayRequests, [])
  })

  await scenario('12d bridge reads fail twice: the library stays loading through the retries, never shown empty', { seed: SEED_ALPHA, bridgeOnly: true, failReads: 2 }, async ({ page, relayRequests }) => {
    const [created] = await page.evaluate(() => window.__g2Pages)
    const text = Object.fromEntries(created.textObject.map(box => [box.containerName, box.content]))
    assert.ok(text.body.includes('Loading your library'), `The first frame waits for the library: ${JSON.stringify(text.body)}`)
    assert.equal(await page.evaluate(() => window.__g2FailReads), 0, 'Both failed reads were retried.')
    await expectBody(page, 'Publications (1)')
    await expect(page.locator('[data-testid="library-loading"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="notice"]')).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.__g2FirstRunAfter), null, 'The phone never showed an empty library that invites edits.')
    await openTab(page, 'publications')
    assert.deepEqual(await rowValues(page, '[data-pub-row]', 'data-pub-row'), [ALPHA])
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).local?.publications?.map(pub => pub.host)).toEqual([ALPHA])
    assert.equal((await storedDoc(page, PREFS_KEY)).bridge?.savedAt, 1000, 'The bridge copy is not rewritten.')
    assert.deepEqual(relayRequests, [])
  })

  await scenario('12e every bridge read of a round fails: a reconnect keeps the loading frame, a notice, edits go to the browser copy, a later attach merges them', {
    seed: { [PREFS_KEY]: prefsSeed({ publications: [ALPHA_PUB], settings: { invertSwipe: true } }) },
    bridgeOnly: true,
    failReads: 99,
    waitReady: false,
  }, async ({ page, relayRequests }) => {
    // The page exists (its device listener is registered) while the library is still loading.
    await expect.poll(() => page.evaluate(() => typeof window.__g2Device)).toBe('function')
    const [created] = await page.evaluate(() => window.__g2Pages)
    assert.ok(created.textObject.find(box => box.containerName === 'body').content.includes('Loading your library'))
    await expect(page.locator('[data-testid="library-loading"]')).toHaveCount(1)
    // The glasses disconnect and reconnect mid-gate: the loading frame is sent again, never the
    // controller's empty-library frame (it has not started).
    await page.evaluate(() => {
      window.__g2Device({ connectType: 'disconnected' })
      window.__g2Device({ connectType: 'connected' })
    })
    await expect.poll(() => page.evaluate(() => window.__g2Writes.some(write => write.name === 'body' && write.content.includes('Loading your library')))).toBe(true)
    assert.equal(await page.evaluate(() => window.__g2Writes.some(write => write.content.includes('No publications yet'))), false,
      'A reconnect while the library loads never draws the first-run frame.')
    await ready(page, 30_000)
    // Read at once, then after 1, 3 and 10 s (the reconnect tries at once without restarting the round):
    // only the fourth failure lifts the gate.
    await expect.poll(() => page.evaluate(() => window.__g2FirstRunAfter ?? -1)).toBeGreaterThanOrEqual(4)
    await expect(page.locator('[data-testid="notice"]')).toContainText('Could not read your library from the Even app; edits will be merged when it answers.')
    await expect(page.locator('[data-testid="library-loading"]')).toHaveCount(0)
    await expectBody(page, 'No publications yet.')
    await openTab(page, 'settings')
    await page.locator('[data-action="set"][data-key="linesPerPage"][data-value="5"]').click()
    await expect(page.locator('[data-action="set"][data-key="linesPerPage"][data-value="5"]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await storedDoc(page, PREFS_KEY)).local?.settings?.linesPerPage).toBe(5)
    assert.equal((await storedDoc(page, PREFS_KEY)).bridge?.savedAt, 1000, 'Nothing is written to the unread bridge copy.')
    // The Even app answers again; the next foreground attaches and merges field by field.
    await page.evaluate(() => {
      window.__g2FailReads = 0
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const pick = settings => settings && { linesPerPage: settings.linesPerPage, invertSwipe: settings.invertSwipe }
    await expect.poll(async () => pick((await storedDoc(page, PREFS_KEY)).bridge?.settings)).toEqual({ linesPerPage: 5, invertSwipe: true })
    assert.deepEqual((await storedDoc(page, PREFS_KEY)).bridge?.publications?.map(pub => pub.host), [ALPHA])
    await expect.poll(async () => pick((await storedDoc(page, PREFS_KEY)).local?.settings)).toEqual({ linesPerPage: 5, invertSwipe: true })
    await expectBody(page, 'Publications (1)')
    assert.deepEqual(relayRequests, [])
  })

  await scenario('13 relay not configured: phone alert, glasses message, no network requests', { unconfigured: true }, async ({ page, relayRequests }) => {
    await expect(page.locator('[data-testid="relay-missing"]')).toBeVisible()
    const [created] = await page.evaluate(() => window.__g2Pages)
    const text = Object.fromEntries(created.textObject.map(box => [box.containerName, box.content]))
    assert.equal(text.body, 'This build has no reader service.\nSee the phone for details.')
    assert.equal(await g2Field(page, 'body'), 'This build has no reader service.\nSee the phone for details.')
    await expectField(page, 'footer', `2${TIMES}tap exit`)
    // A bare domain and a handle (no line has a link, so nothing is read as share text).
    await addInput(page, `${ALPHA}\n@ci_reader`)
    await expect(page.locator('[data-testid="add-result"][data-kind="error"]')).toHaveCount(2)
    await expect(page.locator('[data-testid="add-result"][data-kind="error"]').first()).toContainText('NOT_CONFIGURED')
    await expect(page.locator('[data-pub-row]')).toHaveCount(0)
    await page.locator('[data-panel="diagnostics"]').click()
    await expect(page.locator('[data-testid="check-relay"]')).toBeDisabled()
    await page.locator('[data-panel="about"]').click()
    await expect(page.locator('[data-testid="panel-about"]')).toContainText('no reader service configured')
    assert.deepEqual(relayRequests, [])
  })

  console.log(`\nPhone UI: ${passed} passed, ${failures.length} failed. Relay and G2 were stubbed; no device or live Substack validation.`)
  for (const name of failures) console.log(`  - ${name}`)
  if (failures.length) {
    annotateFailure('Phone UI flows failed', failureDetails.join('\n\n'))
    process.exitCode = 1
  }
} finally {
  await browser?.close()
  for (const served of [configured, unconfigured]) {
    if (!served) continue
    served.server.closeAllConnections()
    await new Promise(resolve => served.server.close(resolve))
  }
  await rm(workDir, { recursive: true, force: true })
}
