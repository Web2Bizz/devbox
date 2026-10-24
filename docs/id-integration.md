# @web2bizz/id integration spec (spec-first, no code yet)

> Status: **BLOCKED — package metadata unavailable** (registry unreachable,
> see §0). No `package.json` / lock in the repo was touched. All install
> attempts happened in `/tmp/id-spec` only. This doc records what was tried,
> what is known from the repo, and the migration plan to execute once the
> registry is reachable. No secrets are recorded here (token length only).

## 0. Probe results (2026-10-01, no secrets logged)

- Token source: `~/.npmrc` (`//npm.registry.web2bizz.team/:_authToken=…`),
  injected as `NPM_TOKEN` env. Presence confirmed (`token_len:360`,
  exact value never printed / logged / committed). Project wiring already
  exists and was NOT changed: `.npmrc` scoped placeholder +
  `bunfig.toml [install.scopes]` + `.env.example NPM_TOKEN=` +
  `docs/npm-registry.md`.
- `npm ping --registry https://npm.registry.web2bizz.team` →
  `ECONNREFUSED 207.180.223.153:443` (curl `000`, `Failed to connect`,
  DNS resolves to `207.180.223.153`).
- `npm view @web2bizz/id version dist-tags dependencies` → same
  `ECONNREFUSED` (packument fetch fails before auth is even evaluated).
- `bun info @web2bizz/id` (with `NPM_TOKEN` exported) →
  `ConnectionRefused: view request failed to send`.
- `/tmp/id-spec` without scoped config: `bun add @web2bizz/id` falls back
  to `registry.npmjs.org` → `404` (expected: scope wiring is required).
- `/tmp/id-spec` WITH scoped config (temp `.npmrc` + `bunfig.toml` created
  in `/tmp` only, placeholder `${NPM_TOKEN}` / `$NPM_TOKEN`, never in repo):
  `bun add @web2bizz/id` reaches Verdaccio and fails with
  `ConnectionRefused downloading package manifest @web2bizz/id`.
- `https://registry.npmjs.org/@web2bizz%2Fid` → `404` (package is private,
  not on public npm — confirms Verdaccio-only distribution).

Conclusion: **network-level blocker, not auth**. The token exists locally;
TCP 443 to the Verdaccio host is refused from this network. Retry from a
network where `npm ping` succeeds, then fill in §1 (version/exports/`.d.ts`).

### Blocker — what exactly prevents progress

1. `npm.registry.web2bizz.team:443` — `ECONNREFUSED`. No packument, no
   tarball, no `.d.ts` to read. Cannot confirm version, deps, exports,
   or `User`/`Session` types.
2. Without the tarball, `dist/*.d.ts` (guard / service / client split) is
   unknown — §1–§3 below are **decisions to verify**, not facts.
3. Unblock command (safe, token never logged):
   ```bash
   export NPM_TOKEN=$(grep -oP '(?<=_authToken=).*' ~/.npmrc | tr -d '\r\n ')
   npm ping --registry https://npm.registry.web2bizz.team  # must print PONG
   npm view @web2bizz/id version dist-tags dependencies peerDependencies
   mkdir -p /tmp/id-spec && cd /tmp/id-spec
   # scoped wiring in /tmp only (copy pattern from repo .npmrc/bunfig.toml)
   NPM_TOKEN=$NPM_TOKEN bun add @web2bizz/id
   # then read: node_modules/@web2bizz/id/dist/**/*.d.ts + package.json exports
   ```

## 1. Package metadata (TO FILL once registry is reachable)

| Field | Value (today) |
|---|---|
| Version | **unknown** (blocked) — record `npm view` output here |
| `dist-tags` | unknown — record `latest` here |
| `dependencies` | unknown — record here |
| `peerDependencies` | unknown — record here (NestJS? React? Next?) |
| `exports` map | unknown — record `./package.json` `exports` verbatim here |
| `dist/*.d.ts` | unread — expected: guard / service / client + `User`/`Session` types |

Verification checklist (in `/tmp/id-spec`, never in repo):

```bash
cat node_modules/@web2bizz/id/package.json | head -n 80  # exports, peerDeps
find node_modules/@web2bizz/id/dist -name '*.d.ts' | head -n 30
# read each .d.ts: exports, guard/service/client, User/Session shapes
grep -rn "export" node_modules/@web2bizz/id/dist/*.d.ts | head -n 60
```

Candidate surface to confirm (do NOT assume — check the real `.d.ts`):

- server: `IdModule` / `IdGuard` / `IdService` (NestJS guard + user resolver),
  `verifyToken` / `getUser` / `getSession`.
