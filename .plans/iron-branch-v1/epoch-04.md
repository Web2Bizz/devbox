# Epoch 4: Три слоя tools (native / skills / MCP) + InferencePort (min vendor lock)

## Hypothesis
Требования 2 (mcp/skills/tools) и 7 (min vendor lock) закрываются двумя симметричными портами: **ToolRegistry** (чем агент действует) и **InferencePort** (чем агент думает). Доменные агенты (`Backend|Frontend|FullstackAgent`, будущие граф-узлы `agent`) зависят только от этих двух абстракций; смена провайдера инференса или добавление MCP-сервера не трогает их код. Skills — версионируемые промпт-пакеты из `.opencode/skills/*`, инжектируемые в контекст через workflow, а не отдельный рантайм.

## Evidence Found
- File: `apps/backend/src/processes/modules/ai/modules/agents/*.agent.ts` — все агенты зовут `runner.chat` напрямую (Zustand-привязка к Zen/OpenAI-совместимому endpoint); параметра tools нет (epoch-00 §Evidence).
- File: `apps/backend/src/common/zen/session-runner.service.ts:17` — `ZEN_CHAT_URL='https://opencode.ai/inference/openai/v1/chat/completions'` захардкожен, без env-override (см. `jev.service.ts:11` «endpoint is fixed»); model-fallback + per-user ключи живут здесь же.
- Pattern: `.opencode/skills/*/SKILL.md` (23 шт.: check, commit, sync, graphify…) — SKILL.md + скрипты, вызываемые workflow-инжекцией; версионируются git-ом вместе с репо.
- File: `apps/backend/src/processes/modules/workers/workers.module.ts` — scaffold only (`@Module({})`), контроллеров/очередей нет; внешних MCP-клиентов в репо нет (`grep McpTool|MCP` — пусто, кроме skills-инструкций).
- Pattern (backend AGENTS.md): тихие фолбэки запрещены — конфиг строго через `common/env/env.ts` + `.env.example`, без `?? default`; логи только AppLogger-однострочники.

## Decisions
- Decision: три слоя tools за единым `AgentTool`-контрактом эпохи 0:
  1. **native** — быстрые внутренние TS-функции (`project_files_list`, `history_search`, `jev_classify`) — handler в процессе backend;
  2. **skills** — `.opencode/skills/*` как промпт-пакеты + скрипты: `SkillToolAdapter implements AgentTool` читает `SKILL.md` (инжекция в system-prompt узла `agent`) и/или запускает скрипт навыка через детерминированный handler (jail+allowlist как у native);
  3. **MCP** — внешние серверы: `McpToolAdapter implements AgentTool` поверх `tools/list` + `tools/call` MCP-протокола; каждый внешний тул регистрируется в том же `ToolRegistry` под именем `mcp_<server>_<tool>`.
- Alternatives considered: (а) skills как отдельный рантайм/лоадер — отвергнуто: в репо skills уже consum'ятся workflow-инжекцией, второй механизм = дрейф; (б) MCP-клиент напрямую в GraphRunner без адаптера — отвергнуто: runner тогда знает про сетевые детали, ломается единый allowlist/jail-gate.
- Rationale: runner и граф видят только `AgentTool` + `ToolRegistry.listAllowed(ctx)`; откуда тул взялся (in-process / skill-скрипт / MCP-сервер) — деталь адаптера. Allowlist на режим/граф: `ctx {graph_id, node_id, mode}` фильтрует доступные тулы (напр. `auto-v2` не видит write-тулов вообще).
- Decision: `InferencePort { chat(prompt, opts {tools?, toolChoice?}) : {text, tool_calls?}; chatStream(...) : AsyncIterable<frame> }` — единственный интерфейс доменных агентов к LLM. Адаптеры: `ZenInferenceAdapter` (текущий `SessionRunnerService`, default), `OpenAICompatAdapter` (любой OpenAI-compatible baseURL+key), `AnthropicAdapter`, `VercelAISdkAdapter` (стриминг-хелпер, опционально). Jev — один из classifier-адаптеров (`ClassifierPort`), заменяемый (`HeuristicClassifierAdapter` для офлайна/тестов) без смены графа.
- Alternatives considered: (а) Vercel AI SDK как оркестратор — отвергнуто (см. PLAN.md §выбор движка: ломает per-user ключи, EXTERNAL_*, AppLogger, Jev-биллинг); (б) тихий fallback провайдера при 5xx — ЗАПРЕЩЁН backend-каноном: конфиг провайдера строго через env (`INFERENCE_PROVIDER`, `INFERENCE_BASE_URL`, `INFERENCE_MODEL_*`), невалиден → fail-fast на boot, в рантайме ошибка маппится в EXTERNAL_* как сейчас.
- Rationale: Ports&Adapters — смена провайдера = 1 новый файл адаптера + env (матрица ниже); домен, граф, бюджеты, SSE, журнал не меняются.

