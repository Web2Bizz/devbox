import {
  Injectable,
  NotFoundException,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { AppLogger } from "../../common/app-logger.service.js";
import {
  DbService,
  dbUnavailable,
  type DbClient,
} from "../../db/db.service.js";
import { projectChats, type ProjectChatRow } from "../../db/schema.js";
import { OrganizationsService } from "../../organizations/organizations.service.js";
import { ProjectsService } from "../projects.service.js";
import type { CreateChatInput } from "./dto.js";

export interface ProjectChat {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

function toChat(row: ProjectChatRow): ProjectChat {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Chats live inside ProjectsModule — every op verifies the parent project.
 * Strict Postgres `project_chats` (FK cascade on project delete).
 * Outages funnel through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 *
 * Scope (Card 5 access layer): user-facing ops (list/create/remove) gate on
 * OrganizationsService.assertProjectAccess — org-linked projects admit any
 * member of a linked org, user-space projects admit only the owner.
 * Strangers get 404 (existence is not leaked). getInProject/removeByProject
 * stay access-free (called by SessionsService.create / project-delete after
 * their own gates).
 */
@Injectable()
export class ChatsService {
  constructor(
    @Inject(forwardRef(() => ProjectsService))
    private readonly projects: ProjectsService,
    private readonly logger: AppLogger = new AppLogger("ChatsService"),
    private readonly db: DbService,
    private readonly orgs?: OrganizationsService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /**
   * Card 5 gate (see SessionsService.checkAccess for the rule). Skipped
   * only when the requester is absent (internal/test callers) or the access
   * service is not wired (manual `new` in unit specs).
   */
  private async checkAccess(
    projectId: string,
    ownerId: string | null,
    requesterId: string | undefined,
    correlationId?: string,
  ): Promise<void> {
    if (!requesterId || !this.orgs) return;
    await this.orgs.assertProjectAccess(
      projectId,
      ownerId,
      requesterId,
      correlationId,
    );
  }

  async list(
    projectId: string,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectChat[]> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      const rows = await this.client()
        .select()
        .from(projectChats)
        .where(eq(projectChats.projectId, projectId));
      return rows
        .map(toChat)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("chats.list", err, this.logger, correlationId);
    }
  }

  async create(
    projectId: string,
    input: CreateChatInput,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectChat> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      const rows = await this.client()
        .insert(projectChats)
        .values({ projectId, title: input.title })
        .returning();
      // Per-request success on a hot path → debug (not info); cid-bound.
      this.logger.debug(`[projects] chat created`, correlationId);
      return toChat(rows[0]);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("chats.create", err, this.logger, correlationId);
    }
  }

  async remove(
    projectId: string,
    chatId: string,
    correlationId?: string,
    requesterId?: string,
  ): Promise<void> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      // project_sessions.chat_id FK is SET NULL — sessions survive with chat detached.
      const rows = await this.client()
        .select()
        .from(projectChats)
        .where(
          and(
            eq(projectChats.id, chatId),
            eq(projectChats.projectId, projectId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundException(
          `Chat ${chatId} not found in project ${projectId}`,
        );
      }
      await this.client()
        .delete(projectChats)
        .where(eq(projectChats.id, chatId));
      // Per-request success on a hot path → debug (not info); cid-bound.
      this.logger.debug(`[projects] chat removed`, correlationId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("chats.remove", err, this.logger, correlationId);
    }
  }

  /** Cascade helper — called when a project is deleted (FK cascade covers PG). */
  async removeByProject(
    projectId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.client()
        .delete(projectChats)
        .where(eq(projectChats.projectId, projectId));
    } catch (err) {
      dbUnavailable("chats.removeByProject", err, this.logger, correlationId);
    }
  }

  async getInProject(
    projectId: string,
    chatId: string,
    correlationId?: string,
  ): Promise<ProjectChat | null> {
    try {
      const rows = await this.client()
        .select()
        .from(projectChats)
        .where(
          and(
            eq(projectChats.id, chatId),
            eq(projectChats.projectId, projectId),
          ),
        )
        .limit(1);
      return rows.length > 0 ? toChat(rows[0]) : null;
    } catch (err) {
      dbUnavailable("chats.getInProject", err, this.logger, correlationId);
    }
  }

  /** Test/e2e seam — DELETE FROM project_chats (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.client().delete(projectChats);
  }
}
