# План прототипа агентской системы (по ADR-0001 Rev.6 / ADR-0002 Rev.2)

> Источники: `docs/adr/0001-cloud-agent-harness.md` (Rev.6), `docs/adr/0002-agent-harness-prototype.md` (Rev.2).
> Глубина: Эпики + шаги (7 эпиков, БЕЗ нарезки на Trello-карточки). Без TCO/сроков — только scope + критерии готовности.
> forwardOnly: baseCommit `00c39` — не откатываться, только новый файл в `.plans/`. Код проекта не трогать.

---

## §0. Связки (ADR → план, инварианты, решения)

### 0.1. Таблица ADR → план

| ADR-источник | Содержание | Эпик плана |
| --- | --- | --- |
| ADR-0001 §8.7.1 / ADR-0002 §6.1 | DDL `run_runs/run_steps/run_events/run_leases` (+ полные `run_effects/run_definitions` как ориентир) | E2 |
| ADR-0001 §8.7.2 / ADR-0002 §6.2 | REST `/api/runs*` (`CreateRunRequest`/`RunInfo`, C4, `VERSION_NEUTRAL`, `ZodValidationPipe`, `ApiError`) | E1 (схемы), E3 (API) |
| ADR-0001 §8.7.3 / ADR-0002 §6.3 | SSE-кадр `RunStreamFrame` (10 типов; прототип — 4), `relaySse` catch-up + live | E1 (схемы), E3 (endpoint), E4 (append), E6 (фронт) |
| ADR-0001 §8.1+§8.7.4 / ADR-0002 §6.4 | `ToolDescriptor` / `ToolView` (zod), политика в дескрипторе, префикс источника | E1 (схемы), E4 (реестр), E5 (enforcement) |
| ADR-0001 §9.8 / ADR-0002 §5 (диаграмма) | `ModelGateway` (1 провайдер, `tools?: ToolView[]`, `need`-флаги) | E4 |
| ADR-0001 §9.2 / ADR-0002 §6.1, D9 | Claim-loop `SKIP LOCKED`, `run_leases` упрощённые (без `epoch`, `TODO(full-fencing)`) | E2 (таблица), E4 (loop) |
| ADR-0001 §9.3 / ADR-0002 D8 | Dual-write `intent → confirm`, трейлер `(run_id, step_id)` как identity (`TODO(dual-write-reconcile)`) | E4 (intent в прототипе), §8 (отложено) |
| ADR-0001 §9.4 / ADR-0002 §6.1, §7-п.7 | `1 run = 1 ветка `agent/<run_id>` + 1 worktree в jail`, `WorkspacePathService`, флаг «без сабмодулей» | E4 |
| ADR-0001 §9.6 / ADR-0002 D7 | Hot-reload данными (`definitions.active`), пиннинг `definition_set_hash` по `commit_sha` | E5 |
| ADR-0001 §9.7 / ADR-0002 D6 | Стриминг `relaySse` + курсор `seq`, probe-до-заголовков, `x-accel-buffering: no` | E3, E6 |
| ADR-0001 §18.2 (тонкий срез 7 шагов) / ADR-0002 §7 | Порядок сборки E1→E7, каждый шаг независимо проверяем | Структура настоящего плана |
| ADR-0001 §18.1 / ADR-0002 §7 | Сквозной критерий готовности | §9 |
| ADR-0001 §18.3 / ADR-0002 §8 | Отложенное с TODO-метками | §8 |
| ADR-0001 §16 / ADR-0002 §9 | Канон репо и образцы для переиспользования | reuse-блок в конце |

### 0.2. Инварианты (обязательны для всех эпиков)

| Инвариант | Формулировка | Где проверяется |
| --- | --- | --- |
| I1 | Воркеры stateless (состояние только в БД-журнале + git) | E4 (claim-loop без локального состояния между итерациями) |
| I2 | Два носителя состояния (БД-журнал + git-репозиторий) | E2 (журнал), E4 (ветка/worktree) |
| I3 | Event-driven, журнал — источник истины для восстановления | E2–E4, E7 (replay из журнала) |
| I4 | Стек TS/Node или Bun (факт: `bun@1.4.2`, NestJS 12, TS, `zod ^4.6.5`, `drizzle-orm ^0.45.3` + `pg ^8.12`, `nx`, `biome`; фронт Next.js 16.3 Turbopack, React Query) | Все эпики |
| I5 | Forward-Only: история `baseCommit` никогда не переписывается назад; допустим только рост (`revert`, новые коммиты), `reset --hard`/`push --force` запрещены | E4 (jail + deny-политика), §9 |
| I6 | Модулит: один деплоящийся NestJS-монолит (`processes/ → organizations/ → common/`); новые границы — только NestJS-модули (`<parent>/modules/<sub>/`), отдельных микросервисов/service mesh/кросс-сервисных саг нет | E3–E4 (раскладка `processes/modules/runs/`, `processes/modules/workers/`) |

### 0.3. Решения D1–D9 (ADR-0002 §3, итог)

| # | Решение | Эпик-носитель |
| --- | --- | --- |
| D1 | Ядро V3: собственное event-sourced ядро на Postgres в монолите | E2–E4 |
| D2 | Исполнитель — существующий opencode-runner, без per-run ресурсов (логическая изоляция: jail + ветка/worktree + claim-loop + C4) | E4 |
| D3 | Инструменты — `ToolDescriptor` + проекция `ToolView` (модель видит только `{id,title,description,inputSchema,outputSchema?}`) | E1, E4, E5 |
| D4 | Инструкции — skills как git-артефакты, эффект наследуется от скриптов, enforcement `allowed-tools` — наше | E5 |
| D5 | MCP — только потребление: stateless-клиент + один `initialize`-фолбэк в прототипе; своего MCP-сервера нет (`TODO(mcp-dual-era)` на полный dual-era) | E4, §8 |
| D6 | Стриминг — `relaySse` + курсор `seq` из журнала | E3, E6 |
| D7 | Hot-reload — данными (`definitions.active`), пиннинг `definition_set_hash` на run | E5 |
| D8 | Dual-write — `intent → confirm`, трейлер как identity (полный reconcile — `TODO(dual-write-reconcile)`) | E4 (intent), §8 |
| D9 | Fencing в прототипе — упрощённый (`SKIP LOCKED`, `epoch` — `TODO`); прототип переживает только graceful-рестарт | E2, E4, §8 |

---

## E1. Контракты-минимум

**Цель.** Зафиксировать wire-контракт runs: типы + `zod v4` boundary-схемы + `openapi.yaml`-патч. Зеркало поле-в-поле (расхождение YAML ↔ пакет = баг пакета).

**Scope.**

Входит:

- `packages/contracts/src/runs/runs.ts` — `export type` only (без `interface`): `RunStatus`, `RunStepStatus`, `RunStepType`, `RunInfo`, `RunInfoList`, `CreateRunRequest`, `RunStreamFrame` (4 типа прототипа), `ToolView`-реэкспорт/ссылка (полные `ToolDescriptor` — см. черновик, в прототипе фиксируем минимум для `ToolView`).
- `packages/contracts/src/runs/runs.schema.ts` — `zod v4` boundary-схемы (`satisfies z.ZodType<…>`): `runStatusSchema`, `runInfoSchema`, `createRunRequestSchema`, `runStreamFrameSchema` (+ 4 суженных фрейма при необходимости), `toolIdSchema`/`toolViewSchema`-минимум.
- `packages/contracts/src/runs/index.ts` — баррель домена.
- Патч `contracts/openapi.yaml`: `components/schemas` (`RunInfo`, `RunInfoList`, `CreateRunRequest`, `RunStreamFrame`, `ToolView`) + `paths /api/runs*` (минимум E3).
- `ApiError`-envelope без изменений (переиспользование `packages/contracts/src/api-error/`).

