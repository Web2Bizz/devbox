# Code of Conduct — wire consistency

## 1. types-over-interfaces

### Scope

Whole monorepo — `packages/contracts/src/**`, `apps/backend/src/**`,
`apps/frontend/src/**`, `apps/frontend/app/**`, `apps/mobile/src/**`.
Mandatory in `@rush-code/contracts` (the wire-contract etalon).

### Rule

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

### Exceptions (require justification in the PR)

- External library types that require `interface` (e.g. `declare module`
  shims where the upstream API mandates it).
- `class` declarations (NestJS providers, DTO classes for `@nestjs/swagger`)
  — never touched by this rule.
- Global declaration merging (`declare global`) — only with a comment
  explaining why a `type` cannot express it.

### Control

```sh
# must print nothing outside the exceptions above
rg -g '*.ts' -g '*.tsx' '(export )?interface \w+' \
  packages/contracts/src apps/backend/src \
  apps/frontend/src apps/frontend/app apps/mobile/src
```

---

## 2. timestamps — ISO-8601

### Scope

Whole monorepo — `packages/contracts/src/**` (etalon), `contracts/openapi.yaml`,
`apps/backend/src/**`, `apps/frontend/src/**`, `apps/mobile/src/**`.
Mandatory for every `*At` wire field (`createdAt`, `updatedAt`, `deletedAt`,
`suspendedAt`, `lastCheckAt`, …).

### Rule

Every timestamp crossing the wire is an ISO-8601 UTC string
(`YYYY-MM-DDTHH:mm:ss.sssZ`, `format: date-time`).
`At`-suffix always means ISO-8601 string — never `Date`, never epoch `number`.

```ts
// do
/** ISO-8601 timestamp */
createdAt: string;

// do — nullable / optional variants keep the same scalar
/** Soft-delete timestamp (null when active). */
deletedAt: string | null;
/** ISO-8601 timestamp (present only when configured). */
updatedAt?: string;
```

```ts
// don't — Date / number never cross the wire (DB-internal only)
createdAt: Date;
createdAt: number;
```

- Entity types: `string` (or `string | null` / `?`) + `/** ISO-8601 … */` doc.
- Emission (backend): always `date.toISOString()` — DB `timestamp withTimezone`
  → `.toISOString()`, upstream epoch millis → `new Date(ms).toISOString()`
  at the domain boundary (see `sessions.service.ts`, `proxy.service.ts`).
- OpenAPI: `type: string` + `format: date-time`.
- Zod boundary: `z.iso.datetime()` (plus `.nullable()` / `.optional()` wrappers)
  for all new schemas; legacy `z.string().min(1)` on `*At` fields is deprecated
  — do not copy into new domains.
- Comparison/sort: lexicographic (`localeCompare`) or `Date.parse` — ISO-8601
  lexicographic order equals chronological order.

Etalon: [`packages/contracts/src/sessions`](packages/contracts/src/sessions) —
`SessionInfo.createdAt` / `SessionMessage.createdAt`
(`string` + `z.iso.datetime()`, error `'Field "createdAt" must be an ISO-8601 timestamp'`),
`contracts/openapi.yaml` `SessionInfo.createdAt` (`type: string`, `format: date-time`).

### Exceptions (require justification in the PR)

- `opencode-session/OpencodeSessionTime`
  (`created/updated/idle/viewed/archived: number`) — upstream
  `Session.Info.time` epoch-millis passthrough owned by the opencode spec.
  The `/api/opencode/*` mirror relays it verbatim and never re-maps;
  conversion to ISO-8601 happens only at the domain boundary
  (`sessions/SessionInfo.createdAt`, `SessionMessage.createdAt`).
- DB layer `Date` objects (`drizzle` `timestamp withTimezone`) — internal only,
  converted via `.toISOString()` before crossing the wire.

### Control

```sh
# must print nothing — At-fields are string over the wire (except the upstream mirror)
rg -g '*.ts' '(createdAt|updatedAt|deletedAt|suspendedAt)\??: (Date|number)' \
  packages/contracts/src apps/backend/src apps/frontend/src apps/mobile/src

# new code must print nothing — At-schemas use strict datetime
rg -g '*.schema.ts' '(createdAt|updatedAt|deletedAt): z\.string' \
  packages/contracts/src

# openapi At-fields must declare format: date-time (spot-check)
rg -A2 'createdAt:|updatedAt:|deletedAt:' contracts/openapi.yaml
```

