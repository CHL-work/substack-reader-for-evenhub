import { version } from '../package.json'

/**
 * The only module that reads import.meta.env. Test bundles (scripts/ci-tests.mjs,
 * scripts/browser-ci.mjs) define exactly the keys used here; add a key there
 * whenever you add one here.
 */

/** Display name on the phone and glasses. Keep in sync with app.json "name". */
export const APP_NAME = 'Reader for Substack'
export const VERSION: string = version

/**
 * Bare public HTTPS origin, or null. Same validation as LIHKG isApiConfigured:
 * https, no credentials, query, hash or path.
 */
export function normalizeRelayOrigin(raw: string | null | undefined): string | null {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    return url.origin
  } catch {
    return null
  }
}

/** Relay origin without a trailing slash, e.g. https://relay.example.org; null when not configured. */
export const RELAY_BASE: string | null = normalizeRelayOrigin(import.meta.env.VITE_RELAY_ORIGIN)

export function isRelayConfigured(): boolean {
  return RELAY_BASE !== null
}

/** Build flag: '1' enables the rss2json fallback (pack.mjs whitelists its origin). Off by default. */
export const ENABLE_RSS2JSON_FALLBACK: boolean = import.meta.env.VITE_ENABLE_RSS2JSON_FALLBACK === '1'
