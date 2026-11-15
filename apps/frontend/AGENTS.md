<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — frontend (Rush Code web)

Этот файл — канон фронтенда: структура, слои, хуки, дизайн-система и граница.
Корень [`AGENTS.md`](../../AGENTS.md) хранит только ссылку сюда.

## Дизайн-система

- Общие правила — [`DESIGN.md`](../../DESIGN.md) (корень). При расхождении
  побеждает **прикладной**: [`DESIGN.md`](../frontend/DESIGN.md) (веб-шелл)
  ближе к коду и кит-версии.
- Читать перед правками шелла (`dashboard-shell`, `layout/Sidebar`,
  `layout/Content`, `app/globals.css`).
- Порядок стилей: `@web2bizz/ui/styles.css` → `globals.css`
  (source order, не менять). Hex — только `:root` / `.dark`.
- Проверки: `bun run lint` (`tsc --noEmit` + `biome lint`) + `bun run build`
  (`next build --turbopack`).

## Слои

- `app/` — только тонкая композиция (страница владеет `<ФичаСекция />`,
  бизнес-логика — в `features/` + `hooks/`). Каталогов `entities/` и `shared/`
  нет — не выдумывать.

| Слой | Путь | Что класть |
| ---- | ---- | ---------- |
| Маршруты | `app/` | `layout.tsx` — владелец расположения (Server по умолчанию, без `'use client'`: `grid`/высоты/пины/слоты); `page.tsx` — тонкая (params → `<ФичаСекция />`); `loading.tsx`/`error.tsx`; `globals.css` |
| Фичи | `src/features/*.tsx` (плоско, без подпапок — см. `CODE_OF_CONDUCT.md` §1) | фича-файл: состояние + порядок строк + UI-секция + диалоги + локальный статус; геометрию маршрута получает через `className` от `layout.tsx`, своей не задаёт (см. `CODE_OF_CONDUCT.md` §2) |
| Компоненты | `src/components/` | папка на компонент: `<имя>/<Имя>.tsx` + `types.ts` + `index.ts` (барелль); типы — только в `types.ts` (`export type`, без `interface`); россыпь файлов `chat-*.tsx` в одной папке запрещена (см. `CODE_OF_CONDUCT.md` §3) |
| Хуки | `src/hooks/` | data-хуки + `query-keys.ts` (единственный источник ключей) |
| API | `src/api/` | `client.ts` (единственный fetch-слой) + `sessions-client.ts` (доменный фасад); своих типов не заводить |
| Lib | `src/lib/` | утилиты, сторы + алиасы схем (реэкспорт пакета) |
| i18n | `src/i18n/` | словарь en/ru, провайдер |

### Server/Client-граница (Next App Router)

- `app/**/layout.tsx` — Server по умолчанию: никакого `'use client'`,
  `useState`/`useEffect`/`usePathname` там запрещены; владеет только
  расположением (`grid`/высоты/пины) и пробрасывает интерактив через
  `children`/слоты.
- `'use client'` — только интерактив: `src/features/*`, `src/components/*`,
  `src/hooks/*` (стриминг-исключение `useChat` — см. ниже).

### Data-хуки — только React Query

- Все data-хуки — на `useQuery`/`useMutation`/`useQueryClient`.
- `queryFn` бросает raw `ApiClientError`; формат — в `useMemo` через `format-error` + `t`.
- `reload` = `invalidateQueries({ queryKey })`; ключи — только из `query-keys.ts`.
- Исключение — streaming/SSE (`useChat`): `useEffect` + доменный SSE
  с комментом-обоснованием; на React Query не переносится.

## Структура

