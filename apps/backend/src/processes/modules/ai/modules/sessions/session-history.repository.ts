import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DbService, dbUnavailable } from '../../../../../common/db/db.service';
import {
  projectSessions,
  sessionAgents,
  sessionMessages,
} from '../../../../../common/db/schema';
import { AppLogger } from '../../../../../common/logger';
import type { SessionInfo, SessionMessage } from './sessions.dto';

/**
 * Durable session history — the ONLY place the sessions domain touches
 * drizzle.
 *
 * Why a separate `session_messages` table instead of reusing
 * `project_sessions`: a project_sessions.id is a uuid, while chat messages
 * are addressed by the DOMAIN session id — upstream `ses_*` values are not
 * uuids. The message table therefore keys on a text session_id and carries
 * project_id for the C4 gate scope (a project can never read another
 * project's history). `project_sessions` stays the durable registry of
 * harness-created sessions (origin='harness'), so no parallel registry is
 * introduced. `session_agents` persists the per-session agent choice so a
 * backend restart no longer drops it.
 *
 * Every method maps Postgres failures through `dbUnavailable` (503
 * EXTERNAL_UNAVAILABLE, logged once with the caller cid) — there is no
 * silent fallback to process memory.
 */
@Injectable()
export class SessionHistoryRepository {
  constructor(
    private readonly db: DbService,
    private readonly logger: AppLogger = new AppLogger(SessionHistoryRepository.name),
  ) {}

  /** Appends one chat row; idempotent on the domain message id (upstream replay-safe). */
  async appendMessage(row: {
    id: string;
    sessionId: string;
    projectId: string;
    userId: string;
    role: 'user' | 'assistant';
    agentId?: string | null;
    text: string;
    createdAt?: string;
  }): Promise<void> {
    try {
      await this.db.client
        .insert(sessionMessages)
        .values({
          id: row.id,
          sessionId: row.sessionId,
          projectId: row.projectId,
          userId: row.userId,
          role: row.role,
          agentId: row.agentId ?? null,
          text: row.text,
          ...(row.createdAt !== undefined ? { createdAt: new Date(row.createdAt) } : {}),
        })
        .onConflictDoNothing({ target: sessionMessages.id });
    } catch (err) {
      dbUnavailable('sessionMessagesAppend', err, this.logger);
    }
  }

  /** Hides a staged row that never became a durable turn (soft delete). */
  async discardMessage(id: string): Promise<void> {
    try {
      await this.db.client
        .update(sessionMessages)
        .set({ deletedAt: new Date() })
        .where(eq(sessionMessages.id, id));
    } catch (err) {
      dbUnavailable('sessionMessagesDiscard', err, this.logger);
    }
  }

  /** Live messages of one session, oldest first (soft-deleted rows hidden). */
  async listMessages(sessionId: string): Promise<Array<SessionMessage>> {
    try {
      const rows = await this.db.client
        .select({
          id: sessionMessages.id,
          role: sessionMessages.role,
          createdAt: sessionMessages.createdAt,
          text: sessionMessages.text,
        })
        .from(sessionMessages)
        .where(
          and(eq(sessionMessages.sessionId, sessionId), isNull(sessionMessages.deletedAt)),
        )
        .orderBy(asc(sessionMessages.createdAt));
      return rows.map((row) => ({
        id: row.id,
        type: row.role,
        createdAt: row.createdAt.toISOString(),
        text: row.text,
      }));
    } catch (err) {
      dbUnavailable('sessionMessagesList', err, this.logger);
    }
  }

  /** Upserts the agent answering a session (create or explicit per-turn choice). */
  async setAgent(sessionId: string, projectId: string, agentId: string): Promise<void> {
    try {
      await this.db.client
        .insert(sessionAgents)
        .values({ sessionId, projectId, agentId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: sessionAgents.sessionId,
          set: { agentId, projectId, updatedAt: new Date() },
        });
    } catch (err) {
      dbUnavailable('sessionAgentsSet', err, this.logger);
    }
  }

  /** Stored agent for one session (undefined → caller applies its default). */
  async getAgent(sessionId: string): Promise<string | undefined> {
    try {
      const rows = await this.db.client
        .select({ agentId: sessionAgents.agentId })
        .from(sessionAgents)
        .where(eq(sessionAgents.sessionId, sessionId))
        .limit(1);
      return rows[0]?.agentId;
    } catch (err) {
      dbUnavailable('sessionAgentsGet', err, this.logger);
    }
  }

  /** Project-scoped session→agent map (one query for the session list). */
  async listAgents(projectId: string): Promise<Map<string, string>> {
    try {
      const rows = await this.db.client
        .select({ sessionId: sessionAgents.sessionId, agentId: sessionAgents.agentId })
        .from(sessionAgents)
        .where(eq(sessionAgents.projectId, projectId));
      return new Map(rows.map((row) => [row.sessionId, row.agentId]));
    } catch (err) {
      dbUnavailable('sessionAgentsList', err, this.logger);
    }
  }

