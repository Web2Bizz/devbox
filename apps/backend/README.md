# Backend — opencode proxy layer (NestJS 12)

NestJS 12 API that fronts the live opencode server (migrated from `node:http`).

Contract: [`contracts/openapi.yaml`](../../contracts/openapi.yaml) ·
DTOs: [`@rush-code/contracts`](../../packages/contracts/src/index.ts) (single source of truth; [`src/contracts.ts`](./src/contracts.ts) is a deprecated re-export).

## Stack (pinned)

| Dep | Version |
| --- | ------- |
| `@nestjs/core,common,platform-express` | `^12.1.0` |
| `@nestjs/config` | `^12.0.1` |
| `@nestjs/swagger` | `^12.0.2` |
| `@nestjs/cli` (dev) | `^12.0.7` |
| `typescript` (dev) | `^7.0.2` |
| `zod` | `^4.6.5` |
| `drizzle-orm` | `^0.45.3` |
| `drizzle-kit` (dev) | `^0.31.11` |
| `pg` | `^8.12.0` |
| `reflect-metadata`, `rxjs` | `^0.2.2`, `^7.8.2` |

CJS project (Nest 12 ESM-ready packages run via `require(esm)` on Node 22+).
`engines: node >= 22`. Env validated by zod@4 (`src/env.ts`) +
`ConfigModule.forRoot({ isGlobal: true, validate })` — fail-fast, secrets never logged.
DB: `drizzle-orm` + `pg` Pool (`DbService`, raw `SELECT 1` health check, no migrations);
without `DATABASE_URL` (or with unreachable PG) the API still boots (`db: "skipped"`/`"down"`).

## Env

See [`.env.example`](./.env.example):

| Var | Default | What |
| --- | ------- | ---- |
| `APP_BACKEND_PORT` (`PORT` legacy) | `3000` | listen port (required, empty → fail-fast) |
| `OPENCODE_URL` (`OPENCODE_SERVER_URL` legacy) | `http://localhost:4096` | upstream opencode server (proxy target) |
| `CORS_ORIGINS` | `http://localhost:${NEXT_PUBLIC_PORT},http://localhost:8080` | allowlist, comma-separated |
| `REQUEST_TIMEOUT_MS` | `10000` | upstream fetch timeout (AbortController) |
| `LOG_LEVEL` | `info` | debug/info/warn/error |
| `DATABASE_URL` | composed from `POSTGRES_*` | optional — `/health.db = skipped` when empty |
| `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID` | empty (disabled) | GitHub App triple — all three or none; partial → fail-fast |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub REST base URL (GHE override) |

## GitHub App (installation repos)

Nested `GithubModule` (imported by `ProjectsModule`, never in `AppModule`):

- `GET /api/v1/projects/github/repos?page=&per_page=` — lists repos accessible
  to the installation via official `octokit` (`GET /installation/repositories`,
  `per_page` 1–100 default 30). Normalized items:
  `{ id, owner, name, fullName, private, defaultBranch, url }`.
- Auth: `GithubAppService` signs the App JWT (`@octokit/auth-app`) →
  `POST /app/installations/{id}/access_tokens` → short-lived installation
  token cached **in-memory only** until `expires_at`. Required App scopes:
  `metadata:read` + `contents:read`.
- Secrets come only from env (`GITHUB_APP_*`), tokens are never persisted,
  `AppLogger` never logs keys/tokens. Unconfigured → `401 { code:
  'unauthorized' }`; bad query → `400`; bad installation/permissions →
  `404`/`403` without leaking the key.
- Format-only link endpoints (`POST/DELETE/GET :id/github-link`) are untouched.

## Routes

| Route | Upstream | Fallback |
| ----- | -------- | -------- |
| `GET /health` | local only (drizzle `SELECT 1`) | `{ status:'ok', db }` |
| `GET /api/v1/session` | `GET {OPENCODE_URL}/session` | mock-session-1 |
| `GET /api/v1/messages?sessionId=` | `GET {OPENCODE_URL}/messages?...` | 1 mock message |
| `POST /api/v1/chat` | `POST {OPENCODE_URL}/chat` | mock echo |

`POST /api/v1/chat` body validated by `ZodValidationPipe(sendChatSchema)`
(Standard Schema). Errors use `{ code, message, correlationId }` + `x-correlation-id` header.
Swagger UI: `GET /swagger` · JSON: `GET /swagger.json` · YAML: `GET /openapi.yaml`.

## Commands

```bash
npm run dev --workspace=apps/backend   # nest start --watch → http://localhost:3000/health
npm run build --workspace=apps/backend # tsc (TS 7) → dist/main.js
npm run start --workspace=apps/backend # node dist/main
npm run lint --workspace=apps/backend  # tsc --noEmit
```

## Диагностика регистрации

Регистрация: `POST /api/v1/auth/register` → `201 { user, accessToken, refreshToken }`
+ `Set-Cookie: rush-code-refresh` (httpOnly, `path=/api/v1/auth`, `SameSite=Lax`,
`Secure` только в production) и `rush-code-auth=1` (маркер для Next-middleware).
Фронт шлёт `credentials: 'include'`, успех → `setSession()` → `/projects` →
`GET /api/v1/auth/me` (`Authorization: Bearer …`) → `200`.

Каждая ошибка несёт сквозной `correlationId`:

- ответ: `{ code, message, correlationId }` + заголовок `x-correlation-id`
  (эхо входящего или сгенерированный uuid; контракт заморожен — только
  additive поля поверх);
- бэкенд-логи: `AppLogger` пишет `warn` на `email_taken`/`invalid_credentials`/
  `refresh reuse` и `error` на падения `createLocal`/хеширования — всегда с
  префиксом `[correlationId]`, секреты (`password`/`passwordHash`/`token`/`jwt*`)
  вырезаны санитайзером;
- фронт: `ApiClientError.correlationId` (из тела или `x-correlation-id`
  заголовка) показывается в `Alert` как `code (ID диагностики: 8 символов)` с
  кнопкой Copy; `400` дополнительно раскладывается в `fieldErrors` под полями,
  `console.error('register failed', { code, correlationId })` — без секретов.

Где смотреть:

```bash
docker logs <backend> 2>&1 | grep '\[correlationId\]'
# или
bun run dev 2>&1 | grep 'email_taken'   # nx-таргет `backend:dev`, не systemd
bun run build && bun dist/auth/auth.e2e.js  # 18/18, включая correlationId-сквозняк
curl -v -X POST http://localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' -H 'x-correlation-id: debug-001' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"a@b.co","password":"s3cret-p4ss"}'
```