Не входит:

- Полный набор SSE-типов (остальные 6 — только схема + `TODO`, реализация в E3/E4 — заглушки типов без эмиссии).
- Полный `ToolDescriptor` с `transport/effects/limits/auth` валидацией на границе (фиксируем схему, enforcement — E4/E5).
- `run_effects`/`run_definitions` wire-типы (БД-ориентир E2, не публичный контракт прототипа).
- Биллинг/OTel-поля, per-run ресурсы, дашборды.

**Пути файлов.**

- Создать: `packages/contracts/src/runs/runs.ts`, `packages/contracts/src/runs/runs.schema.ts`, `packages/contracts/src/runs/index.ts`.
- Изменить: `packages/contracts/src/index.ts` (реэкспорт домена `runs`), `contracts/openapi.yaml` (патч схем + путей).
- Образцы стиля (читать, не менять): `packages/contracts/src/sessions/sessions.ts`, `packages/contracts/src/sessions/sessions.schema.ts`, `packages/contracts/src/sessions/index.ts`, `packages/contracts/AGENTS.md`.
- Проверки рядом: `packages/contracts` — `bun run lint` (`tsc --noEmit` + `biome lint`), `bun run build`, `bun run test` (юнит-тесты схем).

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §8.7.2–§8.7.4, ADR-0002 §6.2–§6.4.

```ts
// packages/contracts/src/runs/runs.ts (DRAFT ~30 строк)
import type { SessionInfoModel } from '../sessions/sessions';

export type RunStatus = 'open' | 'running' | 'awaiting_human' | 'failed' | 'merged' | 'abandoned';
export type RunStepStatus = 'pending' | 'running' | 'committed' | 'failed' | 'skipped';
export type RunStepType = 'llm.call' | 'tool.call' | 'sandbox.exec' | 'git.commit' | 'await_human' | 'router';

export type RunInfo = {
  id: string;                    // uuidv7 (Bun.randomUUIDv7())
  projectId: string;             // uuid (C4-scope)
  title: string | null;          // explicit nullable, never optional
  status: RunStatus;
  definitionSetHash: string;     // пин §9.6 ADR-0001
  baseCommit: string;            // I5, sha
  branch: string;                // agent/<run_id>
  agentId: string | null;        // registry id, nullable как у sessions
  model: SessionInfoModel | null; // reuse из sessions (never duplicate)
  createdAt: string;             // ISO-8601 Z
  updatedAt: string;
};
export type RunInfoList = Array<RunInfo>;
export type CreateRunRequest = {
  projectId: string;
  title?: string;
  agentId?: string;
  model?: SessionInfoModel;
  definitionSetHash?: string;    // default: active-набор
};

// Прототип: только 4 типа кадров (остальные — схема + TODO)
export type RunStreamFrameTypeProto = 'run.started' | 'run.step.started' | 'run.step.committed' | 'run.step.failed';
export type RunStreamFrame = {
  id: string;                    // seq как строка, монотонный per-run
  type: RunStreamFrameTypeProto; // frozen-расширение до полного union позже
  data: Record<string, unknown>;
  run?: string;                  // hoisted run id (аналог session)
};
```

```ts
// packages/contracts/src/runs/runs.schema.ts (DRAFT ~40 строк)
import { z } from 'zod';
import type { CreateRunRequest, RunInfo, RunInfoList, RunStreamFrame } from './runs';
import { sessionInfoModelSchema, agentIdSchema } from '../sessions/sessions.schema';

export const runStatusSchema = z.enum(['open', 'running', 'awaiting_human', 'failed', 'merged', 'abandoned']);
export const runInfoSchema = z.object({
  id: z.uuid({ error: 'Field "id" is required' }),
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  title: z.string().nullable(),
  status: runStatusSchema,
  definitionSetHash: z.string({ error: 'Field "definitionSetHash" is required' }).min(1),
  baseCommit: z.string({ error: 'Field "baseCommit" is required' }).min(1),
  branch: z.string({ error: 'Field "branch" is required' }).min(1),
  agentId: agentIdSchema.nullable(),
  model: sessionInfoModelSchema.nullable(),
  createdAt: z.iso.datetime({ error: 'Field "createdAt" must be an ISO-8601 timestamp' }),
  updatedAt: z.iso.datetime({ error: 'Field "updatedAt" must be an ISO-8601 timestamp' }),
}) satisfies z.ZodType<RunInfo>;
export const runInfoListSchema = z.array(runInfoSchema) satisfies z.ZodType<RunInfoList>;
export const createRunRequestSchema = z.object({
  projectId: z.uuid({ error: 'Field "projectId" is required' }),
  title: z.string().min(1).max(200).optional(),
  agentId: agentIdSchema.optional(),
  model: sessionInfoModelSchema.optional(),
  definitionSetHash: z.string().min(1).optional(),
}) satisfies z.ZodType<CreateRunRequest>;
export const runStreamFrameSchema = z.object({
  id: z.string({ error: 'Field "id" is required' }).min(1),
  type: z.enum(['run.started', 'run.step.started', 'run.step.committed', 'run.step.failed']),
  data: z.record(z.string(), z.unknown()),
  run: z.string().optional(),
}) satisfies z.ZodType<RunStreamFrame>;

// ToolView — единственное, что уходит в модель (D3; обрезка на сервере)
export const toolViewSchema = z.object({
  id: z.string().min(1).max(200).regex(/^(mcp|skill|native):[a-z0-9/_-]+$/),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});
```

**Проверки.**

- `bun run lint` в `packages/contracts` (типы + `biome`), `bun run build`, `bun run test` (юнит-тесты схем: валид/невалид `CreateRunRequest`, 4 кадра, `ToolView`-префикс).
- Ручной diff-аудит: каждое поле `runs.ts` ↔ `openapi.yaml components/schemas` 1:1 (nullable explicit, never optional — как у sessions).
- `grep` на `interface` в `src/runs/` — ноль совпадений (только `export type`).

**Критерий готовности.** `runs.ts`/`runs.schema.ts`/`index.ts` + `openapi.yaml`-патч смержены; зеркало поле-в-поле; `lint/build/test` пакета зелёные; E3 может импортировать схемы без правок контракта.

**Зависимости.** Blocked by: нет (корень цепочки; образцы sessions уже в репо).

---

## E2. БД-минимум

**Цель.** Дополнить `common/db/schema.ts` таблицами `run_runs/run_steps/run_events` + упрощённой `run_leases` (без `epoch`), теми же конвенциями, что у `project_sessions`/`session_messages`; миграция `drizzle/`; `db:check-integrity` зелёный.

**Scope.**

Входит:

- `run_runs(id uuid PK defaultRandom, projectId FK→projects RESTRICT, title?, status default 'open', definitionSetHash, baseCommit, branch, worktree, sandboxId?, agentId?, model jsonb?, createdAt/updatedAt defaultNow notNull, deletedAt?)`, индексы `(projectId)`, `(projectId,status)`.
- `run_steps(id uuid PK, runId FK RESTRICT, seq bigint per-run, type, status default 'pending', attempt, inputHash, idempotencyKey UNIQUE, observedEpoch default 0, resultRef? jsonb, error? jsonb, startedAt/endedAt?)`, `UNIQUE(runId,seq)`, индекс `(runId,status)`.
- `run_events(id uuid PK, runId FK RESTRICT, seq bigint per-run, type, data jsonb, prevHash, createdAt defaultNow)`, `UNIQUE(runId,seq)`; UPDATE/DELETE запрещены политикой (доктрина, не триггер в прототипе).
- `run_leases(runId PK FK CASCADE, holder, expiresAt)` — упрощённая, без `epoch`/`soft-delete`; пометка `TODO(full-fencing)` рядом.
- `*Row`-типы (`RunRow`/`RunStepRow`/`RunEventRow`/`RunLeaseRow`) рядом с существующими.
- Миграция `drizzle/` (`drizzle-kit`), `db:check-integrity`.

