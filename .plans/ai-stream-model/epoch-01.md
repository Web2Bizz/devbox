# Epoch 1: Coarse hypothesis
## Hypothesis
Стриминг сломан на одном из 3 уровней: фронт-редьюсер кадров (useChat frame.session scope, delta vs updated, session.idle финализация), бэкенд-трансляция v2 frames (sse-relay + sessions.service), upstream v2 event shape. Выбора модели нет т.к. CreateSessionRequest/SendMessageRequest без model.
## Decisions
- Диагностика первична, фикс после доказательств.
## Confirmed Plan Items
1. Диагностика стриминга — сравнить фронт-кадры vs бэкенд vs upstream
2. Фикс стриминга
3. Контракт модели YAML+package+бэкенд
4. UI выбора модели
5. Тесты и гейты
## Open Questions
- Какой кадр теряется: delta/updated/idle?
## Next Epoch Focus
- Evidence: прочитать useChat полностью, sse-relay, sessions.service SSE, openapi.yaml sessions
