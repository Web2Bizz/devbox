import { Controller, Get, Optional, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbService } from '../common/db/db.service';
import { OpencodeService } from '../ai/modules/opencode/opencode.service';
import {
  DockerRegistryService,
  type DockerRegistryStatus,
} from '../organizations/modules/registries/modules/docker/docker.service';
import {
  NpmRegistryService,
  type NpmRegistryStatus,
} from '../organizations/modules/registries/modules/npm/npm.service';
import { HealthDto } from '../common/api/dto';
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
 * throw. The registry services are @Optional so health stays green even if a
 * module is unwired; missing → 'skipped' (same as unconfigured URL).
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly opencode: OpencodeService,
    @Optional() private readonly registry?: DockerRegistryService,
    @Optional() private readonly npmRegistry?: NpmRegistryService,
  ) {}

  @Get('health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Liveness + postgres/opencode/registry reachability' })
  @ApiResponse({ status: 200, description: 'ok (even if db/opencode/registry down — flags carry the state)', type: HealthDto })
  async getHealth(): Promise<HealthResponse> {
    const [db, opencode, registry, npmRegistry] = await Promise.all([
      this.db.checkDb(),
      this.opencode.checkConnectivity(),
      this.registry?.checkConnectivity() ?? Promise.resolve('skipped' as DockerRegistryStatus),
      this.npmRegistry?.checkConnectivity() ?? Promise.resolve('skipped' as NpmRegistryStatus),
    ]);
    return { status: 'ok', db, opencode, registry, npmRegistry };
  }

  @Get('v1/health')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Versioned backend liveness + dependency reachability' })
  @ApiResponse({ status: 200, description: 'ok (dependency state is reported in the response)', type: HealthDto })
  async getVersionedHealth(): Promise<HealthResponse> {
    return this.getHealth();
  }
}
