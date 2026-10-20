# Code of Conduct — types-over-interfaces

## Scope

Whole monorepo — `packages/contracts/src/**`, `apps/backend/src/**`,
`apps/frontend/src/**`, `apps/frontend/app/**`, `apps/mobile/src/**`.
Mandatory in `@devbox/contracts` (the wire-contract etalon).

## Rule

New entities are declared only as `export type`. Extension is done via
intersection (`&`). The `interface` keyword is forbidden for our own code.

```ts
// do
export type Project = {
  id: string;
  corrupted: boolean;
};

// do — extension via intersection
export type AuthSession = AuthTokens & {
  user: AuthUser;
};
```

```ts
// don't
export interface Project {
  id: string;
  corrupted: boolean;
}

// don't
export interface AuthSession extends AuthTokens {
  user: AuthUser;
}
```

Etalon: [`packages/contracts/src`](packages/contracts/src) — every domain
(`health/`, `session/`, `repo-entry/`, `api-error/`, `auth/`, `project/`,
`organization/`, `opencode-key/`) declares `<domain>.ts` entities as types
and mirrors `contracts/openapi.yaml` field-for-field.

## Exceptions (require justification in the PR)

- External library types that require `interface` (e.g. `declare module`
  shims where the upstream API mandates it).
- `class` declarations (NestJS providers, DTO classes for `@nestjs/swagger`)
  — never touched by this rule.
- Global declaration merging (`declare global`) — only with a comment
  explaining why a `type` cannot express it.

## Control

```sh
# must print nothing outside the exceptions above
rg -g '*.ts' -g '*.tsx' '(export )?interface \w+' \
  packages/contracts/src apps/backend/src \
  apps/frontend/src apps/frontend/app apps/mobile/src
```
