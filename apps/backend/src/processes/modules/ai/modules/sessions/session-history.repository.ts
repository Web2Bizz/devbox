import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DbService, dbUnavailable } from '@common/db/db.service';
import {
  projectSessions,
  sessionAgents,
  sessionMessages,
  agentCheckpoints,
} from '@common/db/schema';
import type { AgentCheckpointRow } from '@common/db/schema';
import { AppLogger } from '@common/logger';
import type { SessionInfo, SessionMessage } from './sessions.dto';

/** Durable registry row joined with the stored agent (list read shape). */
type SessionRegistryRow = {
  id: string;
  projectId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  agentId: string | null;
};

/** Selected metadata-only row (bindings / owner lookups). */
type SessionMetadataRow = { metadata: Record<string, unknown> | null };

/**
 * Durable session history — the ONLY place the sessions domain touches
 * drizzle.
 *
 * Durable chain (0012): this repository stores the FULL chat thread —
 * user/assistant text bubbles AND tool/reasoning chain links
 * (`session.tool.called/progress/tool input success/failed`,
 * `session.reasoning.*`).
 * Tool/reasoning rows are parentId chain links (kind=tool/reasoning,
 * name/status/detail hints), ordered by orderByParentChain and returned by
 * listMessages/listActiveChain. Reload refetches the same chain (REST) —
 * no live-only loss. Old clients ignore the additive keys.
 *
 * Chain (migration 0009, extended by 0010/0011/0012): projects 1:N project_sessions
 * 1:N session_messages. session_messages.session_id is the harness uuid FK
 * -> project_sessions.id (RESTRICT); session_agents.session_id is the same
 * uuid FK -> project_sessions.id (RESTRICT, 0010 — ses_* orphans dropped
 * before the cast). Project scope resolves via JOIN project_sessions —
 * messages carry NO project_id (the direct session_messages -> projects
 * link is gone, orphans dropped by the migration). 0011 adds the linked-list
 * thread: parent_id (parent domain id, root NULL, index
 * (session_id, parent_id)); 0012 adds kind/name/status/detail + text
 * nullable/default '' (tool rows carry no bubble). listMessages walks the
 * chain with a createdAt fallback, appendMessage parents new rows at the tail.
 *
 * Every method maps Postgres failures through `dbUnavailable` (503
 * EXTERNAL_UNAVAILABLE, logged once with the caller correlationId) — there is no
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
    userId: string;
    role: 'user' | 'assistant' | 'tool' | 'reasoning';
    agentId?: string | null;
    text?: string | null;
    createdAt?: string;
    /** Parent domain id; NULL = root. Undefined = resolve to the session tail. */
    parentId?: string | null;
    /** Additive chain kind (unified ChatEntry) — absent reads as text. */
    kind?: 'text' | 'tool' | 'reasoning' | null;
    /** Additive tool/reasoning name (registry tool id). */
    name?: string | null;
    /** Additive lifecycle status (called/progress/done/failed, started/delta/ended). */
    status?: string | null;
    /** Additive single-line detail (never secrets). */
    detail?: string | null;
  }): Promise<void> {
    try {
      let parentId: string | null | undefined = row.parentId;
      if (parentId === undefined) {
        parentId = await this.findTailId(row.sessionId);
      }
      await this.db.client
        .insert(sessionMessages)
        .values({
          domainId: row.id,
          sessionId: row.sessionId,
          userId: row.userId,
          role: row.role,
          agentId: row.agentId ?? null,
          text: row.text ?? null,
          ...(parentId !== null && parentId !== undefined ? { parentId } : {}),
          ...(row.kind !== undefined && row.kind !== null ? { kind: row.kind } : {}),
          ...(row.name !== undefined && row.name !== null ? { name: row.name } : {}),
          ...(row.status !== undefined && row.status !== null ? { status: row.status } : {}),
          ...(row.detail !== undefined && row.detail !== null ? { detail: row.detail } : {}),
          ...(row.createdAt !== undefined ? { createdAt: new Date(row.createdAt) } : {}),
        })
        .onConflictDoNothing({ target: sessionMessages.domainId });
      // Bump "last activity" on the owning registry row. session_id is now a
      // uuid FK -> project_sessions.id (RESTRICT), so every appended row has a
      // parent — no ses_* no-op branch anymore (orphans were dropped by 0009).
      await this.db.client
        .update(projectSessions)
        .set({ updatedAt: new Date() })
        .where(eq(projectSessions.id, row.sessionId));
    } catch (error) {
      dbUnavailable('sessionMessagesAppend', error, this.logger);
    }
  }

  /** Hides a staged row that never became a durable turn (soft delete). */
  async discardMessage(id: string): Promise<void> {
    try {
      await this.db.client
        .update(sessionMessages)
        .set({ deletedAt: new Date() })
        .where(eq(sessionMessages.domainId, id));
    } catch (error) {
      dbUnavailable('sessionMessagesDiscard', error, this.logger);
    }
  }

  /** Live messages of one session, chain order (branches allowed, see orderByParentChain). */
  async listMessages(sessionId: string, projectId?: string): Promise<Array<SessionMessage>> {
    const rows: Array<RawHistoryRow> = await this.fetchRows(sessionId, projectId);
    const ordered: Array<RawHistoryRow> = orderByParentChain(rows);
    return ordered.map(toSessionMessage);
  }

  /**
   * Active chain root → leafId by walking parent links backwards (branches
   * allowed: only the ancestors of the leaf answer, siblings stay out).
   * Empty array when the leaf is unknown (the service maps it to 404).
   */
  async listActiveChain(
    sessionId: string,
    leafId: string,
    projectId?: string,
  ): Promise<Array<SessionMessage>> {
    try {
      const rows: Array<RawHistoryRow> = await this.fetchRows(sessionId, projectId);
      const byId: Map<string, RawHistoryRow> = new Map(rows.map((row) => [row.id, row]));
      const leaf: RawHistoryRow | undefined = byId.get(leafId);
      if (!leaf) return [];
      const chain: Array<RawHistoryRow> = [];
      const seen: Set<string> = new Set();
      let current: RawHistoryRow | undefined = leaf;
      while (current && !seen.has(current.id)) {
        chain.push(current);
        seen.add(current.id);
        const parent: string | null | undefined = current.parentId;
        current = parent === null || parent === undefined ? undefined : byId.get(parent);
      }
      chain.reverse();
      return chain.map(toSessionMessage);
    } catch (error) {
      dbUnavailable('sessionMessagesActiveChain', error, this.logger);
    }
  }

  /**
   * Branch children of one parent: [{childId, createdAt, preview}].
   * Empty parentId (null) lists the roots (normally one). Ordered by
   * (createdAt ASC, id ASC) — the branch switcher order.
   */
  async listVariants(
    sessionId: string,
    parentId: string | null,
    projectId?: string,
  ): Promise<Array<{ childId: string; createdAt: string; preview: string }>> {
    try {
      const rows: Array<RawHistoryRow> = await this.fetchRows(sessionId, projectId);
      return rows
        .filter((row) => (row.parentId ?? null) === parentId)
        .sort((a, b) => {
          const at: number = a.createdAt.getTime() - b.createdAt.getTime();
          if (at !== 0) return at;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((row) => ({
          childId: row.id,
          createdAt: row.createdAt.toISOString(),
          preview: toPreview(row.text),
        }));
    } catch (error) {
      dbUnavailable('sessionMessagesVariants', error, this.logger);
    }
  }

  /**
   * Durable tail revert from one boundary (messages only, files untouched —
   * the staged file revert lives in TurnWorkspaceService and is never
   * touched here). Soft-deletes the boundary + all its descendants (forward
   * reachable via parent links, every branch below the point). Answers the
   * new leaf: the boundary parent (null when the root was reverted).
   * Null when the boundary is unknown (the service maps it to 404).
   */
  async revertMessages(
    sessionId: string,
    messageId: string,
    projectId?: string,
  ): Promise<string | null | undefined> {
    try {
      const rows: Array<RawHistoryRow> = await this.fetchRows(sessionId, projectId);
      const byId: Map<string, RawHistoryRow> = new Map(rows.map((row) => [row.id, row]));
      const boundary: RawHistoryRow | undefined = byId.get(messageId);
      if (!boundary) return undefined;
      const children: Map<string, Array<string>> = new Map();
      for (const row of rows) {
        if (row.parentId === null || row.parentId === undefined) continue;
        const list: Array<string> = children.get(row.parentId) ?? [];
        list.push(row.id);
        children.set(row.parentId, list);
      }
      const doomed: Array<string> = [];
      const stack: Array<string> = [messageId];
      const seen: Set<string> = new Set();
      while (stack.length > 0) {
        const next: string = stack.pop() as string;
        if (seen.has(next)) continue;
        seen.add(next);
        doomed.push(next);
        for (const child of children.get(next) ?? []) stack.push(child);
      }
      await this.db.client
        .update(sessionMessages)
        .set({ deletedAt: new Date() })
        .where(
          and(eq(sessionMessages.sessionId, sessionId), inArray(sessionMessages.domainId, doomed)),
        );
      return boundary.parentId ?? null;
    } catch (error) {
      dbUnavailable('sessionMessagesRevert', error, this.logger);
    }
  }

  /** Raw live rows of one session (project-scoped when projectId travels). */
  private async fetchRows(sessionId: string, projectId?: string): Promise<Array<RawHistoryRow>> {
    const base = this.db.client
      .select({
        id: sessionMessages.domainId,
        role: sessionMessages.role,
        createdAt: sessionMessages.createdAt,
        text: sessionMessages.text,
        parentId: sessionMessages.parentId,
        kind: sessionMessages.kind,
        name: sessionMessages.name,
        status: sessionMessages.status,
        detail: sessionMessages.detail,
      })
      .from(sessionMessages);
    if (projectId === undefined) {
      return base
        .where(and(eq(sessionMessages.sessionId, sessionId), isNull(sessionMessages.deletedAt)))
        .orderBy(asc(sessionMessages.createdAt));
    }
    return base
      .innerJoin(projectSessions, eq(projectSessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          eq(projectSessions.projectId, projectId),
          isNull(sessionMessages.deletedAt),
          isNull(projectSessions.deletedAt),
        ),
      )
      .orderBy(asc(sessionMessages.createdAt));
  }

  /**
   * Tail of the durable chain (newest live row by createdAt) — the LINEAR
   * default parent for the next append (single-root thread, no branch cursor).
   * Branched appends must pass the active-leaf tip explicitly
   * (`body.parentId`, the branch tip the client renders) and never rely on
   * this clock tip: on a fork the newest row by time is a sibling, not the
   * active tip. NULL when the session has no messages yet.
   */
  async findTailId(sessionId: string): Promise<string | null> {
    try {
      const rows: Array<{ domainId: string }> = await this.db.client
        .select({ domainId: sessionMessages.domainId })
        .from(sessionMessages)
        .where(and(eq(sessionMessages.sessionId, sessionId), isNull(sessionMessages.deletedAt)))
        .orderBy(desc(sessionMessages.createdAt))
        .limit(1);
      const tail: unknown = (rows[0] as Record<string, unknown> | undefined)?.domainId ??
        (rows[0] as Record<string, unknown> | undefined)?.id;
      return typeof tail === 'string' ? tail : null;
    } catch (error) {
      dbUnavailable('sessionMessagesTail', error, this.logger);
    }
  }

  /**
   * Tip for one append: explicit branch parent wins (activeLeaf tip the
   * client already renders, null = explicit root); only an omitted parent
   * (undefined) falls back to the linear clock tail above. Keeps
   * `null ?? tail` from resurrecting a deleted sibling as the parent.
   */
  async resolveAppendParent(sessionId: string, parentId: string | null | undefined): Promise<string | null> {
    if (parentId !== undefined) return parentId;
    return this.findTailId(sessionId);
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
    } catch (error) {
      dbUnavailable('sessionAgentsSet', error, this.logger);
    }
  }

  /** Stored agent for one session (undefined → caller applies its default). */
  async getAgent(sessionId: string): Promise<string | undefined> {
    try {
      const rows: Array<{ agentId: string }> = await this.db.client
        .select({ agentId: sessionAgents.agentId })
        .from(sessionAgents)
        .where(eq(sessionAgents.sessionId, sessionId))
        .limit(1);
      return rows[0]?.agentId;
    } catch (error) {
      dbUnavailable('sessionAgentsGet', error, this.logger);
    }
  }

  /** Project-scoped session→agent map (one query for the session list). */
  async listAgents(projectId: string): Promise<Map<string, string>> {
    try {
      const rows: Array<{ sessionId: string; agentId: string }> = await this.db.client
        .select({ sessionId: sessionAgents.sessionId, agentId: sessionAgents.agentId })
        .from(sessionAgents)
        .where(eq(sessionAgents.projectId, projectId));
      return new Map(rows.map((row) => [row.sessionId, row.agentId]));
    } catch (error) {
      dbUnavailable('sessionAgentsList', error, this.logger);
    }
  }

  /**
   * Stores the embedded host session id on our durable row
   * (`metadata.opencodeSessionId`). `project_sessions.id` stays OUR uuid —
   * there is no separate column and no migration in this stage.
   */
  async setHostSessionId(sessionId: string, hostSessionId: string): Promise<void> {
    try {
      const rows: Array<SessionMetadataRow> = await this.db.client
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.id, sessionId))
        .limit(1);
      const current: Record<string, unknown> = (rows[0]?.metadata ?? {}) as Record<
        string,
        unknown
      >;
      await this.db.client
        .update(projectSessions)
        .set({
          metadata: { ...current, opencodeSessionId: hostSessionId },
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.id, sessionId));
    } catch (error) {
      dbUnavailable('sessionsSetHostId', error, this.logger);
    }
  }

  /** Host session id bound to our uuid (undefined → no embedded-host binding). */
  async getHostSessionId(sessionId: string, projectId?: string): Promise<string | undefined> {
    try {
      const rows: Array<SessionMetadataRow> = await this.db.client
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
      const metadata: Record<string, unknown> = (rows[0]?.metadata ?? {}) as Record<
        string,
        unknown
      >;
      return typeof metadata.opencodeSessionId === 'string' &&
        metadata.opencodeSessionId.length > 0
        ? metadata.opencodeSessionId
        : undefined;
    } catch (error) {
      dbUnavailable('sessionsGetHostId', error, this.logger);
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
      const rows: Array<{ id: string; projectId: string } & SessionMetadataRow> =
        await this.db.client
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
      const row: { id: string; projectId: string } & SessionMetadataRow | undefined = rows[0];
      if (!row) return undefined;
      const metadata: Record<string, unknown> = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        projectId: row.projectId,
        ...(typeof metadata.userId === 'string' && metadata.userId.length > 0
          ? { userId: metadata.userId }
          : {}),
      };
    } catch (error) {
      dbUnavailable('sessionsFindByHostId', error, this.logger);
    }
  }

  /** Project-scoped reverse map: host session id → our durable uuid (SSE scope). */
  async listHostBindings(projectId: string): Promise<Map<string, string>> {
    try {
      const rows: Array<{ id: string } & SessionMetadataRow> = await this.db.client
        .select({ id: projectSessions.id, metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.origin, 'harness'),
            isNull(projectSessions.deletedAt),
          ),
        );
      const bindings: Map<string, string> = new Map<string, string>();
      for (const row of rows) {
        const metadata: Record<string, unknown> = (row.metadata ?? {}) as Record<string, unknown>;
        if (
          typeof metadata.opencodeSessionId === 'string' &&
          metadata.opencodeSessionId.length > 0
        ) {
          bindings.set(metadata.opencodeSessionId, row.id);
        }
      }
      return bindings;
    } catch (error) {
      dbUnavailable('sessionsListHostBindings', error, this.logger);
    }
  }

  /** Hides a row that never became usable (host create failed → honest 503). */
  async discardSession(sessionId: string): Promise<void> {
    try {
      await this.db.client
        .update(projectSessions)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectSessions.id, sessionId));
    } catch (error) {
      dbUnavailable('sessionsDiscard', error, this.logger);
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
    } catch (error) {
      dbUnavailable('sessionsSaveLocal', error, this.logger);
    }
  }

  /** Harness-created sessions of a project, with their stored agent. */
  async listLocalSessions(projectId: string): Promise<Array<SessionInfo>> {
    try {
      const rows: Array<SessionRegistryRow> = await this.db.client
        .select({
          id: projectSessions.id,
          projectId: projectSessions.projectId,
          metadata: projectSessions.metadata,
          createdAt: projectSessions.createdAt,
          updatedAt: projectSessions.updatedAt,
          agentId: sessionAgents.agentId,
        })
        .from(projectSessions)
        // 0010: session_agents.session_id is a uuid FK -> project_sessions.id
        // (RESTRICT) — direct uuid JOIN, no ::text cast.
        .leftJoin(sessionAgents, eq(sessionAgents.sessionId, projectSessions.id))
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.origin, 'harness'),
            isNull(projectSessions.deletedAt),
          ),
        )
        .orderBy(desc(projectSessions.updatedAt), desc(projectSessions.createdAt));
      return rows.map((row) => this.toSessionInfo(row));
    } catch (error) {
      dbUnavailable('sessionsListLocal', error, this.logger);
    }
  }

  /** Distinct session ids of a project that own durable messages (SSE scope). */
  async listSessionIdsWithMessages(projectId: string): Promise<Array<string>> {
    try {
      const rows: Array<{ sessionId: string }> = await this.db.client
        .selectDistinct({ sessionId: sessionMessages.sessionId })
        .from(sessionMessages)
        .innerJoin(projectSessions, eq(projectSessions.id, sessionMessages.sessionId))
        .where(
          and(
            eq(projectSessions.projectId, projectId),
            isNull(sessionMessages.deletedAt),
            isNull(projectSessions.deletedAt),
          ),
        );
      return rows.map((row) => row.sessionId);
    } catch (error) {
      dbUnavailable('sessionMessagesSessionIds', error, this.logger);
    }
  }

  /**
   * Durable checkpoint write (WEB-13 / B2 seam): one row per
   * (session_id, segment_index), upserted — the runner (B2/C2) calls this
   * BETWEEN segments, never mid-segment. Status mirrors the contract
   * `SessionCheckpointStatus` (plain text, no CHECK — the contract owns it).
   */
  async saveCheckpoint(row: {
    sessionId: string;
    threadId: string;
    segmentIndex: number;
    stepsUsed: number;
    totalSteps: number;
    status: string;
    pauseReason?: string | null;
    state?: Record<string, unknown> | null;
    tokensUsed: number;
  }): Promise<void> {
    try {
      await this.db.client
        .insert(agentCheckpoints)
        .values({
          sessionId: row.sessionId,
          threadId: row.threadId,
          segmentIndex: row.segmentIndex,
          stepsUsed: row.stepsUsed,
          totalSteps: row.totalSteps,
          status: row.status,
          ...(row.pauseReason !== undefined && row.pauseReason !== null
            ? { pauseReason: row.pauseReason }
            : {}),
          ...(row.state !== undefined && row.state !== null ? { state: row.state } : {}),
          tokensUsed: row.tokensUsed,
        })
        .onConflictDoUpdate({
          target: [agentCheckpoints.sessionId, agentCheckpoints.segmentIndex],
          set: {
            threadId: row.threadId,
            stepsUsed: row.stepsUsed,
            totalSteps: row.totalSteps,
            status: row.status,
            ...(row.pauseReason !== undefined && row.pauseReason !== null
              ? { pauseReason: row.pauseReason }
              : { pauseReason: null }),
            ...(row.state !== undefined && row.state !== null ? { state: row.state } : {}),
            tokensUsed: row.tokensUsed,
          },
        });
    } catch (error) {
      dbUnavailable('sessionCheckpointsSave', error, this.logger);
    }
  }

  /**
   * Latest durable checkpoint of one session (segmentIndex DESC) — the
   * approval resume (WEB-17 / C3) reads the parked `awaiting_approval` row
   * and resumes with the SAME thread_id. Undefined when the session never
   * checkpointed.
   */
  async findLatestCheckpoint(
    sessionId: string,
  ): Promise<
    | {
        sessionId: string;
        threadId: string | null;
        segmentIndex: number;
        stepsUsed: number;
        totalSteps: number;
        status: string;
        pauseReason: string | null;
        tokensUsed: number;
      }
    | undefined
  > {
    try {
      const rows: Array<AgentCheckpointRow> = await this.db.client
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.sessionId, sessionId))
        .orderBy(desc(agentCheckpoints.segmentIndex))
        .limit(1);
      const row: AgentCheckpointRow | undefined = rows[0];
      if (!row) return undefined;
      return {
        sessionId: row.sessionId,
        threadId: row.threadId,
        segmentIndex: row.segmentIndex,
        stepsUsed: row.stepsUsed,
        totalSteps: row.totalSteps,
        status: row.status,
        pauseReason: row.pauseReason,
        tokensUsed: row.tokensUsed,
      };
    } catch (error) {
      dbUnavailable('sessionCheckpointsLatest', error, this.logger);
    }
  }

  /**
   * Every checkpoint row still `running` (a previous process died mid-turn)
   * — the boot pause (WEB-22 / E1) re-saves each as `paused`/`restart`.
   * Ordered by session for deterministic boot logs.
   */
  async listRunningCheckpoints(): Promise<
    Array<{
      sessionId: string;
      threadId: string | null;
      segmentIndex: number;
      stepsUsed: number;
      totalSteps: number;
      tokensUsed: number;
    }>
  > {
    try {
      const rows: Array<AgentCheckpointRow> = await this.db.client
        .select()
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.status, 'running'))
        .orderBy(asc(agentCheckpoints.sessionId));
      return rows.map((row) => ({
        sessionId: row.sessionId,
        threadId: row.threadId,
        segmentIndex: row.segmentIndex,
        stepsUsed: row.stepsUsed,
        totalSteps: row.totalSteps,
        tokensUsed: row.tokensUsed,
      }));
    } catch (error) {
      dbUnavailable('sessionCheckpointsRunning', error, this.logger);
    }
  }

  /** Durable project_sessions row + metadata → domain SessionInfo. */
  private toSessionInfo(row: SessionRegistryRow): SessionInfo {
    const metadata: Record<string, unknown> = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      title: typeof metadata.title === 'string' ? metadata.title : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      directory: typeof metadata.directory === 'string' ? metadata.directory : '',
      projectId: row.projectId,
      model: (metadata.model ?? null) as SessionInfo['model'],
      agentId: row.agentId ?? null,
      status: (metadata.status ?? { type: 'idle' }) as SessionInfo['status'],
    };
  }
}

