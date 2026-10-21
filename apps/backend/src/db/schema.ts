/**
 * Drizzle schema — projects domain (module in module).
 *
 * Tables:
 * - projects: registry of projects (chats/sessions live underneath).
 * - project_chats: chats bound to a project (FK cascade on project delete).
 * - project_sessions: sessions bound to project (+ optional chat),
 *   cascade on project delete, SET NULL on chat delete.
 * - github_installations: multi-tenant GitHub App installs — one row per
 *   GitHub installation (unique installation_id), linked to our userId
 *   (nullable until users table exists; MVP resolves a mock userId from
 *   the x-user-id header / ?userId query).
 * - organizations / organization_members / projects_and_organizations:
 *   orgs epic (0004) — see the block above those tables for the
 *   single-maintainer partial-unique rationale.
 *
 * Strict Postgres runtime (ProjectsService / GithubInstallationsService /
 * UsersService hit these tables only — no memory fallback); the tables are
 * the durable contract applied via drizzle/000N_*.sql (`drizzle-kit migrate`
 * in production).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  githubOwner: text("github_owner"),
  githubRepo: text("github_repo"),
  githubBranch: text("github_branch").default("main"),
  githubUrl: text("github_url"),
  ownerId: text("owner_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const projectChats = pgTable("project_chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const projectSessions = pgTable("project_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  chatId: uuid("chat_id").references(() => projectChats.id, {
    onDelete: "set null",
  }),
  status: text("status").notNull().default("open"),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectChatRow = typeof projectChats.$inferSelect;
export type ProjectSessionRow = typeof projectSessions.$inferSelect;

/**
 * Multi-tenant GitHub App installations (durable contract for the
 * Postgres-backed GithubInstallationsService; see drizzle/0002_github_installations.sql).
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
 * Internal accounts (durable contract for the Postgres-backed UsersService;
 * see drizzle/0003_users.sql). Email lookup key is the lowercased email
 * (CITEXT-style unique index) — github_installations.user_id stays a
 * nullable text FK-less column carrying the same string key (no backfill).
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
 * Per-user OpenCode API keys (durable contract; see
 * drizzle/0005_user_opencode_keys.sql + 0006_user_opencode_keys_key_id.sql).
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
 * Organizations epic (durable contract; see drizzle/0004_organizations.sql).
 *
 * Tables:
 * - organizations: registry of orgs (id uuid, owner user_id uuid, privacy
 *   flag `is_private` default true). Owner references users(id) SET NULL —
 *   the org outlives its creator (a maintainer keeps administering it).
 * - organization_members: membership (org_id, user_id, role maintainer|user).
 *   Unique (org_id, user_id); role is CHECK-constrained in SQL.
 * - projects_and_organizations: M2M link project_id ↔ org_id (composite PK,
 *   both sides CASCADE — deleting a project or an org drops only the link
 *   rows; the counterpart survives).
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
 * Organization invites (durable contract; see drizzle/0007_organization_invites.sql).
 *
 * - `token` is the uuidv7 invite id (generated in app, PK — no TTL column,
 *   links never expire).
 * - `email` is NULL for open link-invites (any session user can accept) or
 *   the lowercased bound address for email-invites (only that user accepts;
 *   mismatch → 404, no enumeration).
 * - Single-use: the row is DELETED on accept; replay/missing → 404.
 * - `org_id` CASCADE — deleting the org drops pending invites.
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

export const projectsAndOrganizations = pgTable(
  "projects_and_organizations",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.projectId, t.orgId],
      name: "projects_and_organizations_pkey",
    }),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type ProjectsAndOrganizationsRow =
  typeof projectsAndOrganizations.$inferSelect;
