import { Injectable } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { ProjectAccessService } from '../../../../../../../organizations/modules/projects/modules/project-access/project-access.service';
import { AppLogger } from '@common/logger';
import { relaySse, type SseSubscription } from '@common/sse/sse-relay';
import {
  ExternalServiceError,
  fromUnknown,
} from '@common/external/external-error';
import { OpencodeHostService } from '../../../opencode/opencode-host.service';
import { ServeAuthService } from '../../../opencode/modules/auth/serve-auth.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { BufferedFrame, GatedProjectScope, HostBinding } from '../../sessions.types';
import { AssistantRecorderService } from '../recorder/assistant-recorder.service';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';
import { SessionFrameBufferService } from './session-frame-buffer.service';

/**
 * SessionStreamService — SSE re-stream of the embedded host event bus, MERGED
 * with the sessions-owned direct-runner buffer.
 *
 * The C4 gate decides WHO may stream; the bus is process-global, so frames
 * are filtered to sessions of the gated project (our uuids). Durable vs live
 * (explicit): the durable thread (Postgres `session_messages`, text only)
 * survives reload via REST history; reasoning (`session.reasoning.*`) and tool
 * lifecycle (`session.tool.*`) are live-only SSE detail — project-scoped like
 * text, replayed only from the bounded frame buffer when present there,
 * otherwise live from the host bus and gone after redial. The resume cursor
 * covers buffered frame ids; host live frames carry their own ids forward.
 *
 * The stream ends on downstream close (relaySse aborts the signal), on the
 * idle timeout (no busy direct turn AND no new local/host frame), or on the
 * overall STREAM_CAP_MS. Full text content remains available via history.
 */
