# Epoch 6: Fallback-ban — честный 503 вместо serve/stub-веток

## Hypothesis
Подтвержденная задача «Запрет fallback, 503 при недоступности OpenCode» отменяет fallback-гипотезу Epoch 3–4. Новое целевое состояние: прокси `:4010` — единственный прод-путь LangChain→OpenCode; при proxy down / host down / 5xx / таймауте — только честный 503 по backend-канону (`EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`), без тихих фолбэков, без retry внутри gateway (retry решает вызывающий). Ограничения: fallback не предусматривать; LangChain ядро, OpenCode провайдер; только paid/Go `tools:true`.

## Evidence Found
- File: `.plans/langchain-bridge-k7/PLAN.md` §1 — содержал узел `S[serve Tool фолбэк]` и ребро `S --- R`; §2 — содержал `MODEL_GATEWAY=stub|langchain`, «Э3 Фолбэк» (`opencode-serve.tool.ts`, выбор primary/fallback по `need.toolCalls` + health), «переключатель отката `MODEL_GATEWAY`»; §3 — V2 serve Tool как рабочая строка; §4 — R1 с `V2-фолбэк`, приёмка «остановленный `:4010` → зелёный через serve Tool»; §5 — `OpencodeHostService` как «готовый serve-фолбэк». Всё перечисленное — предмет удаления настоящим эпохом.
- File: `.plans/langchain-bridge-k7/epoch-03.md` — Decision «LC→OC fallback — serve Tool» и п.3 «Serve-Tool фолбэк», Superseded-строка «embedded host остаётся для serve-Tool фолбэка».
- File: `.plans/langchain-bridge-k7/epoch-04.md` — Decision «`StubModelGateway` … за флагом/env (`MODEL_GATEWAY=stub|langchain`)», Decision «`OpencodeHostService` остаётся как serve-Tool фолбэк», п.4 «Этап 3 Serve фолбэк».
- File: `.plans/langchain-bridge-k7/epoch-01.md` п.1, `epoch-05.md` скоринг/матрица/риски — ссылки на fallback-ветку.
- Pattern (backend-канон, сохраняется): `external-error.ts EXTERNAL_*`, fail-fast без тихих фолбэков, `AppLogger + x-correlation-id`, `relaySse` (терминальный `stream.error` сохраняется) — 503-контракт ложится на существующую конвенцию, нового канона не вводится.

## Decisions
- Decision: fallback ЗАПРЕЩЁН полностью — нет serve Tool fallback-ветки, нет перехода на stub при proxy down, нет выбора по `need.toolCalls` + health, нет отката `MODEL_GATEWAY=stub` как runtime-переключателя, нет `MODEL_GATEWAY=stub` переключателя как fallback. Rationale: подтверждённая задача + backend-канон fail-fast; тихие фолбэки маскируют отказ и ломают журнал/SSE-семантику.
- Decision: единственный прод-путь — прокси `:4010` как `BaseChatModel` (V1). Отказ — `503 EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`, без retry внутри gateway. Rationale: прокси — единственный OpenAI-совместимый путь; retry решает вызывающий.
- Decision: V2 (serve Tool) — строка матрицы сохранена только как ЗАПРЕТ (инструкция «НЕ ДЕЛАТЬ»), V3 (CLI) — только офлайн/дебаг, НЕ fallback прод-пути. Rationale: сохранить трассируемость решения, не оставлять рабочей fallback-инструкции.
- Decision: Э3 переопределён с «Serve-фолбэк» на «Честный 503» (health-probe + маппинг + e2e на 503); Э1 — «без fallback» (единственный `MODEL_GATEWAY=langchain`); порядок `Э0 → Э1 → Э2 → Э3(503) → Э4 → (Э5)` сохранён по номерам во избежание перенумерации. Rationale: минимальный дифф при смене семантики этапа.
- Alternatives considered: (a) молча удалить V2-строку из матрицы — rejected (потеря трассируемости запрета, правило «mark as superseded»); (b) перенумеровать этапы со сдвигом Э4→Э3 — rejected (ломает ссылки Epoch 4–5); (c) оставить `MODEL_GATEWAY`-переключатель «на всякий случай» — rejected (прямо запрещено задачей).
- Superseded (данным эпохом): все fallback-формулировки Epoch 1/3/4/5 и PLAN.md ревизии до Epoch 6 (перечислены в Evidence Found).

