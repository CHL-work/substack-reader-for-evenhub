/**
 * Prints the GitHub Actions result for a commit: each run, each step, and every
 * annotation (the test runners publish failure details as annotations through
 * scripts/ci-annotate.mjs). Job logs need a GitHub login; run status and
 * annotations of this public repository do not. This queries GitHub only; it
 * runs no app code and no tests.
 *
 *   node scripts/ci-status.mjs [commit-ish] [--wait]
 *
 * The commit defaults to HEAD. --wait polls every 30 s until every run for the
 * commit has finished (at most 40 minutes). Anonymous API calls are limited to
 * 60 per hour per IP; set GITHUB_TOKEN to raise that.
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const wait = args.includes('--wait')
const ref = args.find(arg => !arg.startsWith('--')) ?? 'HEAD'
const git = (...cmd) => execFileSync('git', cmd, { encoding: 'utf8' }).trim()

const sha = git('rev-parse', ref)
const remote = git('remote', 'get-url', 'origin')
const match = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote)
if (!match) throw new Error(`origin is not a GitHub repository: ${remote}`)
const api = `https://api.github.com/repos/${match[1]}/${match[2]}`
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'substack-reader-ci-status' }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

async function get(path) {
  const response = await fetch(path.startsWith('https:') ? path : `${api}${path}`, { headers })
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status} ${await response.text().catch(() => '')}`.slice(0, 400))
  return response.json()
}

const pending = run => run.status !== 'completed'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let runs = []
for (let attempt = 0; ; attempt += 1) {
  runs = (await get(`/actions/runs?head_sha=${sha}&per_page=20`)).workflow_runs ?? []
  const line = runs.map(run => `${run.name} (${run.event}): ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`).join('; ')
  console.log(`${new Date().toISOString().slice(11, 19)} ${sha.slice(0, 7)} ${line || 'no runs yet'}`)
  if (!wait || (runs.length && !runs.some(pending)) || attempt >= 80) break
  await sleep(30_000)
}

for (const run of runs) {
  console.log(`\n# ${run.name} (${run.event}) ${run.conclusion ?? run.status} ${run.html_url}`)
  const { jobs = [] } = await get(`/actions/runs/${run.id}/jobs`)
  for (const job of jobs) {
    console.log(`## job ${job.name}: ${job.conclusion ?? job.status}`)
    for (const step of job.steps ?? []) console.log(`   ${step.conclusion ?? step.status}  ${step.name}`)
    const annotations = await get(`/check-runs/${job.id}/annotations?per_page=100`)
    for (const note of annotations) {
      console.log(`\n--- ${note.annotation_level}${note.title ? `: ${note.title}` : ''}`)
      console.log(note.message)
    }
  }
}
if (runs.some(run => run.conclusion && run.conclusion !== 'success' && run.conclusion !== 'skipped')) process.exitCode = 1