@Injectable()
export class SessionStreamService {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly access: ProjectAccessService,
    private readonly auth: ServeAuthService,
    private readonly history: SessionHistoryRepository,
    private readonly state: SessionRuntimeStateService,
    private readonly buffer: SessionFrameBufferService,
    private readonly recorder: AssistantRecorderService,
    private readonly logger: AppLogger = new AppLogger(SessionStreamService.name),
  ) {}

  /**
   * Translate one host/domain event into our SSE frame:
   * {id, type, data} passthrough with the host session id re-keyed to OUR
   * session uuid via `resolve`; `session` is hoisted from data.sessionID.
   * Upstream top-level extras are dropped; data stays variant-owned.
   *
   * Reasoning (`session.reasoning.*`) and tool lifecycle (`session.tool.*`)
   * pass through untouched (no truncation, no persist): the project-scoped
   * `filterFrame` below admits them like text frames, so the chat sees every
   * step without loss. Durable history stays text-only (see recordHostEvent).
   */
  private toStreamFrame(
    value: unknown,
    resolve: (sessionId: string) => string | undefined,
  ): Record<string, unknown> {
    const frame: { id?: unknown; type?: unknown; data?: unknown } | null = value as {
      id?: unknown;
      type?: unknown;
      data?: unknown;
    } | null;
    const data: Record<string, unknown> =
      frame && typeof frame.data === 'object' && frame.data !== null
        ? { ...(frame.data as Record<string, unknown>) }
        : {};
    const rawSession: string | undefined =
      typeof data.sessionID === 'string' ? (data.sessionID as string) : undefined;
    const localSession: string | undefined = rawSession ? resolve(rawSession) : undefined;
    if (localSession) data.sessionID = localSession;
    const output: Record<string, unknown> = { id: frame?.id, type: frame?.type, data };
    if (localSession) output.session = localSession;
    return output;
  }

  /** GET /api/v1/sessions/events — SSE re-stream (host bus + local buffer). */
  async streamEvents(
    userId: string,
    projectId: string | undefined,
    correlationId: string,
    request: ExpressRequest,
    response: ExpressResponse,
  ): Promise<void> {
    this.auth.assertServeUser(userId, correlationId);
    const project: GatedProjectScope = await this.access.resolveProjectDirectory(
      projectId,
      userId,
      correlationId,
    );
    const localSessionIds: Set<string> = new Set<string>();
    for (const session of await this.history.listLocalSessions(project.projectId)) {
      localSessionIds.add(session.id);
    }
    for (const sessionId of await this.history.listSessionIdsWithMessages(project.projectId)) {
      localSessionIds.add(sessionId);
    }
    // C2: optional `?session=` narrows the subscription to one session.
    // Unknown/foreign session → quiet empty stream (heartbeat flows, no
    // frames), never 404 — the C4 gate must not leak existence.
    const querySession: string | undefined =
      typeof (request.query as Record<string, unknown> | undefined)?.session === 'string'
        ? ((request.query as Record<string, unknown>).session as string)
        : undefined;
    if (querySession !== undefined) {
      if (querySession.length > 0 && localSessionIds.has(querySession)) {
        for (const sessionId of [...localSessionIds]) {
          if (sessionId !== querySession) localSessionIds.delete(sessionId);
        }
      } else {
        localSessionIds.clear();
      }
      this.logger.debug(`[sessions] events session filter applied`, correlationId);
    }
    // C1: resume cursor — `Last-Event-ID` header first, `?cursor=` fallback.
    // Matched against buffered frame ids; unknown/empty → full local replay
    // (never empty, never global — only this project's sessions).
    const headerCursorRaw: string | Array<string> | undefined =
      request.headers?.['last-event-id'];
    const headerCursor: string | undefined = Array.isArray(headerCursorRaw)
      ? headerCursorRaw[0]
      : headerCursorRaw;
    const queryCursorRaw: unknown = (request.query as Record<string, unknown> | undefined)?.cursor;
    const resumeCursor: string | undefined =
      (typeof headerCursor === 'string' && headerCursor.length > 0 ? headerCursor : undefined) ??
      (typeof queryCursorRaw === 'string' && queryCursorRaw.length > 0 ? queryCursorRaw : undefined);
    const persisted: Map<string, string> = await this.history.listHostBindings(project.projectId);
    // Project-scoped resolver: the process-wide bindings map carries the
    // owner projectId, so a session of project B can never be re-keyed and
    // admitted into project A's stream.
    const resolve: (sessionId: string) => string | undefined = (
      sessionId: string,
    ): string | undefined => {
      const memory: HostBinding | undefined = this.state.getHostBinding(sessionId);
      const fromMemory: string | undefined =
        memory !== undefined && memory.projectId === project.projectId
          ? memory.localSessionId
          : undefined;
      const fromDb: string | undefined = persisted.get(sessionId);
      const direct: string | undefined = localSessionIds.has(sessionId) ? sessionId : undefined;
      const local: string | undefined = fromMemory ?? fromDb ?? direct;
      // A session created while this stream is open becomes visible through
      // the in-process binding before the DB metadata write is reloaded.
      if (local !== undefined) localSessionIds.add(local);
      return local;
    };
    // Keep the durable assistant recorder running even if boot raced the host.
    await this.recorder.ensureStarted();

    // Live refs for the merge closure (same array identity — appends and the
    // busy override stay visible to the running generator).
    const frames: ReadonlyArray<BufferedFrame> = this.buffer.list();
    await relaySse({
      operation: 'GET /api/v1/sessions/events',
      correlationId,
      request,
      response,
      logger: this.logger,
      prefix: '[sessions]',
      probe: async (): Promise<'up' | 'down'> => {
        try {
          await this.host.getHost();
          return 'up';
        } catch {
          return 'down';
        }
      },
      unreachableError: (): ExternalServiceError =>
        new ExternalServiceError({
          code: 'EXTERNAL_UNAVAILABLE',
          service: 'opencode',
          operation: 'sessionEvents',
          message: 'сервис временно недоступен, повторите позже',
          isRetryable: true,
          cause: new Error('unreachable'),
        }),
      subscribeFailedError: (error: unknown): Error =>
        fromUnknown('opencode', 'sessionEvents', error),
      subscribe: async (signal: AbortSignal): Promise<SseSubscription> => {
        // C1: replay starts AFTER the resume cursor (by buffered frame id).
        // Unknown cursor → full local replay (filtered to this subscription).
        const replay: Array<BufferedFrame> = this.buffer.replayAfter(resumeCursor, (frame) => {
          const sessionId: string | undefined =
            typeof frame.data.sessionID === 'string' ? frame.data.sessionID : undefined;
          return sessionId !== undefined && localSessionIds.has(sessionId);
        }).frames;
        if (resumeCursor !== undefined) {
          this.logger.debug(
            `[sessions] replay from cursor count=${replay.length} buffered=${frames.length}`,
            correlationId,
          );
        }
        let liveCursor: number = frames.length;
        const live: AsyncIterable<unknown> = await this.host.subscribeEvents(signal);
        let liveIterator: AsyncIterator<unknown> | null = live[Symbol.asyncIterator]();
        const startedAt: number = Date.now();
        let lastActivityAt: number = Date.now();
        const LOCAL_IDLE_MS: number = 30_000;
        const STREAM_CAP_MS: number = 300_000;
        const POLL_MS: number = 250;
        // Captured for the generator (a plain function, so it has its own
        // `this` — the state service method must stay bound to its instance).
        const state: SessionRuntimeStateService = this.state;
        const stream: AsyncGenerator<unknown> = (async function* (): AsyncGenerator<unknown> {
          try {
            for (const frame of replay) {
              if (signal.aborted) return;
              yield frame;
            }
            while (!signal.aborted) {
              while (liveCursor < frames.length) {
                const frame: BufferedFrame = frames[liveCursor];
                liveCursor += 1;
                const sessionId: string | undefined =
                  typeof frame.data.sessionID === 'string' ? frame.data.sessionID : undefined;
                if (sessionId !== undefined && localSessionIds.has(sessionId)) {
                  lastActivityAt = Date.now();
                  yield frame;
                }
              }
              const next: IteratorResult<unknown> | null =
                liveIterator === null
                  ? null
                  : await Promise.race([
                      liveIterator.next(),
                      new Promise<null>((resolveIdle) => {
                        setTimeout(() => resolveIdle(null), POLL_MS);
                      }),
                    ]);
              if (signal.aborted) return;
              if (next !== null && next.done) {
                liveIterator = null;
              } else if (next !== null) {
                lastActivityAt = Date.now();
                yield next.value;
              }
              if (Date.now() - startedAt > STREAM_CAP_MS) return;
              let busyLocal: boolean = false;
              for (const localId of localSessionIds) {
                if (state.isBusy(localId)) {
                  busyLocal = true;
                  break;
                }
              }
              if (liveIterator === null && !busyLocal && liveCursor >= frames.length) return;
              if (liveIterator === null) {
                await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
                if (signal.aborted) return;
              }
              if (!busyLocal && Date.now() - lastActivityAt > LOCAL_IDLE_MS) return;
            }
          } finally {
            // Downstream close / normal end / error: never leave the host bus
            // iterator (and its reader) attached to this client forever.
            const iterator: AsyncIterator<unknown> | null = liveIterator;
            liveIterator = null;
            try {
              await iterator?.return?.(undefined);
            } catch {
              /* abort during teardown is expected */
            }
          }
        })();
        return { stream };
      },
      filterFrame: (frame: unknown): boolean => {
        const candidate: { data?: unknown; session?: unknown } | null = frame as {
          data?: unknown;
          session?: unknown;
        } | null;
        const data: Record<string, unknown> =
          candidate && typeof candidate.data === 'object' && candidate.data !== null
            ? (candidate.data as Record<string, unknown>)
            : {};
        const session: string | undefined =
          typeof candidate?.session === 'string'
            ? candidate.session
            : typeof data.sessionID === 'string'
              ? data.sessionID
              : undefined;
        return typeof session === 'string' && localSessionIds.has(session);
      },
      mapFrame: (value: unknown): Record<string, unknown> => this.toStreamFrame(value, resolve),
    });
  }
}
