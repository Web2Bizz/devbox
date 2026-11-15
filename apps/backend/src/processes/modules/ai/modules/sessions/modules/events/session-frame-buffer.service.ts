import { Injectable } from '@nestjs/common';
import type { BufferedFrame } from '../../sessions.types';

/** Upper bound of the live SSE replay buffer (oldest frames shift out). */
const MAX_FRAMES: number = 500;

/**
 * SessionFrameBufferService — bounded live SSE frame buffer.
 *
 * Holds the harness-owned frames (direct-runner deltas + lifecycle markers)
 * for resume (`Last-Event-ID`/`?cursor=`) replay. Live transport only —
 * durable history lives in SessionHistoryRepository. `list()` returns the
 * internal array as readonly: the stream closure keeps that identity and must
 * see appends made by the running turn.
 */
@Injectable()
export class SessionFrameBufferService {
  private readonly frames: Array<BufferedFrame> = [];

  /** Append one frame with a fresh id (bounded). */
  push(type: string, data: Record<string, unknown>): void {
    this.pushFrame({ id: Bun.randomUUIDv7(), type, data });
  }

  /**
   * Terminal `session.idle` frame for a completed/interrupted local turn:
   * the frontend useChat send() finalizes (clears sending) only on it.
   */
  pushIdle(sessionId: string): void {
    this.push('session.idle', { sessionID: sessionId });
  }

  /** Append an already-built frame (bounded). */
  pushFrame(frame: BufferedFrame): void {
    this.frames.push(frame);
    while (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  /** Live view of the buffer — same array identity as the running stream. */
  list(): ReadonlyArray<BufferedFrame> {
    return this.frames;
  }

  length(): number {
    return this.frames.length;
  }

  /**
   * Replay frames AFTER the given cursor id, filtered by `keep`.
   * An unknown or undefined cursor starts from the beginning (index -1).
   */
  replayAfter(
    cursor: string | undefined,
    keep: (frame: BufferedFrame) => boolean,
  ): { frames: Array<BufferedFrame>; cursorIndex: number } {
    const cursorIndex: number =
      cursor !== undefined ? this.frames.findIndex((frame) => frame.id === cursor) : -1;
    const base: Array<BufferedFrame> =
      cursorIndex >= 0 ? this.frames.slice(cursorIndex + 1) : this.frames;
    return { frames: base.filter(keep), cursorIndex };
  }
}
