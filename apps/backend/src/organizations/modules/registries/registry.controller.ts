import { Controller, Get, Headers, UseGuards, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { V1Endpoint } from '../../../common/api/version';
import { ApiErrorDto } from '../../../common/api/dto';
import { JwtAuthGuard } from '../../../users/auth/jwt-auth.guard';
import { DockerRegistryService } from './modules/docker/docker.service';
import { NpmRegistryService } from './modules/npm/npm.service';
import { RegistryCatalogDto } from './modules/docker/dto';
import { NpmRegistryStatusDto } from './modules/npm/dto';

/**
 * Unified registry lists — canonical read surface (GET only).
 *
 * - GET /api/v1/registry/docker → `{ repositories: string[] }` (live
 *   upstream GET /v2/_catalog; 503 EXTERNAL_UNAVAILABLE + Retry-After 30
 *   when the registry is unconfigured or unreachable — no mock 200s).
 * - GET /api/v1/registry/npm → `{ status: 'up', url, scope }` (live
 *   upstream GET /-/ping with valid credentials; 503 EXTERNAL_UNAVAILABLE +
 *   Retry-After 30 when unconfigured, unreachable, or auth refused).
 *
 * Replaces the legacy per-registry controllers:
 * - `GET /api/v1/registry/catalog` (docker.controller) — deprecated.
 * - `GET /api/v1/registry/npm/status` (npm.controller) — deprecated.
 *
 * Security (Card C3): Bearer-guarded read-only surface (JwtAuthGuard;
 * anonymous → 401). No per-row scoping — the catalog is not user data.
 */
@ApiTags('registry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('registry')
export class RegistryController {
  constructor(
    private readonly dockerService: DockerRegistryService,
    private readonly npmService: NpmRegistryService,
  ) {}

  @Get('docker')
  @Version('1')
  @V1Endpoint('List docker registry repositories (proxy → Docker Registry /v2/_catalog, 503 when unreachable)')
  @ApiResponse({ status: 200, description: 'live catalog', type: RegistryCatalogDto })
  @ApiResponse({ status: 503, description: 'registry unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getDocker(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RegistryCatalogDto> {
    const repositories = await this.dockerService.listCatalog(correlationId ?? '');
    return { repositories };
  }

  @Get('npm')
  @Version('1')
  @V1Endpoint('List npm registry status (probe → Verdaccio /-/ping, 503 when unreachable or auth refused)')
  @ApiResponse({ status: 200, description: 'live npm status', type: NpmRegistryStatusDto })
  @ApiResponse({ status: 503, description: 'npm registry unreachable or auth refused (EXTERNAL_UNAVAILABLE, neutral message, Retry-After)', type: ApiErrorDto })
  async getNpm(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<NpmRegistryStatusDto> {
    return this.npmService.getStatusOrThrow(correlationId ?? '');
  }
}
