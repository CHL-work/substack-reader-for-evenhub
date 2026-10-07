/**
 * Remote-only Node unit tests. The project owner's rule: runtime tests run in
 * GitHub Actions, never locally. This script bundles every
 * tests/unit/*.test.ts with esbuild into a temporary directory and runs the
 * bundles with `node --test`. No dev server, simulator, real Substack traffic
 * or hardware is used (tests stub fetch; see tests/unit/helpers.ts).
 *
 * Optional arguments filter test files by substring:
 *   node scripts/ci-tests.mjs pagination input
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { annotateFailure, failureSection } from './ci-annotate.mjs'

if (process.env.CI !== 'true') {
  throw new Error('These checks run only in remote CI. No local app testing is authorized.')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const unitDir = join(root, 'tests', 'unit')
const filters = process.argv.slice(2)

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

const files = (await readdir(unitDir))
  .filter(name => name.endsWith('.test.ts'))
  .filter(name => !filters.length || filters.some(filter => name.includes(filter)))
  .sort()
if (!files.length) throw new Error(`No unit test files matched in ${unitDir}.`)

const temporary = await mkdtemp(join(tmpdir(), 'substack-reader-unit-'))
let status = 1
try {
  const { build } = await import('esbuild')
  const entryPoints = Object.fromEntries(files.map(name => [basename(name, '.ts'), join(unitDir, name)]))
  await build({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: temporary,
    outExtension: { '.js': '.mjs' },
    sourcemap: 'inline',
    define,
    // Fallback for any import.meta.env key without a define (ESM import.meta is writable in Node).
    banner: { js: `import.meta.env = Object.assign(${JSON.stringify(env)}, import.meta.env);` },
    loader: { '.html': 'text', '.txt': 'text', '.xml': 'text', '.json': 'json' },
    logLevel: 'warning',
  })
  const outputs = files.map(name => join(temporary, `${basename(name, '.ts')}.mjs`))
  console.log(`Running ${outputs.length} unit test file(s): ${files.join(', ')}`)
  const result = spawnSync(process.execPath, [
    '--enable-source-maps',
    '--test',
    '--test-reporter=spec',
    '--test-timeout=60000',
    ...outputs,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: 'true' } })
  if (result.error) throw result.error
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  status = result.status ?? 1
  if (status !== 0) annotateFailure('Unit tests failed', failureSection(`${result.stdout ?? ''}\n${result.stderr ?? ''}`))
} catch (error) {
  annotateFailure('Unit test setup failed', error instanceof Error ? error.stack ?? error.message : String(error))
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
process.exitCode = status