- client: `createIdClient` / `login` / `logout` / `getProfile` / React hooks
  (if the package ships its own `useLogin`/`useProfile`, they replace ours;
  otherwise we keep our hooks and call its client inside).
- types: `User { id, email, name, … }`, `Session { … }` — map to our
  `MockUser` / `Profile` (§4) and note every extra/required field.

Precedent: `@web2bizz/ui@0.26.0` is frontend-only (`apps/frontend/package.json`).
`apps/backend/package.json` currently has zero `@web2bizz/*` deps. So a
dual install (below) would be the first backend private dep — follow the
`docs/npm-registry.md` Docker/CI secret pattern from day one.

## 2. Protocol decision: JWT Bearer (primary), cookie (optional, later)

Repo facts today:

- No `AuthGuard`, no JWT, no passport, no server session. Identity is a
  **mock string**: `resolveUserId(req, queryUserId)` =
  `x-user-id` header wins → `?userId` query → `'default'`
  (`apps/backend/src/projects/github/github.controller.ts:41-60`,
  duplicated in `apps/backend/src/workspaces/workspaces.controller.ts:35-49`).
- CORS allowlist includes `x-user-id`
  (`apps/backend/src/app.setup.ts:70`).
- Drizzle: no `users` table; `github_installations.user_id` is nullable
  text, FK-less, explicitly waiting for users
  (`apps/backend/src/db/schema.ts:11-12,63-72`).
- Frontend: `useLogin` (mock latency + `isMockCredential`) with
  `TODO REAL-API: api.login`, `useProfile` (mock timer + `MOCK_PROFILE`)
  with `TODO REAL-API: GET/PUT /api/v1/profile`; `api/client.ts` is
  `fetch ${BASE_URL}/api/v1/*` with `x-correlation-id`, no auth header yet;
  only cookie in the codebase is `rush-code-locale` (`SameSite=Lax`).
- No `POST /api/survey` exists in `contracts/openapi.yaml` (searched
  `survey|Survey` — zero hits), so there is no frozen survey contract to
  preserve; new auth endpoints must still go through `contracts/openapi.yaml`
  + versioned `/api/v1` (unversioned aliases are 404 by design).

Decision (to confirm against the real `.d.ts`):

- **Primary: JWT Bearer** (`Authorization: Bearer <token>`). Stateless,
  fits the API-only NestJS backend + Next.js `fetch` client, no CSRF
  surface, works for both browser and non-browser callers. Backend
  validates on every request (guard); frontend stores the token in memory
  (never `localStorage` for the refresh token) and sends it via
  `api/client.ts` `requestV1`.
- **Cookie (`HttpOnly; Secure; SameSite=Lax`) — optional phase 2**, only if
  `@web2bizz/id` documents a cookie session mode AND we need SSR cookie
  forwarding in Next.js. Do NOT introduce a cookie session in phase 1 —
  it adds CSRF + CORS credential complexity (`credentials: 'include'`,
  `Access-Control-Allow-Credentials`, origin allowlist tightening).
- Whichever the package uses, the backend remains the **only token verifier**.
  The frontend never verifies JWTs (no secret in the browser bundle).

Open questions for the `.d.ts` reading:

1. Does the package verify JWTs locally (JWKS/issuer) or via introspection
   HTTP call (latency + `EXTERNAL_UNAVAILABLE` mapping needed)?
2. Is there a refresh flow (refresh token rotation, where stored)?
3. Does it ship a NestJS guard (`CanActivate`) or plain `verify()` helpers?
4. Does it ship React hooks, or only a framework-agnostic client?

## 3. Env names (proposal — add to `.env.example` + `AppEnv`, never log values)

Single source stays `.env.example`; typed access via
`apps/backend/src/env.ts` (`validateEnv`, WARN-defaults, fail-fast on
explicit garbage, `findSuspiciousUnknownKeys` typo guard). Naming avoids
collision with the existing `NPM_*` (registry/install token) namespace.

Proposed (all optional until migration lands; empty = mock mode + WARN):

| Var | Meaning |
|---|---|
| `ID_BASE_URL` | IdP base URL (issuer root), e.g. `https://id.web2bizz.team` |
| `ID_ISSUER` | JWT `iss` claim whitelist (defaults to `ID_BASE_URL` when empty) |
| `ID_AUDIENCE` | JWT `aud` whitelist (empty = not checked, WARN) |
| `ID_JWKS_URL` | JWKS endpoint (defaults to `<ID_BASE_URL>/.well-known/jwks.json`) |
| `ID_CLIENT_ID` | Backend OAuth/OIDC client id (empty = no code-exchange flow) |
| `ID_CLIENT_SECRET` | Backend client secret (**never logged**, same doctrine as `GITHUB_*`/`DOCKER_*`) |
| `ID_COOKIE_NAME` | Phase-2 only: session cookie name (no default = cookie mode off) |
| `ID_CLOCK_SKEW_S` | JWT leeway seconds (default `30`, WARN-default like `EXTERNAL_RETRY_*`) |
| `ID_TIMEOUT_MS` | Per-attempt ms for JWKS/introspection calls (default `10000`) |

