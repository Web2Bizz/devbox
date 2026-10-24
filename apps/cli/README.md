# @rush-code/cli — Rush Code CLI (opencode style)

Interactive REPL with `@file` refs (REPOS_ROOT jail) and `/agent` allowlist
(dry-run by default). System output is plain text; chat
messages (user prompt + agent reply) are plain full-width text (no frames,
fg-only color, see § TUI).

## Run

```sh
# from repo root
bun --filter @rush-code/cli cli -- --help
bun --filter @rush-code/cli cli -- agent list
bun --filter @rush-code/cli cli -- resolve @apps/backend/package.json

# from apps/cli
bun run cli -- --help

# REPL
bun --filter @rush-code/cli cli
```

Non-TTY stdin prints help instead of hanging (CI-safe).

## TUI (transparent OpenTUI REPL)

On a TTY the REPL renders through `@opentui/core` + `@opentui/react`
(`src/commands/runners.ts` + `src/ui/screens/index.ts`, pinned in `package.json`):
greeting, scrollback history, status and animated spinner are React
`<text>` nodes, the input stays pinned to the bottom (`space-between`
column + sticky-bottom history + focused `<input>`, submit on `onSubmit`).

Transparency: the root never paints its own color — no backdrop/bg props
anywhere in the render code (fg-only), the terminal shows through. Chat
history + every message line is `width: "100%"` (full terminal width:
renderer → `stdout.columns` → `80`). The plain-text
`plain.ts` renderer stays for system content (greeting, help, ref previews,
`errorText`) inside OpenTUI text nodes; history is capped
(`TUI_HISTORY_CAP`) so the input never scrolls off.

Chat style (`src/ui/shared/chat.ts`, single source of truth): user prompt is
cyan (`USER_FG="cyan"`, stdout `ESC[36m`), agent reply is green
(`AGENT_FG="green"`, stdout `ESC[32m`) — readable pair on a dark
transparent background. Both reset with fg-only `ESC[39m` (no `ESC[0m`,
no `40-47`/`100-107` bg codes anywhere). Messages are plain wrapped
text at terminal width (`terminalWidth()` / `resolveTerminalWidth()`,
word-wrap `wrapMessage()`), never frames — plain `headerText`/`tableText`/`errorText`
lines; TUI history gets the same plain lines with `fg` via `<text>`
(`session.printUser` / `session.printAgent`,
`formatUserPlain` / `formatAgentPlain`). `greetingLines` and `errorText` stay
plain. `hasBgCodes()` + `stripAnsi()` guard the contract in tests
(`src/ui/__tests__/chat.test.ts`: user cyan / agent green, no bg codes,
width = terminal, no frames).

Paste: `<input>` handles bracketed paste natively; `core/utils/paste.ts`
normalizes it (`normalizePastedText`: strips `ESC[200~`/`ESC[201~`,
CRLF→LF, multiline→single line with spaces, C0-strip, trim, cap
`TUI_INPUT_MAX_LENGTH=10000` so pasted blocks are not cut at the
upstream 1000). Submit arrives through `onSubmit`;
`maxLength` is passed explicitly. Focus is declarative (the `focused`
prop survives every `print`/`spin` mutation and each submitted line), so
Ctrl+V / Shift+Ins / bracketed paste keep flowing after alt-tab or spinner.
One-shot routes (`--help` / `--version` / `agent` / `resolve`) and
non-TTY keep the stdout path (same plain text, static spinner line) and never
load the native bindings. Interactive flows (home, project open, chat)
are always TUI — `RUSH_CODE_NO_TUI` is legacy and ignored. If the TUI
fails to start, the REPL reports `[cli] TUI failed to start` on stderr
(`exitCode 1`, no `readline` fallback).

## Env

`REPOS_ROOT` is required for any `@ref` (no default, no `<cwd>/repos`
fallback — fail-fast with `[cli] REPOS_ROOT is required …`, see
`.env.example`). Refs must be relative (`@apps/backend/package.json`);
absolute paths and any `..` segment are denied (traversal → error lines).
Reads only; previews are capped (`40` lines / `2000` chars) and scrubbed
(`Bearer …` → `Bearer [redacted]`, `://user:pass@` → `://user:[redacted]@`).

