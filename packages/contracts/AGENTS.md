# AGENTS.md — contracts (Rush Code wire-контракт)

Этот файл — канон пакета: назначение, структура, правила зеркалирования, скрипты.
Корень [`AGENTS.md`](../../AGENTS.md) хранит только ссылку сюда.

---

**Описание**: Единый wire-контракт бэкенд↔фронт: типы + zod v4 boundary-схемы, зеркалит `contracts/openapi.yaml`.
**Ключевые слова**: contracts, wire-contract, zod, openapi, backend, frontend

---

## `@rush-code/contracts`

Пакет хранит wire-типы и boundary-схемы, которыми бэкенд и фронт обмениваются данными. Назначение — единый источник типов для границы: бэкенд валидирует вход/выход, фронт парсит ответы. Рантайм-логики нет — только типы и схемы.

## Структура

```
src/
├─ index.ts — баррель (реэкспорт всех доменов)
├─ <domain>/ — доменная папка (health, session, auth, project, organization, …)
│   ├─ index.ts — баррель домена (реэкспорт `<domain>.ts` + `<domain>.schema.ts`)
│   ├─ <domain>.ts — entity-типы (только `export type`, `interface` запрещён)
│   └─ <domain>.schema.ts — zod v4 boundary-схемы (Standard Schema)
├─ sessions/ — доменный контракт `/api/v1/sessions*` (SessionInfo, SessionMessage,
│   SessionStreamFrame, SessionRunnerProvider, SessionInterruptResult, SessionModel)
└─ runs/ — доменный контракт `/api/v1/runs*` (RunInfo, CreateRunRequest, RunStreamFrame, ToolView; журнал/SSE-типы прототипа)
```

## Правила

- `contracts/openapi.yaml` — источник правды: пакет зеркалит `components/schemas` поле-в-поле. Расхождение YAML ↔ пакет — баг пакета, не фича.
- Имя: `contracts` основное (контракт + валидация границы), `entities` — содержимое пар.

## Скрипты

- `bun run build` — сборка пакета для потребителей (backend/frontend).
- `bun run dev` — watch-режим для локальной разработки.
- `bun run lint` — проверка типов (`tsc --noEmit`) + стиля (`biome lint`, общий конфиг `packages/biome-config`).
- `bun run test` — юнит-тесты схем.
