# DevBox — monorepo

Bun workspaces monorepo: NestJS 12 (backend) + Next.js 16.3 + Turbopack
(frontend) + Expo 57 / React Native 0.86 (mobile, `@web2bizz/ui-native`) +
Postgres. Shared contract in `contracts/`, deployment images in
`images/opencode/`.

> Runtime: **Bun 1.4.2** (pinned in `.bun-version` — the single source of truth,
> mirrored in `packageManager`, `engines`, `oven/bun` Docker tags and CI).
> `bun.lock` is the lockfile. **Node 22 fallback** is still supported, but note
> that CI is **not** green on Bun yet — see "CI status" below.

## Structure

```
apps/
  backend/    # NestJS 12 + TypeScript 6 + Zod 4 + Drizzle API (GET /health)
  frontend/   # Next.js 16.3 App Router + React 19 + TypeScript + @web2bizz/ui (output: standalone, bundler: Turbopack)
  mobile/     # Expo 57 / RN 0.86 + @web2bizz/ui-native (standalone npm project, NOT a bun workspace)
contracts/    # openapi.yaml (API contract) + opencode-upstream.json
images/
  opencode/   # separate compose stack for the opencode image (Dokploy)
docs/         # env validation, auth, npm registry, migration notes
DESIGN.md     # repo-wide design-system referat (frontend + mobile)
.github/workflows/  # 8 workflows (ci, docker, mobile,
                    # publish-play-store,
                    # activation-e2e, product-intelligence, triage-reviews,
                    # bump-version) — most with paths filters; mobile.yml is the
                    # single conditional workflow for the Android native build
docker-compose.yml
.bun-version / bunfig.toml / bun.lock
```

## Design system

- [`DESIGN.md`](DESIGN.md) — repo-wide referat: общие правила для всех
  UI-приложений монорепо. При расхождении с прикладным `DESIGN.md` побеждает
  прикладной (он ближе к коду и кит-версии).
- [`apps/frontend/DESIGN.md`](apps/frontend/DESIGN.md) — веб-шелл: порядок
  стилей, токены, радиусы, бренд.
- [`apps/mobile/DESIGN.md`](apps/mobile/DESIGN.md) + `apps/mobile/AGENTS.md` —
  mobile-приложение и его гейты.

## Mobile (apps/mobile)

Expo 57 / React Native 0.86 клиент на `@web2bizz/ui-native`
(`file:packages/uikit` — локальный uikit-пакет внутри mobile). Это
**отдельный npm-проект**: свой `package-lock.json`, ставится с
`--legacy-peer-deps`, и намеренно **НЕ входит в bun workspaces** (иначе
`bun.lock` начал бы резолвить его peer-зависимости по своим правилам и ломал
expo-специфичное разрешение). Запуск — только из своей директории:

```bash
cd apps/mobile && npm install --legacy-peer-deps && npx expo start
```

Mobile-воркфлоу в CI: `mobile.yml` (paths-фильтр `apps/mobile/**`: tests +
conditional Android build + Release/Prerelease) и ручной
`publish-play-store.yml`
(`workflow_dispatch`, без paths-фильтров). `activation-e2e.yml` тоже
paths-gated (`apps/mobile/app/**`, `src/**`, `packages/**`).

## images/opencode

Образ `opencode` (`Dockerfile` + `entrypoint.sh` + `reload-secrets.sh` +
`docker-compose.yml` внутри `images/opencode/`). Входит в корневой
`docker-compose.yml` как сервис `opencode` (локальный `build` из
`images/opencode/`, сеть `back`, `expose 4096` без публикации наружу —
порт виден только внутри сети) и дополнительно публикуется через CI
(`docker.yml`, job `opencode`, вне discovery-матрицы) в self-hosted registry
для Dokploy/prod-деплоев, забирающих готовый образ. Тома —
`opencode-*` (`projects`, `ssh-keys`, `gh-config`, `pnpm-store`,
`opencode-data`, …), лимиты prod — `2G`/`2.0` (тяжёлый образ: Playwright
Chromium + pm2). Требует `OPENCODE_SERVER_PASSWORD` (fail-fast, если не
задан). Отдельный `images/opencode/docker-compose.yml` остался для
standalone-поднятия в Dokploy (внешняя сеть `dokploy-network`).

## Frontend UI kit (@web2bizz/ui)

