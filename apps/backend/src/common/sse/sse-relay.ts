import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AppLogger } from '../logger';

/**
 * Shared SSE re-stream mechanics (was the private relaySse of the removed
 * OpencodeController; extracted unchanged so the domain /api/v1/sessions/events
 * route rides the same transport instead of duplicating it).
 *
 * Semantics (preserved 1:1 from the legacy transport, covered by sessions.e2e):
 * - probe first: an unreachable upstream answers 503 BEFORE any SSE header
 *   (the sdk SSE client reconnects forever, so without a probe a down
 *   upstream would stream 200 silence);
 * - AbortController bound to the downstream socket: client disconnect stops
 *   the upstream fetch; backoff is capped so cleanup never hangs;
 * - heartbeat: `: ping` SSE comment every HEARTBEAT_MS (transport-level,
 *   never a data frame — proxies with idle-timeouts keep the socket, parsers
 *   skip it, the client watchdog treats it as liveness);
 * - every data frame carries an `id:` line mirroring the envelope id
 *   (Last-Event-ID redial);
 * - mid-stream failures write ONE terminal `stream.error` frame then end the
 *   stream (never silent); an AbortError is a штатный disconnect (debug, no
 *   answer) per AGENTS.md; warn/error stay one-liners;
 * - best-effort generator return() bounded by a 1500ms race.
 */

export type SseSubscription = {
  stream: AsyncIterable<unknown> & { return?: (value?: unknown) => Promise<unknown> };
};

export type SseRelayParams = {
  /** operation label for logs/errors, e.g. 'GET /event' */
  operation: string;
  correlationId: string;
  request: ExpressRequest;
  response: ExpressResponse;
  /** open the upstream subscription with the relay's abort signal */
  subscribe: (signal: AbortSignal) => Promise<SseSubscription>;
  logger: AppLogger;
  /** log-line prefix: '[opencode]' | '[sessions]' */
  prefix: string;
  /** liveness probe; 'down' aborts with unreachableError() before headers */
  probe: () => Promise<'up' | 'down'>;
  /** typed error when the probe says down (pre-headers → normal JSON 503) */
  unreachableError: () => Error;
  /** typed error for a failed subscribe (pre-headers → normal JSON answer) */
  subscribeFailedError: (error: unknown) => Error;
  /** optional per-frame serializer (mirror: none = verbatim passthrough;
   * domain: re-key upstream names into our frame) */
  mapFrame?: (value: unknown) => unknown;
  /** optional delivery predicate applied AFTER mapFrame; false drops the frame
   * (never written, never counted) — undefined keeps earlier behaviour */
  filterFrame?: (frame: unknown) => boolean;
};

/** Terminal frame written when the upstream stream breaks mid-flight. */
type StreamErrorFrame = {
  id: string;
  type: string;
  data: { message: string };
};

/** Interval between SSE heartbeat comments (transport-level, not a frame). */
export const HEARTBEAT_MS: number = 15_000;

/** True for AbortError shapes (name/code/20, incl. wrapped in cause). */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errorLike: { name?: unknown; code?: unknown; cause?: unknown } =
    error as { name?: unknown; code?: unknown; cause?: unknown };
  if (errorLike.name === 'AbortError') return true;
  if (errorLike.code === 20) return true;
  // DOMException AbortError may be wrapped (e.g. in cause)
  if (errorLike.cause && typeof errorLike.cause === 'object') {
    const causeLike: { name?: unknown; code?: unknown } = errorLike.cause as {
      name?: unknown;
      code?: unknown;
    };
    if (causeLike.name === 'AbortError' || causeLike.code === 20) return true;
  }
  return false;
}

