import { Controller, Get, Headers, Version } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { V1Endpoint } from '../api/version';
import { ApiErrorDto } from '../api/dto';
import { DockerRegistryService } from './docker-registry.service';
import { RegistryCatalogDto } from './dto';

/**
 * Docker Registry HTTP API v2 — minimal read surface (GET only).
 *
 * - GET /api/v1/registry/catalog → `{ repositories: string[] }` (live
 *   upstream GET /v2/_catalog; 503 EXTERNAL_UNAVAILABLE + Retry-After 30
 *   when the registry is unconfigured or unreachable — no mock 200s).
 * - Health is surfaced via GET /health (`registry: up | down | skipped`).
 */
@ApiTags('docker-registry')
@Controller('registry')
export class DockerRegistryController {
  constructor(private readonly registry: DockerRegistryService) {}

  @Get('catalog')
  @Version('1')
  @V1Endpoint('List registry repositories (proxy → Docker Registry /v2/_catalog, 503 when unreachable)')
  @ApiResponse({ status: 200, description: 'live catalog', type: RegistryCatalogDto })
  @ApiResponse({ status: 503, description: 'registry unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async catalog(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RegistryCatalogDto> {
    const repositories = await this.registry.listCatalog(correlationId ?? '');
    return { repositories };
  }
}
