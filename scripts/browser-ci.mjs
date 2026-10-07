/**
 * Remote-only browser tests (code that needs DOMParser). The project owner's
 * rule: runtime tests run in GitHub Actions, never locally.
 *
 * Each tests/browser/*.test.ts (which imports ./harness) is bundled with
 * esbuild as one IIFE and injected into about:blank in Playwright Chromium.
 * Every network route is aborted and recorded; the run fails on any failed
 * test, page error, file without tests, or ANY network attempt.
 *
 * Optional arguments filter test files by substring:
 *   node scripts/browser-ci.mjs html
 */
import { readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CI !== 'true') {
  throw new Error('These checks run only in remote CI. No local app testing is authorized.')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserDir = join(root, 'tests', 'browser')
const filters = process.argv.slice(2)
const FILE_TIMEOUT_MS = 180_000

// Keep in sync with every import.meta.env key read in src/config.ts.
const env = {
  VITE_RELAY_ORIGIN: 'https://relay.ci.invalid',
  VITE_ENABLE_RSS2JSON_FALLBACK: '',
  DEV: false,
  PROD: true,
  SSR: false,
  MODE: 'test',
  BASE_URL: './',
}
const define = Object.fromEntries(Object.entries(env).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]))

const files = (await readdir(browserDir))
  .filter(name => name.endsWith('.test.ts'))
  .filter(name => !filters.length || filters.some(filter => name.includes(filter)))
  .sort()
if (!files.length) throw new Error(`No browser test files matched in ${browserDir}.`)

const { build } = await import('esbuild')
const { chromium } = await import('@playwright/test')

async function bundle(file) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(browserDir, file)],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    define,
    loader: { '.html': 'text', '.txt': 'text', '.xml': 'text', '.json': 'json' },
    logLevel: 'warning',
  })
  return result.outputFiles[0].text
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms) }),
  ])
}

const browser = await chromium.launch()
let passed = 0
let failed = 0
const problems = []
try {
  for (const file of files) {
    const name = basename(file)
    const code = await bundle(file)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const attempts = []
    const pageErrors = []
    await context.route('**/*', route => {
      attempts.push(route.request().url())
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.stack || error.message))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') console.log(`  [${name} console.${message.type()}] ${message.text()}`)
    })
    try {
      await page.goto('about:blank')
      await page.addScriptTag({ content: code })
      const hasRunner = await page.evaluate(() => typeof window.__runTests === 'function')
      if (!hasRunner) throw new Error('The bundle did not register window.__runTests (import ./harness).')
      const results = await withTimeout(page.evaluate(() => window.__runTests()), FILE_TIMEOUT_MS, name)
      console.log(`\n${name}`)
      if (!results.length) problems.push(`${name}: no tests registered`)
      for (const result of results) {
        if (result.ok) {
          passed += 1
          console.log(`  ok   ${result.name} (${result.ms} ms)`)
        } else {
          failed += 1
          console.log(`  FAIL ${result.name} (${result.ms} ms)\n${String(result.error).replace(/^/gm, '       ')}`)
        }
      }
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      for (const message of pageErrors) problems.push(`${name}: page error: ${message}`)
      for (const url of attempts) problems.push(`${name}: network attempt: ${url}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
}

console.log(`\nBrowser tests: ${passed} passed, ${failed} failed, ${problems.length} problem(s) in ${files.length} file(s).`)
for (const problem of problems) console.log(`  - ${problem}`)
if (failed || problems.length) process.exitCode = 1
