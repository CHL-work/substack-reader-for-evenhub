import { defineConfig, loadEnv, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
/** C12: the display name lives in app.json and src/config.ts APP_NAME only (pack.mjs checks they agree). */
const { name: appName } = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf8')) as { name: string }

/**
 * Normalized origin ('' when unset), read the same way Vite fills
 * import.meta.env (process env first, then .env files), so scripts/pack.mjs
 * can compare it with VITE_RELAY_ORIGIN exactly.
 */
function relayOrigin(env: Record<string, string>): string {
  const raw = (env.VITE_RELAY_ORIGIN || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).origin
  } catch {
    throw new Error('VITE_RELAY_ORIGIN must be an absolute https origin, e.g. https://relay.example.org')
  }
}

/** dist/build-info.json: what scripts/pack.mjs and scripts/ui-ci.mjs verify before packaging or testing. */
function buildInfo(origin: string, rss2jsonFallback: boolean): Plugin {
  const info = JSON.stringify({ version, relayOrigin: origin, rss2jsonFallback })
  return {
    name: 'reader-build-metadata',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: info })
    },
  }
}

/** index.html carries __APP_NAME__ instead of a second copy of the display name. */
function appTitle(): Plugin {
  const escaped = appName.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
  return {
    name: 'reader-app-title',
    transformIndexHtml: { order: 'pre', handler: html => html.replaceAll('__APP_NAME__', escaped) },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    base: './', // the packaged app loads from a local package, not a web root
    build: { target: 'es2022', sourcemap: false },
    server: { host: true, port: 5173 },
    // Same rule as src/config.ts ENABLE_RSS2JSON_FALLBACK (exactly '1').
    plugins: [appTitle(), buildInfo(relayOrigin(env), env.VITE_ENABLE_RSS2JSON_FALLBACK === '1')],
  }
})