Не входит:

- `run_effects` + reconciliation (ориентир DDL из ADR — только как комментарий/`TODO(dual-write-reconcile)`; таблица может быть отложена полностью — см. §8; в прототипе git-ошибка = `step.failed`).
- `run_definitions`/`tool_defs` полнота (E5 хранит определения минимально; индексы метаданных — позже).
- `epoch`/`FOR UPDATE` fencing, advisory-lock очереди мержа, партиционирование, read-replica (см. §8).
- CHECK-ограничения статусов в SQL сверх `default` (frozen-перечисления живут в контракте; CHECK — только если это уже конвенция файла).

**Пути файлов.**

- Изменить: `apps/backend/src/common/db/schema.ts` (таблицы + `*Row`-типы).
- Создать: `apps/backend/src/common/db/drizzle/NNNN_*.sql` (миграция через `drizzle-kit`), при необходимости патч `schema-integrity` снапшота тем же механизмом, что и `migrations 0002/0003`.
- Образцы: `projectSessions` (~строки 92–115 `schema.ts`), `sessionMessages` (127+), `sessionAgents` (159+); `docs/manual-migration-orgs-layout.md` (прецедент ручной миграции с `pg_dump`-бэкапом); `docs/backend-hardening-plan.md` (testcontainers + `db:check-integrity`).
- Проверки: `bun run db:check-integrity`, `bun run lint`, `bun run build`.

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §8.7.1, ADR-0002 §6.1.

```ts
// apps/backend/src/common/db/schema.ts — дополнение (DRAFT ~45 строк)
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// run_runs — реестр run (мягкое удаление, история не стирается)
export const runRuns = pgTable('run_runs', {
  id: uuid('id').primaryKey().defaultRandom(), // run_id; в app — Bun.randomUUIDv7()
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'restrict' }), // C4-scope, RESTRICT как у sessions
  title: text('title'),
  status: text('status').notNull().default('open'),
  definitionSetHash: text('definition_set_hash').notNull(),
  baseCommit: text('base_commit').notNull(),   // I5, событие run.started
  branch: text('branch').notNull(),            // agent/<run_id>
  worktree: text('worktree').notNull(),        // REPOS_ROOT/.../content/wt/<run_id>
  sandboxId: text('sandbox_id'),               // opencode-runner слот
  agentId: text('agent_id'),                   // registry id, nullable как у sessions
  model: jsonb('model'),                       // SessionInfoModel | null
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // soft-delete, чтение — isNull(deletedAt)
}, (t) => [index('run_runs_project_idx').on(t.projectId), index('run_runs_project_status_idx').on(t.projectId, t.status)]);

// run_steps — шаги run (write-ahead result, см. ADR-0001 §9.1)
export const runSteps = pgTable('run_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runRuns.id, { onDelete: 'restrict' }),
  seq: bigint('seq', { mode: 'number' }).notNull(), // монотонный per-run
  type: text('type').notNull(),                     // llm.call | tool.call | sandbox.exec | git.commit | await_human | router
  status: text('status').notNull().default('pending'),
  attempt: integer('attempt').notNull().default(0),
  inputHash: text('input_hash').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(), // hash(run_id, step_id, effect_class, input_hash)
  observedEpoch: integer('observed_epoch').notNull().default(0), // fencing — TODO(full-fencing)
  resultRef: jsonb('result_ref'),                   // {artifact_ref, hash} | null до committed
  error: jsonb('error'),                            // {code, message-sanitized} | null
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [uniqueIndex('run_steps_run_seq_idx').on(t.runId, t.seq), index('run_steps_run_status_idx').on(t.runId, t.status)]);

// run_events — append-only журнал (источник истины; UPDATE/DELETE запрещены политикой)
export const runEvents = pgTable('run_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runRuns.id, { onDelete: 'restrict' }),
  seq: bigint('seq', { mode: 'number' }).notNull(), // id SSE-кадра, per-run
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  prevHash: text('prev_hash').notNull(),            // tamper-evident цепочка (§9.9)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('run_events_run_seq_idx').on(t.runId, t.seq)]);

// run_leases — аренда run (эфемерно, без soft-delete; EPOCH — TODO(full-fencing))
export const runLeases = pgTable('run_leases', {
  runId: uuid('run_id').primaryKey().references(() => runRuns.id, { onDelete: 'cascade' }),
  holder: text('holder').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export type RunRow = typeof runRuns.$inferSelect; // + RunStepRow / RunEventRow / RunLeaseRow рядом
```

**Проверки.**

- `bun run db:check-integrity` зелёный; миграция применяется на чистом `postgres:16-alpine` (тот же механизм, что e2e-контейнер).
- `bun run lint` + `bun run build` бэкенда зелёные.
- Ручные asserts: `id` генерируется в app через `Bun.randomUUIDv7()` (не полагаться на `defaultRandom` как истину); чтение `run_runs` всегда с `isNull(deletedAt)`; FK — `restrict` (кроме `run_leases` → `cascade`); `uuidv7`-комментарий в коде.

**Критерий готовности.** Таблицы + миграция + `*Row`-типы в `schema.ts`; `db:check-integrity` зелёный; E3/E4 могут писать `run_runs/run_steps/run_events` без новых DDL-правок.

**Зависимости.** Blocked by: E1 (статусы/типы frozen в контракте — DDL обязан им соответствовать).

---

## E3. API-минимум

**Цель.** `processes/modules/runs/`: `POST /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events` (через `relaySse`, probe + C4 + `VERSION_NEUTRAL` + `ZodValidationPipe` + `ApiError`-envelope).

**Scope.**

Входит:

- `runs.module.ts` / `runs.controller.ts` / `runs.service.ts` / `runs.dto.ts` (реэкспорт `@rush-code/contracts` — как `sessions.dto.ts`) в `apps/backend/src/processes/modules/runs/`.
- `POST /api/runs` — вход `CreateRunRequest`, успех 201 `RunInfo`; 400/404 (C4: чужой проект → 404 без утечки)/503 `EXTERNAL_UNAVAILABLE` + `Retry-After: 30` (через `dbUnavailable`).
- `GET /api/runs/:id` — 200 `RunInfo`; те же ошибки.
- `GET /api/runs/:id/events?cursor=` — SSE кадров E1; до заголовков — JSON-ошибки через probe (down → честный 503, не 200-тишина); после — только close; `JwtAuthGuard` + C4 `ProjectAccessService`; механика `relaySse` 1:1 (probe, abort на disconnect, `x-accel-buffering: no` + `x-correlation-id`, `return()`-гонка 1500 мс); catch-up `seq > cursor` → live (`LISTEN/NOTIFY` несёт только `run_id + next_seq`); кадры без `run` дропаются; фильтр — scope gated-проекта.
- `VERSION_NEUTRAL`, `ZodValidationPipe`, замороженный `ApiError {code,message,correlationId}` + `x-correlation-id`; логи только `AppLogger` (normal path — однострочники без URL/body/секретов).

Не входит:

- `GET /api/runs?projectId=` список, `POST :id/interrupt`, `POST :id/upgrade-definition` (контракт E1 их описывает, реализация — после прототипа; `upgrade-definition` в терминальном → 409 — тоже позже).
- Полный `RunStreamFrame`-union (10 типов): endpoint отдаёт 4 типа прототипа, остальные — схема + `TODO`.
- Reconciliation/merge-очередь, OTel-дашборды, биллинг.

