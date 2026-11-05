# AGENTS.md — Rush Code (monorepo)

## Сервисы

- **apps/backend** — NestJS API, основной бэкенд — см. [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md).
- **apps/frontend** — Next.js веб-шелл — см. [`apps/frontend/AGENTS.md`](apps/frontend/AGENTS.md).
- **apps/mobile** — Expo-мобильное приложение (standalone npm, вне bun workspaces) — см. [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md).
- **apps/cli** — CLI, интерактивный REPL в стиле opencode — см. [`apps/cli/AGENTS.md`](apps/cli/AGENTS.md).

## Пакеты

- **packages/contracts** — общие wire-типы и zod-схемы бэкенд↔фронт — см. [`packages/contracts/AGENTS.md`](packages/contracts/AGENTS.md).
- **packages/biome-config** — общий Biome-конфиг (`biome.json`: парсер + `noConsole` + test-исключения). Корень (`biome.jsonc`) и каждый сервис (`apps/*/biome.jsonc`, `packages/contracts/biome.jsonc`) только наследуют его через `extends` + локальные игноры сборки.

## Скрипты

- `bun run dev` — локальный запуск всего стенда (`nx run-many -t dev`: contracts-watch + backend + frontend).
- `bun run dev:backend` — только бэкенд (:3100).
- `bun run dev:frontend` — только фронтенд (:3001).
- `bun run dev:stop` / `bun run stop` — остановка локального стенда.
- `bun run dev:restart` / `bun run restart` — перезапуск локального стенда (`stop && dev`).
- `bun run build` / `build:backend` / `build:frontend` / `build:affected` — сборка всех / точечно / только изменённых.
- `bun run lint` / `lint:affected` — проверка типов (`tsc --noEmit`) и стиля (`biome lint`) всех / только изменённых.
- `bun run test` / `test:affected` — тесты всех / только изменённых.
- `bun run graph` — граф зависимостей проектов.

## Порты

| Порт | Сервис |
| ---- | ------ |
| `3100` | backend (NestJS API; compose публикует как `${BACKEND_PUBLISH:-3100}:3100`) |
| `3001` | frontend dev (`next dev`; prod standalone — `:3000`, compose маппит `8080:3000`) |
| `8080` | frontend via compose (host-порт к контейнерному `:3000`) |
| `5432` | Postgres внешний (сервиса в compose нет) |

## Дополнительные правила

- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- [`DESIGN.md`](DESIGN.md)

