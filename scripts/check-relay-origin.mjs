/**
 * Validates VITE_RELAY_ORIGIN, the public HTTPS origin of the deployed relay
 * that the build bakes in and pack.mjs whitelists (SPEC 2.9). Static check
 * only: no network, no build, no tests.
 *
 * The value is resolved exactly as Vite resolves it for `vite build`
 * (process env first, then .env files for mode "production"), so CI, the
 * build and pack.mjs all see the same origin.
 *
 *   node scripts/check-relay-origin.mjs            prints configured=false, or configured=true and origin=<origin>
 *   node scripts/check-relay-origin.mjs --require  throws when the origin is not set
 *
 * The output lines are GitHub Actions step outputs (`>> "$GITHUB_OUTPUT"`).
 * Throws (exit code 1) when the value is set but is not a bare public https origin.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const RELAY_ORIGIN_HELP = 'Set repository variable VITE_RELAY_ORIGIN to the deployed relay origin.'

const RESERVED_HOST_RE = /(^|\.)(localhost|example\.(com|net|org)|invalid|test)$/
const LOOPBACK_RE = /^(127\.|0\.0\.0\.0$|\[::1\]$)/

/** Build-time env as Vite sees it (only VITE_* keys). */
export async function readBuildEnv(mode = 'production') {
  const { loadEnv } = await import('vite')
  return loadEnv(mode, ROOT, 'VITE_')
}

/**
 * The normalized origin (`new URL(x).origin`), or null when the value is
 * empty. Throws when it is set but not a bare public https origin.
 */
export function validateRelayOrigin(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  const shown = JSON.stringify(value.slice(0, 200))
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`VITE_RELAY_ORIGIN ${shown} is not an absolute URL. Use the relay origin, e.g. https://substack-reader-relay.<account>.workers.dev`)
  }
  if (url.protocol !== 'https:') throw new Error(`VITE_RELAY_ORIGIN ${shown} must use https.`)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`VITE_RELAY_ORIGIN ${shown} must be a bare origin without credentials, path, query or fragment.`)
  }
  const host = url.hostname.toLowerCase()
  if (RESERVED_HOST_RE.test(host) || LOOPBACK_RE.test(host)) {
    throw new Error(`VITE_RELAY_ORIGIN ${shown} must be a real public host, not a local, example or test name.`)
  }
  return url.origin
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  const target = path.resolve(entry)
  return process.platform === 'win32' ? self.toLowerCase() === target.toLowerCase() : self === target
}

if (invokedDirectly()) {
  const args = process.argv.slice(2)
  const unknown = args.filter(arg => arg !== '--require')
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Usage: node scripts/check-relay-origin.mjs [--require]`)
  const origin = validateRelayOrigin((await readBuildEnv()).VITE_RELAY_ORIGIN)
  if (!origin) {
    if (args.includes('--require')) throw new Error(RELAY_ORIGIN_HELP)
    console.log('configured=false')
  } else {
    console.log('configured=true')
    console.log(`origin=${origin}`)
  }
}