**Пути файлов.**

- Создать: `apps/backend/src/processes/modules/runs/runs.module.ts`, `runs.controller.ts`, `runs.service.ts`, `runs.dto.ts` (+ `__tests__/` рядом для спеки при необходимости).
- Переиспользовать без копипасты: `apps/backend/src/common/sse/sse-relay.ts` (`relaySse`), `apps/backend/src/processes/modules/ai/modules/sessions/sessions.controller.ts` (`:202 events`-образец), `session-harness.service.ts` (`streamEvents`: replay буфера + live-хвост, `LOCAL_IDLE_MS`/`STREAM_CAP_MS`), `sessions.dto.ts` (реэкспорт-паттерн), `common/db/DbService` (`dbUnavailable` → 503), `common/logger` (`AppLogger`), `JwtAuthGuard` + `ProjectAccessService` (C4).
- Регистрация модуля: по `ARCHITECTURE.md` (модулит: `processes/modules/runs/`, вложенность только `<parent>/modules/<sub>/`).

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §8.7.2–§8.7.3 + §9.7, ADR-0002 §6.2–§6.3.

```ts
// runs.dto.ts (DRAFT ~12 строк) — паттерн sessions.dto.ts
export { createRunRequestSchema, runInfoSchema, runInfoListSchema, runStreamFrameSchema,
  type CreateRunInput, type RunInfo, type RunInfoList, type RunStreamFrame } from '@rush-code/contracts';

// runs.controller.ts — сигнатуры (DRAFT ~35 строк)
@UseGuards(JwtAuthGuard)
@Post()
@Version(VERSION_NEUTRAL)
@HttpCode(HttpStatus.CREATED)
async create(
  @ReqUser() identity: RequestIdentity,
  @Body(new ZodValidationPipe(createRunRequestSchema)) body: CreateRunInput,
  @Headers('x-correlation-id') correlationId?: string,
): Promise<RunInfo> { return this.runs.create(identity.id, body, correlationId ?? ''); }

@Get(':id')
@Version(VERSION_NEUTRAL)
async getOne(@ReqUser() identity: RequestIdentity, @Param('id') id: string,
  @Headers('x-correlation-id') correlationId?: string): Promise<RunInfo> {
  return this.runs.getOne(identity.id, id, correlationId ?? '');
}

@Get(':id/events') // SSE: до заголовков — JSON-ошибки через probe, после — только close
@Version(VERSION_NEUTRAL)
async events(@ReqUser() identity: RequestIdentity, @Req() req: ExpressRequest,
  @Res({ passthrough: false }) res: ExpressResponse, @Param('id') id: string,
  @Query('cursor') cursor?: string, @Headers('x-correlation-id') correlationId?: string,
): Promise<void> { return this.runs.streamEvents(identity.id, id, cursor, correlationId ?? '', req, res); }
```

```ts
// runs.service.streamEvents — relaySse вызов (DRAFT ~25 строк)
await relaySse({
  operation: 'GET /api/runs/:id/events', cid, req, res, logger, prefix: '[runs]',
  probe: async () => (await this.db.isAvailable() ? 'up' : 'down'), // до заголовков → честный 503
  unreachableError: () => this.db.dbUnavailable(cid),               // EXTERNAL_UNAVAILABLE + Retry-After: 30
  subscribeFailedError: (err) => toExternalError(err, cid),
  subscribe: (signal) => this.runEventSource.subscribe(runId, cursor, signal), // catch-up seq>cursor + live LISTEN/NOTIFY
  mapFrame: (row) => ({ id: String(row.seq), type: row.type, data: row.data, run: runId }), // RunStreamFrame
  filterFrame: (f) => typeof (f as RunStreamFrame).run === 'string', // кадры без run дропаются
});
```

**Проверки.**

- `bun run lint` + `bun run build` бэкенда зелёные.
- Ручные asserts (до E7): `POST /api/runs` без `projectId` → 400; чужой `projectId` → 404 без утечки (C4); даун БД → 503 + `Retry-After: 30`; `GET events` при даун-источнике → 503 до заголовков (не 200-тишина); disconnect клиента — abort upstream (лог `debug`, без стека).
- e2e-скан секретов (эталон `keys.e2e.ts`) — в E7, но структура ошибок уже обязана быть `ApiError`-envelope + `x-correlation-id`.

**Критерий готовности.** Три endpoint отвечают по контракту E1; SSE идёт через `relaySse` с курсором; C4 + `ApiError` + probe-семантика 1:1 с sessions-образцом.

**Зависимости.** Blocked by: E1 (схемы), E2 (таблицы).

---

## E4. Движок-минимум

**Цель.** In-process claim-loop в `WorkersModule`: `claim → llm.call` (заглушка `ModelGateway`, 1 провайдер) `→ tool.call` (native `git.recon` + 1 внешний MCP) `→ sandbox.exec` (opencode-runner `:4096`) `→ step.committed → SSE`; jail `WorkspacePathService`; ветка `agent/<run_id>`.

**Scope.**

Входит:

- Claim-loop в `processes/modules/workers/` (scaffold `WorkersModule` → рабочий провайдер): `SELECT … FOR UPDATE SKIP LOCKED` по `run_leases`/outbox, heartbeat продлением `expiresAt` владельцем; запись результата в **одной транзакции** (lease-check → append `run_steps`/`run_events`); `TODO(full-fencing)` рядом с местом, где позже будет `epoch` + `FOR UPDATE` по строке lease.
- `llm.call` — заглушка `ModelGateway` с одним провайдером (интерфейс + адаптер-заглушка; логические имена моделей, `tools?: ToolView[]`, `need`-флаги; журналируется нормализованный запрос/ответ + `usage`).
- `tool.call` — `ToolRegistry`: native `git.recon` (in-process, эффект `read`) + 1 внешний MCP-инструмент через stateless-клиент (modern + один `initialize`-фолбэк; `TODO(mcp-dual-era)` на полный dual-era/Tasks); каждый `tools/call` — шаг журнала (`request_hash/response_hash/attempt/durationMs/bytesIn-Out`); разрыв = переотправка с новым id **с проверкой по `request_hash`**; в модель уходит только `ToolView`.
- `sandbox.exec` — существующий opencode-runner (`:4096`, back-сеть) через `OpencodeSdkClient` / `fetchWithRetry` + `serveBasicAuthHeader`; ошибки → `EXTERNAL_*` → `ApiError`-envelope; без per-run ресурсов (квота = лимиты compose + диск).
- `git.commit` (intent в прототипе): `INSERT intent`-эффект → `git commit` с детерминированным трейлером `Run-Id/Step-Id` → append `step.committed`; git-ошибка = `step.failed`, без авто-догона (`TODO(dual-write-reconcile)`).
- Ветка `agent/<run_id>` + worktree `REPOS_ROOT/.../content/wt/<run_id>` через `WorkspacePathService.ensureDir` + `assertInsideJail` (путь никогда не из `cwd`/`__dirname`); `baseCommit` фиксируется в `run.started`; Forward-Only (`merge-base --is-ancestor`, deny `reset --hard`/`push --force`); флаг «без сабмодулей».
- Append `step.committed` → событие SSE (источник для E3 catch-up/live); `heartbeat`-комментарий `:\n\n` ~15 с.

Не входит:

