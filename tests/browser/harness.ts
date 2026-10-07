/**
 * Minimal in-page test registry for scripts/browser-ci.mjs. Each test file is
 * bundled (with this harness) as one IIFE into about:blank; the runner then
 * calls window.__runTests() and fails on any failed test or network attempt.
 */
export interface BrowserTestResult {
  name: string
  ok: boolean
  error?: string
  ms: number
}

type TestFn = () => void | Promise<void>

declare global {
  interface Window {
    __runTests?: () => Promise<BrowserTestResult[]>
  }
}

const registry: { name: string; fn: TestFn }[] = []

export function test(name: string, fn: TestFn): void {
  registry.push({ name, fn })
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

export function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new AssertionError(message)
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(key => Object.prototype.hasOwnProperty.call(b, key)
    && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** For two strings, the first differing position with some context. */
function stringDiff(actual: string, expected: string): string {
  let index = 0
  while (index < actual.length && index < expected.length && actual[index] === expected[index]) index += 1
  const line = actual.slice(0, index).split('\n').length
  const from = Math.max(0, index - 40)
  return `first difference at index ${index} (line ${line}):\n  actual:   ${show(actual.slice(from, index + 60))}\n  expected: ${show(expected.slice(from, index + 60))}`
}

/** Strict equality for primitives, structural equality for arrays and plain objects. */
export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (deepEqual(actual, expected)) return
  const detail = typeof actual === 'string' && typeof expected === 'string'
    ? stringDiff(actual, expected)
    : `actual:   ${show(actual)}\nexpected: ${show(expected)}`
  throw new AssertionError(`${message ? `${message}\n` : ''}${detail}`)
}

/** Passes when fn throws (optionally matching the message). */
export function assertThrows(fn: () => unknown, pattern?: RegExp, message?: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (pattern && !pattern.test(text)) throw new AssertionError(`${message ?? 'Unexpected error'}: ${text}`)
    return
  }
  throw new AssertionError(message ?? 'Expected the function to throw.')
}

window.__runTests = async () => {
  const results: BrowserTestResult[] = []
  for (const { name, fn } of registry) {
    const started = performance.now()
    try {
      await fn()
      results.push({ name, ok: true, ms: Math.round(performance.now() - started) })
    } catch (error) {
      // V8 stacks start with "Name: message", so the stack alone is complete.
      const text = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error)
      results.push({ name, ok: false, error: text, ms: Math.round(performance.now() - started) })
    }
  }
  return results
}
