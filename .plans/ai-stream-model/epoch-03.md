# Epoch 3: Decision foundation
## Hypothesis
Фикс стриминга = scope кадров по frame.session + корректная склейка delta + snapshot updated + финализация по session.idle (+retry бэкофф уже есть 1s->15s). Модель = optional passthrough, дефолт null (серверный дефолт upstream), без тихих фолбэков.
## Decisions
- Decision: SSE scope обязателен — чужой session игнор, без него кросс-ток
- Decision: YAML источник правды; packages/contracts правится вторым; расхождение = баг пакета
- Decision: UI — селектор provider/model в чате (данные из GET /api/sessions/providers доменного, НЕ /api/opencode/config), значение уходит в send()/createSession; useChat остаётся useEffect (исключение зафиксировано)
## Confirmed Plan Items
1. Фаза 1 диагностика — файлы, готовность, риски (см PLAN.md)
2. Фаза 2 фикс стриминга
3. Фаза 3 контракт модели
4. Фаза 4 UI
5. Фаза 5 тесты/гейты
## Next Epoch Focus
- Refinement: точные файлы-кандидаты, критерии готовности, риски