/** Chain row for the parentId validator (message-only links). */
type ChainRow = {
  id: string;
  parentId: string | null | undefined;
  createdAt: Date;
};

/** Raw durable row shape shared by listMessages/listActiveChain/listVariants. */
type RawHistoryRow = {
  id: string;
  role: string;
  createdAt: Date;
  text: string | null;
  parentId: string | null | undefined;
  kind?: string | null;
  name?: string | null;
  status?: string | null;
  detail?: string | null;
};

function toSessionMessage(row: RawHistoryRow): SessionMessage {
  const kind: SessionMessage['kind'] =
    row.kind === 'tool' || row.kind === 'reasoning' ? row.kind : row.text !== null ? 'text' : undefined;
  return {
    id: row.id,
    type: row.role,
    createdAt: row.createdAt.toISOString(),
    text: row.text,
    parentId: row.parentId ?? null,
    ...(kind !== undefined ? { kind } : {}),
    ...(typeof row.name === 'string' && row.name.length > 0 ? { name: row.name } : {}),
    ...(typeof row.status === 'string' && row.status.length > 0 ? { status: row.status } : {}),
    ...(typeof row.detail === 'string' && row.detail.length > 0 ? { detail: row.detail } : {}),
  };
}

function toPreview(text: string | null): string {
  if (text === null) return '';
  const single: string = text.replace(/\s+/g, ' ').trim();
  return single.length > 120 ? `${single.slice(0, 117)}…` : single;
}

