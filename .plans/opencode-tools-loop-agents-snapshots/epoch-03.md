# Epoch 3: Decision foundation

## Hypothesis
Разбивка по слоям приёмника фиксирована; конфликты разрешены в пользу существующих конвенций.

## Evidence Found
- Pattern: backend scope — `processes/ → organizations/ → common/`, стрелка вниз; `common/` один @Global, запрещены `*.module.ts` в подпапках; вложенность только `<parent>/modules/<sub>/`; тесты в `__tests__/` рядом (`*.spec.ts`/`*.e2e.ts`); логи только `AppLogger` однострочники без секретов; fail-fast без REPOS_ROOT (503/500); uuidv7 только `Bun.randomUUIDv7()`; DI `private readonly`.
- Pattern: contracts — `contracts/openapi.yaml` источник правды, пакет зеркалит `components/schemas` поле-в-поле; только типы+схемы, рантайм-логики нет; frontend своих типов не заводит, парсит boundary-схемами.
- Pattern: frontend — `app/` тонкая композиция, логика в `features/+hooks/`; data только React Query (`query-keys.ts` единственный источник); SSE/streaming — `useEffect`-исключение с комментом; запрет `@opencode-ai/sdk` и `/api/opencode/*` (guard-тест).

## Decisions
- Decision: новый backend-модуль `processes/modules/ai/modules/tools/` (ToolRegistry + ToolDispatch + 8 MVP-инструментов поверх `WorkspacePathService`), runner-цикл внутри `sessions/` (harness+runner подпапка, не новый топ-модуль), агенты — расширение `modules/agents/` (registry+subagent-job), снапшот — `sessions/modules/snapshots/` (или `common/storage` хелпер если кросс-доменный), fork/revert — методы harness+controller.
- Alternatives considered: отдельный топ-модуль `session-tools/` / класть snapshots в `common/` сразу — rejected до доказанной кросс-доменности (сначала sessions/modules, вынос в common только при переиспользовании).
- Rationale: CoC §2 (вложенные модули только через modules/<sub>), §3 (один @Global в common).
- Decision: контракты — `packages/contracts/src/sessions/`: `SessionForkRequest/Response`, `RevertStageRequest/RevertInfo`, `SnapshotDiff`, `ToolCallInfo`; YAML правится первым, пакет — зеркалом.
- Alternatives considered: прямые opencode-имена (session.revert.stage) — rejected (наши доменные имена `/api/v1/sessions*` уже канон, upstream-имена живут только внутри harness-перевода).
- Rationale: frontend-граница уже зафиксирована (sessions-client поверх client.ts request()).
- Decision: НЕ портируем — Effect Layers/Bus/State, Hono/server, Solid/TUI/app/desktop, SDK/client, plugin-host, MCP-browser, Rust PTY-демон, httpapi-codegen/recorder/simulation, Astro web, Electron.
- Decision: shell-инструмент — только через jail + allowlist + таймаут, без PTY; логи без командных тел/секретов.

## Confirmed Plan Items
1. Контракты первыми (YAML→zod→баррель) — reason, artifact: contracts, validation: `bun run lint+test` пакета.
2. Backend tools+loop+agents — reason, artifact: processes/ai, validation: spec+e2e, `bun run lint/build`.
3. Backend snapshots+revert+fork — reason, artifact: sessions+harness, validation: e2e файлы+сообщения.
4. Frontend fork/revert/tools-таймлайн — reason, artifact: features/hooks/api, validation: `bun run lint/build` + guard-тест зелёный.

## Open Questions
- Точные имена полей RevertInfo/SnapshotDiff в YAML (согласовать с существующим SessionMessage.text-null конвентом).
- Лимит истории для fork (вся до boundary vs окно) и копирование blob-media.

## Next Epoch Focus
- Refinement: конкретные файлы, API-контракты, порядок по зависимостям, тесты и проверки.
