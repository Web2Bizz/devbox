# evolution-log.md — coral-preflight-k7

- Epoch 01 (coarse hypothesis): предположили однострочный фикс `allowedHeaders` в `app.setup.ts:71-76`; фронт не трогать; альтернативы (`убрать header с фронта`, `'*'`) отклонены предварительно. Статус: hypothesis, confidence high.
- Epoch 02 (evidence → decision): подтверждено чтением — `app.setup.ts:55-82` (4 headers, lowercase, без `last-event-id`, `credentials:true`), `client.ts:340` шлёт `Last-Event-ID`, `sessions.controller.ts:311` + `session-harness.service.ts:1025` читают `last-event-id` с fallback на `?cursor=`, CORS-тестов в репо нет (`sessions-stream.spec.ts` покрывает только cursor-логику). Решение финализировано: добавить `'last-event-id'` lowercase одной строкой. Предыдущие гипотезы не superseded — подтверждены.
- Final (PLAN.md): 1 карточка `fix(cors)` с чек-листом (правка + curl OPTIONS/GET + lint), complexity low, риск low, done-критерии из задачи. Вторая карточка сознательно не выделена.
