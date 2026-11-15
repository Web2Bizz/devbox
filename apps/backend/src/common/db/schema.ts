/**
 * Drizzle schema — projects domain (module in module).
 *
 * Type note (CoC §5): the `pgTable(...)` constants stay inferred on purpose —
 * an explicit annotation cannot express `PgTable` with its column types
 * without duplicating drizzle's inferred shape, and `$inferSelect` row types
 * derive from those constants.
 *
 * Tables:
 * - projects: registry of projects (chats/sessions live underneath).
 * - project_chats: chats bound to a project (FK RESTRICT on project delete).
 * - project_sessions: sessions bound to project (+ optional chat),
 *   RESTRICT on project delete, SET NULL on chat delete. `origin` marks who
 *   owns the row: 'upstream' (lives on the opencode serve stand) or
 *   'harness' (created by the harness while the stand was unreachable).
 * - session_messages: durable chat history keyed by the harness session uuid
 *   (project_sessions.id) — uuid FK RESTRICT. projects 1:N project_sessions
 *   1:N session_messages; there is NO direct session_messages -> projects link
 *   (project scope resolves via the JOIN through project_sessions).
 * - session_agents: the agent chosen for a session (one row per session id).
 * - github_installations: multi-tenant GitHub App installs — one row per
 *   GitHub installation (unique installation_id), linked to our userId
 *   (nullable until users table exists; MVP resolves a mock userId from
 *   the x-user-id header / ?userId query).
 * - organizations / organization_members: orgs epic; projects belong to an
 *   organization through projects.org_id (1:1). The former M2M table is gone.
 * - refresh_tokens: persistent refresh-token rotation registry (jti rows,
 *   soft revoke/soft prune — never physically deleted).
 * - run_runs / run_steps / run_events: agent-harness run domain — the run
 *   registry, the write-ahead step journal (one row per attempt) and the
 *   append-only event journal that feeds replay/SSE (ADR-0001 §8.7.1/§9.1/
 *   §9.7, ADR-0002 §6.1). project_id RESTRICTs a hard project delete.
 * - run_leases: ephemeral claim/heartbeat row per run (simplified fencing —
 *   no `epoch` yet); CASCADE on run delete because a lease is disposable
 *   runtime state, not history.
 * - vault_secrets: shared per-consumer (user|org), per-provider encrypted
 *   secret store (AES-256-GCM ciphertext only; polymorphic consumer_id).
 *
 * Strict Postgres runtime (ProjectsService / GithubInstallationsService /
 * UsersService hit these tables only — no memory fallback); the tables are
 * the durable contract whose code-first source is this schema and whose
 * active migrations live in drizzle/ (`drizzle-kit migrate` in
 * production).
 *
 * Soft-delete rule (project rule): rows are NEVER physically deleted —
 * removal sets `deleted_at = now()` on organizations / projects /
 * project_chats / project_sessions / session_messages / run_runs. Reads hide
 * such rows with `isNull(<table>.deletedAt)` (opt-in `includeDeleted` where
 * the API needs history). projects.org_id and the chats/sessions FKs are
 * ON DELETE RESTRICT so hard deletes fail instead of wiping history.
 * session_messages reaches projects only via
 * session_messages.session_id -> project_sessions.id -> projects.id
 * (both RESTRICT).
 */
import { desc, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not cascade): rows are never physically deleted, so a hard
  // delete of an organization must fail loudly instead of silently wiping
  // its projects. Org removal soft-deletes (`deleted_at`) instead.
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, {
      onDelete: "restrict",
    }),
  name: text("name").notNull(),
  description: text("description"),
  githubOwner: text("github_owner"),
  githubRepo: text("github_repo"),
  githubBranch: text("github_branch").default("main"),
  githubUrl: text("github_url"),
  ownerId: text("owner_id"),
  status: text("status").notNull().default("active"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (t) => [
  index("projects_org_idx").on(t.orgId),
  index("projects_org_status_idx").on(t.orgId, t.status),
]);

