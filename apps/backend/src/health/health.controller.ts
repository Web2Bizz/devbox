import { Controller, Get, Optional, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbService } from '../db/db.service.js';
import { OpencodeService } from '../opencode/opencode.service.js';
import {
  DockerRegistryService,
  type DockerRegistryStatus,
} from '../docker-registry/docker-registry.service.js';
import {
  NpmRegistryService,
  type NpmRegistryStatus,
} from '../npm-registry/npm-registry.service.js';
import { HealthDto } from '../api/dto.js';
import type { HealthResponse } from '../contracts.js';

/**
 * Liveness probe — deliberately VERSION_NEUTRAL and excluded from the global
 * 'api' prefix (see configureApp in app.setup.ts): stays GET /health.
 * No /api/v1/health alias — monitoring probes must not depend on API
 * versioning, and health carries no versioned contract.
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
}
