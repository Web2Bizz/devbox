# Devbox Backend — monorepo MVP

Bun workspaces monorepo: NestJS 12 (backend) + Next.js 16.3 + Turbopack (frontend) + Postgres.

> Runtime: **Bun 1.4.2** (pinned in `.bun-version` — the single source of truth,
> mirrored in `packageManager`, `engines`, `oven/bun` Docker tags and CI).
> `bun.lock` is the lockfile. **Node 22 fallback** stays supported until CI is
> green on Bun (see "Node fallback" below).

## Structure

```
apps/
  backend/    # NestJS 12 + TypeScript 6 + Zod 4 + Drizzle API (GET /health)
  frontend/   # Next.js 16.3 App Router + React 19 + TypeScript + @web2bizz/ui (output: standalone, bundler: Turbopack)
docker-compose.yml
.bun-version / bunfig.toml / bun.lock
.github/workflows/  # ci.yml, docker.yml
```

## Frontend UI kit (@web2bizz/ui)

Private Verdaccio package (`https://npm.registry.web2bizz.team`, scope
`@web2bizz`), pinned exact in `apps/frontend/package.json` (currently
`0.25.8` — bump with `bun add @web2bizz/ui@<ver>` inside `apps/frontend`,
never by hand-editing the version).

- Peer deps: `react>=19`, `react-dom>=19` — frontend runs React 19, do not
  downgrade to 18.
- Auth is env-only: `export NPM_TOKEN=$(grep -oP '(?<=_authToken=).*' ~/.npmrc
  | tr -d '\r\n ')` locally, `secrets.NPM_TOKEN` in CI,
  `docker build --secret id=NPM_TOKEN` for images (never `--build-arg`;
  write the secret file with `printf '%s'`, a trailing newline breaks auth
  with HTTP 400). Details: `docs/npm-registry.md`.
- Wiring (App Router): `@web2bizz/ui/styles.css` imported once in
  `app/layout.tsx`, `<ThemeProvider defaultTheme="system"
  storageKey="devbox-frontend-theme">` via `src/providers.tsx`
  (mount-guarded — the kit reads `localStorage` in its initializer, which
  throws during SSR prerender). Page UI uses modular imports
  (`@web2bizz/ui/components`, `@web2bizz/ui/features`) and semantic tokens —
  no hardcoded colors, no local `cn()`, no `npx shadcn add` in the app.
- Kit API ground truth lives in the package after install:
  `node_modules/@web2bizz/ui/AGENTS.md` +
  `node_modules/@web2bizz/ui/docs/agents/*.md` +
  `node_modules/@web2bizz/ui/dist/<module>.d.ts`.
- Dashboard header is the kit `Header` (`@web2bizz/ui/components`,
  `variant="sticky"`, `wide`, `className="app-header"`): title/breadcrumbs →
  `leadingSlot`, actions/user + `LanguageSwitcher compact` +
  `ThemeToggleDefault` → `trailingSlot`, drawer trigger → `menuToggleSlot`.
  Shell stays `div.app-shell` + `div.app-main` + drawer (`Sidebar open/onClose`);
  i18n `en/ru` cookie-only (`devbox-locale`), brand tokens + `light/dark` via
  `globals.css` + `ThemeProvider` (`devbox-frontend-theme`), flat URLs
  `/login /projects /secrets /profile /ai-providers`, Next `16.3.6` +
  Turbopack + React `19.3.0`.

## Prerequisites

- Bun 1.4.2 (`bun --version` must match `.bun-version`; see it via `cat .bun-version`)
- Node 22 (`nvm use` / `.tool-versions`) — fallback only
- Docker + compose plugin (for full stack)

## Quick start (local, without Docker)

