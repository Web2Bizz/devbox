# @devbox/cli — DevBox CLI (opencode style)

Interactive REPL with `@file` refs (REPOS_ROOT jail) and `/agent` allowlist
(dry-run by default). System output is ASCII boxes (width 80); chat
messages (user prompt + agent reply) are plain full-width text (no boxes,
fg-only color, see § TUI).

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

## TUI (transparent OpenTUI REPL)

On a TTY the REPL renders through `@opentui/core` (`src/ui/tui.ts`,
pinned in `package.json`): greeting, scrollback history, status and
animated spinner are OpenTUI renderables, the input stays pinned to the
bottom (`space-between` column + sticky-bottom history + focused
`InputRenderable`, submit on `ENTER`).

Transparency: the root never paints its own color — no backdrop/bg props
anywhere in the render code (fg-only), the terminal shows through. Chat
history + every message line is `width: "100%"` (full terminal width:
renderer → `stdout.columns` → `80`, never fixed 80). The pure-ASCII
`box.ts` renderer stays for system content (greeting, help, ref previews,
`errorBox`) inside OpenTUI text nodes; history is capped
(`TUI_HISTORY_CAP`) so the input never scrolls off.

Chat style (`src/ui/chat.ts`, single source of truth): user prompt is
cyan (`USER_FG="cyan"`, stdout `ESC[36m`), agent reply is green
(`AGENT_FG="green"`, stdout `ESC[32m`) — readable pair on a dark
transparent background. Both reset with fg-only `ESC[39m` (no `ESC[0m`,
no `40-47`/`100-107` bg codes anywhere). Messages are plain wrapped
text at terminal width (`terminalWidth()` / `resolveTerminalWidth()`,
word-wrap `wrapMessage()`), never `box()`/`header()`/`separator()`
frames; TUI history gets the same plain lines with `fg` via
`TextRenderable` (`session.printUser` / `session.printAgent`,
`formatUserPlain` / `formatAgentPlain`). `Greeting` and `errorBox` boxes
stay as-is. `hasBgCodes()` + `stripAnsi()` guard the contract in tests
(`src/ui/__tests__/chat.test.ts`: user cyan / agent green, no bg codes,
width = terminal, no box frames).

Paste: `InputRenderable` handles bracketed paste natively; `tui.ts`
normalizes it (`normalizePastedText`: strips `ESC[200~`/`ESC[201~`,
CRLF→LF, multiline→single line with spaces, C0-strip, trim, cap
`TUI_INPUT_MAX_LENGTH=10000` so pasted blocks are not cut at the
upstream 1000). `ENTER` submits (`InputRenderableEvents.ENTER`);
`maxLength` is passed explicitly. Focus is refocused after every
`print`/`spin` mutation and after each submitted line, so Ctrl+V /
Shift+Ins / bracketed paste keep flowing after alt-tab or spinner.
Fallback: `--help` / `--version` / non-TTY / CI never load the native
bindings and keep the stdout path (same boxes, static spinner line). If
the TUI fails to start, the REPL falls back to `readline` automatically.
`DEVBOX_NO_TUI=1` forces the stdout fallback (see `.env.example`).

## Env

`REPOS_ROOT` is required for any `@ref` (no default, no `<cwd>/repos`
fallback — fail-fast with `[cli] REPOS_ROOT is required …`, see
`.env.example`). Refs must be relative (`@apps/backend/package.json`);
absolute paths and any `..` segment are denied (traversal → error box).
Reads only; previews are capped (`40` lines / `2000` chars) and scrubbed
(`Bearer …` → `Bearer [redacted]`, `://user:pass@` → `://user:[redacted]@`).

