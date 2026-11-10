import { Injectable } from '@nestjs/common';
import { DbService, dbUnavailable } from '@common/db/db.service';
import type { RunEventRow } from '@common/db/schema';
import { AppLogger } from '@common/logger';
import type { SseSubscription } from '@common/sse/sse-relay';
import { RunsRepository } from './runs.repository';

/** LISTEN/NOTIFY channel published by the journal writers (E4). */
const NOTIFY_CHANNEL: string = 'run_events';
/** Safety tick when a NOTIFY is missed (dedicated LISTEN connections drop). */
const FALLBACK_POLL_MS: number = 2000;
/** AbortSignal event name (the biome no-literal-args plugin forbids the raw literal). */
const ABORT_EVENT: 'abort' = 'abort';

/** Handle of one dedicated LISTEN connection (closing it is idempotent). */
type RunEventListener = { close: () => Promise<void> };

/**
 * RunEventSource — SSE source over the append-only `run_events` journal.
 *
 * Catch-up then live: `listEventsAfter(runId, cursor)` replays everything the
 * client missed (`seq > cursor`, ascending, so a redial can never skip or
 * duplicate a frame); an empty page parks the stream on a
 * dedicated LISTEN connection (`DbService.listen`, payload `<runId>` or
 * `<runId>:<…>`) with a 2s fallback tick so a missed NOTIFY only costs
 * latency, never correctness.
 *
 * The LISTEN connection is opened BEFORE the first catch-up query, so the
 * stream is already subscribed when the first page comes back: frames
 * appended during catch-up are picked up by the next query, and a NOTIFY
 * delivered while the stream is parked wakes it immediately. A NOTIFY that
 * races the query itself can be missed — the 2s tick bounds that gap.
 * No LISTEN connection → 503 EXTERNAL_UNAVAILABLE via dbUnavailable (the same
 * strict-Postgres contract as every other db call) instead of a silent 200.
 * close() is idempotent and also fires on downstream abort, so the dedicated
 * connection is released even when the relay never starts iterating.
 */
@Injectable()
export class RunEventSource {
  constructor(
    private readonly db: DbService,
    private readonly repository: RunsRepository,
    private readonly logger: AppLogger = new AppLogger(RunEventSource.name),
  ) {}

  /** Journal frames after `cursor`, replayed then tailed live until abort. */
  async subscribe(
    runId: string,
    cursor: number,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<SseSubscription> {
    let pendingWake: (() => void) | null = null;
    const release: RunEventListener = await this.openListener(runId, correlationId, () =>
      pendingWake?.(),
    );
    // Captured for the generator body (a plain async generator has its own
    // `this`, so the instance is not reachable inside it).
    const repository: RunsRepository = this.repository;

    /**
     * Resolves on a matching NOTIFY, on the fallback tick, or on downstream
     * abort — always clearing the timer and the abort listener so neither
     * leaks across waits.
     */
    const waitForChange: (milliseconds: number) => Promise<void> = (
      milliseconds: number,
    ): Promise<void> =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle: () => void = (): void => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          signal.removeEventListener(ABORT_EVENT, settle);
          if (pendingWake === settle) pendingWake = null;
          resolve();
        };
        pendingWake = settle;
        timer = setTimeout(settle, milliseconds);
        signal.addEventListener(ABORT_EVENT, settle, { once: true });
      });

    let lastSeq: number = cursor;
    const stream: AsyncGenerator<RunEventRow> = (async function* (): AsyncGenerator<RunEventRow> {
      try {
        for (;;) {
          if (signal.aborted) return;
          const rows: Array<RunEventRow> = await repository.listEventsAfter(
            runId,
            lastSeq,
            correlationId,
          );
          if (rows.length === 0) {
            await waitForChange(FALLBACK_POLL_MS);
            continue;
          }
          for (const row of rows) {
            if (signal.aborted) return;
            lastSeq = Number(row.seq);
            yield row;
          }
        }
      } finally {
        await release.close().catch(() => undefined);
      }
    })();

    // The relay calls stream.return() in its finally block, but a generator
    // body that never started does not run `finally` — close the LISTEN
    // connection on abort directly so it can never outlive the request.
    signal.addEventListener(
      ABORT_EVENT,
      () => {
        void release.close().catch(() => undefined);
      },
      { once: true },
    );
    if (signal.aborted) void release.close().catch(() => undefined);

    return { stream };
  }

  /**
   * Dedicated LISTEN connection for this run. Failure maps to 503 (logged
   * once via correlationId) — an unreachable Postgres is an outage, not 200 silence.
   */
  private async openListener(
    runId: string,
    correlationId: string,
    onWake: () => void,
  ): Promise<RunEventListener> {
    try {
      return await this.db.listen(NOTIFY_CHANNEL, (payload) => {
        // The payload is opaque: `<runId>` or `<runId>:<…>` belongs to this
        // run; anything else is another run's notify and is ignored.
        if (payload === runId || payload.startsWith(`${runId}:`)) onWake();
      });
    } catch (error) {
      dbUnavailable('runs.subscribe', error, this.logger, correlationId);
    }
  }
}
