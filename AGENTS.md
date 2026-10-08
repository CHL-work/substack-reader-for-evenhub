# Agent guide: Reader for Substack

Even Hub plugin (Vite + TypeScript, `@evenrealities/even_hub_sdk` 0.0.16) that shows public Substack posts on Even G2 glasses, plus a stateless relay (`worker/relay.ts`, Cloudflare Workers) because Substack sends no CORS headers.

**Start with [docs/HANDOFF.md](docs/HANDOFF.md)**: current status, what to do next, open issues, facts and history. Then [docs/architecture.md](docs/architecture.md), [docs/glasses.md](docs/glasses.md) and [docs/relay.md](docs/relay.md).

## Hard rules

1. **No local runtime tests.** Never run `scripts/ci-tests.mjs`, `scripts/browser-ci.mjs`, `scripts/ui-ci.mjs`, `node --test`, Playwright, a Vite dev or preview server, a browser against the app, or the Even simulator on the owner's machine. Allowed locally: `pnpm install`, `pnpm run check`, `pnpm run build`, `pnpm run pack`, `node --check <file>`, and `node scripts/ci-status.mjs` (it only queries GitHub). Tests run in GitHub Actions only.
2. **Use the portable toolchain.** There is no system Node. Per command, PowerShell: `$env:PATH = "C:\Code\.tools\node;$env:PATH"; $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"`. Bash: `export PATH="/c/Code/.tools/node:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. pnpm 10.32.1 comes from corepack. Install with the committed lockfile.
3. **CI is the test loop.** Work on a branch, push, run `node scripts/ci-status.mjs --wait`, read the annotations it prints (job logs need a GitHub login), fix, repeat. Fast-forward `main` only after CI is green.
4. **Write tests you cannot run with care.** Trace every expectation by hand against the code, keep tests deterministic (fake clocks from `tests/unit/helpers.ts`), add a regression test for each bug fixed, and update existing expectations whenever behaviour changes.
5. **The relay stays honest.** Never spoof a browser User-Agent or Referer, rotate IPs, replay Substack cookies, log requests, or add a public CORS proxy. The User-Agent is exactly `SubstackReaderForEvenHub/<version>` with no URL in it.
6. **Never persist article text or HTML**, and never insert post HTML into the phone page (parse it with `DOMParser`, extract strings only, never adopt nodes).
7. **Glasses constraints.** Text containers only; `createStartUpPageContainer` once, then `textContainerUpgrade`. Root double-tap must call `shutDownPageContainer(1)`. Every frame body must fit the body container (use `paginate`/`fitBody`). Never emit an ASCII space right after a newline (use NBSP).
8. **Code style.** Strict TypeScript, no UI framework, terse and typed like the existing code. `src/config.ts` is the only reader of `import.meta.env`. `src/substack/html.ts` must stay ASCII-only (use `\u` escapes). No regular-expression lookbehind anywhere (older iOS WebViews reject it).
9. **Versions and names.** Keep `version` equal in `package.json` and `app.json`, and the display name equal in `app.json` and `APP_NAME` (`src/config.ts`); `scripts/pack.mjs` enforces both. Never pass `-c`/`--check` to `evenhub pack`.
10. **Docs follow the code.** Update `README.md` and `docs/*.md` in the same commit as any behaviour change. `docs/background/` is a point-in-time archive; do not edit it except to add new records.
11. **Do not touch** `C:\Code\lihkg-reader-for-evenhub` (the owner's sibling project; read-only reference).

## Commits

Repo-level identity `CHL-work <131831160+CHL-work@users.noreply.github.com>`. End commit messages with the co-author trailer your harness asks for. Pushing goes through Git Credential Manager; there is no `gh` CLI.
