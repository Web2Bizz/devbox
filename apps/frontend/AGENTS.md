<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — frontend (Rush Code web)

Канон — корень [`AGENTS.md`](../../AGENTS.md) (разделы «Frontend — дизайн-система»,
«Frontend — слои», включая `### Data-хуки — только React Query`).
Этот файл хранит Next.js-блок выше + локальные уточнения границы ниже;
правила слоёв/хуков — в корне.

## OpenCode-граница (жёстко)
- Фронтенд **не импортирует `@opencode-ai/sdk`** и не ходит в `/api/opencode/*` — guard-тест `src/__tests__/no-opencode-transport.test.ts` ловит регрессию (включая комментарии). Доменный контракт — `/api/sessions*` (`@rush-code/contracts` `packages/contracts/src/sessions/`).
- Всё опенкод-связанное обёрнуто в `src/api/sessions-client.ts` поверх единого `src/api/client.ts` (`request()`); SSE — документированное исключение `streamSessionEvents` (JSON-буферизации нет).
- `app/` — только тонкая композиция; бизнес-логика в `features/` + `hooks/`. Query-ключи — только из `query-keys.ts`; data-хуки на React Query (streaming/SSE — `useEffect` с комментом-обоснованием, wontfix).
- Доменный `SessionInfo.directory` — реальное поле (Q6 закрыт на бэкенде); `title`/`text` могут быть `null`.
- Все поверхности доменные: abort → `POST /api/sessions/:id/interrupt` (best-effort, `interrupted:false` = idle no-op, не ошибка), провайдеры → `GET /api/sessions/providers`, модели для `ModelSelector` → `GET /api/sessions/models` (единый dropdown, без provider-селектора). `stop()` в `useChat` прерывает prompt, шлёт interrupt, коммитит partial и **глушит дальнейшие SSE-кадры** (`sendingRef`-гард). Выбранная модель живёт в состоянии чата и уходит только на create сессии (prompt её не принимает); перезагрузка страницы её не сохраняет — см. корень «Модель пинится созданием сессии».