## Confirmed Plan Items
1. `SkillToolAdapter implements AgentTool` + `skill-loader` (читает `.opencode/skills/*/SKILL.md`, фронтматтер → description/inputSchema) — причина: версионируемые промпт-пакеты без нового рантайма; артефакт: `processes/modules/ai/modules/tools/skill-tool.adapter.ts`; валидация: юнит «скилл `commit` виден в registry только в графах с allowlist skills».
2. `McpToolAdapter implements AgentTool` (конфиг серверов `MCP_SERVERS=[{name, url, allowTools[]}]` через env strict; `tools/list` при boot → регистрация `mcp_*`; вызов через `tools/call` с таймаутом+маппингом в EXTERNAL_*) — причина: внешние тулы за тем же контрактом/jail/approve; артефакт: `tools/mcp-tool.adapter.ts`; валидация: e2e «неизвестный mcp-tool → 404, запрещённый → 403, недоступный сервер → EXTERNAL_UNAVAILABLE+Retry-After».
3. `ToolRegistry` расширен: `listAllowed({graph_id, mode, userId, projectId})` — allowlist на режим/граф (таблица или конфиг — решает эпоха 0 Open Question §п.2, default: конфиг графа `allowedTools[]`) — причина: `auto-v2` не должен видеть write/MCP-write вообще; валидация: спек матрицы доступов.
4. `InferencePort` + `ZenInferenceAdapter` (обёртка существующего `SessionRunnerService`, поведение 1:1) — причина: домен отвязывается от Zen без регресса; артефакт: `processes/modules/ai/modules/inference/{inference.port,zen-inference.adapter}.ts`; валидация: регресс-спеки ask/auto зелёные через порт.
5. `OpenAICompatAdapter` (+ опционально `AnthropicAdapter`) за тем же портом; выбор через `INFERENCE_PROVIDER` (strict enum, без тихого фолбэка); `tool_calls`-парсер адаптера нормализует к `{name, args}` (ответ на Open Question эпохи 0: формат различается по провайдерам — нормализация в адаптере, не в runner) — валидация: юнит «ответ без tool_calls идёт старым путём» на каждом адаптере.
6. Матрица «что меняется при смене провайдера» (контракт эпохи): 1 файл `*-inference.adapter.ts` + env (`INFERENCE_PROVIDER/BASE_URL/MODEL/KEY`); НЕ меняются: граф-определения, ToolRegistry, BudgetPolicy, agent_runs/steps, SSE-кадры, фронт. Фиксируется в PLAN.md §матрица.

## Open Questions (актуально до Addendum 2026-11-04 ниже)
- MCP-транспорт: Streamable HTTP vs stdio-spawn — какой разрешён в backend-контейнере (stdio может быть запрещён политикой)?
- Нужен ли skills-hot-reload без рестарта (watch `.opencode/skills`) или достаточно boot-лоада?

## Next Epoch Focus
- Рантайм: фоновые воркеры + stateless-горизонталь, append-only журнал событий, SSE-стрим стейта (epoch-05).

---

## Addendum 2026-11-04 — решения пользователя (MCP только Streamable HTTP; skills hot-reload)

