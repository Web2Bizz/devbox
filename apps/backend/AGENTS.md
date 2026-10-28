# AGENTS.md — backend (Rush Code API)

Канон — корень [`AGENTS.md`](../../AGENTS.md). При расхождении побеждает корень.

## Стек

- NestJS 12 + TypeScript 6 + Zod 4 + Drizzle (см. `package.json`, `app.module.ts`).
- Wire-контракт: `@rush-code/contracts` (`packages/contracts`) зеркалит
  `contracts/openapi.yaml` поле-в-поле; `src/contracts.ts` — deprecated-реэкспорт.
- Конфиг/env: `src/env.ts` (+ `.env.example` в корне); обязательные переменные —
  fail-fast, тихие фолбэки запрещены (см. корень «Фолбэки запрещены по умолчанию»).

## Конвенции (коротко)

- Логи — только через `AppLogger` (`src/common/app-logger.service.ts`); `console.*`
  в runtime запрещён; normal path — однострочники без стеков/секретов (см. корень
  «Логирование — без стеков и секретов»).
- Storage: единственный корень — `REPOS_ROOT`; без него — 503/500, не `<cwd>/repos`.
- Проверки: `bun run lint` (`tsc --noEmit` + `biome lint`) и `bun run build`
  (детали — корень «Frontend — дизайн-система», backend-скрипты в `package.json`).
