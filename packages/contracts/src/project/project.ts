/**
 * Project contracts.
 *
 * Mirrors contracts/openapi.yaml components/schemas: Project,
 * CreateProject (+ ProjectScope, reused for the disk-home scope).
 * Request input types live in project.schema.ts (inferred from the
 * backend-verbatim zod schemas).
 */

/**
 * Disk-home scope — frontend-additive (older caches stay valid without it).
 * Linking a project to an org is metadata-only (no disk move).
 */
export type ProjectScope = 'user' | 'org';

export type ProjectStatus = 'active' | 'deleted';

export type Project = {
  id: string;
  /** Owning organization (1:1). null for user-space projects. */
  orgId: string | null;
  name: string;
  description: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  githubBranch: string | null;
  githubUrl: string | null;
  ownerId: string | null;
  /** Lifecycle: active | deleted (soft-delete, restore via API only). */
  status: ProjectStatus;
  /** Soft-delete timestamp (null when active). */
  deletedAt: string | null;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
  /** Computed flag (no DB column): true when the on-disk git repo is missing/invalid. */
  corrupted: boolean;
  /**
   * Machine reason when corrupted (missing-dir, no-git, rev-parse-failed,
   * fsck-failed, timeout, storage-unconfigured, …).
   */
  corruptedReason: string | null;
};
