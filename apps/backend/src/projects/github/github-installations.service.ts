import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { AppLogger } from "../../common/app-logger.service";
import {
  DbService,
  dbUnavailable,
  type DbClient,
} from "../../db/db.service";
import {
  githubInstallations,
  type GithubInstallationRow,
} from "../../db/schema";

/**
 * Stored GitHub App installation (multi-tenant binding).
 * userId is our MVP mock user key (x-user-id header / ?userId query) —
 * nullable until the users table exists. installationId is the GitHub
 * numeric id (unique). Tokens are NEVER stored here — only the binding.
 */
export type GithubInstallation = {
  userId: string | null;
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertInstallationInput = {
  installationId: number;
  userId?: string | null;
  accountLogin?: string | null;
  accountType?: string | null;
  suspendedAt?: string | null;
};

function toInstallation(row: GithubInstallationRow): GithubInstallation {
  return {
    userId: row.userId,
    // bigint mode:number — drizzle already returns a JS number.
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseSuspendedAt(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

/**
 * GithubInstallationsService — Postgres-backed installation registry (strict).
 *
 * Every method hits the `github_installations` table; data survives
 * restarts. When Postgres is unconfigured/unreachable the drizzle throw
 * funnels through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE (Retry-After 30
 * via ApiErrorFilter), logged once with the correlationId.
 * Only ids/logins are kept (never tokens/keys); logs carry fixed prefixes
 * plus non-secret ids only.
 */
@Injectable()
export class GithubInstallationsService {
  constructor(
    private readonly logger: AppLogger = new AppLogger("GithubInstallations"),
    private readonly db: DbService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /**
   * Creates or merges an installation row. Existing userId is preserved
   * unless an explicit userId is supplied (webhook events carry no session,
   * so they must not steal ownership from the callback binding).
   */
  async upsert(
    input: UpsertInstallationInput,
    correlationId?: string,
  ): Promise<GithubInstallation> {
    try {
      const prev = await this.findByInstallationId(
        input.installationId,
        correlationId,
      );
      const userId = input.userId ?? prev?.userId ?? null;
      const accountLogin = input.accountLogin ?? prev?.accountLogin ?? null;
      const accountType = input.accountType ?? prev?.accountType ?? null;
      const suspendedAt =
        input.suspendedAt !== undefined
          ? input.suspendedAt
          : (prev?.suspendedAt ?? null);
      if (!prev) {
        const rows = await this.client()
          .insert(githubInstallations)
          .values({
            userId,
            installationId: input.installationId,
            accountLogin,
            accountType,
            suspendedAt: parseSuspendedAt(suspendedAt) ?? null,
          })
          .returning();
        const record = toInstallation(rows[0]);
        this.logger.info(
          `[github] installation upserted ${record.installationId}`,
          correlationId,
        );
        return record;
      }
      const rows = await this.client()
        .update(githubInstallations)
        .set({
          userId,
          accountLogin,
          accountType,
          suspendedAt: parseSuspendedAt(suspendedAt) ?? null,
          updatedAt: new Date(),
        })
        .where(eq(githubInstallations.installationId, input.installationId))
        .returning();
      const record = toInstallation(rows[0]);
      this.logger.info(
        `[github] installation upserted ${record.installationId}`,
        correlationId,
      );
      return record;
    } catch (err) {
      dbUnavailable(
        "github-installations.upsert",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  async findByUserId(
    userId: string,
    correlationId?: string,
  ): Promise<GithubInstallation | null> {
    try {
      const rows = await this.client()
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.userId, userId))
        .orderBy(desc(githubInstallations.updatedAt))
        .limit(1);
      return rows.length > 0 ? toInstallation(rows[0]) : null;
    } catch (err) {
      dbUnavailable(
        "github-installations.findByUserId",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  async findByInstallationId(
    installationId: number,
    correlationId?: string,
  ): Promise<GithubInstallation | null> {
    try {
      const rows = await this.client()
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .limit(1);
      return rows.length > 0 ? toInstallation(rows[0]) : null;
    } catch (err) {
      dbUnavailable(
        "github-installations.findByInstallationId",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  /** Removes by GitHub installation id; true when a row existed. */
  async removeByInstallationId(
    installationId: number,
    correlationId?: string,
  ): Promise<boolean> {
    try {
      const rows = await this.client()
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .limit(1);
      if (rows.length === 0) return false;
      await this.client()
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId));
      this.logger.info(`[github] installation removed ${installationId}`, correlationId);
      return true;
    } catch (err) {
      dbUnavailable(
        "github-installations.removeByInstallationId",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  /** Test/e2e seam — DELETE FROM github_installations (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.client().delete(githubInstallations);
  }
}
