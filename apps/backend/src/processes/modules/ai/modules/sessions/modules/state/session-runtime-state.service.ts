import { Injectable } from '@nestjs/common';
import type { HostBinding, TurnMeta } from '../../sessions.types';

/**
 * SessionRuntimeStateService — in-process runtime state shared by the session
 * services.
 *
 * Holds ONLY ephemeral process memory: in-flight direct turns (busy ids),
 * host session id → durable domain binding, and the owner/agent context of
 * the last prompt per OUR session uuid. Nothing here is durable; Postgres
 * (SessionHistoryRepository) stays the source of truth for history. No
 * dependencies and no persistence by design.
 */
@Injectable()
export class SessionRuntimeStateService {
  /** Sessions with an in-flight direct turn (status override until the answer lands). */
  private readonly busy: Set<string> = new Set<string>();

  /**
   * In-process host-id → durable binding written by create(), so SSE
   * subscribers already connected see `session.created`/early frames before
   * the Postgres metadata write lands. Every entry carries its projectId —
   * the map is process-wide but reads are always project-scoped.
   */
  private readonly bindings: Map<string, HostBinding> = new Map<string, HostBinding>();

  /** Owner/agent of the in-flight turn keyed by OUR session uuid. */
  private readonly turns: Map<string, TurnMeta> = new Map<string, TurnMeta>();

  /**
   * Server-side cancel flags keyed by OUR session uuid (WEB-24 / E3).
   * Armed by `requestCancel` (the interrupt endpoint), read by the runner's
   * segment-boundary `shouldInterrupt` hook, cleared when the turn settles.
   * A separate set (never the `busy` set itself): interrupt clears `busy`
   * to drop the late answer while the flag must survive until the boundary
   * observes it. Idle sessions never carry a flag (no stale cancels).
   */
  private readonly cancelled: Set<string> = new Set<string>();

  /**
   * AbortControllers of the in-flight turns (WEB-24 / E3): `track` creates
   * one per turn (its signal rides `RunTurnRequest.signal`), `requestCancel`
   * aborts it, `untrack` drops it on settle. Abort never throws — the runner
   * only READS `signal.aborted` on a segment boundary, never mid-segment.
   */
  private readonly controllers: Map<string, AbortController> = new Map<string, AbortController>();

  markBusy(id: string): void {
    this.busy.add(id);
  }

  /** Drops the busy marker, answering true when the id was actually busy. */
  clearBusy(id: string): boolean {
    return this.busy.delete(id);
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  /**
   * Signal of the in-flight turn (WEB-24 / E3): creates the turn controller
   * on first call (idempotent — the same signal answers every call until
   * `untrack`). The runner forwards it to the segment boundary where an
   * abort reads as `cancelled` (server-side only — the client already
   * stopped its own stream, no stream handling here).
   */
  track(id: string): AbortSignal {
    let controller: AbortController | undefined = this.controllers.get(id);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(id, controller);
    }
    return controller.signal;
  }

  /** Drops the turn controller (settle path — never aborts, see `requestCancel`). */
  untrack(id: string): void {
    this.controllers.delete(id);
  }

  /**
   * Server-side cancel (WEB-24 / E3, the interrupt endpoint arms it): aborts
   * the turn signal and sets the boundary flag the runner's `shouldInterrupt`
   * hook reads. Answers whether a turn was in flight — idle sessions answer
   * false and leave NO flag (a stale flag would cancel the NEXT turn).
   */
  requestCancel(id: string): boolean {
    if (!this.busy.has(id)) return false;
    this.controllers.get(id)?.abort();
    this.cancelled.add(id);
    return true;
  }

  /** Boundary flag of a server-side cancel (read by `shouldInterrupt`). */
  isCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }

  /** Clears the cancel flag (turn settle — the boundary already observed it). */
  clearCancelled(id: string): void {
    this.cancelled.delete(id);
  }

  busyIds(): Iterable<string> {
    return this.busy;
  }

  bindHostSession(hostId: string, binding: HostBinding): void {
    this.bindings.set(hostId, binding);
  }

  unbindHostSession(hostId: string): void {
    this.bindings.delete(hostId);
  }

  getHostBinding(hostId: string): HostBinding | undefined {
    return this.bindings.get(hostId);
  }

  setTurnMeta(localId: string, meta: TurnMeta): void {
    this.turns.set(localId, meta);
  }

  getTurnMeta(localId: string): TurnMeta | undefined {
    return this.turns.get(localId);
  }

  deleteTurnMeta(localId: string): void {
    this.turns.delete(localId);
  }
}
