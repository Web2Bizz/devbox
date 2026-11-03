import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type {
  CreateSessionInput,
  InterruptSessionInput,
  SendMessageInput,
  SessionInfo,
  SessionInterruptResult,
  SessionMessage,
  SessionRunStatusMap,
  SessionRunnerProvider,
} from './sessions.dto';

/**
 * SessionHarness — orchestrator of AI sessions behind /api/sessions*.
 *
 * Card 1 (harness-core): the interface speaks ONLY the domain vocabulary
 * (SessionInfo / SessionMessage / SessionStreamFrame-shaped rows from
 * @rush-code/contracts) — no opencode wire shapes cross this boundary.
 * The default implementation (SessionHarnessService) still rides the
 * opencode serve transport (:4096 via OpencodeService/OpencodeSdkClient);
 * card 2 plugs direct provider calls behind this same interface, card 3
 * owns the SSE token stream, card 4 the Postgres persistence, card 5 the
 * OPENCODE_URL cutover. Consumers (SessionsService) depend on the
 * interface, never on the transport.
 */
export interface SessionHarness {
  /** GET /api/sessions?projectId — list scoped to the gated jail. */
  list(userId: string, projectId: string | undefined, cid: string): Promise<Array<SessionInfo>>;

  /** GET /api/sessions/status?projectId — sessionId → derived runtime status. */
  statusMap(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<SessionRunStatusMap>;

  /** POST /api/sessions — create in the gated jail. */
  create(userId: string, body: CreateSessionInput, cid: string): Promise<SessionInfo>;

  /** GET /api/sessions/{id}/messages — normalized domain rows. */
  listMessages(
    userId: string,
    sessionId: string,
    projectId: string | undefined,
    limitRaw: string | undefined,
    cursor: string | undefined,
    cid: string,
  ): Promise<Array<SessionMessage>>;

  /** POST /api/sessions/{id}/messages — queue the prompt, answer the receipt. */
  sendMessage(
    userId: string,
    sessionId: string,
    body: SendMessageInput,
    cid: string,
  ): Promise<SessionMessage>;

  /** POST /api/sessions/{id}/interrupt — honest {interrupted} answer. */
  interrupt(
    userId: string,
    sessionId: string,
    body: InterruptSessionInput,
    cid: string,
  ): Promise<SessionInterruptResult>;

  /** GET /api/sessions/providers — runner provider inventory (gated jail). */
  providers(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<SessionRunnerProvider>>;

  /** GET /api/sessions/models — runner model inventory (Go/Zen family). */
  models(
    userId: string,
    projectId: string | undefined,
    cid: string,
  ): Promise<Array<{ id: string; name: string; providerID: string }>>;

  /** GET /api/sessions/events — SSE re-stream of domain frames (contract frozen). */
  streamEvents(
    userId: string,
    projectId: string | undefined,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void>;
}