Validation doctrine (mirror `NPM_REGISTRY_*` / `DOCKER_REGISTRY_*`):

- `ID_BASE_URL` set but invalid → ERROR fail-fast; empty → WARN + mock mode
  (`health` flag `identity: 'mock'`, auth endpoints answer `503` neutral or
  keep mock — decided at migration time, never mock-200s for protected data).
- `ID_CLIENT_SECRET` half-set without `ID_CLIENT_ID` → ERROR (same as
  `GITHUB_APP_*` pair rule); values never echoed (names only).
- Unknown `ID_*` keys → `APP_ENV_PREFIXES` already covers `ID_`? No — today
  `APP_ENV_PREFIXES` has no `ID_` entry, so add `'ID_'` to the prefix list
  when introducing these vars, otherwise typos go unnoticed.
- Frontend: only `NEXT_PUBLIC_*` is inlined into the browser bundle —
  **no `NEXT_PUBLIC_ID_*` secrets**. Public values the browser needs
  (e.g. login URL) go through `NEXT_PUBLIC_API_URL`-style composition or
  backend-driven redirects, never raw secrets.

## 4. Where `bun add` goes (once unblocked)

Do NOT run these until §0 probe is green. Precedent command shape from
`docs/npm-registry.md §Use`:

```bash
export NPM_TOKEN=$(grep -oP '(?<=_authToken=).*' ~/.npmrc | tr -d '\r\n ')
cd apps/backend && NPM_TOKEN=$NPM_TOKEN bun add @web2bizz/id   # server: guard/service
cd ../frontend && NPM_TOKEN=$NPM_TOKEN bun add @web2bizz/id   # client/hooks (only if .d.ts has a client entry)
```

Rules:

- **Backend** (`apps/backend`): always. Guard + token verification + user
  resolution live here. If the package has separate server/client entrypoints
  (`exports` map), import only the server entry in NestJS (never bundle
  browser code into `dist/`).
- **Frontend** (`apps/frontend`): only if the package ships a client/hooks
  entry that is browser-safe (no `node:` imports, no secrets). Otherwise the
  frontend keeps its own hooks and calls new `api.*` methods (Bearer header
  inside `api/client.ts`) — no `bun add` needed there.
- Dockerfile/CI already pass `NPM_TOKEN` as BuildKit secret / masked env
  (`docs/npm-registry.md §Docker/§CI`) — a new `@web2bizz/*` dep needs no
  infra change, but verify `bun install` on a clean machine after adding.
- Commit the version pin + lock together (Conventional Commits
  `chore(deps): bump @web2bizz/id to <ver>`), never `--build-arg` for the
  token, never `ENV NPM_TOKEN` in images.

## 5. Migration plan mock → real (ordered, no repo breakage)

Current mock touchpoints (all must keep compiling at every step):

- Backend: `DEFAULT_MOCK_USER_ID = 'default'` + `resolveUserId`
  (`github.controller.ts`, `workspaces.controller.ts`), `workspace-path.service.ts`
  per-user dir segment, `github_installations.user_id` nullable text.
- Frontend: `useLogin` + `lib/mocks/auth.ts` (`MOCK_USER`, `isMockCredential`),
  `useProfile` + `lib/mocks/profile.ts` (`MOCK_PROFILE`), `lib/types.ts`
  (`Profile`), `api/client.ts` (no auth header), `api/types.ts` (no auth DTOs).

Phase A — spec lock (this doc + unblock):

1. Green §0 probe → fill §1 table (version, exports, `.d.ts` notes) in this
   file. If exports differ from §1 candidates, revise §2–§4 before coding.
2. Decide guard-vs-helper (§2 Q3) and hooks-vs-client (§2 Q4). Record here.

Phase B — backend (behind env flag, mock stays default):

3. `bun add @web2bizz/id` in `apps/backend` (§4) + `.env.example` `ID_*`
   entries + `AppEnv` fields + `validateEnvWithWarnings` block (WARN-defaults,
   fail-fast on explicit garbage, `ID_` prefix in `APP_ENV_PREFIXES`).
4. New `src/identity/` module (Global, never-throw boot like
   `npm-registry/`): config from `AppEnv`, JWKS/introspection client with
   `withRetry` (GET only, backoff+jitter), `getStatusOrThrow`, `AppLogger`
   scrub, `ApiErrorFilter` → `503 EXTERNAL_UNAVAILABLE` + `Retry-After: 30`
   when the IdP is down (no mock 200s, `401/403` detail never leaves backend).
