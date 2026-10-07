/**
 * Shared helpers for Node unit tests (bundled by scripts/ci-tests.mjs).
 * Every stub returns a restore function; call it in `finally` or `t.after`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface FetchCall {
  /** Absolute URL string (Request.url / URL.href / the string passed). */
  url: string
  /** The init object exactly as passed (undefined when none). */
  init: RequestInit | undefined
  /** The Request when fetch was called with one. */
  request: Request | null
}

export type FetchHandler = (url: string, init: RequestInit | undefined, call: FetchCall) => Response | Promise<Response>

/** Every fetch call since the last denyNetwork()/stubFetch(), in order. */
export const fetchCalls: FetchCall[] = []

function toCall(input: RequestInfo | URL, init: RequestInit | undefined): FetchCall {
  if (typeof input === 'string') return { url: input, init, request: null }
  if (input instanceof URL) return { url: input.href, init, request: null }
  return { url: input.url, init, request: input }
}

function install(handler: FetchHandler): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  fetchCalls.length = 0
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = toCall(input, init)
    fetchCalls.push(call)
    return handler(call.url, init, call)
  }
  Object.defineProperty(globalThis, 'fetch', { value: stub, configurable: true, writable: true })
  return () => {
    if (original) Object.defineProperty(globalThis, 'fetch', original)
    else delete (globalThis as { fetch?: unknown }).fetch
  }
}

/** Any fetch rejects with a TypeError (like a real network failure) and is recorded. */
export function denyNetwork(): () => void {
  return install(url => {
    throw new TypeError(`Outbound network is disabled in unit tests (${url}).`)
  })
}

/** Route every fetch to `handler` (recorded in fetchCalls). */
export function stubFetch(handler: FetchHandler): () => void {
  return install(handler)
}

/** A JSON Response with the given status and extra headers. */
export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export interface FakeClock {
  now(): number
  advance(ms: number): number
  set(ms: number): void
}

/** Manual clock for pure modules that take `now: () => number`. */
export function createFakeClock(start = 10_000): FakeClock {
  let time = start
  return {
    now: () => time,
    advance(ms) { time += ms; return time },
    set(ms) { time = ms },
  }
}

export interface LocalStorageShim {
  /** Backing map; inspect or seed it directly. */
  data: Map<string, string>
  restore(): void
}

/**
 * Install a minimal Storage on globalThis.localStorage and, when absent,
 * globalThis.window (= globalThis), so `window.localStorage` works in Node.
 * With `throwing: true` every access throws, like a blocked WebView storage.
 */
export function installLocalStorage(options: { throwing?: boolean; quotaChars?: number } = {}): LocalStorageShim {
  const data = new Map<string, string>()
  const fail = () => { throw new DOMException('Storage is disabled.', 'SecurityError') }
  const sizeOf = (map: Map<string, string>) => [...map].reduce((sum, [key, value]) => sum + key.length + value.length, 0)
  const storage = {
    get length() { if (options.throwing) fail(); return data.size },
    key(index: number) { if (options.throwing) fail(); return [...data.keys()][index] ?? null },
    getItem(key: string) { if (options.throwing) fail(); return data.has(String(key)) ? data.get(String(key))! : null },
    setItem(key: string, value: string) {
      if (options.throwing) fail()
      const k = String(key)
      const v = String(value)
      if (options.quotaChars !== undefined) {
        const next = new Map(data)
        next.set(k, v)
        if (sizeOf(next) > options.quotaChars) throw new DOMException('Quota exceeded.', 'QuotaExceededError')
      }
      data.set(k, v)
    },
    removeItem(key: string) { if (options.throwing) fail(); data.delete(String(key)) },
    clear() { if (options.throwing) fail(); data.clear() },
  }
  const g = globalThis as Record<string, unknown>
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  Object.defineProperty(globalThis, 'localStorage', { get: () => storage, configurable: true })
  if (!hadWindow) Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true })
  return {
    data,
    restore() {
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
      else delete g.localStorage
      if (!hadWindow) delete g.window
    },
  }
}

/** Read a fixture as UTF-8 text, relative to the repository root (process.cwd() in CI). */
export function readFixture(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n')
}

/** Read and parse a JSON fixture relative to the repository root. */
export function readJsonFixture<T = unknown>(relativePath: string): T {
  return JSON.parse(readFixture(relativePath)) as T
}

/** Resolve after pending microtasks and one macrotask turn. */
export function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
