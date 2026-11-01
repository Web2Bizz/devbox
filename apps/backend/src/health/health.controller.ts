import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbService } from '../common/db/db.service';
import { HealthRegistry } from '../common/health/health-registry';
import { HealthDto } from '../common/http/api/dto';
import type { HealthResponse } from '@rush-code/contracts';

/**
 * Liveness probe — deliberately VERSION_NEUTRAL and excluded from the global
 * 'api' prefix (see configureApp in app/app.setup.ts): stays GET /health.
 * The /api/v1/health alias is also exposed for API clients; monitoring can
 * continue using the unversioned /health route.
 *
 * Always 200: db, opencode, registry and npmRegistry are reachability flags
 * ('up' | 'down' | 'skipped'), never error statuses. The opencode/registry
 * probes run on a short budget and degrade to 'down' on timeout — never
 * throw. Dependency probes are self-registered by their owning domain
 * modules through HealthRegistry (Common → domain imports are forbidden);
 * a key nobody registered falls back to 'down' (opencode) / 'skipped'
 * (registries, same as unconfigured URL). The opencode wire flag is
 * 'up' | 'down' only — 'skipped' is never reported for it.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly health: HealthRegistry,
  ) {}

  @Get('health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Liveness + postgres/opencode/registry reachability' })
  @ApiResponse({ status: 200, description: 'ok (even if db/opencode/registry down — flags carry the state)', type: HealthDto })
  async getHealth(): Promise<HealthResponse> {
    const [db, opencodeFlag, registry, npmRegistry] = await Promise.all([
      this.db.checkDb(),
      this.health.probe('opencode'),
      this.health.probe('registry'),
      this.health.probe('npmRegistry'),
    ]);
    // Contract HealthResponse.opencode is 'up' | 'down' — a probe that never
    // registered (or answers 'skipped') reports 'down', never a third state.
    const opencode: HealthResponse['opencode'] =
      opencodeFlag === 'up' ? 'up' : 'down';
    return { status: 'ok', db, opencode, registry: registry ?? 'skipped', npmRegistry: npmRegistry ?? 'skipped' };
  }

  @Get('v1/health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Versioned backend liveness + dependency reachability' })
  @ApiResponse({ status: 200, description: 'ok (dependency state is reported in the response)', type: HealthDto })
  async getVersionedHealth(): Promise<HealthResponse> {
    return this.getHealth();
  }
}
