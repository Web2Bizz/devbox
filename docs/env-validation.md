# Env validation rule

Single source of truth: **repo-root `.env.example`**.
Every key the backend reads MUST be declared there; `apps/backend/src/env.ts`
is the only place that validates them (zod@4), and `docs/env-validation.md`
(this file) is the taxonomy reference.

## Order

1. `apps/backend/src/main.ts` — `validateEnvWithWarnings()` runs FIRST in
   `bootstrap()`, before `NestFactory.create()`. Warnings are emitted once via
   `AppLogger.warn()` (scrubbed like any other log).
2. `ConfigModule.forRoot({ validate: validateConfigForNest })` in
   `app.module.ts` — fail-fast re-validation without warning spam
   (the boot path already reported them).
3. Any service needing typed env calls `validateEnv()` (pure: collects
   warnings without logging, so per-request callers stay quiet).

`validateEnv()` = `validateEnvWithWarnings().env`. Tests live in
`apps/backend/src/env.spec.ts`
(`bun run build && bun dist/env.spec.js`, also runs under `bun test dist`).

## Message format

- ERROR (throws, boot stops): `[env] KEY <what is wrong>. <how to fix> (see .env.example).`
- WARN (continues, logged once at boot): `[env] WARN <KEY?> <fallback/notice>. ... (see .env.example).`
- Every message ends with the `(see .env.example)` pointer. Grep: `\[env\]`.

## ERROR — fail-fast (throw)

| Key | Fails when |
| --- | ---------- |
| `APP_BACKEND_PORT` (`PORT` legacy) | Missing, or not a numeric port 1–65535 |
| `APP_BACKEND_SOCKET` (+ composed) | Not a URL with a host |
| `OPENCODE_URL` (+ composed) | Not a URL with a host |
| `GITHUB_API_URL` | Not a URL with a host |
| `NEXT_PUBLIC_API_URL` | Set but not a URL with a host (unset → backend socket) |
| `CORS_ORIGINS` | Any entry not an `http(s)` URL — message carries the `entry #N` index |
| `DATABASE_URL` | Set but not `postgres://...` / `postgresql://...` shape |
| `GITHUB_APP_ID` | Set but not numeric |
| `GITHUB_APP_INSTALLATION_ID` | Set but not numeric |
| `GITHUB_APP_SLUG` | Set but not URL-safe |
| `GITHUB_APP_*` pair | Partially configured (ID without key or vice versa) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Set but unreadable (message carries the path, never the key) |
| `POSTGRES_PORT` / `OPENCODE_PORT` / `NEXT_PUBLIC_PORT` | Set but not a numeric port |
| `APP_BACKEND_PROTOCOL` / `OPENCODE_PROTOCOL` | Not `http`/`https` |
| `REQUEST_TIMEOUT_MS` | Not a non-negative integer |
| `DOCKER_REGISTRY_URL` | Set but not a URL with a host (unset → skipped, never an error) |
| `DOCKER_REGISTRY_TIMEOUT_MS` | Set but not a non-negative integer |
| `DOCKER_REGISTRY_RETRY_MAX_ATTEMPTS` | Set but not an integer 1–10 |
| `DOCKER_REGISTRY_RETRY_BASE_DELAY_MS` / `DOCKER_REGISTRY_RETRY_MAX_DELAY_MS` | Set but not an integer 0–60000 ms |
| `NPM_REGISTRY_URL` | Set but not a URL with a host (unset → skipped, never an error) |
| `NPM_REGISTRY_TIMEOUT_MS` | Set but not a non-negative integer |
| `NPM_REGISTRY_RETRY_MAX_ATTEMPTS` | Set but not an integer 1–10 |
| `NPM_REGISTRY_RETRY_BASE_DELAY_MS` / `NPM_REGISTRY_RETRY_MAX_DELAY_MS` | Set but not an integer 0–60000 ms |
| `PROJECTS_ROOT` | Contains NUL |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Set but shorter than 32 chars |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | Set but not `15m`/`1h`/`7d`/seconds 60–7776000 |
| `AUTH_LEGACY_MOCK_FALLBACK` | Set but not `true`/`false` (`1`/`0` ok) |

Broken composites (`http://:` from `${...}` interpolation with an empty HOST)
are NOT errors: they recompose from the parts + WARN.

## WARN — continue (AppLogger at boot)