## Confirmed Plan Items
1. Архитектура без fallback-узла (диаграмма без `S`, ребро `P -. down/timeout/5xx .-> 503`) — reason: единственный прод-путь + честный отказ; artifact: PLAN.md §1; validation: в §1 нет `serve Tool фолбэк` как рабочей ветки, `OpencodeHostService` помечен «вне LC-пути».
2. Этапы Э1 (без fallback-переключателя) и Э3 (честный 503 вместо serve) — reason: убрать `MODEL_GATEWAY=stub`-фолбэк, `opencode-serve.tool.ts`, выбор `need.toolCalls + health`; artifact: PLAN.md §2; validation: e2e Э3 ожидает 503 с `Retry-After: 30`, а не зелёный serve-путь.
3. Матрица V1 (единственный путь + 503) / V2 (ЗАПРЕЩЁН, «НЕ ДЕЛАТЬ») / V3 (НЕ fallback) — reason: закрыть неверные стыки без потери истории; artifact: PLAN.md §3; validation: V2 не содержит инструкции к реализации.
4. Риски R1 (без V2-фолбэка) / R2 (503-контракт: free/beelding/proxy down/host down → 503 + `Retry-After: 30` + correlation, без retry) и приёмка отказа — reason: митигация без тихого фолбэка; artifact: PLAN.md §4; validation: чек-лист «Отказ вместо фолбэка».
5. Reuse-заметки без serve-фолбэка + явный fallback-запрет — reason: не переписывать рабочее, зафиксировать запрет; artifact: PLAN.md §5; validation: `OpencodeHostService` — «вне LC-пути, как fallback НЕ используется».
6. Скоринг пересчитан: complexity `13/20 medium` (−1 за удаление serve-ветки), risk `5/8 medium [breaking,data,security,external]` (численно без изменений, mitigation — честный 503) — reason: удаление ветки упрощает план, но external/paid-ключи держат medium; artifact: epoch-05.md + evolution-log; validation: files 10–12, deps 5, unknowns 2.

## Open Questions
- Нет открытых — unknowns (wire `tool_calls` прокси↔v2, zod-v4 адаптер, compose `:4010` топология + health/503-контракт) остаются задачами пилота Э0/Э3, не блокерами документа.

## Next Epoch Focus
- Финал уже отражён: `PLAN.md` (§§1–5 без fallback), `epoch-01/03/04/05.md` с пометками superseded, `evolution-log.md` с записью Epoch 6. Дальнейшие эпохи — только при изменении канона 503 или провенанса прокси.

## Superseded (Epoch 7 — in-place, без нового модуля)

- Настоящий эпох сохранял новодоменную архитектуру («Архитектура без fallback-узла», `LangChainGateway`, `MODEL_GATEWAY=langchain` как единственный путь) — ОТМЕНЕНА Epoch 7: нового домена и переключателя нет; единственный прод-путь — LC step-executor внутри `SessionHarnessService`.
- Запреты настоящего эпоха (serve Tool, переход на stub при proxy down, выбор `need.toolCalls + health`, CLI как прод-фолбэк) — ПОДТВЕРЖДЕНЫ Epoch 7 без изменений.
- Актуальное состояние — см. `PLAN.md` (in-place) и `epoch-07.md`.

## Terminology (Epoch 8 — глоссарий session/harness/runner; историю не переписывает)

- Читать этот эпох по `PLAN.md §0` (`epoch-08.md`): `session` — только чат, `harness` — только система (`SessionHarnessService`), `runner` — только экземпляр цикла; запреты fallback/503 этого эпоха подтверждены без изменений. `freeze/stop/kill/run` — только определение управления runner, не скоуп. Кодовые имена без переименования.

## Config-isolation (Epoch 9 — harness игнорирует opencode-конфиги; историю не переписывает)

- Читать этот эпох с инвариантом `epoch-09.md` (норматив — `PLAN.md` шапка + §§1/5): новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель: `.opencode/opencode.json`; иные — `[???]`, список не зафиксирован) не читает, не парсит, совместимость не гарантируется; при наличии — молча игнорировать (без чтения), без варнингов в прод-пути (решение Epoch 9, поведение ранее не задано). LangChain-ядро / `:4010` / 503 / in-place / запреты Epoch 6–7 и глоссарий Epoch 8 — без изменений.
