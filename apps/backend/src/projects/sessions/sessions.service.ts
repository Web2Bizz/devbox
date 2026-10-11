import {
  BadRequestException,
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
import { projectSessions, type ProjectSessionRow } from "../../db/schema.js";
import { ChatsService } from "../chats/chats.service.js";
import { ProjectsService } from "../projects.service.js";
import { OrganizationsService } from "../../organizations/organizations.service.js";
import type { CreateSessionInput } from "./dto.js";

export interface ProjectSession {
  id: string;
  projectId: string;
  chatId: string | null;
  status: "open" | "closed";
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

function toSession(row: ProjectSessionRow): ProjectSession {
  return {
    id: row.id,
    projectId: row.projectId,
    chatId: row.chatId,
    status: (row.status as ProjectSession["status"]) ?? "open",
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Sessions live inside ProjectsModule — bound to projectId (+ optional chatId).
 * Strict Postgres `project_sessions` (cascade on project delete, SET NULL on
 * chat delete). Outages funnel through `dbUnavailable` → 503
 * EXTERNAL_UNAVAILABLE (Retry-After 30 via ApiErrorFilter), logged once with
 * the correlationId.
 *
 * Scope (Card 5 access layer): every user-facing op gates on
 * OrganizationsService.assertProjectAccess — org-linked projects admit any
 * member of a linked org, user-space projects admit only the owner
 * (project.ownerId vs the requester). Strangers get 404 (existence is not
 * leaked). Cascade helpers (removeByProject/detachChat/hasChatReference)
 * stay access-free — the project-delete path calls them after its own gate.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(forwardRef(() => ProjectsService))
    private readonly projects: ProjectsService,
    @Inject(forwardRef(() => ChatsService))
    private readonly chats: ChatsService,
    private readonly logger: AppLogger = new AppLogger("SessionsService"),
    private readonly db: DbService,
    private readonly orgs?: OrganizationsService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /**
   * Card 5 gate: org-linked → any linked-org member; user-space → owner
   * only; strangers → 404 (no existence leak). Skipped only when the
   * requester is absent (internal/test callers without an identity) or the
   * access service is not wired (manual `new` in unit specs).
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
  ): Promise<ProjectSession[]> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      const rows = await this.client()
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.projectId, projectId));
      return rows
        .map(toSession)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("sessions.list", err, this.logger, correlationId);
    }
  }

  async get(
    projectId: string,
    sessionId: string,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectSession> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      const rows = await this.client()
        .select()
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.id, sessionId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundException(
          `Session ${sessionId} not found in project ${projectId}`,
        );
      }
      return toSession(rows[0]);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("sessions.get", err, this.logger, correlationId);
    }
  }

  async create(
    projectId: string,
    input: CreateSessionInput,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectSession> {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    if (input.chatId) {
      const chat = await this.chats.getInProject(
        projectId,
        input.chatId,
        correlationId,
      );
      if (!chat) {
        throw new BadRequestException(
          `chatId ${input.chatId} does not belong to project ${projectId}`,
        );
      }
    }
    try {
      const rows = await this.client()
        .insert(projectSessions)
        .values({
          projectId,
          chatId: input.chatId ?? null,
          status: input.status ?? "open",
          metadata: (input.metadata ?? null) as Record<string, unknown> | null,
        })
        .returning();
      // Per-request success on a hot path → debug (not info); cid-bound.
      this.logger.debug(`[projects] session created`, correlationId);
      return toSession(rows[0]);
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      )
        throw err;
      dbUnavailable("sessions.create", err, this.logger, correlationId);
    }
  }

  async close(
    projectId: string,
    sessionId: string,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectSession> {
    await this.get(projectId, sessionId, correlationId, requesterId);
    try {
      const rows = await this.client()
        .update(projectSessions)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(projectSessions.id, sessionId))
        .returning();
      if (rows.length === 0) {
        throw new NotFoundException(
          `Session ${sessionId} not found in project ${projectId}`,
        );
      }
      // Per-request success on a hot path → debug (not info); cid-bound.
      this.logger.debug(`[projects] session closed`, correlationId);
      return toSession(rows[0]);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      dbUnavailable("sessions.close", err, this.logger, correlationId);
    }
  }

  /** Cascade helper — called when a project is deleted (FK cascade covers PG). */
  async removeByProject(
    projectId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.client()
        .delete(projectSessions)
        .where(eq(projectSessions.projectId, projectId));
    } catch (err) {
      dbUnavailable(
        "sessions.removeByProject",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  /**
   * Chat-delete helper — detaches sessions bound to the chat (chat_id → NULL).
   * The Postgres FK (ON DELETE SET NULL) already handles this; the explicit
   * UPDATE keeps explicit-delete paths consistent.
   */
  async detachChat(chatId: string, correlationId?: string): Promise<void> {
    try {
      await this.client()
        .update(projectSessions)
        .set({ chatId: null, updatedAt: new Date() })
        .where(eq(projectSessions.chatId, chatId));
    } catch (err) {
      dbUnavailable("sessions.detachChat", err, this.logger, correlationId);
    }
  }

  /** True when the session row still references a chat (SET NULL check helper). */
  async hasChatReference(
    sessionId: string,
    correlationId?: string,
  ): Promise<boolean> {
    try {
      const rows = await this.client()
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.id, sessionId))
        .limit(1);
      return rows.length > 0 && rows[0].chatId !== null;
    } catch (err) {
      dbUnavailable(
        "sessions.hasChatReference",
        err,
        this.logger,
        correlationId,
      );
    }
  }

  /** Test/e2e seam — DELETE FROM project_sessions (requires live Postgres). */
  async clearAllForTests(): Promise<void> {
    await this.client().delete(projectSessions);
  }
}
