# Epoch 9: Config-isolation — harness игнорирует opencode-конфиги (документ, без кода и карточек)

## Hypothesis

Подтвержденная задача Epoch 9: зафиксировать в плане-документе `.plans/langchain-bridge-k7/`
инвариант — новый harness НЕ читает и НЕ совместим с конфигами opencode. Только фиксация в плане,
без кода, без карточек. Сохраняются без изменений: LangChain — ядро управления (библиотека внутри
существующих сервисов, не домен), OpenCode-провайдер через прокси `:4010` — primary и единственный
прод-путь, только paid/Go `tools:true`, при недоступности OpenCode — честный 503
(`EXTERNAL_UNAVAILABLE` + `Retry-After: 30` + `x-correlation-id`), fallback запрещён (Epoch 6 в силе),
in-place без `workers/modules/langchain/` (Epoch 7 в силе), глоссарий Epoch 8
(`session` — только чат, `harness` — только система, `runner` — только процесс/экземпляр цикла).

## Evidence Found

- Check: `ls opencode.json` в корне репо — файла нет; известный носитель — `.opencode/opencode.json`
  (внутри `.opencode/` рядом с `agents/`, `commands/`, `tools/`, `skills/`, `workflows/`, `scripts/`).
  Иные носители opencode-конфигов в репо не инвентаризованы → точный список НЕ фиксируем,
  помечаем `[???]`, не выдумываем.
- Check: `grep "opencode\.json|opencode-config" .plans/langchain-bridge-k7/*.md` — совпадений нет:
  до Epoch 9 план молчал о конфигах (поведение при наличии конфигов ранее не задано →
  фиксируем как решение, не как констатацию).
- Сохранено: `PLAN.md` §§0–5, запреты Epoch 6 (fallback/503) и Epoch 7 (in-place, без нового модуля),
  глоссарий Epoch 8 — правки этого эпоха только аддитивные, смысловых изменений ноль.

## Decisions

- Decision: новый harness игнорирует opencode-конфиги — `opencode.json` (известный носитель:
  `.opencode/opencode.json`; иные — `[???]`, точный список не зафиксирован, не выдумывать) не читает,
  не парсит, совместимость не гарантируется. Rationale: подтвержденная задача строго по формулировке
  («не будет читать и не будет совместим»).
- Decision: при наличии конфигов — молча игнорировать (без чтения), без варнингов в прод-пути.
  Rationale: поведение ранее не задано → зафиксировано как решение Epoch 9 (fail-fast канон:
  прод-путь без шумных веток; варнинги — только вне прод-пути и только отдельным решением).
- Decision: источник настроек harness — только env/код/существующие домены; opencode-конфиги
  источником настроек НЕ являются. Rationale: config-isolation, in-place без новых связей.
- Alternatives considered: (a) перечислить полный список opencode-конфигов — rejected (инвентаризация
  не проведена; выдумывать запрещено задачей; зафиксировано `[???]`); (b) читать конфиги read-only
  «для совместимости» — rejected (прямо запрещено подтвержденной задачей); (c) варнинг при обнаружении
  конфигов в прод-пути — rejected (задано молча игнорировать; варнинги — только отдельным решением
  вне прод-пути).
- Superseded (данным эпохом — нет): смысловые решения Epoch 6 (fallback-запрет, честный 503),
  Epoch 7 (in-place, без нового модуля), Epoch 8 (глоссарий) — ПОДТВЕРЖДЕНЫ без изменений;
  Epoch 9 только добавляет инвариант.

## Confirmed Plan Items

1. Инвариант config-isolation в `PLAN.md` (шапка + §1 bullet + §5 запрет-список; эпохи `epoch-01..09.md`) — reason: нормативная точка чтения всего документа; artifact: `PLAN.md`; validation: в документе нет чтения/парсинга opencode-конфигов harness как допустимого.
2. Этот файл `epoch-09.md` — решение config-isolation — reason: трассируемость инварианта; artifact: `epoch-09.md`; validation: структура epoch соблюдена (Hypothesis/Evidence/Decisions/Items/Questions/Focus/Scoring).
3. Запись `evolution-log.md` Epoch 9 — reason: история решений; artifact: appended-раздел; validation: скоринг плана Epoch 7 неизменен, скоринг правки зафиксирован.
4. Указатели `Config-isolation (Epoch 9)` в `epoch-01..08.md` (без переписывания истории) — reason: трассируемость; artifact: appended-разделы; validation: каждый файл ссылается на `epoch-09.md` + `PLAN.md`.
5. Ноль кода, ноль карточек: изменения только внутри `.plans/langchain-bridge-k7/` — reason: Forward-Only + формат документ; artifact: diff только `PLAN.md` + `epoch-*.md` + `evolution-log.md`; validation: `git merge-base --is-ancestor 0300575 HEAD` true.

## Open Questions

- [???] Точный список носителей opencode-конфигов (кроме `.opencode/opencode.json`) — НЕ инвентаризован; при инвентаризации — уточнить инвариант отдельной правкой документа (без кода).
- Источник настроек harness (env/код/существующие домены) — детализация при необходимости, вне этого эпоха.

## Next Epoch Focus

- Дальнейшие эпохи — только при изменении канона 503, провенанса прокси `:4010`, allowlist `tools:true`
  или инвентаризации `[???]`-списка конфигов; инвариант считать закрытым этим эпохом.

## Scoring (правка Epoch 9; скоринг плана Epoch 7 неизменен)

- Правка Epoch 9: complexity `2/20 low` (файлов 11 `.md` — PLAN + 9 эпох + лог, deps 0, unknowns 0, type docs) — reason: только текст, код/поведение/контракты не затрагиваются; validation: diff только `.plans/langchain-bridge-k7/`.
- Правка Epoch 9: risk `1/8 low` (factors `[docs]` — вне шкалы breaking/data/security/external; тихих фолбэков/контрактных изменений нет) — reason: инвариант не меняет исполнение; validation: 503/in-place запреты дословно сохранены.
- План Epoch 7 (подтвержден без изменений): complexity `14/20 medium-high`, risk `6/8 medium-high [breaking,data,security,external]` — reason: переделка живого чат-пути in-place; validation: см. `epoch-07.md` п.6.
