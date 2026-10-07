/**
 * Production packaging only (SPEC 2.10 with correction C5). Builds nothing and
 * runs no tests: it checks that dist/ was built for the configured relay,
 * writes the network permission into a copy of app.json, stages dist/ without
 * the relay bundle and runs the Even Hub CLI.
 *
 * Output: artifacts/substack-reader-<version>.ehpk
 *
 * Environment:
 *   VITE_RELAY_ORIGIN               the relay origin the build used (process env or .env, as Vite reads it)
 *   ENABLE_RSS2JSON_FALLBACK=1      also whitelist https://api.rss2json.com; the build must have been made
 *                                   with VITE_ENABLE_RSS2JSON_FALLBACK=1 (and vice versa)
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, readBuildEnv, validateRelayOrigin } from './check-relay-origin.mjs'

/** The SDK the bundle is built against, and the Even app floor the CLI must stamp for it. */
const SDK_VERSION = '0.0.16'
const MIN_APP_VERSION = '2.2.10'
const RSS2JSON_ORIGIN = 'https://api.rss2json.com'
/** dist/ entries that never go into the .ehpk (the relay bundle and hosting metadata). */
const EXCLUDED = new Set(['server', '.openai', 'worker.mjs', '_appgen_meta'])
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g

const at = (...parts) => path.join(ROOT, ...parts)

async function readJson(relative, hint) {
  let text
  try {
    text = await readFile(at(relative), 'utf8')
  } catch {
    throw new Error(`Missing ${relative}. ${hint}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${relative} is not valid JSON. ${hint}`)
  }
}

/** new URL(x).origin, or null (C5: both sides are normalized before comparing). */
function originOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- inputs

const env = await readBuildEnv()
const origin = validateRelayOrigin(env.VITE_RELAY_ORIGIN)
if (!origin) throw new Error('Set VITE_RELAY_ORIGIN to the deployed HTTPS relay origin before building and packaging.')

const manifest = await readJson('app.json', 'The repository is incomplete.')
const pkg = await readJson('package.json', 'The repository is incomplete.')
const buildInfo = await readJson('dist/build-info.json', 'Run `pnpm run build` with VITE_RELAY_ORIGIN set first.')

// ---------------------------------------------------------------- consistency checks

if (manifest.version !== pkg.version) {
  throw new Error(`app.json version ${manifest.version} must equal package.json version ${pkg.version}.`)
}
if (buildInfo.version !== manifest.version) {
  throw new Error(`dist/ was built for version ${buildInfo.version}, not ${manifest.version}. Rebuild before packaging.`)
}
const builtOrigin = originOf(buildInfo.relayOrigin)
if (builtOrigin !== origin) {
  throw new Error(`dist/ was built for relay ${builtOrigin ?? '(none)'}, but VITE_RELAY_ORIGIN is ${origin}. Rebuild with the same VITE_RELAY_ORIGIN before packaging.`)
}
if (pkg.dependencies?.['@evenrealities/even_hub_sdk'] !== SDK_VERSION || manifest.min_sdk_version !== SDK_VERSION) {
  throw new Error(`package.json must pin @evenrealities/even_hub_sdk ${SDK_VERSION} and app.json min_sdk_version must be ${SDK_VERSION} (pack stamps --sdk-ver ${SDK_VERSION}).`)
}
if ('min_app_version' in manifest) {
  throw new Error('Remove min_app_version from app.json; the CLI stamps it from the SDK version.')
}

// C12: the display name lives in src/config.ts APP_NAME and app.json only, and they must agree.
const configSource = await readFile(at('src/config.ts'), 'utf8')
const appName = /export const APP_NAME = '([^'\\]+)'/.exec(configSource)?.[1]
if (!appName) throw new Error('src/config.ts must declare APP_NAME as a plain string literal.')
if (manifest.name !== appName) throw new Error(`app.json name "${manifest.name}" must equal src/config.ts APP_NAME "${appName}".`)
if (typeof manifest.name !== 'string' || manifest.name.length > 20 || /even/i.test(manifest.name)) {
  throw new Error('app.json name must be at most 20 characters and must not contain "Even" (Even Hub review rule).')
}