- Полный fencing (`epoch`, `FOR UPDATE` по lease) — `TODO(full-fencing)`; kill -9 посреди шага не переживается (только graceful-рестарт).
- `run_effects` + reconciliation-job по трейлерам (`git log --grep`, `superseded`, rebase-правило) — `TODO(dual-write-reconcile)`.
- MCP dual-era полностью, Tasks-расширение (`tasks/get`), `ttlMs/cacheScope`-кэш — `TODO(mcp-dual-era)`; своего MCP-сервера нет вообще (D5).
- Merge-очередь (`pg_advisory_xact_lock`), `resolve.conflict`, push/PR fail-closed, GC worktree по лимитам, OTel-спаны, биллинг.

**Пути файлов.**

- Изменить: `apps/backend/src/processes/modules/workers/workers.module.ts` (scaffold → claim-loop провайдер(ы) + `__tests__/`).
- Создать (внутри `workers/modules/<sub>/` по модулиту): claim-loop сервис, `model-gateway/` (интерфейс + заглушка-адаптер), `tool-registry/` (native `git.recon` + MCP-клиент), `sandbox/` (тонкий провайдер поверх `OpencodeSdkClient`/`fetchWithRetry`), git-хелпер поверх `repository/{repos,workspaces,clone}` + `utils/{repos-git,submodules}`.
- Переиспользовать: `common/db/DbService`, `common/storage/workspace-path.service.ts` (`assertInsideJail/ensureDir/removeDir`), `common/sse/sse-relay.ts` (только E3, движок лишь append-ит), `OpencodeSdkClient` + `fetchWithRetry` + `serveBasicAuthHeader` (задел исполнителя), `AppLogger` + `ExternalClient`-семантика, `Bun.randomUUIDv7()`.
- Конвенции: `private readonly` DI, `utils/<name>/index.ts` + `__tests__`, без `*.module.ts` в `common/`-подпапках.

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §9.1–§9.2 + §9.5 + §9.8, ADR-0002 §5 + D2/D5/D9.

```ts
// ModelGateway интерфейс + заглушка (DRAFT ~22 строки, ADR-0001 §9.8)
interface ModelGateway {
  stream(req: { model: string; system?: string; messages: Message[];
    tools?: ToolView[]; responseFormat?: JSONSchema; // только ToolView, не полный дескриптор (D3)
    maxTokens?: number; temperature?: number;
    need: { toolCalls?: boolean; jsonSchema?: boolean; vision?: boolean; reasoning?: boolean };
  }): AsyncIterable<ModelEvent>; // {type:'delta'|'tool_call'|'usage'|'done'}
}
class StubModelGateway implements ModelGateway { // 1 провайдер в прототипе
  async *stream(req: GatewayReq): AsyncIterable<ModelEvent> {
    this.logger.info(`[runs] llm.call model=${req.model} tools=${req.tools?.length ?? 0}`, cid);
    yield { type: 'delta', text: 'stub-turn' }; // заглушка: журналируется как нормализованный ответ + usage
    yield { type: 'done', usage: { in: 0, out: 1 } };
  }
}
```

```ts
// Workers claim-loop псевдокод (DRAFT ~28 строк, ADR-0001 §9.2; TODO(full-fencing))
async function claimLoop(): Promise<void> {
  for (;;) {
    const lease = await db.tx(async (tx) => // claim свободной работы
      tx.query(`SELECT * FROM run_leases WHERE expires_at < now() LIMIT 1 FOR UPDATE SKIP LOCKED`));
    if (!lease) { await sleep(POLL_MS); continue; }
    await touchLease(lease.runId, HOLDER, TTL); // heartbeat — продление владельцем
    const step = await planNextStep(lease.runId); // llm.call → tool.call → sandbox.exec → git.commit(intent)
    try {
      const out = await runStep(step); // native git.recon | MCP tools/call | opencode-runner :4096
      await db.tx(async (tx) => {       // ОДНА транзакция: lease-check → append
        // TODO(full-fencing): SELECT leases … FOR UPDATE + проверка epoch/holder; несовпадение → fenced + останов
        await tx.insert(runSteps).values({ ...step, status: 'committed', resultRef: out.artifactRef });
        await tx.insert(runEvents).values({ runId: step.runId, seq: step.seq, type: 'run.step.committed', data: out, prevHash });
      });
    } catch (err) { await appendStepFailed(step, sanitize(err)); } // git-ошибка = step.failed; TODO(dual-write-reconcile)
  }
}
```

**Проверки.**

- `bun run lint` + `bun run build` зелёные; юнит-спеки claim-loop (claim → heartbeat → append; зомби-lease перехватывается).
- Ручные asserts: worktree создан внутри jail (`assertInsideJail`), ветка `agent/<run_id>` существует, `baseCommit` записан в `run.started`; повторный `tools/call` с тем же `request_hash` не двоит эффект; даун opencode-runner → `EXTERNAL_*` + `step.failed` (не тишина); логи — однострочники без URL/body/секретов.
- e2e-скан секретов (в E7).

**Критерий готовности.** Один run in-process проходит `claim → llm.call → tool.call → sandbox.exec → step.committed → SSE-кадр`; worktree в jail; журнал — истина (рестарт процесса продолжает со следующего незавершённого шага, `committed` не пере-исполняется).

**Зависимости.** Blocked by: E2 (таблицы/leases), E3 (journal-append + SSE-источник). Параллельно с E3 — только по замороженному контракту E1.

---

## E5. Агенты + инструкции

**Цель.** Реестр агентов (`AgentBase` + `AskAgent`) + skills-лоадер (frontmatter → тело → ресурсы, 1 пилот-скилл, `allowed-tools` deny-by-default) + пиннинг `definition_set_hash` по `commit_sha`.

**Scope.**

Входит:

- Реестр агентов в `processes/modules/ai/modules/agents/`: `AgentBase` (существующий) + `AskAgent` (зародыш из стека) как первый исполнитель за `Executor`-интерфейсом (уровень шага, не `ModelGateway`); `agents.service`/`agents.controller` (`GET /api/v1/agents`) — переиспользование.
- Skills-лоадер: каталог `skills/<name>/SKILL.md` (frontmatter `name ≤64`, `description ≤1024`, `allowed-tools` экспериментально) + `scripts/`/`references/`/`assets/`; progressive disclosure (метаданные ~100 токенов на старте → тело `<5000` токенов при активации → ресурсы по требованию); 1 пилот-скилл: frontmatter → тело подмешивается в системный промпт; `allowed-tools` проверяется ядром, deny по умолчанию.
- Классификация эффекта скилла: чистые инструкции/шаблоны = `read`; скиллы с исполняемыми `scripts/` = минимум `write-local` (переоценка вверх обязательна, вниз — запрещена).
- Пиннинг: `run` фиксирует `definition_set_hash` при старте; воркер читает срезы строго по пинованному хэшу (тело скилла — по `commit_sha`, «свежий» текст идущему run запрещён); смена `active` влияет только на новые run; явный апгрейд — только событием `run.upgrade_definition` (endpoint — после прототипа).
- Валидация публикации `skills-ref validate` в CI (если тривиально добавляется; иначе — ручной чек-лист).

Не входит:

- Полный `run_definitions`/`tool_defs` индекс с версионированием всех видов (`agent|skill|tool-registry|mcp-config`) — минимум под 1 скилл + реестр.
- Hot-reload endpoint (`upgrade-definition`), Tasks-инструменты, OTel-корреляция `agent/definition_version` сверх `AppLogger` + `x-correlation-id`.
- Новые SDK-исполнители (Claude/OpenAI Agents как `Executor`) — только точка расширения.

**Пути файлов.**

