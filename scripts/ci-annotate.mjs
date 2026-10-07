/**
 * Publishes CI failure details as GitHub Actions error annotations and in the
 * step summary, so failures are readable from the run page and the public
 * checks API without downloading logs. Outside GitHub Actions it does nothing.
 */
import { appendFileSync } from 'node:fs'

const CHUNK = 3500
const MAX_CHUNKS = 8

const escapeData = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = value => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** Emits `text` as up to MAX_CHUNKS error annotations titled `title (i/n)`. */
export function annotateFailure(title, text) {
  if (process.env.GITHUB_ACTIONS !== 'true') return
  const body = String(text).trim() || '(no output)'
  const chunks = []
  for (let i = 0; i < body.length && chunks.length < MAX_CHUNKS; i += CHUNK) chunks.push(body.slice(i, i + CHUNK))
  chunks.forEach((chunk, i) => {
    console.log(`::error title=${escapeProperty(`${title} (${i + 1}/${chunks.length})`)}::${escapeData(chunk)}`)
  })
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n\`\`\`\n${body.slice(0, CHUNK * MAX_CHUNKS)}\n\`\`\`\n`)
    } catch { /* The summary is a convenience. */ }
  }
}

/** Returns the failure section of Node's spec reporter output, or its tail. */
export function failureSection(output) {
  const marker = output.lastIndexOf('failing tests:')
  return marker >= 0 ? output.slice(marker) : output.slice(-CHUNK * MAX_CHUNKS)
}