// rss2json: whitelist it only when asked, and only when the build can actually use it.
const wantRss2json = process.env.ENABLE_RSS2JSON_FALLBACK === '1'
let builtRss2json
if (typeof buildInfo.rss2jsonFallback === 'boolean') {
  builtRss2json = buildInfo.rss2jsonFallback
} else {
  builtRss2json = env.VITE_ENABLE_RSS2JSON_FALLBACK === '1'
  console.log('Note: dist/build-info.json has no rss2jsonFallback flag; using VITE_ENABLE_RSS2JSON_FALLBACK from the build environment.')
}
if (wantRss2json && !builtRss2json) {
  throw new Error('ENABLE_RSS2JSON_FALLBACK=1 whitelists api.rss2json.com, but dist/ was built without VITE_ENABLE_RSS2JSON_FALLBACK=1. Rebuild with it, or unset ENABLE_RSS2JSON_FALLBACK.')
}
if (!wantRss2json && builtRss2json) {
  throw new Error('dist/ was built with VITE_ENABLE_RSS2JSON_FALLBACK=1, so set ENABLE_RSS2JSON_FALLBACK=1 to whitelist api.rss2json.com, or rebuild without the flag.')
}
if (origin === RSS2JSON_ORIGIN) throw new Error('VITE_RELAY_ORIGIN must be the relay, not rss2json.')

// ---------------------------------------------------------------- manifest

const whitelist = wantRss2json ? [origin, RSS2JSON_ORIGIN] : [origin]
const desc = `Loads public Substack posts through the ${manifest.name} relay service at ${new URL(origin).host}`
  + (wantRss2json ? ' and, if it is unavailable, the rss2json feed converter.' : '.')
if (desc.length > 300) throw new Error('The network permission description exceeds 300 characters; use a shorter relay host.')
manifest.permissions = [{ name: 'network', desc, whitelist }]

// ---------------------------------------------------------------- staging

const artifacts = at('artifacts')
const staging = path.join(artifacts, 'package')
if (!staging.startsWith(artifacts + path.sep)) throw new Error('Unsafe staging directory.')
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
const entries = await readdir(at('dist'))
if (!entries.includes(manifest.entrypoint)) throw new Error(`dist/${manifest.entrypoint} is missing. Run \`pnpm run build\` first.`)
for (const name of entries) {
  if (EXCLUDED.has(name)) continue
  await cp(at('dist', name), path.join(staging, name), { recursive: true })
}
const manifestPath = path.join(artifacts, 'app.json')
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// ---------------------------------------------------------------- Even Hub CLI

const output = path.join(artifacts, `substack-reader-${manifest.version}.ehpk`)
await rm(output, { force: true })
const cliRoot = at('node_modules/@evenrealities/evenhub-cli')
const cliPackage = JSON.parse(await readFile(path.join(cliRoot, 'package.json'), 'utf8'))
const bin = typeof cliPackage.bin === 'string' ? cliPackage.bin : cliPackage.bin?.evenhub
if (typeof bin !== 'string') throw new Error('Cannot find the evenhub CLI entry point.')
// Never pass -c/--check (it calls the Even Hub API and is not part of packaging).
const result = spawnSync(process.execPath, [
  path.join(cliRoot, bin), 'pack', manifestPath, staging, '--sdk-ver', SDK_VERSION, '-o', output,
], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`evenhub pack failed with exit code ${result.status ?? result.signal}.`)

// C5: any CLI warning (e.g. the npm registry was unreachable and a guessed floor was used) fails the pack.
const printed = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(ANSI_RE, '')
if (/\b(WARNING|ERROR)\b/.test(printed)) throw new Error('evenhub pack printed a WARNING or ERROR; the package was not accepted.')
const floor = new RegExp(`^\\s*min_app_version\\s+${MIN_APP_VERSION.replace(/\./g, '\\.')}(?![\\d.])`, 'm')
if (!floor.test(printed)) throw new Error(`evenhub pack did not report min_app_version ${MIN_APP_VERSION} for SDK ${SDK_VERSION}.`)

const info = await stat(output).catch(() => null)
if (!info || info.size === 0) throw new Error(`evenhub pack did not write ${path.relative(ROOT, output)}.`)
const sha256 = createHash('sha256').update(await readFile(output)).digest('hex')
console.log(`Packed ${path.relative(ROOT, output).split(path.sep).join('/')} (${info.size} bytes, sha256 ${sha256})`)
console.log(`Network whitelist: ${whitelist.join(', ')}`)
