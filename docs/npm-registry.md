# Private npm registry (selfhosted)

Selfhosted Verdaccio: `https://npm.registry.web2bizz.team`
Scope: `@web2bizz` (e.g. `@web2bizz/auth@0.1.1`, `@web2bizz/ui@0.25.7`).
Public packages fall back to `registry.npmjs.org` — default registry is NOT overridden.

## Files (working copy only, no secrets committed)

| File | Purpose |
|---|---|
| `.npmrc` | Scoped registry + `${NPM_TOKEN}` placeholder. Safe to commit (no hardcoded token). Read by npm + bun. |
| `bunfig.toml` `[install.scopes]` | Bun-native scoped auth: `"@web2bizz" = { url = "...", token = "$NPM_TOKEN" }`. No token hardcoded. |
| `.env.example` | Documents `NPM_TOKEN=` placeholder. Copy to `.env` locally (ignored). |
| `.gitignore` | Ignores `.env`, `.npmrc.local`, `.npmrc.auth`, `*.tgz`. Project `.npmrc` itself IS committed (placeholder-safe). |
| `apps/*/Dockerfile` | `COPY .npmrc` + `RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN bun install`. |
| `.github/workflows/ci.yml` | `NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` on Install (masked). |
| `.github/workflows/docker.yml` | `secrets: NPM_TOKEN=${{ secrets.NPM_TOKEN }}` on both images. |

Global `~/.npmrc` (`//npm.registry.web2bizz.team/:_authToken=…`) is left untouched.

## Use

```bash
# 1. One-time: expose token from global auth (no logging, no commit)
export NPM_TOKEN=$(grep -oP '(?<=_authToken=).*' ~/.npmrc | tr -d '\r\n ')

# 2. Connectivity (exit code only, token never logged)
npm ping --registry https://npm.registry.web2bizz.team

# 3. Install (root + workspaces)
bun install

# 4. Resolve checks
bun info @web2bizz/auth   # private → via Verdaccio
bun info @web2bizz/ui     # private → via Verdaccio
bun info zod              # public → fallback to npmjs

# 5. Add a private dep to an app
cd apps/frontend && NPM_TOKEN=$NPM_TOKEN bun add @web2bizz/ui
```

Bun loads `$NPM_TOKEN` from shell env AND from `.env` (`.env.local`, `.env.[NODE_ENV]`, `.env`).
`.npmrc` `${NPM_TOKEN}` expansion is done by npm/bun at install time.

## Publish (dry-run only, no push)

All three `package.json` are `"private": true` → real `npm publish` is blocked by npm itself.
To ship a scoped package:

1. In `apps/<pkg>/package.json`: remove `"private": true`, set `"name": "@web2bizz/<pkg>"`, add:
   ```json
   "publishConfig": { "registry": "https://npm.registry.web2bizz.team/", "access": "restricted" }
   ```
2. Dry-run (safe, no push):
   ```bash
   bun pm pack --dry-run
   npm publish --dry-run --registry https://npm.registry.web2bizz.team
   ```
3. Real publish (explicit, with rights):
   ```bash
   NPM_TOKEN=$NPM_TOKEN npm publish --registry https://npm.registry.web2bizz.team
   ```

## Docker (BuildKit secret, never `--build-arg`)

```bash
# token in a 600 file, never in image layers / history
grep -oP '(?<=_authToken=).*' ~/.npmrc | tr -d '\r\n ' > /tmp/npm-token && chmod 600 /tmp/npm-token
docker build --secret id=NPM_TOKEN,src=/tmp/npm-token -f apps/backend/Dockerfile -t devbox-backend:test .
docker build --secret id=NPM_TOKEN,src=/tmp/npm-token -f apps/frontend/Dockerfile -t devbox-frontend:test .
shred -u /tmp/npm-token
```

Without secret the build still works for public-only deps; `@web2bizz/*` install fails fast.

## CI (clean machine)

1. Add repo secret `NPM_TOKEN` (Settings → Secrets → Actions). GitHub masks `secrets.*` in logs.
2. `ci.yml` Install already injects it; empty secret → public-only install (no break).
3. `docker.yml` passes it as BuildKit secret to both images (never `--build-arg`).
4. Verify on a clean runner: `bun install && bun info @web2bizz/auth`.

## Rotation

1. Reissue token in registry UI.
2. Update local: edit `~/.npmrc` `_authToken`, `export NPM_TOKEN=…` (or `.env`, ignored).
3. Update CI: repo secret `NPM_TOKEN`.
4. No code change needed (placeholder only). Verify: `npm ping`, `bun info @web2bizz/auth`, `bun install`.