### A. MCP-транспорт: только Streamable HTTP, stdio-spawn НЕ делать
- Decision: `McpToolAdapter` работает только по Streamable HTTP (единый endpoint по спеке MCP; допускается развёрнутый вариант `POST {base}/mcp/tools/list` + `POST {base}/mcp/tools/call` — выбор фиксирует эпоха 0 Open Question по контракту сервера, адаптер прячет за собой оба маппинга). stdio-spawn запрещён: backend-контейнер не плодит процессы, нет проблем с jail/сигналами/логами дочерних процессов.
- Контракт адаптера: boot — `tools/list` → регистрация `mcp_<server>_<tool>` в `ToolRegistry` (только `allowTools[]` из конфига); вызов — `tools/call {name, arguments}` с `ctx {run_id, node_id, attempt, correlationId}` в метаданных (для идемпотентности на стороне сервера, если он её поддерживает).
- Таймауты/ретраи — только через `ExternalClient` (`common/external/external-client.ts`): per-attempt timeout (`timeoutMs`, default `REQUEST_TIMEOUT_MS`), POST вызывается один раз без ретрая по умолчанию; ретрай POST — только с явным `allowNonIdempotentRetry: true` + серверный dedupeKey (`run_id/node_id/attempt`), иначе риск двойного side-effect. Ошибки маппятся в `EXTERNAL_*` (`EXTERNAL_TIMEOUT/UNAVAILABLE`), недоступный сервер → `EXTERNAL_UNAVAILABLE` + `Retry-After`, без тихих фолбэков.
- Allowlist хостов: `MCP_SERVERS=[{name, url, allowTools[]}]` строго через `common/env/env.ts` + `.env.example` (fail-fast на boot при невалиде, канон backend AGENTS.md); дополнительно `MCP_ALLOWED_HOSTS[]` — URL сервера обязан совпадать с allowlist (схема http(s), хост из списка; путь вне джейла/неизвестный тул → 403/404 до вызова). Секреты (токены MCP) — только через env/CryptoService-прецедент, в AppLogger — только `service/operation/attempt/latencyMs/status` (никогда URL/тела/ключи — канон ExternalClient).
- Alternatives considered: stdio-spawn — отвергнут решением пользователя + политикой контейнера; прямой fetch без ExternalClient — отвергнут (теряются единый timeout/retry/логи без секретов).
- Валидация: e2e «неизвестный mcp-tool → 404, запрещённый хост/тул → 403, недоступный сервер → EXTERNAL_UNAVAILABLE+Retry-After, повтор call с тем же dedupeKey не дублирует side-effect».

### B. Skills hot-reload (вотчер, версионирование, лог, fallback)
- Decision: `SkillRegistry` (расширение `skill-loader` эпохи 4) грузит `.opencode/skills/*/SKILL.md` с hot-reload: вотчер на `.opencode/skills/*` — **`chokidar`** (уже транзитивно в дереве, `node_modules/chokidar present`; обоснование минимализма: `node:fs.watch` на Linux требует ручной обработки `rename`-штормов, пропусков поддиректорий и дедупликации событий — chokidar это закрывает из коробки, новая зависимость не тянется, т.к. уже есть в lock-файле; если lock-достоверность оспорена — fallback `node:fs.watch` с дебаунсом 300ms только на `SKILL.md`).
- Семантика: перезагрузка реестра без рестарта backend — `add/change/unlink` → перепарс фронтматтера → атомарная замена записи `имя@версия/sha` (версия = поле фронтматтера или `sha` git-blob/head SKILL.md; одновременные версии не живут — last-write-wins с версионированной меткой в логе); каждый переход пишется в `agent_steps`-совместимый лог-однострочник AppLogger `[skills] reload name=… version=… sha=… reason=add|change|unlink` (без тел SKILL.md).
- Fallback: если вотч недоступен (FS без inotify, права) — boot-лоад + ручной `POST /api/admin/skills/reload` (C4 + JwtAuthGuard, zod) + poll-интервал (default 30s, env `SKILLS_POLL_MS`, 0 = выкл); деградация логируется warn-однострочником, тихих рассинхронов нет (registry отдаёт `loadedAt+version` в `GET steps`/health для сверки).
- Alternatives considered: только boot-лоад — отвергнут решением пользователя (нужен hot-reload); `node:fs.watch` как primary — запасной вариант (см. обоснование выше).
- Валидация: юнит «изменение SKILL.md → registry обновился без рестарта, версия сменилась, в логе строка reload»; e2e «вотч недоступен → fallback reload endpoint + warn в логе».
