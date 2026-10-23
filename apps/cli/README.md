# @devbox/cli — DevBox CLI (opencode style)

Interactive REPL with `@file` refs (REPOS_ROOT jail) and `/agent` allowlist
(dry-run by default). All output is ASCII boxes (width 80).

## Run

```sh
# from repo root
bun --filter @devbox/cli cli -- --help
bun --filter @devbox/cli cli -- agent list
bun --filter @devbox/cli cli -- resolve @apps/backend/package.json

# from apps/cli
bun run cli -- --help

# REPL
bun --filter @devbox/cli cli
```

Non-TTY stdin prints help instead of hanging (CI-safe).

## Env

`REPOS_ROOT` is required for any `@ref` (no default, no `<cwd>/repos`
fallback — fail-fast with `[cli] REPOS_ROOT is required …`, see
`.env.example`). Refs must be relative (`@apps/backend/package.json`);
absolute paths and any `..` segment are denied (traversal → error box).
Reads only; previews are capped (`40` lines / `2000` chars) and scrubbed
(`Bearer …` → `Bearer [redacted]`, `://user:pass@` → `://user:[redacted]@`).

`OPENCODE_API_KEY` is required for any live OpenCode call
(`--apply` agent runs, free-prompt replies). Priority: env
`OPENCODE_API_KEY` (fallback `JEV_API_KEY`) → fallback `auth.json`
(`$HOME/.local/share/opencode/auth.json`, `XDG_DATA_HOME` override,
JSON `{opencode:{key}, opencode-go:{key}}` — `.opencode-go.key` first).
Missing → fail-fast `missing OPENCODE_API_KEY → задай env или auth.json`
(✗-box with `→` hint, secret never logged). The Cloud API base URL is
hard-coded in `src/agents/opencode.ts` (`OPENCODE_API_BASE_URL`,
`https://opencode.ai`; NOT `api.opencode.ai` — catch-all); explicit
`OPENCODE_API_KEY` env overrides just the base (inference path
`/inference/systemone/v1/systemone` is joined via `new URL(path, base)` —
proven v2 systemone contract `{model:"jev-1.13-free", state, questions}` +
Bearer, see `src/agents/opencode.ts`; never `/v1/chat`, 404 HTML catch-all).
Copy `.env.example` → `.env`; never commit real keys.

## Commands

- `cli --help` / `cli --version`
- `cli agent list` — allowlist table (`ask plan build build-fast
  build-smart refactor unit-test review diagnostics task-manager devops`)
- `cli agent run <name> <prompt> [--apply]` — dry-run box by default
  (shows what would go + `OPENCODE_API_KEY` hint); `--apply` sends the
  prompt to OpenCode via `src/agents/opencode.ts` (timeout 30s, 1 retry,
  scrubbed `cause ≤2000`) and prints the reply in a box
- `cli resolve @path` — jailed preview box
- REPL: `/help` `/exit` `/agent list` `/agent <name> <prompt> [--apply]`
  plus free text with `@refs` — free text without `@refs` goes to OpenCode
  when the key is set (reply box), otherwise dry-run echo + missing-key
  ✗-box with `→` hint

## Layers

- `src/ui/` — ASCII render only (`box/table/header/separator`,
  `spinner` frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)
- `src/refs/` — ref resolve only (jail + read-only preview)
- `src/agents/` — allowlist + dry-run runner + `opencode.ts` key/chat only
- `src/prompt/` — line parser only (`parseLine`, no readline)

Output goes through `process.stdout.write` (never `console.*`, so the
`noConsole` lint stays green); tests live in
`src/ui/__tests__/ascii.test.ts` (width-80 snapshot, no broken layout).