## Safety rules

- Token ONLY via env `${NPM_TOKEN}` / `$NPM_TOKEN`. Never hardcode, never `--build-arg`, never `ENV NPM_TOKEN` in Dockerfile.
- Never `git add/commit` `.env` or token files. Project `.npmrc` contains placeholder only.
- Never log token: use `token_len:${#NPM_TOKEN}`, exit codes, `sed …[REDACTED]`.

## Observe-only backend module (`apps/backend/src/npm-registry/`)

Mirrors `src/docker-registry/` (Global module, never-throw boot, retry only
GET, `AppLogger` scrub, 503 + `Retry-After: 30` via `ApiErrorFilter`).
The module ONLY probes availability — it never publishes/installs, so the
bun-install wiring above (`.npmrc` / `bunfig.toml` / `NPM_TOKEN`) is untouched.

| File | Purpose |
|---|---|
| `npm-registry.config.ts` | Typed config from `AppEnv` + auth headers (TOKEN Bearer wins, else USER/PASSWORD Basic; secrets never logged) |
| `npm-registry.service.ts` | `GET /-/ping` probe, `onModuleInit` withRetry (backoff+jitter), `getStatusOrThrow`, 401/403 → down + 503 neutral |
| `npm-registry.controller.ts` | `GET /api/v1/registry/npm/status` → `200 { status, url, scope }` / `503` neutral envelope |
| `npm-registry.module.ts` | `@Global()` module (health imports it explicitly) |
| `dto.ts` | `NpmRegistryStatusDto` + `NpmRegistryHealthDto` (swagger) |
| `npm-registry.service.spec.ts` | Unit: auth priority (token > basic > anonymous), legacy fallback, retry, soft start, 401/403 → down + 503 neutral, never-log-secrets |
| `npm-registry.e2e.ts` | E2E: down / skipped / up-token / up-basic / 401→503 / 403→503 (stubs enforce Authorization) |

Env (`NPM_REGISTRY_*`, see `.env.example` + `docs/env-validation.md`):

- `NPM_REGISTRY_URL` — set but invalid → ERROR fail-fast; empty → WARN + `skipped`.
- `NPM_REGISTRY_TOKEN` — module Bearer token (never logged); unset → legacy
  `NPM_TOKEN` fallback (WARN once, bun wiring untouched); both set →
  `NPM_REGISTRY_TOKEN` wins (WARN).
- `NPM_REGISTRY_USER` / `NPM_REGISTRY_PASSWORD` — closed-Verdaccio basic pair
  (trimmed, never logged); used only when no Bearer token is set; token set +
  pair set → pair ignored (WARN); half-set pair → WARN + anonymous; none →
  anonymous probe (WARN).
- `NPM_REGISTRY_SCOPE` — observed scope, default `@web2bizz`; invalid → WARN + default.
- `NPM_REGISTRY_TIMEOUT_MS` / `RETRY_MAX_ATTEMPTS` / `RETRY_BASE_DELAY_MS` /
  `RETRY_MAX_DELAY_MS` — WARN-defaults `10000 / 3 / 200 / 2000` (mirror `EXTERNAL_RETRY_*`).

Auth doctrine: priority is `TOKEN` (Bearer) → `USER/PASSWORD` (Basic) →
anonymous. A ping-level `401` (bad credentials) / `403` (forbidden) on the
closed Verdaccio counts as `down` (internal reasons `AUTH_401`/`AUTH_403`,
reason + `authMode` presence-fact in backend logs/monitoring only) and the
status endpoint answers `503 EXTERNAL_UNAVAILABLE` with the neutral message
`сервис временно недоступен, повторите позже` + `Retry-After: 30` — the
`401/403` detail never leaves the backend. The endpoint therefore never
answers `401/403/502` for upstream auth, and secrets never appear in
responses, logs, or the error envelope. Health (`GET /health`, always `200`)
carries `npmRegistry: up | down | skipped` (`down` covers
timeout/network AND auth failures).

```bash
# unit + e2e (compiled dist, same as docker-registry)
bun run build
bun dist/npm-registry/npm-registry.service.spec.js
bun dist/npm-registry/npm-registry.e2e.js

# live status (needs NPM_REGISTRY_URL; 503 + Retry-After when down/skipped)
curl -s http://localhost:3100/api/v1/registry/npm/status
curl -s http://localhost:3100/health
```
