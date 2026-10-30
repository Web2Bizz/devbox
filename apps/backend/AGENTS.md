# AGENTS.md — backend (Rush Code API)

Канон — корень [`AGENTS.md`](../../AGENTS.md). При расхождении побеждает корень.

## Стек

- NestJS 12 + TypeScript 6 + Zod 4 + Drizzle (см. `package.json`, `app.module.ts`).
- Wire-контракт: `@rush-code/contracts` (`packages/contracts`) зеркалит
  `contracts/openapi.yaml` поле-в-поле; `src/contracts.ts` — deprecated-реэкспорт.
- OpenCode-граница: `/api/opencode/*` — deprecated-алиас на один релиз, публичный
  контракт — `/api/sessions*` (см. корень «OpenCode — граница backend/frontend»).
  Liveness — `GET /api/info`, `OpencodeService.checkConnectivity()` трактует
  `401+JSON` как `up`. Upstream-вызовы spread'ят `serveBasicAuthHeader()`;
  `global/health` шлёт его тоже (браузерный вход анонимен, upstream — Basic).
  Ошибки: 400/422 → `EXTERNAL_BAD_REQUEST`, 404 → `EXTERNAL_NOT_FOUND`
  (без `Retry-After`); `cause` сериализуется `serializeCause` (только debug).
- Конфиг/env: `src/env.ts` (+ `.env.example` в корне); обязательные переменные —
  fail-fast, тихие фолбэки запрещены (см. корень «Фолбэки запрещены по умолчанию»).

## Структура модулей (по факту на 2026-10-30)

```
src/
├─ main.ts, app.setup.ts, app.module.ts, env.ts (+ env*.spec) — бутстрап, strict-env
├─ contracts.ts — deprecated-реэкспорт @rush-code/contracts
├─ api/ — v1 REST: api.controller.ts (@Controller()+@Version('1')), dto.ts, proxy.service.ts
│         (legacy-прокси), version.ts (versioning URI), versioning.e2e.ts
├─ auth/ — аккаунты/JWT (auth.controller v1, jwt-auth.guard, auth.e2e)
├─ sessions/ — ДОМЕННЫЙ модуль (карточки 4–6): sessions.controller.ts (@Controller('sessions'),
│    GET /, POST /, GET status|models|providers|events, GET/POST :id/messages, POST :id/interrupt),
│    sessions.service.ts (гейт requireProject, трансляция runner→домен, toSessionInfo с model,
│    fetchWithRetry+serveBasicAuthHeader для create/prompt/interrupt, SSE через sse-relay),
│    sessions.dto.ts (реэкспорт-баррель), sessions.module.ts, sessions.e2e.ts
├─ opencode/ — DEPRECATED-зеркало /api/opencode/* (18 роутов, deprecated:true) + транспорт runner'а:
│    opencode.controller.ts, opencode.service.ts (dialUrl, checkConnectivity→/api/info,
│    fetchWithRetry/fetchWithTimeout — авторизацию НЕ добавляют), opencode-client.ts
│    (OpencodeSdkClient, lazy import @opencode-ai/sdk/v2), module, opencode.e2e.ts (37)
├─ opencode-keys/ — per-user ключи OpenCode + serveBasicAuthHeader (opencode-auth.service.ts)
│    + billing usage; opencode-keys.e2e.ts — эталон скана секретов/форм логов
├─ common/ — app-logger.service.ts (AppLogger + serializeCause), api-error.filter.ts,
│    correlation.interceptor.ts, noindex.interceptor.ts, zod-validation.pipe.ts, common.module.ts,
│    sse-relay.ts (общая механика SSE: probe до заголовков→503, abort downstream, бэкофф),
│    external/ (external-client.ts + .spec/.e2e, external-error.ts + .spec: маппинг EXTERNAL_*, retry.ts)
├─ projects/, organizations/ — C4: assertProjectAccessById (404 без утечки существования)
├─ repos/, workspaces/, storage/ — REPOS_ROOT (jail WorkspacePathService.resolveUserStrict/assertInsideJail)
├─ db/ — Drizzle (миграции apps/backend/drizzle, meta/ не коммитится)
└─ docker-registry/, npm-registry/, health/ — реестры-пинги и GET /health
```

`packages/contracts/src/` — 12 пар `entity.ts` + `entity.schema.ts` (`opencode-session/`,
`opencode-event/`, `sessions/` добавлены карточками 3–6, включая `SessionModel` для
`GET /api/sessions/models`); `contracts/openapi.yaml` — источник правды;
`contracts/opencode-stand-2.2.0.json` — провенанс живой спеки.

### Поток одного запроса

`JwtAuthGuard` (или публичный роут) → C4-гейт `assertProjectAccessById` (404 без утечки
существования) → гейт + jail модуля (`requireProject` / `WorkspacePathService` поверх
`REPOS_ROOT`) → upstream к runner: sdk (`OpencodeSdkClient`) для полей, которые генератор
НЕ режет, иначе сырой `fetchWithRetry` + `serveBasicAuthHeader` → маппинг сбоя в
`EXTERNAL_*` (`external-error.ts`) → `ApiErrorFilter` оборачивает в `ApiError`-envelope
(+`x-correlation-id`, cors) — normal path однострочник `[http] handled`, без стеков/секретов.

## Конвенции (коротко)

- Логи — только через `AppLogger` (`src/common/app-logger.service.ts`); `console.*`
  в runtime запрещён; normal path — однострочники без стеков/секретов (см. корень
  «Логирование — без стеков и секретов»).
- Storage: единственный корень — `REPOS_ROOT`; без него — 503/500, не `<cwd>/repos`.
- Проверки: `bun run lint` (`tsc --noEmit` + `biome lint`) и `bun run build`
  (детали — корень «Frontend — дизайн-система», backend-скрипты в `package.json`).