  /**
   * Stores the embedded host session id on our durable row
   * (`metadata.opencodeSessionId`). `project_sessions.id` stays OUR uuid —
   * there is no separate column and no migration in this stage.
   */
  async setHostSessionId(sessionId: string, hostSessionId: string): Promise<void> {
    try {
      const rows = await this.db.client
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.id, sessionId))
        .limit(1);
      const current = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
      await this.db.client
        .update(projectSessions)
        .set({
          metadata: { ...current, opencodeSessionId: hostSessionId },
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.id, sessionId));
    } catch (err) {
      dbUnavailable('sessionsSetHostId', err, this.logger);
    }
  }

  /** Host session id bound to our uuid (undefined → no embedded-host binding). */
  async getHostSessionId(sessionId: string, projectId?: string): Promise<string | undefined> {
    try {
      const rows = await this.db.client
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(
          projectId === undefined
            ? and(eq(projectSessions.id, sessionId), isNull(projectSessions.deletedAt))
            : and(
                eq(projectSessions.id, sessionId),
                eq(projectSessions.projectId, projectId),
                isNull(projectSessions.deletedAt),
              ),
        )
        .limit(1);
      const meta = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
      return typeof meta.opencodeSessionId === 'string' && meta.opencodeSessionId.length > 0
        ? meta.opencodeSessionId
        : undefined;
    } catch (err) {
      dbUnavailable('sessionsGetHostId', err, this.logger);
    }
  }

  /**
   * Reverse lookup for the assistant recorder: host session id → our row.
   * Single-row lookup; metadata carries project scope and owner id set by
   * create (needed for durable assistant rows).
   */
  async findSessionByHostSessionId(
    hostSessionId: string,
  ): Promise<{ id: string; projectId: string; userId?: string } | undefined> {
    try {
      const rows = await this.db.client
        .select({
          id: projectSessions.id,
          projectId: projectSessions.projectId,
          metadata: projectSessions.metadata,
        })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.origin, 'harness'),
            isNull(projectSessions.deletedAt),
            sql`${projectSessions.metadata} ->> 'opencodeSessionId' = ${hostSessionId}`,
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        projectId: row.projectId,
        ...(typeof meta.userId === 'string' && meta.userId.length > 0
          ? { userId: meta.userId }
          : {}),
      };
    } catch (err) {
      dbUnavailable('sessionsFindByHostId', err, this.logger);
    }
  }

  /** Project-scoped reverse map: host session id → our durable uuid (SSE scope). */
  async listHostBindings(projectId: string): Promise<Map<string, string>> {
    try {
      const rows = await this.db.client
        .select({ id: projectSessions.id, metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.origin, 'harness'),
            isNull(projectSessions.deletedAt),
          ),
        );
      const map = new Map<string, string>();
      for (const row of rows) {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        if (typeof meta.opencodeSessionId === 'string' && meta.opencodeSessionId.length > 0) {
          map.set(meta.opencodeSessionId, row.id);
        }
      }
      return map;
    } catch (err) {
      dbUnavailable('sessionsListHostBindings', err, this.logger);
    }
  }

  /** Hides a row that never became usable (host create failed → honest 503). */
  async discardSession(sessionId: string): Promise<void> {
    try {
      await this.db.client
        .update(projectSessions)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectSessions.id, sessionId));
    } catch (err) {
      dbUnavailable('sessionsDiscard', err, this.logger);
    }
  }

  /** Registers a harness-created session (origin='harness') in the durable registry. */
  async saveLocalSession(info: SessionInfo, userId?: string): Promise<void> {
    try {
      await this.db.client
        .insert(projectSessions)
        .values({
          id: info.id,
          projectId: info.projectId,
          chatId: null,
          status: 'open',
          metadata: {
            title: info.title,
            directory: info.directory,
            model: info.model,
            status: info.status,
            // Owner identity for durable assistant rows (session_messages
            // .user_id is NOT NULL; the recorder never invents it).
            ...(userId !== undefined && userId.length > 0 ? { userId } : {}),
          },
          origin: 'harness',
        })
        .onConflictDoNothing({ target: projectSessions.id });
    } catch (err) {
      dbUnavailable('sessionsSaveLocal', err, this.logger);
    }
  }

  /** Harness-created sessions of a project, with their stored agent. */
  async listLocalSessions(projectId: string): Promise<Array<SessionInfo>> {
    try {
      const rows = await this.db.client
        .select({
          id: projectSessions.id,
          projectId: projectSessions.projectId,
          metadata: projectSessions.metadata,
          createdAt: projectSessions.createdAt,
          agentId: sessionAgents.agentId,
        })
        .from(projectSessions)
        // project_sessions.id is a uuid; session_agents.session_id is text
        // (upstream `ses_*` ids never fit a uuid column) — cast the uuid side.
        .leftJoin(sessionAgents, sql`${sessionAgents.sessionId} = ${projectSessions.id}::text`)
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.origin, 'harness'),
            isNull(projectSessions.deletedAt),
          ),
        )
        .orderBy(asc(projectSessions.createdAt));
      return rows.map((row) => this.toSessionInfo(row));
    } catch (err) {
      dbUnavailable('sessionsListLocal', err, this.logger);
    }
  }

  /** Distinct session ids of a project that own durable messages (SSE scope). */
  async listSessionIdsWithMessages(projectId: string): Promise<Array<string>> {
    try {
      const rows = await this.db.client
        .selectDistinct({ sessionId: sessionMessages.sessionId })
        .from(sessionMessages)
        .where(
          and(
            eq(sessionMessages.projectId, projectId),
            isNull(sessionMessages.deletedAt),
          ),
        );
      return rows.map((row) => row.sessionId);
    } catch (err) {
      dbUnavailable('sessionMessagesSessionIds', err, this.logger);
    }
  }

  /** Durable project_sessions row + metadata → domain SessionInfo. */
  private toSessionInfo(row: {
    id: string;
    projectId: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    agentId: string | null;
  }): SessionInfo {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      title: typeof meta.title === 'string' ? meta.title : null,
      createdAt: row.createdAt.toISOString(),
      directory: typeof meta.directory === 'string' ? meta.directory : '',
      projectId: row.projectId,
      model: (meta.model ?? null) as SessionInfo['model'],
      agentId: row.agentId ?? null,
      status: (meta.status ?? { type: 'idle' }) as SessionInfo['status'],
    };
  }
}
