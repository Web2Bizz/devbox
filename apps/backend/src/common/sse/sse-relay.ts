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
  stream: AsyncIterable<unknown> & { return?: (v?: unknown) => Promise<unknown> };
};

export type SseRelayParams = {
  /** operation label for logs/errors, e.g. 'GET /event' */
  operation: string;
  cid: string;
  req: ExpressRequest;
  res: ExpressResponse;
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
  subscribeFailedError: (err: unknown) => Error;
  /** optional per-frame serializer (mirror: none = verbatim passthrough;
   * domain: re-key upstream names into our frame) */
  mapFrame?: (value: unknown) => unknown;
  /** optional delivery predicate applied AFTER mapFrame; false drops the frame
   * (never written, never counted) — undefined keeps earlier behaviour */
  filterFrame?: (frame: unknown) => boolean;
};

/** Interval between SSE heartbeat comments (transport-level, not a frame). */
export const HEARTBEAT_MS = 15_000;

/** True for AbortError shapes (name/code/20, incl. wrapped in cause). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  if (e.name === 'AbortError') return true;
  if (e.code === 20) return true;
  // DOMException AbortError may be wrapped (e.g. in cause)
  if (e.cause && typeof e.cause === 'object') {
    const c = e.cause as { name?: unknown; code?: unknown };
    if (c.name === 'AbortError' || c.code === 20) return true;
  }
  return false;
}

export async function relaySse(p: SseRelayParams): Promise<void> {
  const { operation, cid, req, res, subscribe, logger, prefix, mapFrame, filterFrame } = p;
  if ((await p.probe()) === 'down') {
    logger.warn(`${prefix} ${operation} upstream failed`, cid);
    throw p.unreachableError();
  }
  // AbortSignal reaches the sdk generator (options.signal) so a downstream
  // disconnect stops the upstream fetch; backoff is capped so cleanup never
  // hangs the handler. Retries stay unbounded while live (re-stream
  // semantics across transient drops).
  const upstream = new AbortController();
  let sub: SseSubscription;
  try {
    sub = await subscribe(upstream.signal);
  } catch (err) {
    // Client went away before subscribe resolved: upstream.abort()
    // surfaces here as AbortError — штатный disconnect, не 503.
    if (isAbortError(err)) {
      logger.debug(`${prefix} client disconnected before subscribe`, cid);
      return;
    }
    logger.warn(`${prefix} ${operation} upstream failed`, cid);
    logger.debug((err as Error).message, cid);
    throw p.subscribeFailedError(err);
  }
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.setHeader('x-correlation-id', cid || 'none');
  res.flushHeaders();

  let closed = false;
  /** Count of frames rejected by filterFrame (metadata only — never content). */
  let droppedByFilter = 0;
  // Heartbeat (C0): SSE comment `: ping` on idle so proxies with an
  // idle-timeout keep the socket; transport-level, never a data frame, so
  // frame parsers and the filter predicate never see it.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (closed || req.destroyed || res.writableEnded || res.destroyed) return;
      try {
        res.write(': ping\n\n');
      } catch {
        /* write after close — the loop teardown handles it */
      }
    }, HEARTBEAT_MS);
    // A pending heartbeat must never pin the process open.
    const t = heartbeat as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  };
  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  startHeartbeat();
  logger.debug(`${prefix} ${operation} heartbeat on`, cid);

  const onClose = (): void => {
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
  const onCloseSafe = (): void => {
    try {
      onClose();
    } catch {
      /* disconnect — noop */
    }
  };
  req.on('close', onCloseSafe);
  // Socket errors after disconnect would otherwise bubble as unhandled
  // 'error' events on the request — swallow, close handler does cleanup.
  req.on('error', () => {
    /* downstream socket error — noop, handled via close */
  });

  // SSE `id:` for Last-Event-ID redial (C0/C1): the envelope carries the
  // authoritative id; the transport line mirrors it so native clients and
  // the browser EventSource can resume without parsing bodies.
  const frameIdOf = (frame: unknown): string | undefined => {
    if (frame && typeof frame === 'object') {
      const id = (frame as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return undefined;
  };
  const writeFrame = (frame: unknown): void => {
    const payload = JSON.stringify(frame);
    const id = frameIdOf(frame);
    res.write(id ? `id: ${id}\nevent: message\ndata: ${payload}\n\n` : `data: ${payload}\n\n`);
  };
  // Terminal error frame (C0): mid-stream failure is NOT silent — the client
  // distinguishes terminal (ErrorState + retry) from transient (quiet redial).
  // AbortError/disconnect stays quiet (debug only, no frame).
  const writeStreamError = (err: unknown): void => {
    if (closed || req.destroyed || res.writableEnded || res.destroyed) return;
    const message = err instanceof Error && err.message ? err.message : 'stream interrupted';
    const terminal = {
      id: `stream-error-${Date.now()}`,
      type: 'stream.error',
      data: { message },
    };
    try {
      const payload = JSON.stringify(terminal);
      res.write(`id: ${terminal.id}\nevent: message\ndata: ${payload}\n\n`);
    } catch {
      /* best-effort — the end() below still closes the stream */
    }
  };

  try {
    const it = sub.stream[Symbol.asyncIterator]();
    while (!closed && !req.destroyed) {
      let next: IteratorResult<unknown>;
      try {
        next = await it.next();
      } catch (err) {
        // AbortError from the sdk generator on downstream disconnect —
        // штатный disconnect, выходим молча без stack.
        if (isAbortError(err) || closed) {
          logger.debug(`${prefix} client disconnected`, cid);
          break;
        }
        throw err;
      }
      if (next.done || closed || req.destroyed) break;
      try {
        const frame = mapFrame ? mapFrame(next.value) : next.value;
        if (filterFrame && !filterFrame(frame)) {
          droppedByFilter += 1;
          continue;
        }
        writeFrame(frame);
      } catch (err) {
        // Write after downstream close — то же, что disconnect.
        if (isAbortError(err) || closed || req.destroyed) {
          logger.debug(`${prefix} client disconnected`, cid);
          break;
        }
        throw err;
      }
    }
  } catch (err) {
    // Mid-stream failure: status is already 200, so the terminal error frame
    // + end() is the only signal (message only, never secrets). AbortError —
    // штатный disconnect (debug, no frame).
    if (isAbortError(err)) {
      logger.debug(`${prefix} client disconnected`, cid);
    } else {
      logger.debug(`${prefix} stream.error ${(err as Error).message}`, cid);
      writeStreamError(err);
    }
  } finally {
    stopHeartbeat();
    // Distinguish "the filter dropped everything" from "upstream was silent":
    // count only, never frame ids/data.
    if (droppedByFilter > 0) {
      logger.debug(
        `${prefix} ${operation} dropped ${droppedByFilter} frame(s) by filter`,
        cid,
      );
    }
    req.removeListener('close', onCloseSafe);
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
          await sub.stream.return?.(undefined);
        } catch (err) {
          if (!isAbortError(err)) {
            /* non-abort cleanup errors are also best-effort — noop */
          }
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
  if (!req.destroyed && !res.writableEnded && !res.destroyed) {
    try {
      res.end();
    } catch (err) {
      if (!isAbortError(err)) {
        logger.debug(`${prefix} event stream end failed: ${(err as Error).message}`, cid);
      }
    }
  }
}