```
app/            — маршруты Next (тонкая композиция: страница владеет <ФичаСекция/>)
src/
├─ api/
│   ├─ client.ts — ЕДИНСТВЕННЫЙ fetch-слой: request()/requestV1(), BASE_URL из
│   │   process.env.NEXT_PUBLIC_API_URL (verbatim), ApiClientError, x-correlation-id,
│   │   parseBoundary zod-схемами (@rush-code/contracts), streamSessionEvents — SSE-исключение
│   ├─ sessions-client.ts — доменный фасад /api/v1/sessions*: withAuth (single-flight refresh,
│   │   одна ротация на честный 401, spent → SessionExpiredError; 400/404 никогда не логаут),
│   │   ensureSessionAuth, listSessions/createSession/getSessionStatuses/listSessionModels/
│   │   listSessionProviders/listSessionMessages/sendSessionMessage/interruptSession/
│   │   sessionEventStream/toErrorMessage
│   └─ types.ts — deprecated-реэкспорт контрактов (своих типов не заводить)
├─ hooks/ — useSessions, useSessionMessages, useSessionEvents, useChat (стриминг-исключение:
│   useEffect+domain SSE, финал session.step.ended, stop() глушит кадры), useAiProviders,
│   useProjects/useProject/useOrganizations/... ; query-keys.ts — ЕДИНСТВЕННЫЙ источник ключей
├─ components/chat/ — папки компонентов: `mode-selector/`, `chat-input/`,
│   `chat-message/`, `chat-thread/`, `chat-thinking-row/`, `chat-thread-empty/`,
│   `chat-thread-loading/`, `chat-tool-row/`, `chat-live-status/`
│   (в каждой `<Имя>.tsx` + `types.ts` + `index.ts`, в `chat-tool-row/` +
│   `utils.ts` (форматеры); плоских `chat-*.tsx`
│   в корне `chat/` нет; dropdown режимов — единый `ModeSelector` из
│   GET /api/v1/agents (backend-контракт agents), без provider-селектора)
├─ features/ — плоско: `chat-section.tsx` (тонкая сборка useChat+kit),
│   `chat-fork-dialog.tsx`, `chat-revert-dialog.tsx`, `usage-section.tsx`
│   (без подпапок — см. `CODE_OF_CONDUCT.md` §1)
├─ lib/ — auth-store, format-error, session-expired, словари-схемы
├─ i18n/ — en/ru/types (namespace t.sessions/t.chat)
└─ __tests__/no-opencode-transport.test.ts — guard: запрет @opencode-ai/sdk и /api/opencode/*
    в src+app+package.json (включая комментарии), ассерт покрытия против «молча проверяет 0»
```

Статика — только `public/assets/` (единственное место: `logo.png`,
`favicon.ico`, `icon.png`, `apple-icon.png`). File-конвенции в корне
`app/` не использовать — иконки заданы явными `icons.url` (`/assets/*`)
в `app/layout.tsx`; `app/assets/` не заводить.

### Цепочка чата

`send` → `POST /api/v1/sessions/:id/messages` (queued) → дельты по `events` SSE (scope по
`frame.session`) → `session.step.ended` коммитит ответ. `stop()`: abort POST'а prompt'а +
`POST /api/v1/sessions/:id/interrupt` + partial-коммит + drop дальнейших кадров (`sendingRef`-гард).

## OpenCode-граница (жёстко)
- Фронтенд **не импортирует `@opencode-ai/sdk`** и не ходит в `/api/opencode/*` — guard-тест `src/__tests__/no-opencode-transport.test.ts` ловит регрессию (включая комментарии). Доменный контракт — `/api/v1/sessions*` (`@rush-code/contracts` `packages/contracts/src/sessions/`).
- Всё опенкод-связанное обёрнуто в `src/api/sessions-client.ts` поверх единого `src/api/client.ts` (`request()`); SSE — документированное исключение `streamSessionEvents` (JSON-буферизации нет).
- `app/` — только тонкая композиция; бизнес-логика в `features/` + `hooks/`. Query-ключи — только из `query-keys.ts`; data-хуки на React Query (streaming/SSE — `useEffect` с комментом-обоснованием, wontfix).
- Доменный `SessionInfo.directory` — реальное поле (Q6 закрыт на бэкенде); `title`/`text` могут быть `null`.
- Все поверхности доменные: abort → `POST /api/v1/sessions/:id/interrupt` (best-effort, `interrupted:false` = idle no-op, не ошибка), провайдеры → `GET /api/v1/sessions/providers`, модели для `ModelSelector` → `GET /api/v1/sessions/models` (единый dropdown, без provider-селектора). `stop()` в `useChat` прерывает prompt, шлёт interrupt, коммитит partial и **глушит дальнейшие SSE-кадры** (`sendingRef`-гард). Выбранная модель живёт в состоянии чата и уходит только на create сессии (prompt её не принимает); перезагрузка страницы её не сохраняет — см. корень «Модель пинится созданием сессии».

## Дополнительные правила

- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — обязательно к прочтению
  перед написанием кода (плоские фичи `features-flat`).
