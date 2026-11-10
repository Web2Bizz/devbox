import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { AppLogger } from "@common/logger";
import {
  DbService,
  dbUnavailable,
  type DbClient,
} from "@common/db/db.service";
import { projectSessions, type ProjectSessionRow } from "@common/db/schema";
import { ChatsService, type ProjectChat } from "../chats/chats.service";
import { ProjectsService, type Project } from "../../projects.service";
import { ProjectAccessService } from "../project-access/project-access.service";
import type { CreateSessionInput } from "./sessions.dto";

export type ProjectSession = {
  id: string;
  projectId: string;
  chatId: string | null;
  status: "open" | "closed";
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

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
 * Strict Postgres `project_sessions` (RESTRICT on project delete, SET NULL on
 * chat delete: rows are soft-deleted, so hard deletes must fail loudly).
 * Outages funnel through `dbUnavailable` → 503 EXTERNAL_UNAVAILABLE
 * (Retry-After 30 via ApiErrorFilter), logged once with the correlationId.
 *
 * Scope (Card 5 access layer): every user-facing op gates on
 * ProjectAccessService.assertProjectAccess — org members pass.
 * Strangers get 404 (existence is not leaked). Cascade helpers (removeByProject/detachChat/hasChatReference)
 * stay access-free — the project-delete path calls them after its own gate.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(forwardRef(() => ProjectsService))
    private readonly projects: ProjectsService,
    @Inject(forwardRef(() => ChatsService))
    private readonly chats: ChatsService,
    private readonly logger: AppLogger = new AppLogger(SessionsService.name),
    private readonly db: DbService,
    private readonly access: ProjectAccessService,
  ) {}

  /** Live drizzle client — throws 503 EXTERNAL_UNAVAILABLE when Postgres is down. */
  private client(): DbClient {
    return this.db.client;
  }

  /**
   * Card 5 gate: org members pass; strangers → 404 (no existence leak).
   * A missing requester is a fail-closed 401 — there is no
   * anonymous/service bypass.
   */
  private async checkAccess(
    projectId: string,
    ownerId: string | null,
    requesterId: string | undefined,
    correlationId?: string,
  ): Promise<void> {
    if (!requesterId) {
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
    await this.access.assertProjectAccess(
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
  ): Promise<Array<ProjectSession>> {
    const project: Project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      const rows: Array<ProjectSessionRow> = await this.client()
        .select()
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            isNull(projectSessions.deletedAt),
          ),
        );
      return rows
        .map(toSession)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("sessions.list", error, this.logger, correlationId);
    }
  }

  async get(
    projectId: string,
    sessionId: string,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectSession> {
    const project: Project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    try {
      const rows: Array<ProjectSessionRow> = await this.client()
        .select()
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.id, sessionId),
            eq(projectSessions.projectId, projectId),
            isNull(projectSessions.deletedAt),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundException(
          `Session ${sessionId} not found in project ${projectId}`,
        );
      }
      return toSession(rows[0]);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("sessions.get", error, this.logger, correlationId);
    }
  }

  async create(
    projectId: string,
    input: CreateSessionInput,
    correlationId?: string,
    requesterId?: string,
  ): Promise<ProjectSession> {
    const project: Project = await this.projects.getOrThrow(projectId, correlationId);
    await this.checkAccess(project.id, project.ownerId, requesterId, correlationId);
    if (input.chatId) {
      const chat: ProjectChat | null = await this.chats.getInProject(
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
      const rows: Array<ProjectSessionRow> = await this.client()
        .insert(projectSessions)
        .values({
          projectId,
          chatId: input.chatId ?? null,
          status: input.status ?? "open",
          metadata: (input.metadata ?? null) as Record<string, unknown> | null,
        })
        .returning();
      // Per-request success on a hot path → debug (not info); correlationId-bound.
      this.logger.debug(`[projects] session created`, correlationId);
      return toSession(rows[0]);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      )
        throw error;
      dbUnavailable("sessions.create", error, this.logger, correlationId);
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
      const rows: Array<ProjectSessionRow> = await this.client()
        .update(projectSessions)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(projectSessions.id, sessionId))
        .returning();
      if (rows.length === 0) {
        throw new NotFoundException(
          `Session ${sessionId} not found in project ${projectId}`,
        );
      }
      // Per-request success on a hot path → debug (not info); correlationId-bound.
      this.logger.debug(`[projects] session closed`, correlationId);
      return toSession(rows[0]);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      dbUnavailable("sessions.close", error, this.logger, correlationId);
    }
  }

  /** Cascade helper — soft-deletes the project's sessions (no physical DELETE). */
  async removeByProject(
    projectId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.client()
        .update(projectSessions)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            isNull(projectSessions.deletedAt),
          ),
        );
    } catch (error) {
      dbUnavailable(
        "sessions.removeByProject",
        error,
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
    } catch (error) {
      dbUnavailable("sessions.detachChat", error, this.logger, correlationId);
    }
  }

  /** True when the session row still references a chat (SET NULL check helper). */
  async hasChatReference(
    sessionId: string,
    correlationId?: string,
  ): Promise<boolean> {
    try {
      const rows: Array<ProjectSessionRow> = await this.client()
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.id, sessionId))
        .limit(1);
      return rows.length > 0 && rows[0].chatId !== null;
    } catch (error) {
      dbUnavailable(
        "sessions.hasChatReference",
        error,
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