```bash
cp .env.example .env
bun install
bun run dev:backend   # http://localhost:3000/health
bun run dev:frontend  # http://localhost:3001 (or $NEXT_PUBLIC_PORT)
```

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build
# frontend → http://localhost:8080 (compose maps 8080:3000 to Next standalone via `bun server.js`)
# backend  → http://localhost:3000/health (`bun dist/main.js` on oven/bun:1.4.2)
```

## PM2 dev (local, one command)

PM2 reads the repo-root `.env` via `ecosystem.config.cjs` (no `env_file`
dependency) and injects it into both apps. Works with a real `.env` or with
built-in dev defaults (`PORT` 3000, `NEXT_PUBLIC_PORT` 3001, `OPENCODE_SERVER_URL`
`http://localhost:4096`, empty `DATABASE_URL` → backend boots with
`db: "skipped"`). PM2 spawns `bun run dev` / `bun run dev:next` per app.

```bash
cp .env.example .env   # once; .env is gitignored, never commit it
bun install
bun run dev            # pm2 start ecosystem.config.cjs (idempotent: starts or restarts)
bun run dev:shutdown   # pm2 delete ecosystem.config.cjs + pm2 kill (idempotent)
# aliases (kept for compatibility):
bun run dev:pm2        # = bun run dev
bun run dev:logs       # follow logs (= dev:pm2:logs)
bun run dev:pm2:logs   # alias, kept for compatibility
bun run dev:restart    # pm2 restart ecosystem.config.cjs --update-env
bun run dev:pm2:restart # alias, kept for compatibility
bun run dev:pm2:stop   # pm2 delete ecosystem.config.cjs
# backend  → http://localhost:3000/health (or $PORT/health)
# frontend → http://localhost:3001 (or $NEXT_PUBLIC_PORT)
```

## Окружение (dev/prod)

Single source: `.env.example` → скопируй в `.env` (gitignored, секреты только
там). Готовые пары для compose: `.env.dev` (localhost) и `.env.prod`
(шаблон — подставь реальные хосты и пароль перед деплоем). Все файлы —
машинно-чистые `KEY=VALUE` без комментариев; пояснения живут в таблице ниже.
`NEXT_PUBLIC_*` вшиваются в браузерный бандл на `next build` (через build ARG
в `apps/frontend/Dockerfile`), поэтому смена API URL требует пересборки
фронтенд-образа.

| переменная | назначение | dev | prod | обязательна |
| --- | --- | --- | --- | --- |
| `APP_BACKEND_PORT` | порт backend внутри/снаружи | `3100` | `3100` | нет |
| `APP_BACKEND_HOST` | хост backend для сборки URL (пусто → `localhost`) | пусто | пусто | нет |
| `APP_BACKEND_PROTOCOL` | схема backend URL | `http` | `https` | нет |
| `APP_BACKEND_SOCKET` | публичный URL backend (браузер + compose default API) | `http://localhost:3100` | `https://api.example.com` | да (prod) |
| `OPENCODE_URL` | адрес OpenCode stand (`0.0.0.0` маппится на `127.0.0.1` в коде) | `http://127.0.0.1:4096` | `http://127.0.0.1:4096` | нет |
| `POSTGRES_USER` | пользователь Postgres | `devbox` | `devbox` | нет |
| `POSTGRES_PASSWORD` | пароль Postgres (замени в prod) | `changeme` | замени | да (prod) |
| `POSTGRES_DB` | имя базы | `devbox` | `devbox` | нет |
| `POSTGRES_PORT` | хост-порт Postgres | `5432` | `5432` | нет |
| `POSTGRES_HOST` | хост PG для доступа с хоста (внутри сети всегда `postgres`) | `postgres` | `postgres` | нет |
| `DATABASE_URL` | строка подключения (в сети — хост `postgres`) | `postgres://devbox:changeme@postgres:5432/devbox` | та же схема, свой пароль | нет |
| `CORS_ORIGINS` | разрешённые origins фронтенда | `http://localhost:3001,http://localhost:8080` | `https://app.example.com` | да (prod) |
| `REQUEST_TIMEOUT_MS` | таймаут upstream-запросов backend | `10000` | `10000` | нет |
| `LOG_LEVEL` | уровень логов | `debug` | `info` | нет |
| `NEXT_PUBLIC_PORT` | порт `next dev` (prod standalone всегда `:3000`) | `3001` | `3001` | нет |
| `NEXT_PUBLIC_API_URL` | URL backend для браузера (build ARG) | `http://localhost:3100` | `https://api.example.com` | да (prod) |
| `NPM_TOKEN` | токен приватного registry `@web2bizz` (только env/secret, не в git) | env | CI secret | да (сборка) |

