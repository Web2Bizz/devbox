/**
 * Drizzle schema — projects domain (module in module).
 *
 * Tables:
 * - projects: registry of projects (chats/sessions live underneath).
 * - project_chats: chats bound to a project (FK RESTRICT on project delete).
 * - project_sessions: sessions bound to project (+ optional chat),
 *   RESTRICT on project delete, SET NULL on chat delete. `origin` marks who
 *   owns the row: 'upstream' (lives on the opencode serve stand) or
 *   'harness' (created by the harness while the stand was unreachable).
 * - session_messages: durable chat history keyed by the DOMAIN session id
 *   (upstream `ses_*` or a harness uuid) — text column, NOT uuid, because
 *   upstream ids are not uuids. project_id carries the gate scope.
 * - session_agents: the agent chosen for a session (one row per session id).
 * - github_installations: multi-tenant GitHub App installs — one row per
 *   GitHub installation (unique installation_id), linked to our userId
 *   (nullable until users table exists; MVP resolves a mock userId from
 *   the x-user-id header / ?userId query).
 * - organizations / organization_members: orgs epic; projects belong to an
 *   organization through projects.org_id (1:1). The former M2M table is gone.
 * - refresh_tokens: persistent refresh-token rotation registry (jti rows,
 *   soft revoke/soft prune — never physically deleted).
 *
 * Strict Postgres runtime (ProjectsService / GithubInstallationsService /
 * UsersService hit these tables only — no memory fallback); the tables are
 * the durable contract whose code-first source is this schema and whose
 * active migrations live in drizzle/ (`drizzle-kit migrate` in
 * production).
 *
 * Soft-delete rule (project rule): rows are NEVER physically deleted —
 * removal sets `deleted_at = now()` on organizations / projects /
 * project_chats / project_sessions / session_messages. Reads hide such rows with
 * `isNull(<table>.deletedAt)` (opt-in `includeDeleted` where the API needs
 * history). projects.org_id and the chats/sessions project_id FKs are
 * ON DELETE RESTRICT so hard deletes fail instead of wiping history.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not cascade): rows are never physically deleted, so a hard
  // delete of an organization must fail loudly instead of silently wiping
  // its projects. Org removal soft-deletes (`deleted_at`) instead.
  orgId: uuid("org_id").references(() => organizations.id, {
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
});

/**
 * Durable session chat history.
 *
 * Separate from project_sessions because the two id domains differ:
 * project_sessions.id is a uuid, while messages are addressed by the DOMAIN
 * session id (upstream `ses_*` or a harness uuid) — hence a text session_id.
 * project_id keeps every row inside the C4 gate scope (messages are never
 * read across projects) and RESTRICTs a hard project delete, matching the
 * soft-delete rule used by every history table.
 */
export const sessionMessages = pgTable(
  "session_messages",
  {
    id: text("id").primaryKey(),
    // Domain session id: `ses_*` (upstream) or a uuid (harness) — never a
    // uuid column, so both id shapes are addressable.
    sessionId: text("session_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    // FK-less text, same convention as projects.owner_id /
    // github_installations.user_id / refresh_tokens.user_id.
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    agentId: text("agent_id"),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("session_messages_session_idx").on(t.sessionId, t.createdAt),
    index("session_messages_project_idx").on(t.projectId),
  ],
);

/**
 * Agent chosen per session (upserted on create/explicit per-turn agentId).
 * session_id is the same text domain id as session_messages.session_id, so
 * the choice survives a backend restart for both upstream and harness rows.
 */
export const sessionAgents = pgTable("session_agents", {
  sessionId: text("session_id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  agentId: text("agent_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

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
 * Per-user OpenCode API keys (durable contract).
 * One row per user (user_id is both PK and FK → users(id) ON DELETE CASCADE,
 * so deleting a user drops their key). The API key itself is stored ONLY as
 * AES-256-GCM ciphertext (encrypted_key = base64(ct || tag), iv =
 * base64(iv)) — plaintext never touches the DB, the logs, or the wire back
 * to the client. `keyId` names the KEK version that wrapped the row
 * (dual-read decrypt across the rotation window; legacy '' = pre-versioning
 * row, readable via the active → previous fallback, lazily re-wrapped).
 */
export const userOpencodeKeys = pgTable("user_opencode_keys", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  encryptedKey: text("encrypted_key").notNull(),
  iv: text("iv").notNull(),
  keyId: text("key_id").notNull().default("v1"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserOpencodeKeyRow = typeof userOpencodeKeys.$inferSelect;

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
