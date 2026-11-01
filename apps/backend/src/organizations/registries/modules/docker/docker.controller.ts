import { Controller, Get, Headers, UseGuards, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { V1Endpoint } from '../../../../common/http/api/version';
import { ApiErrorDto } from '../../../../common/http/api/dto';
import { JwtAuthGuard } from '../../../../auth/jwt-auth.guard';
import { DockerRegistryService } from './docker.service';
import { RegistryCatalogDto } from './dto';

/**
 * Docker Registry HTTP API v2 — minimal read surface (GET only).
 *
 * @deprecated Use GET /api/v1/registry/docker instead.
 *
 * - GET /api/v1/registry/catalog → `{ repositories: string[] }` (live
 *   upstream GET /v2/_catalog; 503 EXTERNAL_UNAVAILABLE + Retry-After 30
 *   when the registry is unconfigured or unreachable — no mock 200s).
 * - Health is surfaced via GET /health (`registry: up | down | skipped`).
 *
 * Security (Card C3): Bearer-guarded read-only surface (JwtAuthGuard;
 * anonymous → 401). No per-row scoping — the catalog is not user data.
 */
@ApiTags('docker-registry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('registry')
export class DockerRegistryController {
  constructor(private readonly registry: DockerRegistryService) {}

  @Get('catalog')
  @Version('1')
  @V1Endpoint('DEPRECATED: use GET /api/v1/registry/docker — List registry repositories (proxy → Docker Registry /v2/_catalog, 503 when unreachable)')
  @ApiOperation({ deprecated: true })
  @ApiResponse({ status: 200, description: 'live catalog', type: RegistryCatalogDto })
  @ApiResponse({ status: 503, description: 'registry unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async catalog(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RegistryCatalogDto> {
    const repositories = await this.registry.listCatalog(correlationId ?? '');
    return { repositories };
  }
}