/**
 * Safe one-line error text for logs and the terminal frame: only a real
 * Error message is used, everything else (null/undefined/string/number/
 * message-less Error) falls back to the neutral text. Never stack, never
 * multi-line, never a raw throwable.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'stream interrupted';
}

export async function relaySse(params: SseRelayParams): Promise<void> {
  const {
    operation,
    correlationId,
    request,
    response,
    subscribe,
    logger,
    prefix,
    mapFrame,
    filterFrame,
  }: SseRelayParams = params;
  if ((await params.probe()) === 'down') {
    logger.warn(`${prefix} ${operation} upstream failed`, correlationId);
    throw params.unreachableError();
  }
  // AbortSignal reaches the sdk generator (options.signal) so a downstream
  // disconnect stops the upstream fetch; backoff is capped so cleanup never
  // hangs the handler. Retries stay unbounded while live (re-stream
  // semantics across transient drops).
  const upstream: AbortController = new AbortController();
  let subscription: SseSubscription;
  try {
    subscription = await subscribe(upstream.signal);
  } catch (error) {
    // Client went away before subscribe resolved: upstream.abort()
    // surfaces here as AbortError — штатный disconnect, не 503.
    if (isAbortError(error)) {
      logger.debug(`${prefix} client disconnected before subscribe`, correlationId);
      return;
    }
    logger.warn(`${prefix} ${operation} upstream failed`, correlationId);
    logger.debug((error as Error).message, correlationId);
    throw params.subscribeFailedError(error);
  }
  response.setHeader('content-type', 'text/event-stream');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.setHeader('x-correlation-id', correlationId || 'none');
  response.flushHeaders();

  let closed: boolean = false;
  /** Count of frames rejected by filterFrame (metadata only — never content). */
  let droppedByFilter: number = 0;
  // Heartbeat (C0): SSE comment `: ping` on idle so proxies with an
  // idle-timeout keep the socket; transport-level, never a data frame, so
  // frame parsers and the filter predicate never see it.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat: () => void = (): void => {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (closed || request.destroyed || response.writableEnded || response.destroyed) {
        return;
      }
      try {
        response.write(': ping\n\n');
      } catch {
        /* write after close — the loop teardown handles it */
      }
    }, HEARTBEAT_MS);
    // A pending heartbeat must never pin the process open.
    const intervalHandle: { unref?: () => void } = heartbeat as unknown as {
      unref?: () => void;
    };
    if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  };
  const stopHeartbeat: () => void = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  startHeartbeat();
  logger.debug(`${prefix} ${operation} heartbeat on`, correlationId);

  const onClose: () => void = (): void => {
    if (closed) return;
    closed = true;
    try {
      upstream.abort();
    } catch {
      /* abort is idempotent — never throws outward */
    }
  };
  // upstream.abort() may throw DOMException AbortError synchronously
  // inside EventEmitter emit — swallow it here so it never escapes as
  // unhandledRejection (Bun prints it as line:127 onClose→emitCloseNT).
  const onCloseSafe: () => void = (): void => {
    try {
      onClose();
    } catch {
      /* disconnect — noop */
    }
  };
  request.on('close', onCloseSafe);
  // Socket errors after disconnect would otherwise bubble as unhandled
  // 'error' events on the request — swallow, close handler does cleanup.
  request.on('error', () => {
    /* downstream socket error — noop, handled via close */
  });

  // SSE `id:` for Last-Event-ID redial (C0/C1): the envelope carries the
  // authoritative id; the transport line mirrors it so native clients and
  // the browser EventSource can resume without parsing bodies.
  const frameIdOf: (frame: unknown) => string | undefined = (
    frame: unknown,
  ): string | undefined => {
    if (frame && typeof frame === 'object') {
      const id: unknown = (frame as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return undefined;
  };
  const writeFrame: (frame: unknown) => void = (frame: unknown): void => {
    const payload: string = JSON.stringify(frame);
    const id: string | undefined = frameIdOf(frame);
    response.write(
      id
        ? `id: ${id}\nevent: message\ndata: ${payload}\n\n`
        : `data: ${payload}\n\n`,
    );
  };
  // Terminal error frame (C0): mid-stream failure is NOT silent — the client
  // distinguishes terminal (ErrorState + retry) from transient (quiet redial).
  // AbortError/disconnect stays quiet (debug only, no frame).
  const writeStreamError: (error: unknown) => void = (error: unknown): void => {
    if (closed || request.destroyed || response.writableEnded || response.destroyed) {
      return;
    }
    const message: string = errorMessage(error);
    const terminal: StreamErrorFrame = {
      id: `stream-error-${Date.now()}`,
      type: 'stream.error',
      data: { message },
    };
    try {
      const payload: string = JSON.stringify(terminal);
      response.write(`id: ${terminal.id}\nevent: message\ndata: ${payload}\n\n`);
    } catch {
      /* best-effort — the end() below still closes the stream */
    }
  };

  try {
    const iterator: AsyncIterator<unknown> =
      subscription.stream[Symbol.asyncIterator]();
    while (!closed && !request.destroyed) {
      let next: IteratorResult<unknown>;
      try {
        next = await iterator.next();
      } catch (error) {
        // AbortError from the sdk generator on downstream disconnect —
        // штатный disconnect, выходим молча без stack.
        if (isAbortError(error) || closed) {
          logger.debug(`${prefix} client disconnected`, correlationId);
          break;
        }
        throw error;
      }
      if (next.done || closed || request.destroyed) break;
      try {
        const frame: unknown = mapFrame ? mapFrame(next.value) : next.value;
        if (filterFrame && !filterFrame(frame)) {
          droppedByFilter += 1;
          continue;
        }
        writeFrame(frame);
      } catch (error) {
        // Write after downstream close — то же, что disconnect.
        if (isAbortError(error) || closed || request.destroyed) {
          logger.debug(`${prefix} client disconnected`, correlationId);
          break;
        }
        throw error;
      }
    }
  } catch (error) {
    // Mid-stream failure: status is already 200, so the terminal error frame
    // + end() is the only signal (message only, never secrets). AbortError —
    // штатный disconnect (debug, no frame).
    if (isAbortError(error)) {
      logger.debug(`${prefix} client disconnected`, correlationId);
    } else {
      logger.debug(`${prefix} stream.error ${errorMessage(error)}`, correlationId);
      writeStreamError(error);
    }
  } finally {
    stopHeartbeat();
    // Distinguish "the filter dropped everything" from "upstream was silent":
    // count only, never frame ids/data.
    if (droppedByFilter > 0) {
      logger.debug(
        `${prefix} ${operation} dropped ${droppedByFilter} frame(s) by filter`,
        correlationId,
      );
    }
    request.removeListener('close', onCloseSafe);
    if (!closed) {
      closed = true;
      try {
        upstream.abort();
      } catch {
        /* noop */
      }
    }
    // Best-effort cancel: the sdk generator may sit out a reconnect
    // backoff — bound the wait so the handler never hangs. AbortError
    // from return() — штатный disconnect, глотаем молча.
    await Promise.race([
      (async (): Promise<void> => {
        try {
          await subscription.stream.return?.(undefined);
        } catch (error) {
          if (!isAbortError(error)) {
            /* non-abort cleanup errors are also best-effort — noop */
          }
        }
      })(),
      new Promise<void>((resolve: () => void) => setTimeout(resolve, 1500)),
    ]);
  }
  if (!request.destroyed && !response.writableEnded && !response.destroyed) {
    try {
      response.end();
    } catch (error) {
      if (!isAbortError(error)) {
        logger.debug(
          `${prefix} event stream end failed: ${(error as Error).message}`,
          correlationId,
        );
      }
    }
  }
}
