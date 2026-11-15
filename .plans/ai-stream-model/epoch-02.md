# Epoch 2: Evidence gathering
## Evidence Found
- File: apps/frontend/src/hooks/useChat.ts (1-80) — useEffect+SSE исключение (wontfix, AGENTS.md), парсит delta/updated через zod-схемы из @rush-code/contracts, toChatMessages скипает text:null
- File: packages/contracts/src/sessions/sessions.ts — SessionInfoModel{id,providerID,variant?}, SessionInfo.model nullable, CreateSessionRequest{projectId,title?,parentID?} — model НЕТ
- File: apps/backend/src/sessions/sessions.service.ts (1-60) — UpstreamSession.model?{id,providerID,variant?}, relaySse через common/sse-relay
- Pattern: фронт ходит только через src/api/sessions-client.ts поверх client.ts request(); guard no-opencode-transport запрещает sdk и /api/opencode/*
## Decisions
- Decision: контракт модели добавлять как optional model{providerID,id(,variant?)} в Create + SendMessage, зеркально YAML<->package
- Alternatives: modelId string — rejected (теряется providerID, upstream требует пару)
## Open Questions
- Есть ли model в SendMessageRequest? проверить sessions.ts 61+ и schema + openapi.yaml
- Куда бэкенд кладёт model: session.create body vs session.prompt body (SDK v1 режет неизвестные ключи — обход через fetchWithRetry+serveBasicAuthHeader с непустым телом!)
## Next Epoch Focus
- Decision foundation: точки врезки model, диагностика SSE scope/finalize