- Переиспользовать: `apps/backend/src/processes/modules/ai/modules/agents/{agent.base.ts,ask.agent.ts,agents.service.ts,agents.controller.ts,agents.module.ts,agents.dto.ts}` + `__tests__/agents.controller.security.spec.ts`.
- Создать: skills-лоадер (`processes/modules/ai/modules/skills/` или `workers/modules/skills/` — решить по `ARCHITECTURE.md` на реализации; вложенность только `<parent>/modules/<sub>/`), `skills/<пилот>/SKILL.md` (пилот-скилл как git-артефакт), тест лоадера в `__tests__/`.
- Контракт: `definitions.active`-флаг и `definition_set_hash` уже в E1/E2 (`run_runs.definitionSetHash`).

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §8.4 + §9.6, ADR-0002 D4/D7.

```ts
// skills-лоадер (DRAFT ~30 строк)
type SkillMeta = { name: string; description: string; allowedTools?: string[] }; // frontmatter: name ≤64, description ≤1024
async function loadSkill(skillDir: string): Promise<{ meta: SkillMeta; body: string }> {
  const raw = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
  const { meta, body } = parseFrontmatter(raw); // frontmatter → тело
  assertSkillMeta(meta);                          // name/description лимиты; allowed-tools — экспериментально, enforcement наше
  return { meta, body };                          // ресурсы scripts//references//assets — только по требованию (progressive disclosure)
}
function buildSystemPrompt(base: string, skills: LoadedSkill[]): string {
  return [base, ...skills.map((s) => `<skill name="${s.meta.name}">\n${s.body}\n</skill>`)].join('\n\n');
}
function checkAllowedTools(skill: SkillMeta, toolId: string): void {
  const allow = skill.allowedTools ?? [];         // deny-by-default: нет списка — нет вызовов
  if (!allow.includes(toolId)) throw new ForbiddenToolError(skill.meta.name, toolId);
}
// Пиннинг: тело скилла читается строго по commit_sha из run.started; чтение «свежего» текста идущим run запрещено.
async function loadSkillPinned(repo: string, commitSha: string, name: string) {
  return gitShow(`${commitSha}:skills/${name}/SKILL.md`); // тот же follow-up, что baseCommit (I5)
}
```

**Проверки.**

- `bun run lint` + `bun run build` зелёные; спеки лоадера (frontmatter-парсинг, лимиты, deny-by-default, пин по `commit_sha`).
- Ручные asserts: пилот-скилл активируется по описанию, тело попадает в системный промпт, запрещённый тул отклоняется ядром; смена `active` не трогает идущий run; новая версия видна только новым run.
- `skills-ref validate` (или ручной чек) на пилот-скилл.

**Критерий готовности.** `AskAgent` отвечает через реестр; 1 пилот-скилл грузится трёхступенчато и участвует в промпте; `allowed-tools` enforced; пиннинг `definition_set_hash` соблюдён.

**Зависимости.** Blocked by: E4 (точка `system+Skill+ToolView` в loop). Контракт E1 — вход.

---

## E6. Фронт-минимум

**Цель.** `api/runs-client.ts` (фасад над `client.ts`) + хуки `useRuns`/`useRun`/`useRunEvents` + `query-keys.ts`; SSE — `useEffect`-исключение (аналог `streamSessionEvents`), переиспользование chat-паттерна; отдельного дизайна run-экрана нет.

**Scope.**

Входит:

- `apps/frontend/src/api/runs-client.ts`: `listRuns/createRun/getRun` (+ `runEventStream` SSE-генератор) поверх единого `src/api/client.ts` (`request()`/`requestV1()`, `NEXT_PUBLIC_API_URL` verbatim, `ApiClientError`, `x-correlation-id`, парсинг boundary-схемами E1); `withAuth` + `ensureSessionAuth` + `toErrorMessage` — как в `sessions-client.ts`.
- Хуки: `useRuns`/`useRun` на React Query (`useQuery`/`useMutation`, `reload` = `invalidateQueries`), ключи только из `query-keys.ts` (`runsQueryKey`, `runQueryKey`); `useRunEvents` — `useEffect` + доменный SSE с комментом-обоснованием (как `useChat`/`useSessionEvents`); финал цепочки прототипа — `run.step.committed`; `stop()`-семантика — abort + drop кадров (`sendingRef`-гард) по образцу `useChat`.
- SSE-парсинг: `data:`-джойн многострочных payload, `runStreamFrameSchema.parse` (malformed → FAIL LOUD + redial с backoff, не silent cast); heartbeat-комменты без `data:` скипаются транспортом; дедуп по `seq`; фильтр scope по `frame.run`.
- Guard `no-opencode-transport` не трогать, но не нарушить: только `/api/runs*` через доменный клиент.

Не входит:

- Run-экран дизайн, `interrupt`/`upgrade-definition` кнопки, провайдер/модель-селекторы для runs, OTel-дашборды, биллинг-индикаторы.
- Второй транспорт (WebSocket), React Query поверх SSE (исключение зафиксировано каноном).

**Пути файлов.**

- Создать: `apps/frontend/src/api/runs-client.ts`, `apps/frontend/src/hooks/useRuns.ts` (или `useRuns`/`useRun`/`useRunEvents` рядом), патч `apps/frontend/src/hooks/query-keys.ts`.
- Образцы (читать, не менять): `apps/frontend/src/api/sessions-client.ts` (`withAuth`, `sessionEventStream`, `toErrorMessage`), `apps/frontend/src/api/client.ts` (`request()`, `streamSessionEvents`-исключение), `apps/frontend/src/hooks/useChat.ts` (`sendingRef`-гард, `session.step.ended`-финал), `apps/frontend/src/hooks/query-keys.ts`, `apps/frontend/AGENTS.md` (слои, `useEffect`-исключение).
- Проверки: `bun run lint` (`tsc --noEmit` + `biome lint`) + `bun run build` (`next build --turbopack`) фронта.

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §9.7, ADR-0002 §6.3 + §6.6; образец `sessions-client.ts:187-248`, `useChat.ts`.

```ts
// runs-client.ts — фасад + SSE (DRAFT ~40 строк)
import { ApiClientError, api } from './client';
import { runStreamFrameSchema } from '@rush-code/contracts';
import type { CreateRunRequest, RunInfo, RunStreamFrame } from '@rush-code/contracts';

export function listRuns(projectId: string, opts?: { signal?: AbortSignal }): Promise<RunInfo[]> {
  return withAuth((token) => api.listRuns(token, projectId, opts)); // request() + parseBoundary, как listSessions
}
export function createRun(body: CreateRunRequest): Promise<RunInfo> {
  return withAuth((token) => api.createRun(token, body));
}
// SSE-исключение: useEffect + доменный SSE, на React Query не переносится (канон фронта).
export async function* runEventStream(runId: string, projectId: string, cursor: number, signal: AbortSignal,
): AsyncGenerator<RunStreamFrame, void, undefined> {
  const res = await withAuth((token) => api.streamRunEvents(token, runId, projectId, cursor, { signal }));
  const reader = res.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) return;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n'); let idx = buffer.indexOf('\n\n');
      while (idx >= 0) { const chunk = buffer.slice(0, idx); buffer = buffer.slice(idx + 2); idx = buffer.indexOf('\n\n');
        const lines = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        if (!lines.length) continue; // heartbeat — скип транспортом
        yield runStreamFrameSchema.parse(JSON.parse(lines.join('\n'))); // malformed → throw → redial с backoff
      }
    }
  } finally { try { await reader.cancel().catch(() => null); } catch {} try { reader.releaseLock(); } catch {} }
}
```

