import { Injectable } from "@nestjs/common";

/** Reachability flag carried by every health probe (wire shape of HealthResponse). */
export type HealthFlag = "up" | "down" | "skipped";

/** Dependency keys the health endpoint reports (fixed contract, not free-form). */
export type HealthProbeKey = "opencode" | "registry" | "npmRegistry";

/**
 * HealthRegistry — Common-owned indirection for dependency reachability.
 *
 * Common (health/) must not import Organization/Processes modules, so the
 * dependency direction is inverted: each domain module registers its own
 * probe on boot (OpencodeModule → 'opencode', DockerModule → 'registry',
 * NpmModule → 'npmRegistry') and the health controller only asks the
 * registry. Registering the same key twice is a wiring bug and throws
 * instead of silently overriding; an unregistered key resolves to
 * `undefined` so the controller can pick the contract fallback.
 */
@Injectable()
export class HealthRegistry {
  private readonly probes = new Map<HealthProbeKey, () => Promise<HealthFlag>>();

  register(key: HealthProbeKey, probe: () => Promise<HealthFlag>): void {
    if (this.probes.has(key)) {
      throw new Error(`health probe already registered: ${key}`);
    }
    this.probes.set(key, probe);
  }

  async probe(key: HealthProbeKey): Promise<HealthFlag | undefined> {
    const probe = this.probes.get(key);
    if (!probe) return undefined;
    return probe();
  }
}
