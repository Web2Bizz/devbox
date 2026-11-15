import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbService } from '@common/db/db.service';
import { HealthRegistry } from '@common/health/health-registry';
import { HealthDto } from '@common/http/api/api.dto';
import type { HealthResponse } from '@rush-code/contracts';

/**
 * Liveness probe — deliberately VERSION_NEUTRAL and excluded from the global
 * 'api' prefix (see configureApp in app/app.setup.ts): stays GET /health.
 * The /api/v1/health alias is also exposed for API clients; monitoring can
 * continue using the unversioned /health route.
 *
 * Always 200: db, opencode, registry and npmRegistry are reachability flags
 * ('up' | 'down' | 'skipped'), never error statuses. Probes come from the
 * inverted HealthRegistry (opencode/registry/npmRegistry register themselves
 * from their own modules) — health/ imports no domain. An unregistered probe
 * keeps the historical fallback: opencode → 'down', registries → 'skipped'
 * (the wire type of opencode is 'up' | 'down', never 'skipped').
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly registry: HealthRegistry,
  ) {}

  @Get('health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Liveness + postgres/opencode/registry reachability' })
  @ApiResponse({ status: 200, description: 'ok (even if db/opencode/registry down — flags carry the state)', type: HealthDto })
  async getHealth(): Promise<HealthResponse> {
    const [db, opencode, registry, npmRegistry] = await Promise.all([
      this.db.checkDb(),
      this.registry.probe('opencode'),
      this.registry.probe('registry'),
      this.registry.probe('npmRegistry'),
    ]);
    return {
      status: 'ok',
      db,
      opencode: (opencode ?? 'down') as 'up' | 'down',
      registry: registry ?? 'skipped',
      npmRegistry: npmRegistry ?? 'skipped',
    };
  }

  @Get('v1/health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Versioned backend liveness + dependency reachability' })
  @ApiResponse({ status: 200, description: 'ok (dependency state is reported in the response)', type: HealthDto })
  async getVersionedHealth(): Promise<HealthResponse> {
    return this.getHealth();
  }
}
