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

## Chat

Free-text answers with the paid OpenCode Go subscription go ONLY through
the local serve (`opencode serve --port 4096`): the CLI creates a session
once per process (`POST /session {title} → {id}`, id cached in memory) and
sends prompts via `POST /session/{id}/message {parts:[{type:"text",text}]}`
(`chatLocal` in `src/agents/opencode.ts`, base `OPENCODE_LOCAL_URL`
`http://127.0.0.1:4096`, override `OPENCODE_URL`/`OPENCODE_SERVER_URL`).
The Go key itself is read by serve from
`~/.local/share/opencode/auth.json` (written by `/connect`), but new serve
versions print a password on boot and require it as
`Authorization: Bearer <OPENCODE_TOKEN>` (otherwise `401`). Pass it via
`export OPENCODE_TOKEN=<пароль из лога opencode serve>` (or inline
`OPENCODE_TOKEN=... bun src/cli.ts`); the password itself is shown by
`pm2 logs opencode` / the `opencode serve` output. Empty = serve without
a password → header omitted (as before); the value is never logged.
Serve down → `✗`-box with the `opencode serve --port 4096` hint (503),
reply never empty.
Cloud systemone (`chatOpencode`, `{model:"jev-1.13-free", state, questions}` +
Bearer) stays ONLY for `choice` classification, never for user replies.

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
