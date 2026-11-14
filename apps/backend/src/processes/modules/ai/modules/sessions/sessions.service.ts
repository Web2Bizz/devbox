import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { ProjectAccessService } from '../../../../../organizations/modules/projects/modules/project-access/project-access.service';
import {
  ExternalServiceError,
  fromUnknown,
} from '@common/external/external-error';
import { AppLogger } from '@common/logger';
import { AgentsService } from '../agents/agents.service';
import { OpencodeHostService, type HostSessionInfo } from '../opencode/opencode-host.service';
import { ServeAuthService } from '../opencode/modules/auth/serve-auth.service';
import type {
  CreateSessionInput,
  InterruptSessionInput,
  RevertInfo,
  RevertMessagesResult,
  RevertStageRequest,
  SendMessageInput,
  SessionApprovalInput,
  SessionCheckpointStatus,
  SessionForkRequest,
  SessionForkResponse,
  SessionInfo,
  SessionInterruptResult,
  SessionMessage,
  SessionMessageVariant,
  SessionRunStatusMap,
  SessionModel,
  SessionRunnerProvider,
  SnapshotDiff,
} from './sessions.dto';
import type { GatedProjectScope } from './sessions.types';
import { SessionHistoryRepository } from './session-history.repository';
import { SessionFrameBufferService } from './modules/events/session-frame-buffer.service';
import { SessionStreamService } from './modules/events/session-stream.service';
import { SessionInventoryService } from './modules/inventory/session-inventory.service';
import { SessionMessagingService } from './modules/messaging/session-messaging.service';
import { InProcessTurnService } from './modules/messaging/in-process-turn.service';
import { resolveTurnThreadId } from './modules/runner/runner.service';
import { SessionRuntimeStateService } from './modules/state/session-runtime-state.service';
import { TurnWorkspaceService } from './modules/workspace/turn-workspace.service';