---

## 3. array-generic-style

### Scope

Whole monorepo — `apps/backend/src/**`, `apps/frontend/src/**`,
`apps/cli/src/**`, `packages/contracts/src/**`, `apps/mobile/src/**`.
Mandatory for all new type annotations.

### Rule

Array types are written only as `Array<T>` — the `T[]` shorthand is forbidden.
Applies to declarations, signatures, generics, and `readonly` arrays
(`ReadonlyArray<T>` / `readonly Array<T>`, never `readonly T[]`).
Index access (`items[0]`) and tuple literals are untouched by this rule.

```ts
// do
export type Project = {
  memberIds: Array<string>;
};

function listUsers(ids: Array<string>): Array<User> {
  return ids.map((userId) => findUser(userId));
}
```

```ts
// don't
export type Project = {
  memberIds: string[];
};

function listUsers(ids: string[]): User[] {
  return ids.map((userId) => findUser(userId));
}
```

### Control

```sh
# candidates for review — every hit in type position must become Array<T>
# (triage out index access like items[0])
rg -g '*.ts' -g '*.tsx' ':\s*[A-Za-z0-9_<>]+(\[\])+|=>\s*[A-Za-z0-9_<>]+(\[\])+' \
  packages/contracts/src apps/backend/src apps/frontend/src apps/cli/src apps/mobile/src
```

---

## 4. no-abbreviated-names

### Scope

Whole monorepo — same paths as §3. Mandatory for all new identifiers.

### Rule

Variable, parameter, property, and function names are never abbreviated —
write the full word. `userRepository`, `configuration`, `message`,
`index`, `error`, `request`, `response` — not `usrRepo`, `cfg`, `msg`,
`idx`, `err`, `req`, `res`. Loop counters and conventional domain terms
(`id`, `url`, `api`) keep their canonical form; anything else is spelled out.

```ts
// do
function findUserById(userId: string, userRepository: UserRepository): User {
  const user = userRepository.findById(userId);
  return user;
}
```

```ts
// don't
function findUsrById(usrId: string, usrRepo: UserRepository): User {
  const usr = usrRepo.findById(usrId);
  return usr;
}
```

### Control

Review-only — no reliable regex exists. Reviewers reject new abbreviations
(`repo`, `cfg`, `ctx`, `msg`, `err`, `req`, `res`, `idx`, `tmp`, `util`
as a name) unless the abbreviation is the canonical domain term
(`id`, `url`, `api`) or an upstream API mandates it.

---

## 5. explicit-type-annotations

### Scope

Whole monorepo — same paths as §3. Mandatory for all new code.

### Rule

Every variable, object field, parameter, and return value is declared
with an explicit type (`name: Type = value`) — inferred types are forbidden
for new code. Applies to `const` / `let` / `var`, `readonly` fields,
function and method signatures.

```ts
// do
class UserCard {
  readonly fullName: string = 'some';
}

const fullName: string = 'some';

function findUserById(userId: string, userRepository: UserRepository): User {
  const user: User = userRepository.findById(userId);
  return user;
}
```

```ts
// don't
class UserCard {
  readonly fullName = 'some';
}

const fullName = 'some';

function findUserById(userId, userRepository) {
  const user = userRepository.findById(userId);
  return user;
}
```

### Exceptions (require justification in the PR)

- Test-local constants where the literal makes the type trivial — only with
  a `// type: trivial — <reason>` comment and reviewer sign-off.
- Literals in local throwaway constants where the type is obvious from
  the right-hand side — only with a comment stating why the annotation
  adds nothing, and only by reviewer decision.
- Upstream APIs that mandate inference (destructuring patterns the explicit
  syntax cannot express) — only with a comment pointing at the upstream type.

### Control