```ts
// useRunEvents скелет (DRAFT ~20 строк) — useEffect-исключение с комментом-обоснованием
export function useRunEvents(runId: string | null, projectId: string, cursor = 0) {
  // Исключение из React Query: streaming/SSE — useEffect + доменный SSE (см. useChat).
  const [frames, setFrames] = useState<RunStreamFrame[]>([]);
  useEffect(() => { if (!runId) return; const ac = new AbortController(); let live = true;
    (async () => { for await (const f of runEventStream(runId, projectId, cursor, ac.signal)) {
      if (!live || f.run !== runId) continue; // scope по frame.run; дедуп по f.id (seq)
      setFrames((prev) => (prev.some((p) => p.id === f.id) ? prev : [...prev, f]));
      if (f.type === 'run.step.committed') queryClient.invalidateQueries({ queryKey: runQueryKey(runId) });
    } })().catch((e) => { if (!isAbort(e)) setError(toErrorMessage(e)); });
    return () => { live = false; ac.abort(); }; // stop(): abort + drop кадров
  }, [runId, projectId, cursor]);
  return { frames };
}
```

**Проверки.**

- `bun run lint` + `bun run build` фронта зелёные; `no-opencode-transport` guard зелёный.
- Ручные asserts: `createRun` → карточка в списке после invalidate; SSE показывает `run.started → run.step.committed`; reconnect с `cursor` не дублирует кадры (дедуп по `seq`); чужой проект — `404` (не логаут, `400/404` никогда не разлогинивают — как в `sessions-client.ts`).

**Критерий готовности.** Фронт создаёт run, показывает прогресс по SSE и переживает reconnect без потерь/дублей; chat-паттерн переиспользован, новых транспортов нет.

**Зависимости.** Blocked by: E1 (схемы/парсинг), E3 (endpoint `/api/runs*` + SSE-формат).

---

## E7. E2E-минимум

**Цель.** `runs.e2e.ts` на testcontainers (`postgres:16-alpine`) по образцу `sessions.e2e.ts`: создать run → `step.committed` → переподключение с `cursor` → replay; asserts: jail-путь, ветка `agent/<id>`, чужой `projectId` → `404`.

**Scope.**

Входит:

- Сьют `apps/backend/.../__tests__/runs.e2e.ts` (место — рядом с `sessions/__tests__/sessions.e2e.ts` или в `processes/modules/runs/__tests__/`; решить по `ARCHITECTURE.md` на реализации): запуск против COMPILED `dist` (декораторы), `scripts/e2e.ts` бюджет `E2E_SUITE_TIMEOUT_MS=300000`.
- Строгий Postgres: одноразовый `postgres:16-alpine` через `e2e-db.container.ts`, миграции `drizzle/`, гашение в `stop()` (+ Ryuk); `TEST_DATABASE_URL`/`E2E_DB_MODE=unreachable` — только явные override; `DATABASE_URL` в e2e не читается.
- Сценарий: `POST /api/runs` → дождаться `step.committed` (poll `GET :id` + SSE) → переподключиться `GET :id/events?cursor=` → проверить replay без потерь.
- Asserts: worktree-путь внутри `REPOS_ROOT` (jail, патч `WorkspacePathService` как в `sessions.e2e.ts`), ветка `agent/<run_id>` существует, чужой `projectId` → `404 not_found` (C4, без утечки), гость → 401, `PROJECT_REQUIRED` без `projectId`, секреты (Basic-пароль, upstream-секрет) нигде не в логах/ответах, warn/error — однострочники (`AppLogger`-захват по образцу `keys.e2e.ts`).
- Outage-поверхность: `E2E_DB_MODE=unreachable` → 503 + `Retry-After: 30` (явный прогон, не дефолт).

Не входит:

- Нагрузочные бенчмарки `LISTEN/NOTIFY`, долгоживущие run, kill -9/fencing-проверки, merge-очередь, MCP-матрица `endpoint × era × supported` (пилот D5 — отдельным прогоном, не в этом сьюте).
- Фронт-e2e (только API-уровень).

**Пути файлов.**

- Создать: `.../__tests__/runs.e2e.ts` (образец: `apps/backend/src/processes/modules/ai/modules/sessions/__tests__/sessions.e2e.ts`, ~структура: детерминированный env → stub upstream → `configureApp()/setupSwagger()` → патч C4-гейта → сценарий → asserts → скан секретов).
- Переиспользовать: `src/common/db/e2e-db.container.ts`, `scripts/e2e.ts`, `docs/backend-hardening-plan.md` (стенд), `src/processes/modules/ai/modules/opencode/__tests__/keys.e2e.ts` (скан секретов + `AppLogger`-захват).
- Проверки: `bun run build && <скомпилированный сьют>`; точечный фильтр `bun scripts/e2e.ts runs.e2e`.

**Черновик решения.**

> DRAFT — опора для реализации, не финальный код. Источник: ADR-0001 §13-п.3 + §8.7.6, ADR-0002 §6.6 + §7-п.7; образец `sessions.e2e.ts:1-80`.

```ts
// runs.e2e.ts — скелет (DRAFT ~45 строк)
import assert from 'node:assert/strict';
// Runs against COMPILED dist (tsc emits decorator metadata; bun test on TS sources must not run this).
process.env.APP_BACKEND_PORT ??= '3000';
process.env.REQUEST_TIMEOUT_MS = '2000';
process.env.OPENCODE_URL = 'http://127.0.0.1:9'; // stub ниже (opencode-runner :4096 в e2e — стаб)
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-not-real-0123456789';
const E2E_PROJECT_ID = '123e4567-e89b-12d3-a456-426614174090';
const JAIL_DIR = '/tmp/rush-code-e2e-runs'; // патч WorkspacePathService → jail (как sessions.e2e JAIL_DIR)

async function main(): Promise<void> {
  const { container, url } = await startThrowawayPostgres('postgres:16-alpine'); // e2e-db.container.ts
  try {
    await applyMigrations(url); // drizzle/ — включая run_runs/run_steps/run_events/run_leases
    const app = await bootApp({ databaseUrl: url, workspaceRoot: JAIL_DIR }); // C4-гейт патчится как в sessions.e2e
    // 1. создать run
    const created = await api('POST /api/runs', { projectId: E2E_PROJECT_ID, title: 'e2e-run' });
    assert.equal(created.status, 201); const runId: string = created.body.id;
    assert.match(created.body.branch, /^agent\//);
    // 2. дождаться step.committed (poll + SSE)
    const committed = await waitFor(() => api(`GET /api/runs/${runId}`), (r) => hasStepCommitted(r));
    assert.ok(committed, 'step.committed not observed');
    // 3. переподключение с cursor → replay без потерь
    const replay = await collectSse(`GET /api/runs/${runId}/events?cursor=0`, /* then abort+reconnect with cursor */);
    assert.deepEqual(ids(replay), ids(live), 'replay loss');
    // 4. asserts: jail-путь, ветка, C4
    assert.ok(created.body.worktree.startsWith(JAIL_DIR), 'worktree outside jail');
    assert.ok(await gitBranchExists(created.body.worktree, created.body.branch), 'branch agent/<id> missing');
    assert.equal((await api('GET /api/runs/' + runId, { projectId: STRANGER_PROJECT })).status, 404); // чужой → 404
    assertNoSecretsLeaked(logCapture, [BASIC_PASSWORD, UPSTREAM_SECRET]); // эталон keys.e2e.ts
  } finally { await container.stop(); }
}
```

**Проверки.**

- `bun run build` + скомпилированный `runs.e2e.js` зелёный; фильтр `bun scripts/e2e.ts runs.e2e`.
- Отдельный прогон `E2E_DB_MODE=unreachable` → 503 + `Retry-After: 30`.
- Без Docker — явная ошибка (не скип), per канон e2e.

**Критерий готовности.** Сьют зелёный: run сквозняком, `step.committed` наблюдаем, reconnect с `cursor` отдаёт историю без потерь, jail/ветка/C4 asserts держат, секреты не текут.

