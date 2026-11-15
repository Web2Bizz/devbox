import { ForbiddenException, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { AppLogger } from "@common/logger";
import {
  DbService,
  dbUnavailable,
  type DbClient,
} from "@common/db/db.service";
import {
  githubInstallations,
  type GithubInstallationRow,
} from "@common/db/schema";

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
    private readonly logger: AppLogger = new AppLogger(GithubInstallationsService.name),
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
   *
   * A foreign owner is never overwritten: when the stored row already has a
   * userId and the incoming userId differs, the write is rejected with
   * 403 GITHUB_INSTALLATION_FORBIDDEN (no UPDATE, no INSERT).
   */
  async upsert(
    input: UpsertInstallationInput,
    correlationId?: string,
    previous?: GithubInstallation | null,
  ): Promise<GithubInstallation> {
    const existing: GithubInstallation | null =
      previous === undefined
        ? await this.findByInstallationId(input.installationId, correlationId)
        : previous;
    if (
      typeof input.userId === "string" &&
      existing !== null &&
      typeof existing.userId === "string" &&
      existing.userId !== input.userId
    ) {
      throw new ForbiddenException({
        code: "GITHUB_INSTALLATION_FORBIDDEN",
        message: "GitHub App installation belongs to another user",
      });
    }
    const userId: string | null = input.userId ?? existing?.userId ?? null;
    const accountLogin: string | null = input.accountLogin ?? existing?.accountLogin ?? null;
    const accountType: string | null = input.accountType ?? existing?.accountType ?? null;
    const suspendedAt: string | null =
      input.suspendedAt !== undefined
        ? input.suspendedAt
        : (existing?.suspendedAt ?? null);
    if (!existing) {
      try {
        const rows: Array<GithubInstallationRow> = await this.client()
          .insert(githubInstallations)
          .values({
            userId,
            installationId: input.installationId,
            accountLogin,
            accountType,
            suspendedAt: parseSuspendedAt(suspendedAt) ?? null,
          })
          .returning();
        const record: GithubInstallation = toInstallation(rows[0]);
        this.logger.info(
          `[github] installation upserted ${record.installationId}`,
          correlationId,
        );
        return record;
      } catch (error) {
        dbUnavailable(
          "github-installations.upsert",
          error,
          this.logger,
          correlationId,
        );
      }
    }
    let rows: Array<GithubInstallationRow>;
    try {
      const ownership: SQL<unknown> | undefined =
        typeof input.userId === "string"
          ? and(
              eq(githubInstallations.installationId, input.installationId),
              or(
                isNull(githubInstallations.userId),
                eq(githubInstallations.userId, input.userId),
              ),
            )
          : eq(githubInstallations.installationId, input.installationId);
      rows = await this.client()
        .update(githubInstallations)
        .set({
          userId,
          accountLogin,
          accountType,
          suspendedAt: parseSuspendedAt(suspendedAt) ?? null,
          updatedAt: new Date(),
        })
        .where(ownership)
        .returning();
    } catch (error) {
      dbUnavailable(
        "github-installations.upsert",
        error,
        this.logger,
        correlationId,
      );
    }
    if (rows.length === 0) {
      throw new ForbiddenException({
        code: "GITHUB_INSTALLATION_FORBIDDEN",
        message: "GitHub App installation belongs to another user",
      });
    }
    const record: GithubInstallation = toInstallation(rows[0]);
    this.logger.info(
      `[github] installation upserted ${record.installationId}`,
      correlationId,
    );
    return record;
  }

  async findByUserId(
    userId: string,
    correlationId?: string,
  ): Promise<GithubInstallation | null> {
    try {
      const rows: Array<GithubInstallationRow> = await this.client()
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.userId, userId))
        .orderBy(desc(githubInstallations.updatedAt))
        .limit(1);
      return rows.length > 0 ? toInstallation(rows[0]) : null;
    } catch (error) {
      dbUnavailable(
        "github-installations.findByUserId",
        error,
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
      const rows: Array<GithubInstallationRow> = await this.client()
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .limit(1);
      return rows.length > 0 ? toInstallation(rows[0]) : null;
    } catch (error) {
      dbUnavailable(
        "github-installations.findByInstallationId",
        error,
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
      const rows: Array<GithubInstallationRow> = await this.client()
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .returning();
      if (rows.length === 0) return false;
      this.logger.info(`[github] installation removed ${installationId}`, correlationId);
      return true;
    } catch (error) {
      dbUnavailable(
        "github-installations.removeByInstallationId",
        error,
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