Chat needs the cloud key (same Go subscription as `/connect`):
auth.json ONLY (`$HOME/.local/share/opencode/auth.json`, `XDG_DATA_HOME`
override, JSON `{opencode:{key}, opencode-go:{key}}` — `opencode-go.key`
first). Env key vars (`OPENCODE_API_KEY`/`JEV_API_KEY`) are NOT read.
Missing → fail-fast `missing opencode key in auth.json → вставь через
/connect` (✗-box with path, secret never logged). Cloud endpoint:
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
  ≤2000, preview first 500 in `preview=`). `errorBox` wraps (never
  `{"error":{"type":"serv…`-cuts). Hint by cause: `invalid-key` →
  refresh via `/connect`; `service` → check `OPENCODE_CLOUD_URL`/model;
  else generic. Reply is always text —
  never empty and never the `"answer"`/`"reply"` placeholder.
- Serve fallback (only when `OPENCODE_USE_SERVE=1` and cloud failed):
  `POST /session {title} → {id}` (cached) → `POST /session/{id}/message
  {parts:[{type:"text",text}], model?} → {parts:[...]}` (pinned SDK
  `OPENCODE_SDK_VERSION` 1.18.33); `404` on message → session recreated
  once.

## Commands

- `cli --help` / `cli --version`
- `cli agent list` — allowlist table (`ask plan build build-fast
  build-smart refactor unit-test review diagnostics task-manager devops`)
- `cli agent run <name> <prompt> [--apply]` — dry-run box by default
  (shows what would go + cloud-key hint); `--apply` sends the
  prompt to the cloud via `src/agents/opencode.ts` (OpenAI-compatible,
  timeout 30s, 1 retry, scrubbed `cause ≤2000`) and prints the reply in a
  box (never empty/`answer`; no serve needed)
- `cli resolve @path` — jailed preview box
- REPL: `/help` `/exit` `/agent list` `/agent <name> <prompt> [--apply]`
  plus free text with `@refs` — free text goes to the cloud
  (reply box) or fails with a cloud-key ✗-box; serve is never required

## Экраны

Главная (RUSH CODE): заголовок `RUSH CODE` + 3 пункта по середине экрана —
`1. Выбрать проект` / `2. Открыть директорию` / `3. Выйти` (см.
`src/ui/home.ts`: `HOME_TITLE` + `HOME_OPTIONS`, `renderHomeScreen()` центрит
горизонтально, отступ сверху центрит вертикально). Навигация TTY: стрелки
`↑↓` + `Enter` (raw-mode селектор в `cli.ts`); фолбэк везде одинаковый —
цифры `1-3` (`parseHomeInput()`, `DEVBOX_NO_TUI=1` / non-TTY / CI держат
stdout-путь, прозрачность без bg не ломается).

- `Выбрать проект` — список из сканирования `REPOS_ROOT`
  (`src/refs/projects.ts`: `listProjects()`; только директории без точки,
  сортировка; пустой корень — fail-fast `нет проектов`, не молчаливый `[]`).
  Выбор номером/именем → `resolveProjectDir()` (jail как в `resolve.ts`).
- `Открыть директорию` — ввод пути + `resolveCustomDir()` (jail `REPOS_ROOT`,
  `..` denied, только директории).
- `Выйти` — чистый выход (`bye ✓`, `exit 0`).

Сессия (чат с агентом): после выбора проекта/директории — экран чата
(`RUSH CODE — Сессия: <имя> (<путь>)` + переиспользуемый cloud-чат
`chatLocal()` → `chatCloud()` из `src/agents/opencode.ts`: ключ строго
`auth.json`, `OPENCODE_*` env для ключа не читаются, scrub `Bearer`/userinfo,
`cause ≤2000`, fail-fast `missing opencode key in auth.json`). История
full-width plain: user cyan (`USER_FG`), agent green (`AGENT_FG`) — см. § TUI,
не ломать (тесты `chat.test.ts` + `tui.test.ts`).

## Layers

- `src/ui/` — ASCII render only (`box/table/header/separator`,
  `spinner` frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)
- `src/refs/` — ref resolve only (jail + read-only preview)
- `src/agents/` — allowlist + dry-run runner + `opencode.ts` key/chat only
- `src/prompt/` — line parser only (`parseLine`, no readline)

Output goes through `process.stdout.write` (never `console.*`, so the
`noConsole` lint stays green); tests live in
`src/ui/__tests__/ascii.test.ts` (width-80 snapshot, no broken layout).