export const projectChats = pgTable("project_chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not cascade): rows are never physically deleted, so a hard
  // delete of a project must fail loudly instead of wiping chat history.
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const projectSessions = pgTable("project_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not cascade): rows are never physically deleted, so a hard
  // delete of a project must fail loudly instead of wiping session history.
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  chatId: uuid("chat_id").references(() => projectChats.id, {
    onDelete: "set null",
  }),
  status: text("status").notNull().default("open"),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  // Session ownership: 'upstream' (the row only mirrors a serve-stand
  // session) vs 'harness' (created locally while the stand was unreachable).
  // Existing rows predate the split and are upstream sessions.
  origin: text("origin").notNull().default("upstream"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("project_sessions_project_idx").on(t.projectId),
  index("project_sessions_project_origin_idx").on(t.projectId, t.origin),
]);

/**
 * Durable session chat history.
 *
 * Chain: projects 1:N project_sessions 1:N session_messages (both RESTRICT).
 * session_id is the harness uuid (project_sessions.id); upstream `ses_*`
 * rows are orphans and were dropped by migration 0009 (no cast possible).
 * Project scope resolves via JOIN project_sessions (messages carry no
 * project_id — the direct session_messages -> projects link is gone).
 *
 * Surrogate PK (migration 0010, SURROGATE decision): `id` is an internal
 * uuid PK (defaultRandom) that never leaves the DB; `domain_id` carries the
 * stable wire message id (upstream `msg_*` / Bun.randomUUIDv7() receipts)
 * with a UNIQUE constraint. Replay stays idempotent via
 * onConflictDoNothing(domain_id) — the PK change does not alter the wire
 * contract (SessionMessage.id is still the domain id).
 *
 * Linked list (migration 0011, parentId-only): `parent_id` is the parent
 * link — TEXT carrying the parent domain id (nullable, root is NULL),
 * logical FK -> session_messages.domain_id (UNIQUE) with SET NULL on
 * delete; hard deletes never happen (soft-delete rule), so the FK only
 * guards the chain shape. Index (session_id, parent_id) scopes the walk.
 * Invariant: one parent per message, traversal from the root, no branches
 * (a parent owns at most one child — enforced in the repository
 * validator, fallback to createdAt order on break).
 *
 * Tool/reasoning chain (migration 0012, additive): `kind`/`name`/`status`/
 * `detail` are nullable chain hints (unified ChatEntry) — 'text' bubbles vs
 * 'tool' timeline steps vs 'reasoning' traces. `text` is nullable with a
 * '' default (tool rows carry no bubble). Reads return the full chain
 * (orderByParentChain), old clients ignore the new keys.
 */
export const sessionMessages = pgTable(
  "session_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable wire message id (was the text PK before 0010); UNIQUE so a
    // replayed append is a no-op instead of a duplicate row.
    domainId: text("domain_id").notNull().unique(),
    // Harness session uuid -> project_sessions.id (RESTRICT: history is never
    // physically deleted, a hard session delete must fail loudly).
    sessionId: uuid("session_id")
      .notNull()
      .references(() => projectSessions.id, { onDelete: "restrict" }),
    // FK-less text, same convention as projects.owner_id /
    // github_installations.user_id / refresh_tokens.user_id.
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    agentId: text("agent_id"),
    text: text("text").default(""),
    // Tool/reasoning chain (0012, additive): kind/name/status/detail are
    // nullable hints — 'text' bubble vs 'tool' step vs 'reasoning' trace.
    // Absent kind reads as text; tool rows carry name/status/detail.
    kind: text("kind").default("text"),
    name: text("name"),
    status: text("status"),
    detail: text("detail"),
    // Linked list parent link (0011): parent domain id, NULL for the root.
    // TEXT (not uuid) because domain ids are upstream-owned (`msg_*` receipts
    // are not uuids); logical FK -> domain_id (UNIQUE), SET NULL on delete.
    parentId: text("parent_id").references((): AnyPgColumn => sessionMessages.domainId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("session_messages_session_idx").on(t.sessionId, t.createdAt),
    index("session_messages_session_parent_idx").on(t.sessionId, t.parentId),
  ],
);

/**
 * Agent chosen per session (upserted on create/explicit per-turn agentId).
 * session_id is the harness uuid FK -> project_sessions.id (RESTRICT,
 * migration 0010; upstream `ses_*` rows were dropped before the cast —
 * no cast possible, same call as 0009). One row per session id.
 */
export const sessionAgents = pgTable("session_agents", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => projectSessions.id, { onDelete: "restrict" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  agentId: text("agent_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (t) => [
  index("session_agents_project_idx").on(t.projectId),
]);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectChatRow = typeof projectChats.$inferSelect;
export type ProjectSessionRow = typeof projectSessions.$inferSelect;
export type SessionMessageRow = typeof sessionMessages.$inferSelect;
export type SessionAgentRow = typeof sessionAgents.$inferSelect;

/**
 * Multi-tenant GitHub App installations (durable contract for the
 * Postgres-backed GithubInstallationsService).
 * userId stays a nullable text FK-less column until the users table exists.
 */
export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id"),
  installationId: bigint("installation_id", { mode: "number" })
    .notNull()
    .unique(),
  accountLogin: text("account_login"),
  accountType: text("account_type"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Internal accounts (durable contract for the Postgres-backed UsersService).
 * Email is stored lowercased (`createLocal` normalizes), so the raw unique
 * constraint gives case-insensitive identity; lookup still uses
 * `lower(email) = lower($1)` for legacy rows. github_installations.user_id
 * stays a nullable text FK-less column carrying the same string key.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  provider: text("provider").notNull().default("local"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserRow = typeof users.$inferSelect;

/**
 * Shared vault (durable contract): per-consumer, per-provider secrets.
 *
 * One row per stored secret. `consumer_type` is 'user' | 'org' (CHECK in SQL)
 * and `consumer_id` is the owning uuid — the pair is polymorphic on purpose,
 * so an org can reuse the same mechanism without a second table. The provider
 * id is arbitrary (`vaultSecretInputSchema` in @rush-code/contracts), so the
 * vault is not limited to AI providers. The secret itself is stored ONLY as
 * AES-256-GCM ciphertext (encrypted_key = base64(ct || tag), iv = base64(iv));
 * plaintext never touches the DB, the logs, or the wire back to the client.
 * `key_id` names the KEK version that wrapped the row (dual-read decrypt
 * across the rotation window; legacy '' = pre-versioning row).
 *
 * Polymorphic-consumer trade-off: `consumer_id` intentionally has NO foreign
 * key (it points at `users` OR `organizations`), so Postgres cannot cascade.
 * User cleanup is compensated in `UsersRepository.deleteById`/`deleteAll`
 * (vault rows are deleted in the same transaction as the user). Org deletion
 * is soft (`deleted_at`) and its secrets stay in place, inaccessible but
 * restorable; a future hard org delete must clear `consumer_type = 'org'`
 * rows explicitly.
 */
export const vaultSecrets = pgTable(
  "vault_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consumerType: text("consumer_type").notNull(),
    consumerId: uuid("consumer_id").notNull(),
    provider: text("provider").notNull(),
    label: text("label").notNull().default(""),
    encryptedKey: text("encrypted_key").notNull(),
    iv: text("iv").notNull(),
    keyId: text("key_id").notNull().default("v1"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("vault_secrets_consumer_provider_idx").on(
      t.consumerType,
      t.consumerId,
      t.provider,
    ),
    check(
      "vault_secrets_consumer_type_check",
      sql`${t.consumerType} in ('user', 'org')`,
    ),
  ],
);

export type VaultSecretRow = typeof vaultSecrets.$inferSelect;


export type GithubInstallationRow = typeof githubInstallations.$inferSelect;

/**
 * Organizations epic (durable contract).
 *
 * Tables:
 * - organizations: registry of orgs (id uuid, owner user_id uuid, privacy
 *   flag `is_private` default true). Owner references users(id) SET NULL —
 *   the org outlives its creator (a maintainer keeps administering it).
 * - organization_members: membership (org_id, user_id, role maintainer|user).
 *   Unique (org_id, user_id); role is CHECK-constrained in SQL.
 * - projects: organization ownership is represented by projects.org_id
 *   (1:1); the former projects_and_organizations M2M table is gone.
 *
 * Single-maintainer constraint (partial unique index):
 *   CREATE UNIQUE INDEX ... ON organization_members (org_id)
 *   WHERE role = 'maintainer'
 * Rationale: exactly one maintainer per org must hold under concurrency —
 * an app-level "count maintainers then insert" check races when two
 * add/role-change requests run in parallel. A partial unique index enforces
 * it in Postgres itself (unlimited `user` rows, at most one `maintainer`
 * row per org), while the service layer adds friendly 409s plus the
 * last-maintainer removal/demotion guard (400). No data migration: fresh
 * tables only, existing projects/users rows untouched.
 */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: uuid("owner_id").references(() => users.id, {
    onDelete: "set null",
  }),
  isPrivate: boolean("is_private").notNull().default(true),
  // Personal org of a single user (created at register, immutable — never
  // deleted via the API). Default false so existing team orgs are unaffected.
  isPersonal: boolean("is_personal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("organization_members_org_user_idx").on(t.orgId, t.userId),
    // Partial unique index: at most one `maintainer` row per org (see
    // rationale above). Plain `user` rows are unaffected by the predicate.
    uniqueIndex("organization_members_single_maintainer_idx")
      .on(t.orgId)
      .where(sql`${t.role} = 'maintainer'`),
  ],
);

/**
 * Organization invites (durable contract).
 *
 * - `token` is the uuidv7 invite id (generated in app, PK — no TTL column,
 *   links never expire).
 * - `email` is NULL for open link-invites (any session user can accept) or
 *   the lowercased bound address for email-invites (only that user accepts;
 *   mismatch → 404, no enumeration).
 * - Single-use: the row is DELETED on accept; replay/missing → 404.
 * - `org_id` CASCADE — a hard delete of the org would drop pending invites
 *   (app-level org removal is a soft delete, so invites are kept but a
 *   soft-deleted org never accepts them).
 */
export const organizationInvites = pgTable(
  "organization_invites",
  {
    token: uuid("token").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email"),
    role: text("role").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("organization_invites_org_idx").on(t.orgId)],
);

export type OrganizationInviteRow = typeof organizationInvites.$inferSelect;

export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;

/**
 * Persistent refresh-token registry (durable contract for TokenService).
 *
 * - `id` is the JWT `jti` (uuid string; no FK — the token survives a user
 *   hard-delete window and stays auditable).
 * - `user_id` is the same text key used by `projects.owner_id` /
 *   `github_installations.user_id` (no users FK, matching the auth contract).
 * - `issued_at` / `expires_at` mirror the JWT `iat` / `exp` claims.
 * - Rotation NEVER deletes a row: consumed/logged-out tokens get
 *   `revoked_at = now()`, and the prune job only sets `deleted_at = now()`
 *   for expired rows (soft-prune). Reads require both timestamps to be NULL
 *   and `expires_at > now()`.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("refresh_tokens_user_id_idx").on(t.userId),
    index("refresh_tokens_expires_at_idx").on(t.expiresAt),
  ],
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

/**
 * Run registry (agent-harness prototype, ADR-0001 §8.7.1 / ADR-0002 §6.1).
 *
 * One row per run: the C4 scope (project_id), the Forward-Only base commit,
 * the dedicated branch/worktree pair and the pinned definition set. Statuses
 * come from the frozen `RunStatus` union in `@rush-code/contracts` — the
 * column is plain text with a default, no CHECK (the contract owns the enum).
 * `deleted_at` follows the soft-delete rule: aborted runs are hidden with
 * `isNull(runRuns.deletedAt)`, never removed from disk.
 */
export const runRuns = pgTable(
  "run_runs",
  {
    // run_id; the app mints Bun.randomUUIDv7() — defaultRandom is a DB-side
    // safety net, not the source of truth (uuidv7 keeps creation order).
    id: uuid("id").primaryKey().defaultRandom(),
    // C4 scope; RESTRICT — rows are never physically deleted (soft-delete rule).
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title"),
    status: text("status").notNull().default("open"),
    // pin of the active definition set (skills/agents/tools) at run start
    definitionSetHash: text("definition_set_hash").notNull(),
    // Forward-Only lower bound: history is never rewound below this sha
    baseCommit: text("base_commit").notNull(),
    branch: text("branch").notNull(), // agent/<run_id>
    worktree: text("worktree").notNull(), // REPOS_ROOT/.../wt/<run_id>
    sandboxId: text("sandbox_id"), // opencode-runner slot; null while none
    agentId: text("agent_id"), // registry id, nullable like session_agents.agent_id
    model: jsonb("model").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // soft-delete: reads use isNull(deletedAt)
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("run_runs_project_idx").on(t.projectId),
    index("run_runs_project_status_idx").on(t.projectId, t.status),
  ],
);

/**
 * Run steps — write-ahead step journal (ADR-0001 §9.1). One row per
 * llm.call/tool.call/sandbox.exec/git.commit/await_human/router attempt.
 *
 * Written BEFORE the effect happens, then closed with its outcome, so a
 * crash leaves a recoverable trail; `idempotency_key` makes a replay of the
 * same effect a no-op. `seq` is monotonic per run (unique with run_id).
 */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runRuns.id, { onDelete: "restrict" }),
    seq: bigint("seq", { mode: "number" }).notNull(), // monotonic per run
    // llm.call | tool.call | sandbox.exec | git.commit | await_human | router
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    inputHash: text("input_hash").notNull(),
    // hash(run_id, step_id, effect_class, input_hash) — one row per effect
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // fencing slot: reserved for TODO(full-fencing); simplified claim ignores it
    observedEpoch: integer("observed_epoch").notNull().default(0),
    resultRef: jsonb("result_ref").$type<Record<string, unknown> | null>(),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("run_steps_run_seq_idx").on(t.runId, t.seq),
    index("run_steps_run_status_idx").on(t.runId, t.status),
  ],
);

