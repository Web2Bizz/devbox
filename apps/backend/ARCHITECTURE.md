# ARCHITECTURE.md

## Структура модулей

```
src/
├─ main.ts — бутстрап (dotenv-expand, configureApp/setupSwagger, validateEnvWithWarnings)
├─ app/ — app.module.ts (DI-граф), app.setup.ts (global prefix 'api' + URI-versioning + CORS + swagger)
├─ contracts.ts — deprecated-реэкспорт @rush-code/contracts
├─ api/ — ApiController + modules/proxy/ (ProxyModule/ProxyService), dto.ts,
│         version.ts (DEFAULT_API_VERSION='1'), versioning.e2e.ts
├─ auth/ — аккаунты/JWT (auth.controller v1, users.controller, jwt-auth.guard,
│         identity/token/password services, auth.dto.ts + dto.ts)
├─ sessions/ — ДОМЕННЫЙ модуль /api/sessions* (VERSION_NEUTRAL, 9 роутов):
│    list/create/status/providers/models/:id/messages GET+POST/:id/interrupt/events (SSE)
├─ opencode/ — DEPRECATED-зеркало /api/opencode/* (18 роутов) + транспорт runner'а:
│    opencode.controller.ts + modules/: crypto/ (CryptoService, AES-256-GCM),
│    keys/ (OpencodeKeysService store + OpencodeKeysController /api/v1/key+usage),
│    billing/ (OpencodeBillingService, live usage), auth/ (OpencodeAuthService gate +
│    serveBasicAuthHeader), client/ (OpencodeService dialUrl/checkConnectivity→/api/info +
│    OpencodeSdkClient, lazy import @opencode-ai/sdk/v2);
│    modules/keys/opencode-keys.e2e.ts — эталон скана секретов/форм логов
├─ common/ — logger/ (AppLogger + serializeCause, index.ts), env/ (validateEnv),
│    validation/ (ZodValidationPipe, index.ts), external/ (ExternalClient/retry/error),
│    api-error.filter.ts, correlation.interceptor.ts, noindex.interceptor.ts,
│    sse-relay.ts (probe до заголовков→503, abort downstream, бэкофф), common.module.ts
├─ projects/ — проекты + подмодули: chats/, files/ (project-files), github/
│    (github-app/installations/webhook), sessions/; C4-гейт assertProjectAccessById
│    (404 без утечки существования)
├─ organizations/ — организации + org-projects.controller.ts (проекты орга)
├─ repos/ — REPOS_ROOT реестр (repos-git.util.ts, jail resolveUserStrict/assertInsideJail)
├─ workspaces/ — per-user surface (workspace-path/clone/submodules, clone-jobs.repository.ts)
├─ storage/ — storage-unavailable.ts (единый 503-гейт без корня) + spec
├─ db/ — Drizzle (schema.ts, db.module/service, schema-integrity, e2e-db)
└─ docker-registry/, npm-registry/, health/ — реестры-пинги и GET /health
```
