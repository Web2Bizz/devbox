import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type {
  CreateSessionInput,
  InterruptSessionInput,
  RevertInfo,
  RevertStageRequest,
  SendMessageInput,
  SessionForkRequest,
  SessionForkResponse,
  SessionInfo,
  SessionInterruptResult,
  SessionMessage,
  SessionRunStatusMap,
  SessionRunnerProvider,
  SnapshotDiff,
} from './sessions.dto';

/**
 * SessionHarness — orchestrator of AI sessions behind /api/v1/sessions*.
 *
 * Card 1 (harness-core): the interface speaks ONLY the domain vocabulary
 * (SessionInfo / SessionMessage / SessionStreamFrame-shaped rows from
 * @rush-code/contracts) — no opencode wire shapes cross this boundary.
 * The default implementation (SessionHarnessService) rides the embedded
 * OpenCode V2 host (OpencodeHostService, in-process) while Postgres stays
 * the source of truth for lists/threads. Consumers (SessionsService) depend
 * on the interface, never on the transport.
 */
export interface SessionHarness {
  /** GET /api/v1/sessions?projectId — list scoped to the gated jail. */
  list(userId: string, projectId: string | undefined, cid: string): Promise<Array<SessionInfo>>;

  /** GET /api/v1/sessions/status?projectId — sessionId → derived runtime status. */
  statusMap(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<SessionRunStatusMap>;

  /** POST /api/v1/sessions — create in the gated jail. */
  create(userId: string, body: CreateSessionInput, cid: string): Promise<SessionInfo>;

  /** GET /api/v1/sessions/{id}/messages — normalized domain rows. */
  listMessages(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    limitRaw: string | undefined,
    cursor: string | undefined,
    cid: string,
  ): Promise<Array<SessionMessage>>;

  /** POST /api/v1/sessions/{id}/messages — queue the prompt, answer the receipt. */
  sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage>;

  /** POST /api/v1/sessions/{id}/interrupt — honest {interrupted} answer. */
  interrupt(
    userId: string,
    sessionId: string,
    body: InterruptSessionInput,
    cid: string,
  ): Promise<SessionInterruptResult>;

  /** GET /api/v1/sessions/providers — runner provider inventory (gated jail). */
  providers(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<SessionRunnerProvider>>;

  /** GET /api/v1/sessions/models — runner model inventory (Go/Zen family). */
  models(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<{ id: string; name: string; providerID: string }>>;

  /** GET /api/v1/sessions/events — SSE re-stream of domain frames (contract frozen). */
  streamEvents(
    userId: string,
    projectId: string | undefined,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void>;

  /** POST /api/v1/sessions/{id}/fork — copy the durable thread up to a boundary. */
  fork(
    userId: string,
    sessionId: string,
    body: SessionForkRequest,
    cid: string,
  ): Promise<SessionForkResponse>;

  /** POST /api/v1/sessions/{id}/revert/stage — restore + diff the boundary turn. */
  stageRevert(
    userId: string,
    sessionId: string,
    body: RevertStageRequest,
    cid: string,
  ): Promise<RevertInfo>;

  /** DELETE /api/v1/sessions/{id}/revert — discard the staged revert. */
  clearRevert(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<void>;

  /** POST /api/v1/sessions/{id}/revert/commit — keep the restored files. */
  commitRevert(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<void>;

  /** GET /api/v1/sessions/{id}/snapshots/diff?from&to — per-file diff rows. */
  snapshotDiff(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    from: string,
    to: string,
    contextRaw: string | undefined,
    cid: string,
  ): Promise<Array<SnapshotDiff>>;
}