| Notice | Meaning |
| ------ | ------- |
| `APP_BACKEND_HOST` empty → `localhost` | Dev default; set explicitly for production |
| `OPENCODE_HOST` empty → `localhost`, `OPENCODE_PORT` unset → `4096` | Dev defaults (explicit `0.0.0.0` is preserved verbatim, no WARN) |
| `POSTGRES_HOST` empty → `localhost`, `POSTGRES_PORT` unset → `5432` | Only when composing from `POSTGRES_*` |
| `LOG_LEVEL` unset/unknown → `info` | Expected `debug\|info\|warn\|error` |
| `GITHUB_APP_*` empty pair | Normal: github endpoints answer 401/503 until configured |
| `DOCKER_REGISTRY_URL` unset → skipped | Normal: registry endpoints answer 503, health flag is `skipped` |
| `DOCKER_REGISTRY_*` no credentials | Anonymous access (private registries will 401 → 503 downstream) |
| `DOCKER_REGISTRY_*` half-set basic pair | WARN + anonymous access (names only, values never echoed); boot continues |
| `DOCKER_REGISTRY_TOKEN` + basic pair | Token (Bearer) wins, pair ignored |
| `DOCKER_REGISTRY_TIMEOUT_MS` / `RETRY_*` unset | Dev defaults (10000 / 3 / 200 / 2000, mirrors `EXTERNAL_RETRY_*`) |
| `NPM_REGISTRY_URL` unset → skipped | Normal: npm status endpoint answers 503, health flag is `skipped` |
| `NPM_REGISTRY_*` no credentials | Anonymous probe (closed Verdaccio answers 401/403 → health `down`, status 503 neutral) |
| `NPM_REGISTRY_TOKEN` + legacy `NPM_TOKEN` | `NPM_REGISTRY_TOKEN` (Bearer) wins for the module; `NPM_TOKEN` stays for bun install |
| `NPM_REGISTRY_TOKEN` unset, `NPM_TOKEN` set | WARN once + legacy fallback for the module probe (bun wiring untouched) |
| `NPM_REGISTRY_TOKEN` + basic pair | Token (Bearer) wins, `NPM_REGISTRY_USER/PASSWORD` pair ignored |
| `NPM_REGISTRY_*` half-set basic pair | WARN + anonymous access (names only, values never echoed); boot continues |
| `NPM_REGISTRY_SCOPE` unset/invalid → `@web2bizz` | Invalid scope WARNs + falls back (never throws — registry is optional) |
| `NPM_REGISTRY_TIMEOUT_MS` / `RETRY_*` unset | Dev defaults (10000 / 3 / 200 / 2000, mirrors `EXTERNAL_RETRY_*`) |
| No database (`DATABASE_URL` + `POSTGRES_*` empty) | Normal: pg stub stays skipped, MVP boots |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` unset → ephemeral dev secret | WARN + random per boot (tokens die on restart); set explicitly for production |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` unset → `15m` / `7d` | Dev defaults (seconds 900 / 604800) |
| `AUTH_LEGACY_MOCK_FALLBACK` unset → `true` | Dev default: `x-user-id` mock identity still accepted; set `false` for production |
| `GITHUB_APP_INSTALLATION_ID` set | **Deprecated** legacy single-install dev fallback — prefer per-user installations via the install flow |
| `PROJECTS_ROOT` points to a missing directory | File browser 404s until it exists |
| Unknown app-prefixed key (`APP_BACKEND_PORTT`, …) | Likely typo — only `APP_/OPENCODE_/POSTGRES_/DATABASE_URL/CORS_/REQUEST_TIMEOUT_MS/EXTERNAL_/LOG_LEVEL/NEXT_PUBLIC_/GITHUB_/DOCKER_/DOCKER_REGISTRY_/NPM_/NPM_REGISTRY_/JWT_/AUTH_/PROJECTS_ROOT` prefixes are reported; unrelated OS vars (`PATH`, `HOME`, …) stay silent |

## Never log secrets

`DATABASE_URL`, `POSTGRES_PASSWORD`, `DOCKER_REGISTRY_USER/PASSWORD/TOKEN`,
`NPM_REGISTRY_TOKEN`, `NPM_TOKEN` (legacy fallback),
`NPM_REGISTRY_USER/PASSWORD` (basic pair), `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, password hashes, access/refresh tokens,
private keys, tokens: never appear in
errors, warnings, or logs — only key NAMES plus the `.env.example` pointer.
`AppLogger` additionally scrubs secret keys, `scheme://user:pass@host`
credentials in URLs, and live secret values. Unit tests assert the leakage
rule (`env.spec.ts`: "without echoing the value").

## Sync checklist (when adding a key)

1. Add the key to repo-root `.env.example` (+ `apps/frontend/.env.example` pointer if frontend-consumed).
2. Add the optional string to `envRawSchema` in `env.ts`.
3. Decide ERROR vs WARN per the tables above; add the `[env]` message + spec case.
4. Keep `AppEnv` in sync; never read `process.env` directly in services for validated keys.
