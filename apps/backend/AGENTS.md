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

- `src/opencode/` — владелец opencode-транспорта: `opencode.controller.ts` (зеркало `/api/opencode/*`, deprecated), `opencode.service.ts` (`checkConnectivity` → `/api/info`, `fetchWithRetry`/`fetchWithTimeout`, `serveBasicAuthHeader` из `opencode-keys`), `opencode-client.ts` (SDK-обёртка), `opencode.module.ts`. `opencode.e2e.ts` — стенд-пробы.
- `src/sessions/` — доменный контракт `/api/sessions*` (карточки 4–6): `sessions.controller.ts`, `sessions.service.ts` (трансляция runner-форм + relay SSE через `common/sse-relay.ts`), `sessions.dto.ts`, `sessions.module.ts`, `sessions.e2e.ts`. Маршруты: `GET/POST /`, `GET status|models|providers|events` (SSE), `GET/POST :id/messages`, `POST :id/interrupt`. Модель — только на create (prompt-body upstream `model` не принимает); `SessionInfo.model` — из `Model.Ref` лист-ответа.
- `src/common/` — `app-logger.service.ts` (`serializeCause`), `external/external-client.ts` + `.spec.ts`, `external/external-error.ts`, `api-error.filter.ts`, `sse-relay.ts` (вынесенная механика SSE).
- `src/api/` — `proxy.service.ts` (legacy зеркало).
- `src/opencode-keys/` — per-user opencode-ключи, `opencode-auth.service.ts` (`serveBasicAuthHeader`), e2e-эталон скана секретов.
- `src/contracts.ts` — deprecated-реэкспорт `@rush-code/contracts`.
- `packages/contracts/src/` — 12 пар `entity.ts` + `entity.schema.ts` (`opencode-session/`, `opencode-event/`, `sessions/` добавлены карточками 3–6, включая `SessionModel` для `GET /api/sessions/models`); `contracts/openapi.yaml` — источник правды; `contracts/opencode-stand-2.2.0.json` — провенанс живой спеки.

## Конвенции (коротко)

- Логи — только через `AppLogger` (`src/common/app-logger.service.ts`); `console.*`
  в runtime запрещён; normal path — однострочники без стеков/секретов (см. корень
  «Логирование — без стеков и секретов»).
- Storage: единственный корень — `REPOS_ROOT`; без него — 503/500, не `<cwd>/repos`.
- Проверки: `bun run lint` (`tsc --noEmit` + `biome lint`) и `bun run build`
  (детали — корень «Frontend — дизайн-система», backend-скрипты в `package.json`).