/**
 * SessionsService — the sessions DOMAIN orchestrator behind /api/v1/sessions*.
 *
 * Owns only the domain decisions: the C4 gate + auth order, the durable
 * registry/thread (SessionHistoryRepository), and the frozen wire shapes.
 * Work is delegated to the domain zones:
 * - messaging (SessionMessagingService) — file commands / direct / host turns;
 * - streaming (SessionStreamService) — SSE re-stream of the host bus;
 * - inventory (SessionInventoryService) — provider/model projections;
 * - workspace (TurnWorkspaceService) — snapshots, staged revert, diffs;
 * - runtime state (SessionRuntimeStateService) + live frames
 *   (SessionFrameBufferService) — in-process only, never durable.
 *
 * No parsers, no buffers, no recorder, no git calls live here. Durable
 * Postgres history stays the source of truth for list/thread; the embedded
 * OpenCode host is reached only through the zones. Logs ride AppLogger
 * one-liners without URLs/secrets/stacks.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly access: ProjectAccessService,
    private readonly auth: ServeAuthService,
    private readonly history: SessionHistoryRepository,
    private readonly stream: SessionStreamService,
    private readonly messaging: SessionMessagingService,
    private readonly inventory: SessionInventoryService,
    private readonly workspace: TurnWorkspaceService,
    private readonly state: SessionRuntimeStateService,
    private readonly buffer: SessionFrameBufferService,
    @Optional() private readonly agents?: AgentsService,
    @Optional() private readonly inProcess?: InProcessTurnService,
    private readonly logger: AppLogger = new AppLogger(SessionsService.name),
  ) {}

  /** Same non-negative-integer query guard the mirror uses for ?limit. */
  private parseLimit(limitRaw?: string): number | undefined {
    if (limitRaw === undefined) return undefined;
    const limit: number = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new BadRequestException('Query "limit" must be a non-negative integer');
    }
    return limit;
  }

  /** Non-negative integer query guard for ?context (git -U). */
  private parseContext(contextRaw?: string): number | undefined {
    if (contextRaw === undefined) return undefined;
    const context: number = Number(contextRaw);
    if (!Number.isInteger(context) || context < 0 || context > 10) {
      throw new BadRequestException('Query "context" must be an integer between 0 and 10');
    }
    return context;
  }

  /** Validate a client-supplied agentId against the registry (honest 404). */
  private resolveAgentId(agentId: string | undefined, correlationId: string): string | undefined {
    if (agentId === undefined) return undefined;
    const known: boolean = this.agents?.list().some((agent) => agent.id === agentId) ?? false;
    if (!known) {
      this.logger.warn(`[sessions] unknown agent agentId=${agentId}`, correlationId);
      throw new NotFoundException(`Agent '${agentId}' not found`);
    }
    return agentId;
  }

  /** Drop a staged row without masking the original failure (best effort). */
  private async discardQuietly(sessionId: string, correlationId: string): Promise<void> {
    try {
      await this.history.discardSession(sessionId);
    } catch (error) {
      this.logger.warn('[sessions] rollback failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
    }
  }

  /** GET /api/v1/sessions?projectId — durable list scoped to the gated jail. */
  async list(
    userId: string,
    projectId: string | undefined,
    correlationId: string,
  ): Promise<Array<SessionInfo>> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    return this.history.listLocalSessions(project.projectId);
  }

  /** GET /api/v1/sessions/status?projectId — sessionId → runtime status. */
  async statusMap(
    userId: string,
    projectId: string | undefined,
    correlationId: string,
  ): Promise<SessionRunStatusMap> {
    const rows: Array<SessionInfo> = await this.list(userId, projectId, correlationId);
    const map: SessionRunStatusMap = {};
    for (const row of rows) {
      map[row.id] = this.state.isBusy(row.id) ? { type: 'busy' } : { type: 'idle' };
    }
    return map;
  }

  /**
   * POST /api/v1/sessions — durable row first (our uuid), then the embedded
   * host session; the host id is stored in `metadata.opencodeSessionId`.
   * A host failure soft-deletes the staged row and answers the typed 503.
   */
  async create(userId: string, body: CreateSessionInput, correlationId: string): Promise<SessionInfo> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      body.projectId,
      userId,
      correlationId,
    );
    // Fail fast on an unknown agent (honest 404, no side effects) before any
    // durable/host work; undefined keeps the pre-agent behavior (agentId null).
    const agentId: string | undefined = this.resolveAgentId(body.agentId, correlationId);
    const id: string = Bun.randomUUIDv7();
    const info: SessionInfo = {
      id,
      title: body.title ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      directory: project.directory,
      projectId: project.projectId,
      model: body.model ?? null,
      agentId: agentId ?? null,
      status: { type: 'idle' },
    };
    // Row first: the domain id exists before the host does, and list/status
    // never need an upstream round-trip.
    await this.history.saveLocalSession(info, userId);

    let created: HostSessionInfo;
    try {
      created = await this.host.sessionCreate({
        directory: project.directory,
        title: body.title,
        parentID: body.parentID,
        model: body.model,
        agent: agentId,
      });
    } catch (error) {
      // No half state: the row never becomes a visible session without a host
      // binding. The error keeps its honest mapping (4xx stays 4xx, outage 503).
      await this.discardQuietly(id, correlationId);
      if (error instanceof ExternalServiceError || error instanceof HttpException) {
        throw error;
      }
      throw fromUnknown('opencode', 'sessionsCreate', error);
    }

    // Bind before persisting so live SSE subscribers can resolve the host id.
    this.state.bindHostSession(created.id, {
      projectId: project.projectId,
      localSessionId: id,
      userId,
    });
    try {
      await this.history.setHostSessionId(id, created.id);
      if (agentId !== undefined) {
        await this.history.setAgent(id, project.projectId, agentId);
      }
    } catch (error) {
      // Postgres outage after the host session exists: drop both sides so a
      // retry does not leave an orphan host session or a phantom row.
      this.state.unbindHostSession(created.id);
      await this.host.sessionRemove(created.id).catch(() => undefined);
      await this.discardQuietly(id, correlationId);
      throw error;
    }

    this.logger.info('[sessions] created', correlationId);
    return {
      ...info,
      title:
        typeof created.title === 'string' && created.title.length > 0
          ? created.title
          : info.title,
    };
  }

  /**
   * GET /api/v1/sessions/{id}/messages — durable Postgres thread only.
   * `limit` keeps its validation contract (400 on garbage) but the durable
   * read has no cursor semantics; an unknown session is an honest empty array.
   * `leafId` narrows to the active chain root → leaf (branch siblings out);
   * unknown leaf answers 404 MessageNotFound.
   */
  async listMessages(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    limitRaw: string | undefined,
    _cursor: string | undefined,
    correlationId: string,
    leafId?: string,
  ): Promise<Array<SessionMessage>> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    this.parseLimit(limitRaw);
    if (leafId !== undefined && leafId.length > 0) {
      const chain: Array<SessionMessage> = await this.history.listActiveChain(
        sessionId,
        leafId,
        project.projectId,
      );
      if (chain.length === 0) {
        throw new NotFoundException({
          code: 'MessageNotFound',
          message: `Message '${leafId}' not found in session`,
        });
      }
      return chain;
    }
    return this.history.listMessages(sessionId, project.projectId);
  }

  /**
   * GET /api/v1/sessions/{id}/variants — branch children of one parent
   * ([{childId, createdAt, preview}], time-ordered for the branch switcher).
   * Null parentId lists the roots (normally one). Unknown parent answers 404.
   */
  async listVariants(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    parentId: string | null | undefined,
    correlationId: string,
  ): Promise<Array<SessionMessageVariant>> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    if (parentId !== null && parentId !== undefined) {
      const thread: Array<SessionMessage> = await this.history.listMessages(
        sessionId,
        project.projectId,
      );
      if (!thread.some((message) => message.id === parentId)) {
        throw new NotFoundException({
          code: 'MessageNotFound',
          message: `Message '${parentId}' not found in session`,
        });
      }
    }
    return this.history.listVariants(sessionId, parentId ?? null, project.projectId);
  }

  /**
   * POST /api/v1/sessions/{id}/messages/revert — durable tail revert from a
   * boundary (messages only, files untouched). Soft-deletes the boundary +
   * descendants; answers the new leaf (boundary parent, null for root).
   */
  async revertMessages(
    userId: string,
    sessionId: string,
    projectId: string,
    messageId: string,
    correlationId: string,
  ): Promise<RevertMessagesResult> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    const activeLeaf: string | null | undefined = await this.history.revertMessages(
      sessionId,
      messageId,
      project.projectId,
    );
    if (activeLeaf === undefined) {
      throw new NotFoundException({
        code: 'MessageNotFound',
        message: `Message '${messageId}' not found in session`,
      });
    }
    this.buffer.push('session.reverted', {
      sessionID: sessionId,
      messageID: messageId,
      ...(activeLeaf ? { parentId: activeLeaf, leafId: activeLeaf } : {}),
    });
    this.logger.info('[sessions] messages reverted', correlationId);
    return { activeLeaf };
  }

  /**
   * POST /api/v1/sessions/{id}/messages — one message turn. Gate order is
   * intentional: access first, then the serve-user gate, then the agent
   * registry, then the messaging zone (file command → auto host → direct).
   */
  async sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    correlationId: string,
  ): Promise<SessionMessage> {
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      body.projectId,
      userId,
      correlationId,
    );
    this.auth.assertServeUser(userId, correlationId);
    // Fail fast on an unknown agent (honest 404, no side effects) before any
    // transport work — both paths share this gate.
    const explicitAgentId: string | undefined = this.resolveAgentId(body.agentId, correlationId);
    return this.messaging.send(
      userId,
      sessionId,
      body,
      project.directory,
      explicitAgentId,
      correlationId,
    );
  }

  /** GET /api/v1/sessions/events — SSE re-stream (contract frozen). */
  async streamEvents(
    userId: string,
    projectId: string | undefined,
    correlationId: string,
    request: ExpressRequest,
    response: ExpressResponse,
  ): Promise<void> {
    return this.stream.streamEvents(userId, projectId, correlationId, request, response);
  }

  /**
   * POST /api/v1/sessions/{id}/interrupt — interrupt the bound host session.
   * A local direct turn is marked interrupted here (its late answer is
   * dropped); an idle direct session keeps the honest no-op answer.
   */
  async interrupt(
    userId: string,
    sessionId: string,
    body: InterruptSessionInput,
    correlationId: string,
  ): Promise<SessionInterruptResult> {
    this.auth.assertServeUser(userId, correlationId);
    await this.access.resolveProjectDirectory(body.projectId, userId, correlationId);
    // WEB-24 / E3 server-side cancel: arm the boundary flag + abort the turn
    // signal BEFORE clearing busy — the runner's next segment boundary reads
    // it as `cancelled` while the cleared marker drops the late answer.
    // Idle sessions arm nothing (no stale flag for the next turn).
    this.state.requestCancel(sessionId);
    const localInterrupted: boolean = this.state.clearBusy(sessionId);
    // Guarantee the hanging client sending flag clears even if the terminal
    // session.idle was lost.
    if (localInterrupted) this.buffer.pushIdle(sessionId);
    const hostSessionId: string | undefined = await this.history.getHostSessionId(
      sessionId,
      body.projectId,
    );
    if (!hostSessionId) {
      if (localInterrupted) return { interrupted: true };
      throw new NotFoundException({
        code: 'opencode_session_unbound',
        message: 'Session is not bound to the embedded OpenCode host',
      });
    }
    try {
      const answer: { interrupted: boolean } = await this.host.sessionInterrupt(hostSessionId);
      this.logger.info('[sessions] interrupted', correlationId);
      return { interrupted: answer.interrupted || localInterrupted };
    } catch (error) {
      this.logger.warn('[sessions] interrupt failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      const mapped: ExternalServiceError =
        error instanceof ExternalServiceError
          ? error
          : fromUnknown('opencode', 'sessionInterrupt', error);
      // Host does not know the session but we did interrupt a direct turn.
      if (localInterrupted && mapped.code === 'EXTERNAL_NOT_FOUND') {
        this.logger.info('[sessions] interrupted locally', correlationId);
        return { interrupted: true };
      }
      throw mapped;
    }
  }

  /**
   * POST /api/v1/sessions/{id}/approval — human decision for a turn parked
   * on `awaiting_approval` (WEB-17 / C3, DTO C1, gate C4).
   *
   * `reject` parks the turn on `paused` (durable checkpoint row + resolved
   * frame + idle, never a resume). `approve` consumes the parked row (a
   * `running` marker on the next segment) and resumes the SAME checkpoint
   * thread via the in-process turn wiring (B2 `CheckpointStore` over
   * `agent_checkpoints` + C2 `shouldInterrupt` segment-boundary hook the E3
   * server-side cancel flips (read here from the runtime cancel flag — a
   * resumed turn cancelled via interrupt closes `cancelled` on the next
   * boundary). A turn with no `awaiting_approval` row answers 409
   * ApprovalNotPending (honest, non-retryable, no Retry-After).
   */
  async approval(
    userId: string,
    sessionId: string,
    body: SessionApprovalInput,
    correlationId: string,
  ): Promise<{ status: SessionCheckpointStatus }> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      body.projectId,
      userId,
      correlationId,
    );
    const parked = await this.history.findLatestCheckpoint(sessionId);
    if (!parked || parked.status !== 'awaiting_approval') {
      throw new ConflictException({
        code: 'ApprovalNotPending',
        message: `Session '${sessionId}' has no turn awaiting approval`,
      });
    }
    const threadId: string =
      parked.threadId && parked.threadId.length > 0
        ? parked.threadId
        : resolveTurnThreadId({ sessionId, correlationId });
    if (body.decision === 'reject') {
      await this.history.saveCheckpoint({
        sessionId,
        threadId,
        segmentIndex: parked.segmentIndex + 1,
        stepsUsed: 0,
        totalSteps: parked.totalSteps,
        status: 'paused',
        pauseReason: body.reason ?? 'rejected',
        tokensUsed: parked.tokensUsed,
      });
      this.buffer.push('session.approval.resolved', {
        sessionID: sessionId,
        decision: 'reject',
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      this.buffer.pushIdle(sessionId);
      this.logger.info(`[sessions] approval rejected steps=${parked.totalSteps}`, correlationId);
      return { status: 'paused' };
    }
    await this.history.saveCheckpoint({
      sessionId,
      threadId,
      segmentIndex: parked.segmentIndex + 1,
      stepsUsed: 0,
      totalSteps: parked.totalSteps,
      status: 'running',
      pauseReason: body.reason ?? 'approved',
      tokensUsed: parked.tokensUsed,
    });
    this.buffer.push('session.approval.resolved', {
      sessionID: sessionId,
      decision: 'approve',
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    this.logger.info(
      `[sessions] approval resumed thread=${threadId} steps=${parked.totalSteps}`,
      correlationId,
    );
    const agentId: string = (await this.history.getAgent(sessionId)) ?? 'auto';
    const inProcess: InProcessTurnService | undefined = this.inProcess;
    if (!inProcess) throw new Error('InProcessTurnService is not wired');
    await inProcess.resume({
      userId,
      sessionId,
      directory: project.directory,
      projectId: project.projectId,
      agentId,
      threadId,
      correlationId,
      shouldInterrupt: (): boolean => this.state.isCancelled(sessionId),
    });
    return { status: 'running' };
  }

  /**
   * GET /api/v1/sessions/providers — the project's host provider inventory.
   * The domain row is the REQUIRED artifact subset
   * (Provider.Info: id/name/activation/package); settings/headers/body are
   * never projected. A row violating the required set fails loud.
   */
  async providers(
    userId: string,
    projectId: string | undefined,
    correlationId: string,
  ): Promise<Array<SessionRunnerProvider>> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    return this.inventory.providers(project.directory, correlationId);
  }

  /**
   * GET /api/v1/sessions/models — host model inventory filtered to the
   * OpenCode Go/Zen family (provider id opencode / opencode-go / opencode-zen).
   */
  async models(
    userId: string,
    projectId: string | undefined,
    correlationId: string,
  ): Promise<Array<SessionModel>> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    return this.inventory.models(project.directory, correlationId);
  }

  /**
   * POST /api/v1/sessions/{id}/fork — create a new session and copy the
   * durable thread up to the boundary. `before` excludes that message;
   * without it the whole thread is copied ('through' the newest message).
   * An empty thread answers 409 ForkEmpty, an absent boundary 404
   * MessageNotFound — both honest non-retryable answers.
   */
  async fork(
    userId: string,
    sessionId: string,
    body: SessionForkRequest,
    correlationId: string,
  ): Promise<SessionForkResponse> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      body.projectId,
      userId,
      correlationId,
    );
    const messages: Array<SessionMessage> = await this.history.listMessages(
      sessionId,
      project.projectId,
    );
    const last: SessionMessage | undefined = messages[messages.length - 1];
    if (!last) {
      throw new ConflictException({
        code: 'ForkEmpty',
        message: `Session '${sessionId}' has no messages to fork`,
      });
    }
    let copied: Array<SessionMessage>;
    let boundary: SessionForkResponse['boundary'];
    if (body.before !== undefined) {
      const index: number = messages.findIndex((message) => message.id === body.before);
      if (index < 0) {
        throw new NotFoundException({
          code: 'MessageNotFound',
          message: `Message '${body.before}' not found in session`,
        });
      }
      copied = messages.slice(0, index);
      boundary = { type: 'before', messageID: body.before };
    } else {
      copied = messages;
      boundary = { type: 'through', messageID: last.id };
    }
    const sessions: Array<SessionInfo> = await this.history.listLocalSessions(project.projectId);
    const source: SessionInfo | undefined = sessions.find((row) => row.id === sessionId);
    const agentId: string =
      (await this.history.getAgent(sessionId)) ?? source?.agentId ?? 'ask';
    const created: SessionInfo = await this.create(
      userId,
      {
        projectId: project.projectId,
        ...(source?.title ? { title: source.title } : {}),
        ...(source?.model ? { model: source.model } : {}),
        agentId,
      },
      correlationId,
    );
    // Preserve the linked-list thread: old domain id → new domain id, so
    // parent links survive the copy in chain order (listMessages is already
    // chain-ordered, so the walk below rebuilds the same shape).
    const idMap: Map<string, string> = new Map();
    for (const message of copied) {
      const nextId: string = Bun.randomUUIDv7();
      const parentDomain: string | null = message.parentId ?? null;
      const parentNext: string | null =
        parentDomain !== null ? (idMap.get(parentDomain) ?? null) : null;
      await this.history.appendMessage({
        id: nextId,
        sessionId: created.id,
        userId,
        role:
          message.type === 'assistant'
            ? 'assistant'
            : message.type === 'tool'
              ? 'tool'
              : message.type === 'reasoning'
                ? 'reasoning'
                : 'user',
        agentId,
        text: message.text ?? null,
        createdAt: message.createdAt,
        parentId: parentNext,
        ...(message.kind !== undefined ? { kind: message.kind } : {}),
        ...(message.name !== undefined ? { name: message.name } : {}),
        ...(message.status !== undefined ? { status: message.status } : {}),
        ...(message.detail !== undefined ? { detail: message.detail } : {}),
      });
      idMap.set(message.id, nextId);
    }
    this.buffer.push('session.forked', {
      sessionID: created.id,
      parentID: sessionId,
      boundary,
    });
    this.logger.info(`[sessions] forked messages=${copied.length}`, correlationId);
    return { session: created, boundary };
  }

  /** POST /api/v1/sessions/{id}/revert/stage — restore + diff the boundary turn. */
  async stageRevert(
    userId: string,
    sessionId: string,
    body: RevertStageRequest,
    correlationId: string,
  ): Promise<RevertInfo> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      body.projectId,
      userId,
      correlationId,
    );
    const info: RevertInfo = await this.workspace.stage(
      {
        sessionId,
        directory: project.directory,
        messageID: body.messageID,
        ...(body.files !== undefined ? { files: body.files } : {}),
        projectId: project.projectId,
      },
      correlationId,
    );
    this.buffer.push('revert.staged', {
      sessionID: sessionId,
      messageID: info.messageID,
      snapshot: info.snapshot,
      files: info.files,
    });
    this.logger.info(`[sessions] revert staged files=${info.files.length}`, correlationId);
    return info;
  }

  /** DELETE /api/v1/sessions/{id}/revert — discard the staged revert. */
  async clearRevert(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    correlationId: string,
  ): Promise<void> {
    this.auth.assertServeUser(userId, correlationId);
    await this.access.resolveProjectDirectory(projectId, userId, correlationId);
    await this.workspace.clear(sessionId, correlationId);
    this.buffer.push('revert.cleared', { sessionID: sessionId });
    this.logger.info('[sessions] revert cleared', correlationId);
  }

  /** POST /api/v1/sessions/{id}/revert/commit — keep the restored files. */
  async commitRevert(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    correlationId: string,
  ): Promise<void> {
    this.auth.assertServeUser(userId, correlationId);
    await this.access.resolveProjectDirectory(projectId, userId, correlationId);
    await this.workspace.commit(sessionId, correlationId);
    this.buffer.push('revert.committed', { sessionID: sessionId });
    this.logger.info('[sessions] revert committed', correlationId);
  }

  /** GET /api/v1/sessions/{id}/snapshots/diff?from&to — per-file diff rows. */
  async snapshotDiff(
    userId: string,
    _sessionId: string,
    projectId: string | undefined,
    from: string,
    to: string,
    contextRaw: string | undefined,
    correlationId: string,
  ): Promise<Array<SnapshotDiff>> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    const treeIdPattern: RegExp = /^[0-9a-f]{40}$/;
    if (!treeIdPattern.test(from) || !treeIdPattern.test(to)) {
      throw new BadRequestException('Query "from"/"to" must be snapshot tree ids');
    }
    const rows: Array<SnapshotDiff> = await this.workspace.diff(
      project.directory,
      from,
      to,
      this.parseContext(contextRaw),
      correlationId,
    );
    this.logger.info(`[sessions] snapshot diff files=${rows.length}`, correlationId);
    return rows;
  }
}