/**
 * Run events — append-only journal, the source of truth for replay/SSE
 * (ADR-0001 §9.7). UPDATE/DELETE are forbidden by doctrine (no trigger in
 * the prototype); `seq` is the SSE frame id and `prevHash` chains events
 * tamper-evidently.
 */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runRuns.id, { onDelete: "restrict" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    prevHash: text("prev_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)],
);

/**
 * Run leases — ephemeral claim/heartbeat rows (simplified fencing).
 * TODO(full-fencing): add `epoch` + `SELECT ... FOR UPDATE` on the lease row
 * in the same transaction as the journal append; a stale/foreign epoch must
 * fence the worker. The prototype only survives a graceful restart.
 */
export const runLeases = pgTable("run_leases", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => runRuns.id, { onDelete: "cascade" }),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Agent checkpoints — durable pause/resume slices of a session turn
 * (WEB-12 / B1). One row per (session_id, segment_index): a turn is cut
 * into segments of `CHECKPOINT_SEGMENT_STEPS` model steps
 * (`processes/.../sessions/modules/runner/max-steps.ts`, single home of the
 * segment config) up to the `CHECKPOINT_MAX_TOTAL_STEPS` ceiling.
 *
 * `session_id` is the harness uuid FK -> project_sessions.id with CASCADE:
 * checkpoints are disposable runtime state (like run_leases), not history
 * under the soft-delete rule, so they die with the session. `status`
 * (running/paused/awaiting_approval/limit_reached/cancelled/completed/
 * failed) and `pause_reason` (limit/loop/timeout/approval/cancelled/
 * restart) are plain text with no CHECK — the contract owns the enums
 * (same call as run_runs.status). `state` carries the opaque agent snapshot.
 */
export const agentCheckpoints = pgTable(
  "agent_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => projectSessions.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    segmentIndex: integer("segment_index").notNull(),
    stepsUsed: integer("steps_used").notNull(),
    totalSteps: integer("total_steps").notNull(),
    status: text("status").notNull().default("running"),
    pauseReason: text("pause_reason"),
    state: jsonb("state").$type<Record<string, unknown> | null>(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("agent_checkpoints_session_segment_idx").on(
      t.sessionId,
      t.segmentIndex,
    ),
    index("agent_checkpoints_session_created_idx").on(
      t.sessionId,
      desc(t.createdAt),
    ),
  ],
);

export type RunRow = typeof runRuns.$inferSelect;
export type RunStepRow = typeof runSteps.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type RunLeaseRow = typeof runLeases.$inferSelect;
export type AgentCheckpointRow = typeof agentCheckpoints.$inferSelect;