5. `IdGuard` (or `AuthGuard('id')`): validates Bearer, attaches typed
   `req.user { id, email, … }`. Keep `resolveUserId` as the **explicit
   fallback only when `ID_BASE_URL` is empty** (mock mode, WARN once) so
   existing e2e (`x-user-id: alice/bob/carol`) keeps passing until cutover.
   Deduplicate the two `resolveUserId` copies into one import from
   `src/identity/` at this point.
6. Cutover per controller (`projects/github`, `workspaces`, then rest):
   `@UseGuards(IdGuard)` + `req.user.id` instead of `resolveUserId`.
   `POST /api/v1/auth/login|logout`, `GET|PUT /api/v1/profile` (or whatever
   the package's server surface maps to) through `contracts/openapi.yaml` +
   `contracts.ts` DTOs + `V1Endpoint` versioning.
7. `health` gains `identity: 'real' | 'mock' | 'down'` (same tri-state as
   `npmRegistry`); `github_installations.user_id` backfill plan + future
   `users` table migration (`drizzle/00NN_*.sql`) — FK-less text stays until
   the users table lands.
8. Tests: unit (token verify, guard allow/deny, env priority, never-log-
   secrets) + e2e (mock mode old behavior, real mode with stub JWKS/IdP:
   200 live, down → 503 + Retry-After, bad token → 401 envelope). Extend
   `test:e2e` script entries like `npm-registry` did.

Phase C — frontend (hook interiors only, caller contracts frozen):

9. `bun add @web2bizz/id` in `apps/frontend` only if §4 says so. Otherwise:
   `api/client.ts`: `setAuthToken` + `Authorization: Bearer` injection in
   `requestV1`, `api.login/refresh/me/updateProfile` methods, `ApiClientError`
   mapping (`invalid_credentials` → 401 message path already exists in
   `useLogin`). `api/types.ts`: auth DTOs mirroring backend `contracts.ts`.
10. `useLogin.login` interior → `api.login`, `useProfile` mount/update →
    `api.me`/`api.updateProfile`; keep `UseLoginResult`/`UseProfileResult`
    shapes so callers don't change. `MOCK_USER`/`MOCK_PROFILE` become
    test fixtures only (or deleted when e2e covers real flow).
11. Token storage: in-memory (+ `HttpOnly` cookie only in phase 2); logout
    clears it; 401 from `requestV1` triggers logout + login redirect.
12. `bun run lint` (`nx run-many -t lint`: `tsc --noEmit` + `biome lint`) +
    `bun run build` (`nx run-many -t build`, frontend → `next build --turbopack`)
    after every hook change (per `AGENTS.md` frontend checks; pinpoint with
    `lint:affected` / `build:affected`, graph via `bun run graph`;
    low-level — `bun --filter frontend <script>`).

Phase D — cleanup:

13. Remove `DEFAULT_MOCK_USER_ID` / `x-user-id` mock path (keep the header
    name only if the IdP flow still needs it for tests; otherwise drop from
    CORS allowlist + `@ApiHeader` docs), delete `lib/mocks/auth.ts` +
    `lib/mocks/profile.ts` mock exports, close the `TODO REAL-API`s.
14. Docs: update this file (fill §1, check off §2 questions), `.env.example`,
    `docs/env-validation.md`, README auth section.

## 6. Decisions recorded (pending `.d.ts` confirmation)

- D1 — Spec-first, no code: package unreachable → only this doc is written.
  Repo `package.json`/lock untouched (verified `git status` before/after).
- D2 — Protocol: JWT Bearer primary; cookie deferred to phase 2.
- D3 — Backend verifies, frontend never verifies; no browser secrets.
- D4 — `ID_*` env namespace (no `NPM_*` collision); `ID_` prefix added to
  typo-guard list at implementation time.
- D5 — Dual `bun add` only if client entry is browser-safe; backend always.
- D6 — Mock fallback stays behind empty-`ID_BASE_URL` until cutover; no
  mock 200s for protected data once real mode is on (503 + Retry-After
  doctrine like `npm-registry`/`docker-registry`).

## 7. Next action for the implementer

Run the §0 unblock sequence from a network with Verdaccio access, paste the
`npm view` output + `exports` map + `.d.ts` export list into §1, answer the
four §2 questions, then start Phase B step 3. If the registry stays
unreachable, this spec is the complete deliverable for now: version unknown,
exports unknown, decisions D1–D6 recorded, blocker = `ECONNREFUSED
207.180.223.153:443` on all Verdaccio routes.