Chat needs the cloud key (same Go subscription as `/connect`):
auth.json ONLY (`$HOME/.local/share/opencode/auth.json`, `XDG_DATA_HOME`
override, JSON `{opencode:{key}, opencode-go:{key}}` — `opencode-go.key`
first). Env key vars (`OPENCODE_API_KEY`/`JEV_API_KEY`) are NOT read.
Missing → fail-fast `missing opencode key in auth.json → вставь через
/connect` (✗ lines with path, secret never logged). Cloud endpoint:
`OPENCODE_CLOUD_URL` (explicit override only, default
`https://opencode.ai/inference/openai/v1/chat/completions` — documented
inference endpoint, see § Chat). Cloud model: `OPENCODE_MODEL` (optional,
empty = `deepseek-v4.1-flash`); `jev` is rejected for chat (choice-only).
Qwen 3 Coder 480B (`qwen-3-coder-480b`) is DEPRECATED since 2026-02-06
(upstream `400 Model is unavailable`) — do not set it as default.
Serve fallback is OFF by default (`OPENCODE_USE_SERVE=1` to enable):
`OPENCODE_URL` / `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4096`;
`0.0.0.0`/`::` dialed as `127.0.0.1`), `OPENCODE_TOKEN` (serve password,
alias `OPENCODE_SERVER_PASSWORD`; `''` = no password → header omitted,
value never logged).
Copy `.env.example` → `.env`; never commit real keys/passwords.

## Chat

Decision (2026-10-23): chat is a DIRECT cloud client — no serve required.
Default `chatLocal()` → `chatCloud()` (OpenAI-compatible
`POST {model, messages:[{role:"user", content}]} → {choices:[...]}` at
`OPENCODE_CLOUD_URL`, `Bearer` from auth.json only, timeout 30s, 1 retry on
network/`429`/`5xx`, scrubbed `cause ≤2000`). Serve is an OPTIONAL fallback
only (`OPENCODE_USE_SERVE=1`; default off = cloud without serve).
Endpoint: `https://opencode.ai/inference/openai/v1/chat/completions`
(documented inference endpoint per
`https://opencode.ai/v2/docs/console/models`, `@ai-sdk/openai-compatible`
for `/v1/chat/completions`). Selection format: `opencode/<model-id>`.

| Model id | Role |
| --- | --- |
| `deepseek-v4.1-flash` | Default (DeepSeek V4.1 Flash) |
| `deepseek-v4-pro` | DeepSeek V4 Pro (larger) |
| `deepseek-v4-flash` | DeepSeek V4 Flash |
| `deepseek-v4.1-flash-free` | Free variant |

Qwen 3 Coder 480B (`qwen-3-coder-480b`) is DEPRECATED since 2026-02-06 —
upstream answers `400 Model is unavailable`, so it is NOT the default
and must not be set back without re-verification.

- History (canon + context7): the old paths never gave free-text cloud chat —
  SDK (`createOpencodeClient({ baseUrl })` → `session.create` →
  `session.prompt`, `@opencode-ai/sdk` 1.18.33) needs a RUNNING server
  (old serve-only path → `405`/unreachable without serve); cloud systemone
  (`{model:"jev-1.13-free", state, questions}` + Bearer,
  `.opencode/tools/classify_build.ts`) is `choice`-only (never free text —
  misused it collapses to the literal `"answer"`); Zen billing
  (`GET https://opencode.ai/zen/go/v1/usage`) is usage-only.
  Free-text chat now goes through the documented inference endpoint above.
- LIMITATION (explicit): the default
  `https://opencode.ai/inference/openai/v1/chat/completions` is the
  documented inference composition (base `https://opencode.ai/inference` +
  OpenAI-compatible `/openai/v1/chat/completions` from console/model docs).
  `404` surfaces verbatim (check
  `OPENCODE_CLOUD_URL`); reply is still never empty/`"answer"`/`"reply"`
  (shape mismatch).
- Default model `deepseek-v4.1-flash` (DeepSeek V4.1 Flash; override via
  `OPENCODE_MODEL`, see table above; `opencode/<model-id>` selection).
  `qwen-3-coder-480b` is DEPRECATED (2026-02-06, `400 Model is
  unavailable`) and must NOT be restored as default. `jev`
  (`jev-1.13-free`) is REJECTED for chat:
  SystemOne is choice-only, so `resolveChatModel()` drops it for the serve
  fallback and cloud never sends it.
- Cloud systemone stays ONLY for `choice` classification, never replies.
- Auth: `Authorization: Bearer <cloud key>` (value never logged, only
  `auth=yes|no` may be traced). Before fetch the key file is probed as the
  same uid (`stat` perms/owner + trial read, len only —
  `getOpencodeKeyInfo()`; `EACCES`/parse → fail-fast `missing … path=`).
- Failures are scrubbed (`cause ≤2000`, secrets → `[redacted]`), timeout
  30s, 1 retry on network/`429`/`5xx`; `401/403` → key hint, `404` →
  endpoint hint, `429` → retry later. `400` shows full
  diagnostics WITHOUT the key value: `endpoint=` (`OPENCODE_CLOUD_URL`),
  `model=`, `key_len=` + `key_source=` (auth.json path, perms `600`, uid +
  `uid_match`), `body-shape={model,messages:1}`, scrubbed `cause=` (full
  ≤2000, preview first 500 in `preview=`). `errorText` keeps full lines (never
  `{"error":{"type":"serv…`-cuts). Hint by cause: `invalid-key` →
  refresh via `/connect`; `service` → check `OPENCODE_CLOUD_URL`/model;
  else generic. Reply is always text —
  never empty and never the `"answer"`/`"reply"` placeholder.
