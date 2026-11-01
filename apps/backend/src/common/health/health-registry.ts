import { Injectable } from '@nestjs/common';

/** Reachability flag carried by every health probe. */
export type HealthFlag = 'up' | 'down' | 'skipped';

/** Probe keys exposed by GET /health (and /api/v1/health). */
export type HealthProbeKey = 'opencode' | 'registry' | 'npmRegistry';

/**
 * HealthRegistry — dependency-free probe registry for HealthController.
 *
 * Health stays inverted: `health/` and `common/` never import domains.
 * Owning modules (OpencodeModule, DockerModule, NpmModule) register their
 * own probe in `onModuleInit`; the controller only reads the registry.
 *
 * - `register()` throws on a duplicate key — a silent overwrite would make
 *   the reported flag depend on module init order.
 * - `probe()` answers `undefined` when the key was never registered, so the
 *   controller keeps its documented fallbacks ('down' for opencode,
 *   'skipped' for the registries).
 */
@Injectable()
export class HealthRegistry {
  private readonly probes = new Map<HealthProbeKey, () => Promise<HealthFlag>>();

  register(key: HealthProbeKey, probe: () => Promise<HealthFlag>): void {
    if (this.probes.has(key)) {
      throw new Error(`Health probe already registered: ${key}`);
    }
    this.probes.set(key, probe);
  }

  async probe(key: HealthProbeKey): Promise<HealthFlag | undefined> {
    const probe = this.probes.get(key);
    if (!probe) return undefined;
    return probe();
  }
}
