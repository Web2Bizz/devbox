# AGENTS.md

---

**Описание**: NestJS API, основной бэкенд Rush Code.
**Ключевые слова**: backend, nestjs, api, drizzle, zod

---

## Стек

- **NestJS** — HTTP-каркас и DI (модули, контроллеры, гарды)
- **TypeScript** — язык бэкенда
- **Zod** — валидация границы (DTO и boundary-схемы входа/выхода)
- **Drizzle ORM** — типовой доступ к Postgres (схема, миграции, запросы)
- **pg** — драйвер Postgres под Drizzle
- **@rush-code/contracts** — wire-типы и схемы, зеркало `contracts/openapi.yaml` поле-в-поле

## Поток одного запроса

`JwtAuthGuard` → C4-гейт `assertProjectAccessById` (404 без утечки) →
jail (`WorkspacePathService` поверх `REPOS_ROOT`) → upstream к runner:
sdk (`OpencodeSdkClient`) для полей, которые генератор НЕ режет, иначе сырой
`fetchWithRetry` + `serveBasicAuthHeader` → маппинг сбоя в `EXTERNAL_*`
(`external-error.ts`) → `ApiErrorFilter` в `ApiError`-envelope
(+`x-correlation-id`) — normal path однострочник `[http] handled`, без стеков/секретов.

## Фолбэки запрещены по умолчанию

Правила: никаких тихих фолбэков без явного указания пользователя. Валидация конфигов и env (`common/env/env.ts`, `.env.example`) — строго. `REPOS_ROOT` — единственный источник чтения И записи всего storage. Без конфига — отказ (storage-чтения 503 `EXTERNAL_UNAVAILABLE`, создание проектов 500), boot без корня продолжается с логом ERROR. Исключения: `GET /projects` и `GET /projects/:id` без корня — `corrupted` + `storage-unconfigured`. Фолбэк для тюнинга чтения (таймауты/ретраи/хосты dev-dial) — лишь исключение с комментарием, но НЕ для путей хранения.

### Не правильно

```ts
// Тихий fallback на cwd — проекты молча создаются не там
const root = process.env.REPOS_ROOT ?? path.join(process.cwd(), 'repos');
```

```ts
// WARN-тихоня вместо fail-fast
if (!process.env.REPOS_ROOT) {
  logger.warn('no root, using default');
  return path.join(process.cwd(), 'repos');
}
```

```ts
// Молча отдаём [] без корня
if (!reposRoot) return [];
```

### Правильно

```ts
// Fail-fast с понятной ошибкой
if (!process.env.REPOS_ROOT) {
  throw new Error('REPOS_ROOT is not set: задайте в .env (см. .env.example)');
}
```

```ts
// Без корня — отказ, а не fallback
if (!reposRoot) {
  throw new ExternalServiceError('EXTERNAL_UNAVAILABLE', 'storage-unconfigured', {
    retryAfter: 30,
    correlationId,
  });
}
```

## Логирование — без стеков и секретов в normal path

Правила: только через `AppLogger` (`src/common/logger/`), `console.*` в runtime запрещён. Уровни `debug → info → warn → error → fatal`, уважает `LOG_LEVEL`. Normal path — однострочники `[domain] op key=value` + `correlationId`, без `\n at `, без URL/query/headers/body/`Bearer`/секретов/PII. Стек/`cause` (санитизирован, ≤2000, через `serializeCause`) — только в `debug`. `ExternalClient` — только `service/operation/attempt/latencyMs/status/code`. e2e-скан секретов обязателен (эталон `src/processes/modules/ai/modules/opencode/__tests__/keys.e2e.ts`).

### Не правильно

```ts
// console в runtime
console.log('getUsage', response.data);
```

```ts
// Стек в error + секрет в сообщении
logger.error(`getUsage failed ${apiKey}\n at ${err.stack}`);
```

```ts
// URL/body в external-логe
logger.warn(`[external] retry ${url} body=${JSON.stringify(body)}`);
```

### Правильно

```ts
// Однострочник без секретов, стек только в debug
logger.warn(`[opencode-billing] getUsage status=${status} code=${code} [cid=${correlationId}]`);
logger.debug(`[opencode-billing] cause code=${code} detail=${serializeCause(err)}`);
```

```ts
// ExternalClient — только поля, без URL/body
logger.debug(`[external] start service=${service} operation=${op} method=${method}`);
logger.error(`[external] failure service=${service} operation=${op} status=${status} code=${code} attempt=${n} latencyMs=${ms}`);
```

## Скрипты

| Скрипт | Описание |
|---|---|
| `bun run dev` | watch-режим (nest + swc) |
| `bun run build` | сборка в `dist` |
| `bun run start` | запуск собранного `dist/main.js` |
| `bun run lint` | проверка типов (`tsc --noEmit`) + стиля (`biome`) |
| `bun run test` | юнит-спеки из `dist` (`*.spec.js`) |
| `bun run test:e2e` | полный e2e-сьют (build + все e2e/spec) |
| `bun run test:e2e:auth` / `:projects` / `:github` / `:repos` / `:opencode-keys` | точечные e2e |
| `bun run keys:reencrypt` | перешифровка opencode-ключей |
| `bun run db:check-integrity` | проверка целостности Drizzle-схемы |

## Scope-правила (кратко)

- Три слоя: `processes/` → `organizations/` (⊃ `modules/projects/`) → `common/`.
  Стрелка только вниз: `common/` не знает о доменах, `organizations/` не
  импортирует `processes/` (в т.ч. `ai`). `organizations/org-projects` проекции нет.
- `common/` — ОДИН `@Global()` модуль (`common.module.ts`); в подпапках
  `*.module.ts` запрещён (CoC §3). Новый кросс-доменный код — в `common/`.
- Вложенные модули — только `<parent>/modules/<sub>/` (CoC §2), наружу торчит
  родитель. Утилиты — `utils/<name>/` со своим `index.ts` и `__tests__/`.
  Тесты — `__tests__/` рядом с кодом (`*.spec.ts` / `*.e2e.ts`).
- Storage: `REPOS_ROOT` — единственный корень. fs — только через
  `common/storage` (`WorkspacePathService`) или `repository/**`; `cwd`/`__dirname`
  как корень запрещены.
- uuidv7 — только `Bun.randomUUIDv7()` (runtime Bun); своего util нет.
- DI-зависимости в конструкторах — `private readonly` (CoC §5).

## Конвенции (коротко)

- Логи — только через `AppLogger` (`src/common/logger/`); `console.*` в runtime запрещён;
  normal path — однострочники без стеков/секретов.
- Storage: единственный корень — `REPOS_ROOT`; без него — 503/500, не `<cwd>/repos`.
- Проверки: `bun run lint` (`tsc --noEmit` + `biome lint`) и `bun run build`.

## Дополнительные правила

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — структура модулей бэкенда (`src/`).
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — backend-дополнение
  к корневому [`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md).