Private Verdaccio package (`https://npm.registry.web2bizz.team`, scope
`@web2bizz`), pinned exact in `apps/frontend/package.json` (currently
`0.26.0` — bump with `bun add @web2bizz/ui@<ver>` inside `apps/frontend`,
never by hand-editing the version). Mobile uses the sibling package
`@web2bizz/ui-native` (vendored as `apps/mobile/packages/uikit`).

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
там) для локальных запусков без Docker. Compose читает ЕДИНСТВЕННЫЙ
`docker-compose.yml`; конфиги — только через внешнее окружение (shell/Dokploy),
никаких `env_file` и `.env.${NODE_ENV}`-файлов compose не читает — не создавай
их. Пояснения живут в таблице ниже.
`NEXT_PUBLIC_*` вшиваются в браузерный бандл на `next build` (через build ARG
в `apps/frontend/Dockerfile`), поэтому смена API URL требует пересборки
фронтенд-образа.

| переменная | назначение | dev | prod | обязательна |
| --- | --- | --- | --- | --- |
| `APP_BACKEND_PORT` | порт backend внутри/снаружи | `3100` | `3100` | нет |
| `APP_BACKEND_HOST` | хост backend для сборки URL (пусто → `localhost`) | пусто | пусто | нет |
| `APP_BACKEND_PROTOCOL` | схема backend URL | `http` | `https` | нет |
| `APP_BACKEND_SOCKET` | публичный URL backend (браузер + compose default API) | `http://localhost:3100` | `https://api.example.com` | да (prod) |
| `OPENCODE_URL` | адрес OpenCode stand (`0.0.0.0` маппится на `127.0.0.1` в коде; в compose дефолт — `http://opencode:4096` внутри сети) | `http://127.0.0.1:4096` | `http://opencode:4096` | нет |
| `OPENCODE_SERVER_PASSWORD` | пароль `opencode serve` (compose fail-fast без него; в секреты, не в git) | задай | задай | да (compose) |
| `POSTGRES_USER` | пользователь Postgres | `devbox` | `devbox` | нет |
| `POSTGRES_PASSWORD` | пароль Postgres (замени в prod) | `changeme` | замени | да (prod) |
| `POSTGRES_DB` | имя базы | `devbox` | `devbox` | нет |
| `POSTGRES_PORT` | хост-порт Postgres | `5432` | `5432` | нет |
| `POSTGRES_HOST` | хост внешней PG (сервиса postgres в compose нет) | `pg.db.web2bizzz.store` | свой хост | нет (код) |
| `DATABASE_URL` | строка подключения к внешней PG (в compose обязательна — fail-fast) | `postgres://devbox:changeme@pg.db.web2bizzz.store:5432/devbox` | та же схема, свой пароль | да (compose) |
| `CORS_ORIGINS` | разрешённые origins фронтенда | `http://localhost:3001,http://localhost:8080` | `https://app.example.com` | да (prod) |
| `REQUEST_TIMEOUT_MS` | таймаут upstream-запросов backend | `10000` | `10000` | нет |
| `LOG_LEVEL` | уровень логов | `debug` | `info` | нет |
| `BACKEND_PUBLISH` | публикация backend (`[ip:]hostport`, контейнерный `:3100` фиксирован) | `127.0.0.1:3100` | `3100` | нет |
| `FRONTEND_PUBLISH` | публикация frontend prod (`[ip:]hostport`, контейнерный `:3000` фиксирован) | `127.0.0.1:8080` | `8080` | нет |
| `FRONTEND_DEV_PUBLISH` | публикация dev-сервера (`--profile dev`) | `127.0.0.1:3001` | — | нет |
| `COMPOSE_PROFILES` | включает `frontend-dev` (`build` + `bun run dev:next` с бинд-маунтами) | `dev` | пусто | нет |
| `NEXT_PUBLIC_PORT` | порт `next dev` (prod standalone всегда `:3000`) | `3001` | `3001` | нет |
| `NEXT_PUBLIC_API_URL` | URL backend для браузера (build ARG) | `http://localhost:3100` | `https://api.example.com` | да (prod) |
| `NPM_TOKEN` | токен приватного registry `@web2bizz` (только env/secret, не в git) | env | CI secret | да (сборка) |

```bash
docker compose up -d --build   # prod: лимиты вшиты, standalone (DATABASE_URL и OPENCODE_SERVER_PASSWORD обязательны, извне)
COMPOSE_PROFILES=dev BACKEND_PUBLISH=127.0.0.1:3100 docker compose --profile dev up --build backend frontend-dev  # dev: hot-reload, bind-mounts, 127.0.0.1
```

