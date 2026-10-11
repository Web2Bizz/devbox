# Auth decision (internal accounts + external-provider seam)

Date: 2026-10-01. Card 1/5 — research only, no code.
Constraint: only public npm (Verdaccio UNAVAILABLE, `@web2bizz/*` forbidden),
NestJS 12.1 + TS 6 + zod 4 + drizzle 0.45.3 pg + bun 1.4.2 + SWC.

## 1. Password hashing — `Bun.password` (argon2id), zero new deps

Verified on the dev runtime (`bun -e`, bun 1.4.0):
`Bun.password.hash('…', { algorithm: 'argon2id' })` → `$argon2id$v=…`,
`verify()` true/false as expected.

- Chosen: `Bun.password` with `algorithm: 'argon2id'` (memory/time costs = bun defaults).
- Rejected: `@node-rs/argon2` / `argon2` native addons — native build per platform,
  extra supply-chain surface, no benefit while bun ships argon2id natively;
  `bun.password` covers the requirement (`bun-password` is bun-native, not npm).
- Seam: `PasswordService` wraps `globalThis.Bun.password` so unit tests can stub
  it and a future `node:crypto`-scrypt fallback can slot in without touching callers.

## 2. JWT — hand-rolled HS256 (`node:crypto`), zero new deps

- Chosen: minimal HS256 sign/verify in `TokenService` (`node:crypto` HMAC +
  base64url, `jti` per token, `typ: access|refresh`, `exp/iat`).
- Rejected: `@nestjs/jwt` + `passport-jwt` — pulls `passport` + strategy layers,
  passport's CJS/ESM interop is fragile under Nest 12 + SWC + `NodeNext`;
  `jose` (ESM-only) is fine on bun but adds a dependency for ~40 lines of HMAC
  we fully control (key handling, clock, rotation store). Zero-dep keeps the
  `test:e2e` "no new deps" story and works identically under `bun dist/*.js`.
- Tokens: short-lived access (`JWT_ACCESS_TTL`, default `15m`) + rotating
  refresh (`JWT_REFRESH_TTL`, default `7d`). Refresh rotation: single-use `jti`
  store — reuse of a rotated `jti` revokes the family (401). Secrets only via
  env (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, ≥32 chars when set;
  unset → ephemeral dev secret + boot WARN, never logged).
- Guard: custom `JwtAuthGuard` (no passport) — `Authorization: Bearer` →
  `req.user = { id, email }`; logs via `AppLogger`, fixed messages,
  `ExternalServiceError` code-style for upstream-shaped failures.

## 3. Frontend token storage + route guard

- Access token: in-memory singleton (`lib/auth-store.ts`) mirrored to
  `localStorage` (`devbox-access-token`) so reload survives; refresh token:
  httpOnly cookie `devbox-refresh` set by the backend (`credentials: 'include'`
  on refresh/logout only) + JSON copy in the login response (kept in memory).
- Marker cookie `devbox-auth=1` (readable) lets Next `middleware.ts` redirect
  unauthenticated `/projects|/profile|/secrets|…` → `/login` without ever
  seeing a secret. Real authorization stays server-side (`JwtAuthGuard`).
- Refresh flow: `auth-store.getValidAccessToken()` → `POST /auth/refresh`
  single-flight; `401` → clear store + redirect `/login`.
  Hook contracts (`UseLoginResult` / `UseProfileResult`) are unchanged —
  only hook bodies swap mock → `api.*`.

## 4. Users + provider seam

- `users` table (drizzle + `drizzle/0003_users.sql`): `id uuid PK`,
  `first_name`, `last_name`, `email CITEXT-unique (lower(email) index)`,
  `password_hash`, `provider default 'local'`, `created_at/updated_at`.
  `github_installations.user_id` stays text FK-less (no backfill — same string key).
- `AuthProvider` strategy interface: `local` (email+password, this task) +
  `sso-oauth` / `github-app` stubs (throw 501 `provider_not_configured`,
  no integration code). Runtime keeps the in-memory store pattern
  (`UsersService`, like `GithubInstallationsService`); drizzle table is the
  durable contract.
- Env rule (`docs/env-validation.md`): `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
  `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `AUTH_LEGACY_MOCK_FALLBACK` in
  `.env.example` + `envRawSchema` + ERROR/WARN rows + `env.spec.ts` cases.
  `POST /api/survey` frozen — untouched.

## 5. Identity dedup

`resolveUserId` duplicated in `github.controller.ts` + `workspaces.controller.ts`
moves to `auth/identity.service.ts` (`IdentityService` + `@ReqUser()`).
Dual-mode e2e: `x-user-id` fallback stays ONLY when
`AUTH_LEGACY_MOCK_FALLBACK=true` (dev default + WARN); new tests use Bearer.