- Serve fallback (only when `OPENCODE_USE_SERVE=1` and cloud failed):
  `POST /session {title} → {id}` (cached) → `POST /session/{id}/message
  {parts:[{type:"text",text}], model?} → {parts:[...]}` (pinned SDK
  `OPENCODE_SDK_VERSION` 1.18.33); `404` on message → session recreated
  once.

## Chat

Free-text answers with the paid OpenCode Go subscription go ONLY through
the local serve (`opencode serve --port 4096`): the CLI creates a session
once per process (`POST /session {title} → {id}`, id cached in memory) and
sends prompts via `POST /session/{id}/message {parts:[{type:"text",text}]}`
(`chatLocal` in `src/agents/opencode/index.ts`, base `OPENCODE_LOCAL_URL`
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
- `cli agent run <name> <prompt> [--apply]` — dry-run plain lines by default
  (shows what would go + cloud-key hint); `--apply` sends the
  prompt to the cloud via `src/agents/opencode/index.ts` (OpenAI-compatible,
  timeout 30s, 1 retry, scrubbed `cause ≤2000`) and prints the reply as plain
  text (never empty/`answer`; no serve needed)
- `cli resolve @path` — jailed preview lines
- REPL: `/help` `/exit` `/agent list` `/agent <name> <prompt> [--apply]`
  plus free text with `@refs` — free text goes to the cloud
  (plain reply) or fails with cloud-key ✗ lines; serve is never required

## Экраны

Главная (RUSH CODE): заголовок `RUSH CODE` + 3 пункта по середине экрана —
`1. Выбрать проект` / `2. Открыть директорию` / `3. Выйти` (см.
`src/ui/screens/home/index.tsx`: `HOME_TITLE` + `HOME_OPTIONS`, `renderHomeScreen()` центрит
горизонтально, отступ сверху центрит вертикально). Навигация всегда TUI:
стрелки `↑↓` + `Enter` + цифры `1-3` (селектор `HomeApp` в
`src/ui/screens/index.ts` через `useKeyboard`). Интерактив (home, открытие
проекта, чат) — всегда TUI, `RUSH_CODE_NO_TUI` больше не действует (legacy,
игнорируется); stdout остаётся только для one-shot
(`--help`/`--version`/`agent`/`resolve`) и non-TTY.

- `Выбрать проект` — список из сканирования `REPOS_ROOT`
  (`src/core/queries/refs/projects.ts`: `listProjects()`; только директории без точки,
  сортировка; пустой корень — fail-fast `нет проектов`, не молчаливый `[]`).
  Выбор номером/именем → `resolveProjectDir()` (jail как в `core/queries/refs/resolve.ts`).
- `Открыть директорию` — ввод пути + `resolveCustomDir()` (jail `REPOS_ROOT`,
  `..` denied, только директории).
- `Выйти` — чистый выход (`bye ✓`, `exit 0`).

Сессия (чат с агентом): после выбора проекта/директории — экран чата
(`RUSH CODE — Сессия: <имя> (<путь>)` + переиспользуемый cloud-чат
`chatLocal()` → `chatCloud()` из `src/agents/opencode/index.ts`: ключ строго
`auth.json`, `OPENCODE_*` env для ключа не читаются, scrub `Bearer`/userinfo,
`cause ≤2000`, fail-fast `missing opencode key in auth.json`). История
full-width plain: user cyan (`USER_FG`), agent green (`AGENT_FG`) — см. § TUI,
не ломать (тесты `chat.test.ts` + `tui.test.ts`).

## Layers

- `src/commands/` — entry-команды (`commands`/`dispatchLine`, `interactive` TUI-флоу, `sinks`)
- `src/ui/shared/` — plain-text render only (`chat/plain/store`: `headerText/tableText/errorText/greetingLines/statusLine`)
- `src/ui/components/` — `Spinner` (фреймы — в `src/core/utils/frames.ts`: `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)
- `src/ui/screens/` (`home/`-модуль + `projects/` + `repl/` + `error/` + `index.ts`) + `src/commands/runners.ts` + `src/commands/session.ts` — экраны, TUI-раннеры, home-модуль
- `src/core/utils/` — чистые хелперы (`frames`, `paste`)
- `src/core/queries/refs/` — ref resolve only (jail + read-only preview)
- `src/agents/` — allowlist + dry-run runner + `opencode/index.ts` key/chat only
- `src/prompt/` — line parser only (`parseLine`, no readline)

Output goes through `process.stdout.write` (never `console.*`, so the
`noConsole` lint stays green); tests live in
`src/ui/__tests__/ascii.test.ts` (plain snapshot, no frames).