Порты: `3100` backend · `3001` frontend dev (`next dev --turbopack` через `frontend-dev`) / `8080` frontend prod (standalone `:3000`) · `4096` opencode только внутри сети (`expose`, наружу не публикуется). Postgres — внешний (в compose сервиса нет).
Сети: `front` (frontend↔backend) · `back` (backend↔opencode).
Volumes: `frontend-dev-next` (только `--profile dev`, кэш `.next`) · `opencode-*` (workspace/ssh/gh-config/pnpm-store/pm2/opencode-data/secrets/playwright-browsers). Бэкап БД — на стороне внешнего Postgres.

## Commands

| Command              | What it does                          |
| -------------------- | ------------------------------------- |
| `bun install`        | install all workspaces (`bun.lock`)   |
| `bun run dev`        | pm2 cluster (backend+frontend, via bun)|
| `bun run dev:shutdown` | stop cluster + kill pm2 daemon        |
| `bun run dev:backend`| backend dev (`bun --bun nest start --watch`, :3000) |
| `bun run dev:frontend`| frontend dev (next dev, :3001)        |
| `bun run build`      | build all workspaces (`bun --filter …`); in CI the same goes via `nx affected` (touched projects only) |
| `bun run lint`       | `tsc --noEmit` + `biome lint` per workspace (Biome replaces eslint — no eslint config left) |
| `bun run test`       | `bun test --pass-with-no-tests` per workspace; in CI via `nx affected` (backend tests run on `dist`, so build precedes test) |
| `docker compose up --build` | full stack (backend + frontend + opencode; postgres внешний) |

`apps/mobile` is **not** in `workspaces` and has no `bun --filter` script — it
is a separate npm project run from its own directory:

```bash
cd apps/mobile
npm install --legacy-peer-deps   # its own package-lock.json
npx expo start                   # see apps/mobile/AGENTS.md for gates
```

## CI / Docker

Workflows live in the root `.github/workflows/` — 8 of them: `ci`, `docker`,
`mobile`, `publish-play-store`,
`activation-e2e`, `product-intelligence`, `triage-reviews`,
`bump-version`. Most are gated by `paths:` filters, so `mobile.yml` only runs
on `apps/mobile/**` changes and the web/docker stack only on its own paths;
the `publish-*` mobile workflows are manual (`workflow_dispatch`).

- CI (`ci.yml`) uses `oven-sh/setup-bun@v2` with `bun-version-file: .bun-version`,
  then `bun install`, resolves base/head via `nrwl/nx-set-shas`, and runs
  `nx affected -t lint` → `build` → `test` (only touched projects; order
  matters — backend tests run against compiled `dist`).
- Docker (`docker.yml`, push to `dev` + manual) discovers services in
  `apps/*`, intersects with the Nx affected set, and pushes to the self-hosted
  `docker.registry.web2bizz.team/<owner>/<repo>/<service>` (not GHCR).
- Mobile has its own workflows (`mobile.yml` → tests + conditional Android
  native build + Release/Prerelease, `publish-*.yml`) and `activation-e2e.yml`
  for smoke tests.

- Images build `FROM oven/bun:1.4.2` (3 stages each): backend on the `-slim`
  base, frontend on the regular one. Backend runs `bun dist/main.js`, frontend
  runs `bun apps/frontend/server.js` (Next standalone,
  `output: 'standalone'` preserved). Healthchecks probe via `bun -e fetch(…)`.
- `images/opencode/` is a separate Dokploy stack — see its section above.

### CI status — NOT green (honest)

As of 2026-10-13 on `ci/normalize-builds-publish`: Install ✓, Lint
(affected) ✓, Build (affected) ✓, Mobile CI ✓. Red is `Test affected` —
6 frontend `login page 400 wiring` contract tests fail (100 pass / 6 fail
across 19 files); backend `dist` tests pass. Secrets (`NPM_TOKEN`,
`DOCKER_REGISTRY_PASSWORD`) are set, so this is test debt, not missing auth.
Until it is fixed, do not read a red CI as an infra regression.

## Node fallback

Node 22 works today **because CI is not green on Bun** (see "CI status"); the
previous wording was "until CI is green on Bun". If CI turns green, revisit
this section.

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

- `3000` backend · `3001` frontend (next dev) / `8080` frontend via compose (Next standalone)

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
