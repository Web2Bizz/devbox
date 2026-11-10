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