**Зависимости.** Blocked by: E1–E6 (нужен весь срез: контракт → БД → API → движок → фронт-формат кадров).

---

## §8. Отложенное с TODO-метками (не молча)

| Метка | Что откладываем | Где ставить | Что делает прототип вместо |
| --- | --- | --- | --- |
| `TODO(full-fencing)` | Полный fencing: `epoch` в `run_leases`, `SELECT … FOR UPDATE` по строке lease в одной транзакции с append, `epoch` только растёт, чужой/протухший `epoch` → `fenced` + останов воркера | `WorkersModule` claim-loop (место lease-check), `schema.ts` у `run_leases` (`observedEpoch` уже есть как задел) | Упрощённый claim `SKIP LOCKED` + heartbeat; прототип честно переживает только graceful-рестарт, не kill -9 посреди шага (ADR-0001 §18.3, ADR-0002 D9/§8) |
| `TODO(dual-write-reconcile)` | `run_effects` + reconciliation по трейлерам (`intent → committed/failed`, `committed → superseded`, `git log --grep` по ветке `agent/<run_id>`, индекс `(trailerRunId,trailerStepId)`, rebase-правило §9.3) | Движок `git.commit`, будущий reconciliation-job | Git-ошибка = `step.failed` без авто-догона; оператор видит `failed` и решает (ADR-0001 §18.3, ADR-0002 D8/§8) |
| `TODO(mcp-dual-era)` | Полный MCP dual-era (разбор `400` → `initialize`-фолбэк → HTTP+SSE-фолбэк), Tasks-расширение (`tasks/get` polling), `ttlMs/cacheScope`-кэш дескрипторов | MCP-клиент в `ToolRegistry`/`ExternalClient` | Один modern-клиент + один `initialize`-фолбэк; матрица пилота `endpoint × era × supported` отдельно (ADR-0001 §8.3/§13-п.5, ADR-0002 D5/§8) |
| (без метки — вне прототипа) | Биллинг/SLA, OTel-дашборды (`gen_ai.*` нестабильны — только `AppLogger` + `x-correlation-id`), per-run ресурсы/cgroup/microVM (E2B — лишь имя будущего `SandboxProvider`), сабмодули (флаг «без сабмодулей») | Нигде в коде прототипа | Квоты общие (compose `2G/2.0` + диск `opencode-projects`); параллельных run — «десятки», мерим e2e-стендом |

---

## §9. Сквозной критерий готовности (§18.1 ADR-0001) + инварианты

**Сквозной run (все пункты — обязательно, по ADR-0001 §18.1 / ADR-0002 §7):**

1. `POST /api/runs` создал run (201 `RunInfo`).
2. Агент вызвал ≥1 tool (`tool.call` в журнале: `request_hash/response_hash/attempt`).
3. Результат записан в журнал (`run_steps`: `step.committed` + `resultRef`; `run_events`: цепочка с `prevHash`).
4. SSE показал `run.started → run.step.committed` (catch-up + live через `relaySse`).
5. Worktree с веткой `agent/<run_id>` создан в jail (`REPOS_ROOT/.../content/wt/<run_id>`, `assertInsideJail`) и виден в git.
6. Повторный `GET events?cursor=` отдал историю без потерь (replay = live по `seq`, дедуп на клиенте).

**Инварианты приёмки (нарушение = не готово):**

- **I5 Forward-Only:** `git merge-base --is-ancestor base HEAD` = 0; в коде/политике запрещены `reset --hard`/`push --force` (deny на уровне tool-дескриптора `git.*`); откат — только `revert`/новые коммиты.
- **C4:** чужой `projectId` → `404 not_found` без утечки существования (все `/api/runs*`, включая `events`); `missing projectId` → 400 `PROJECT_REQUIRED`; гость → 401 (не маскируется под 400/404).
- **ApiError-envelope:** все ошибки — замороженный `ApiError {code,message,correlationId}` + `x-correlation-id`; БД/раннер down → 503 `EXTERNAL_UNAVAILABLE` + `Retry-After: 30` (до SSE-заголовков — JSON, после — только close); логи — `AppLogger`-однострочники без URL/body/секретов, стек только в `debug` через `serializeCause`; `console.*` — ноль.

---

## reuse-блок (для гейта)

```json
{
  "queries": ["sessions contract", "sse relay", "workers scaffold", "workspace jail", "agents registry", "frontend SSE hooks", "e2e testcontainers", "neighbor plans format"],
  "found": ["packages/contracts/src/sessions/{sessions.ts,sessions.schema.ts,index.ts}", "apps/backend/src/common/sse/sse-relay.ts", "apps/backend/src/processes/modules/ai/modules/sessions/{sessions.controller.ts,sessions.service.ts,session-harness.service.ts,sessions.dto.ts,__tests__/sessions.e2e.ts}", "apps/backend/src/processes/modules/workers/workers.module.ts", "apps/backend/src/common/db/schema.ts (projectSessions/sessionMessages/sessionAgents)", "apps/backend/src/common/storage/workspace-path.service.ts", "apps/backend/src/processes/modules/ai/modules/agents/{agent.base.ts,ask.agent.ts,agents.service.ts}", "apps/frontend/src/api/{client.ts,sessions-client.ts}", "apps/frontend/src/hooks/{query-keys.ts,useChat.ts}", ".plans/password-service/PLAN.md", "docs/adr/0001,0002 (Rev.6/Rev.2)"],
  "reused": ["sessions.ts/sessions.schema.ts — стиль mirrorulu поле-в-поле, nullable-паттерн, agentId-regex, z.iso.datetime (E1)", "sse-relay.ts — relaySse 1:1: probe-до-заголовков, abort, x-accel-buffering, return-гонка 1500мс (E3)", "sessions.controller.ts:202 events + streamEvents replay+live — структура endpoint и catch-up/live (E3)", "sessions.dto.ts — реэкспорт-паттерн @rush-code/contracts (E3)", "sessions.e2e.ts + e2e-db.container.ts + scripts/e2e.ts + keys.e2e.ts — стенд testcontainers postgres:16-alpine, бюджет 300000, скан секретов (E7)", "schema.ts projectSessions/sessionMessages — RESTRICT, soft-delete isNull(deletedAt), индексы (projectId)/(session_id,createdAt) (E2)", "WorkspacePathService assertInsideJail/ensureDir/removeDir — jail WorktreePathService (E4)", "agent.base.ts/ask.agent.ts/agents.service.ts — AgentBase+AskAgent реестр (E5)", "sessions-client.ts withAuth/sessionEventStream/toErrorMessage + client.ts request()/parseBoundary — фасад и SSE-парсинг (E6)", "useChat.ts sendingRef-гард + session.step.ended-финал, query-keys.ts — хуки-исключения и ключи (E6)", "workers.module.ts scaffold — дом claim-loop (E4)", "password-service/PLAN.md — формат соседнего плана (структура настоящего файла)"],
  "created_new_why": ["packages/contracts/src/runs/ — нового домена runs нет, sessions не покрывает RunInfo/RunStreamFrame/ToolView", "processes/modules/runs/ — нового REST-домена /api/runs* нет, sessions-контроллер чужого scope", "claim-loop + ModelGateway-заглушка + ToolRegistry(git.recon+MCP) + sandbox.exec + git.commit(intent) — движка run нет, sessions-harness покрывает только чат-стрим", "skills-лоадер (frontmatter→тело→ресурсы, 1 пилот-скилл) — в репо skills-лоадера нет", "runs-client.ts + useRuns/useRun/useRunEvents — фронта runs нет", "runs.e2e.ts — e2e runs нет; sessions.e2e покрывает только /api/sessions*"]
}
```