```sh
# candidates for review — every hit omits the explicit type and must be annotated
# (triage out loop counters like for (let index = 0; ...))
rg -g '*.ts' -g '*.tsx' '(const|let|var)\s+[A-Za-z0-9_]+\s*=' \
  packages/contracts/src apps/backend/src apps/frontend/src apps/cli/src apps/mobile/src

# candidates for review — readonly fields without an explicit type
rg -g '*.ts' -g '*.tsx' 'readonly\s+[A-Za-z0-9_]+\s*=' \
  packages/contracts/src apps/backend/src apps/frontend/src apps/cli/src apps/mobile/src
```

---

## 6. exceptions-inline

### Scope

Whole monorepo — `apps/backend/src/**`, `packages/contracts/src/**`,
`apps/frontend/**`, `apps/cli/src/**`, `apps/mobile/src/**`. Mandatory for all
new and changed code.

### Rule

An exception is instantiated and thrown AT THE SITE. Helper functions or
methods that build and return an exception instance are forbidden: they hide
the throw site and turn one HTTP contract into an opaque helper.

```ts
// do
if (!secret) {
  throw new NotFoundException({
    code: 'vault_secret_not_found',
    message: 'Vault secret not found',
  });
}
```

```ts
// don't
export function secretNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'vault_secret_not_found',
    message: 'Vault secret not found',
  });
}
```

### Exceptions (require justification in the PR)

- Upstream status/cause mappers in `common/external` (`fromStatus`,
  `fromUnknown`, `toExternalServiceError`, `ExternalClient` retry/backoff) and
  the private `failure()`/`unavailable()` mappers in `OpencodeHostService`:
  they translate an ARBITRARY upstream status/cause into the
  `ExternalServiceError` envelope and are boundary adapters, not fixed-message
  factories. A new fixed-message helper is still forbidden.
- Callback parameters that the transport requires to produce an error on
  demand (e.g. `relaySse`'s `unreachableError: () => Error`) — the `new` stays
  inline at the callback site, never behind a named factory.
- Third-party exceptions constructed inside adapters that must translate
  foreign error classes.

### Control

```sh
# must print nothing outside the documented mappers
rg -g '*.ts' -g '!**/common/external/**' -g '!**/opencode-host.service.ts' \
  '\):\s*(NotFoundException|BadRequestException|ForbiddenException|UnauthorizedException|ConflictException|HttpException|ExternalServiceError)\b' \
  apps/backend/src packages/contracts/src apps/frontend apps/cli/src apps/mobile/src
```

---

## 7. uuid-validation-via-zod

### Scope

Whole monorepo production code — `apps/backend/src/**`,
`packages/contracts/src/**`, `apps/frontend/**`, `apps/cli/src/**`,
`apps/mobile/src/**`. Tests may assert with the same schemas.

### Rule

UUID shape is validated only by zod: `z.uuid()` for RFC UUIDs (any version,
case-insensitive), `z.uuidv7()` for v7-only values (invite tokens),
`z.guid()` only when an upstream contract is deliberately version-agnostic.
Hand-written UUID regexes (`UUID_RE`, `USER_ID_PATTERN`, `[0-9a-f]{8}-…`)
and boolean wrappers (`isUserId`, `isUuid`, `isUuidV7`) are forbidden.

```ts
// do — one schema, one decision point
if (!uuidSchema.safeParse(identity.id).success) {
  throw new UnauthorizedException({ code: 'unauthorized', message: 'Authentication required' });
}

// do — boundary schema
const inputSchema = z.object({ projectId: z.uuid() });
```

```ts
// don't
const USER_ID_PATTERN: RegExp = /^[0-9a-f]{8}-…$/i;
export function isUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value);
}
```

### Exceptions (require justification in the PR)

- Non-UUID identifiers (opencode `ses_*` host ids, slugs, opaque tokens) are
  validated by their own contract, never by a UUID schema.
- Test fixtures may keep literal UUID strings; validation still goes through
  the schema.

### Control

```sh
# must print nothing outside the exceptions above
rg -g '*.ts' -g '!**/*.spec.ts' -g '!**/*.e2e.ts' -g '!**/__tests__/**' \
  '\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}' \
  apps/backend/src packages/contracts/src apps/frontend apps/cli/src apps/mobile/src
```