```bash
docker compose --env-file .env.dev up --build                       # dev: override (hot-reload, bind-mounts, 127.0.0.1)
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d --build  # prod: лимиты, standalone
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod exec postgres pg_dump -U devbox devbox > backup.sql  # бэкап PG
```

Порты: `5432` postgres · `3100` backend · `3001` frontend dev (`next dev --turbopack`) / `8080` frontend prod (standalone `:3000`).
Сети: `front` (frontend↔backend) · `back` (backend↔postgres).
Volumes: `pgdata` (данные PG — бэкап командой выше) · `frontend-dev-next` (только dev-override, кэш `.next`).

## Commands

| Command              | What it does                          |
| -------------------- | ------------------------------------- |
| `bun install`        | install all workspaces (`bun.lock`)   |
| `bun run dev`        | pm2 cluster (backend+frontend, via bun)|
| `bun run dev:shutdown` | stop cluster + kill pm2 daemon        |
| `bun run dev:backend`| backend dev (`bun --bun nest start --watch`, :3000) |
| `bun run dev:frontend`| frontend dev (next dev, :3001)        |
| `bun run build`      | build all workspaces (`bun --filter …`)|
| `bun run lint`       | `tsc --noEmit` per workspace          |
| `bun run test`       | `bun test --pass-with-no-tests` per workspace |
| `docker compose up --build` | full stack (pg + backend + frontend) |

## CI / Docker

- CI (`ci.yml`) uses `oven-sh/setup-bun@v2` with `bun-version-file: .bun-version`,
  then `bun install` / `bun run lint` / `bun run build` / `bun run test`.
- Images build `FROM oven/bun:1.4.2` (3 stages each); backend runs
  `bun dist/main.js`, frontend runs `bun apps/frontend/server.js` (Next standalone,
  `output: 'standalone'` preserved). Healthchecks probe via `bun -e fetch(…)`.

## Node fallback

Until Bun CI is green, Node 22 still works:

```bash
npm install                  # legacy lockfile removed; regenerates package-lock.json (gitignored)
npm run dev:backend          # nest start --watch (backend script also runs under node)
npm run dev:frontend         # next dev
```

Notes: backend `start` (`bun dist/main.js`) also runs as `node dist/main` —
compiled output is plain JS. PM2 fallback: set `script: 'npm', args: 'run dev'`
/ `'run dev:next'` in `ecosystem.config.cjs`. Frontend `start` under node:
`node .next/standalone/apps/frontend/server.js`.

## Ports

- `5432` postgres · `3000` backend · `3001` frontend (next dev) / `8080` frontend via compose (Next standalone)

## Repos registry (readonly)

Readonly index of git repositories on disk — the backend never clones,
pulls or writes, it only scans and validates what you put there.

Layout: `REPOS_ROOT/<user-space>/workspace/<repo>` (`REPOS_ROOT` in `.env`,
required for all storage — empty root denies reads with 503 and creates with
500; an explicitly set but missing/unreadable `REPOS_ROOT` fails boot with
`[env] REPOS_ROOT`).

How to drop a test repo:

```bash
mkdir -p "$REPOS_ROOT/alice/workspace"
git init "$REPOS_ROOT/alice/workspace/demo"   # or: cp -r /path/to/repo "$REPOS_ROOT/alice/workspace/demo"
curl 'http://localhost:3000/api/v1/repos'                    # all spaces
curl 'http://localhost:3000/api/v1/repos/alice?q=dem&limit=10&offset=0'
```

Rules: only directories containing a valid `.git` are listed (`git rev-parse
+ git fsck`, 5s timeout each, no shell); plain directories (`no-git`) and
broken repos (`corrupted` → `logger.warn { path, reason }`) are skipped and
never fail the whole listing. API is GET-only (`POST /api/v1/repos` → 404);
`userSpace` must match `/^[a-zA-Z0-9_-]+$/` (else 400); every path is
realpath-resolved and jailed inside `REPOS_ROOT`.
