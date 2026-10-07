/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public HTTPS origin of the deployed relay (baked in at build time). */
  readonly VITE_RELAY_ORIGIN?: string
  /** '1' enables the optional rss2json fallback (also whitelisted at pack time). */
  readonly VITE_ENABLE_RSS2JSON_FALLBACK?: string
}