/**
 * Orders durable rows by the parentId chain (root → tail). Branches allowed:
 * 1 parent → N children (the branch switcher lists them via listVariants).
 * Children visit in (createdAt ASC, id ASC) order (depth-first pre-order),
 * so the default thread is deterministic without dropping rows.
 *
 * Tool/reasoning decision (0012): tool/reasoning rows ARE durable chain
 * links (kind=tool/reasoning, parentId=tip/receipt), so the chain links
 * message AND tool rows in one order. Zero/multiple roots, dangling parents
 * and cycles still fall back to (createdAt ASC, id ASC). No throw: the API
 * always answers an array.
 */
export function orderByParentChain<T extends ChainRow>(rows: Array<T>): Array<T> {
  if (rows.length <= 1) return [...rows];
  const byId: Map<string, T> = new Map(rows.map((row) => [row.id, row]));
  const children: Map<string, Array<T>> = new Map();
  for (const row of rows) {
    if (row.parentId === null || row.parentId === undefined) continue;
    if (!byId.has(row.parentId)) return fallbackOrder(rows);
    const list: Array<T> = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  const roots: Array<T> = rows.filter(
    (row) => row.parentId === null || row.parentId === undefined,
  );
  if (roots.length !== 1) return fallbackOrder(rows);
  for (const list of children.values()) {
    list.sort((a, b) => {
      const at: number = a.createdAt.getTime() - b.createdAt.getTime();
      if (at !== 0) return at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  const ordered: Array<T> = [];
  const seen: Set<string> = new Set();
  const stack: Array<T> = [roots[0] as T];
  while (stack.length > 0) {
    const current: T = stack.pop() as T;
    if (seen.has(current.id)) return fallbackOrder(rows);
    seen.add(current.id);
    ordered.push(current);
    const next: Array<T> = children.get(current.id) ?? [];
    for (let index: number = next.length - 1; index >= 0; index -= 1) {
      stack.push(next[index] as T);
    }
  }
  if (ordered.length !== rows.length) return fallbackOrder(rows);
  return ordered;
}

function fallbackOrder<T extends ChainRow>(rows: Array<T>): Array<T> {
  return [...rows].sort((a, b) => {
    const at: number = a.createdAt.getTime() - b.createdAt.getTime();
    if (at !== 0) return at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
