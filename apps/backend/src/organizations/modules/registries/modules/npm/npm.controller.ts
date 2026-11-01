import { Controller, Get, Headers, UseGuards, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { V1Endpoint } from '../../../../../common/api/version';
import { ApiErrorDto } from '../../../../../common/api/dto';
import { JwtAuthGuard } from '../../../../../users/auth/jwt-auth.guard';
import { NpmRegistryService } from './npm.service';
import { NpmRegistryStatusDto } from './dto';

/**
 * npm registry (Verdaccio) — observe-only read surface (GET only).
 *
 * @deprecated Use GET /api/v1/registry/npm instead.
 *
 * - GET /api/v1/registry/npm/status → `{ status: 'up', url, scope }` (live
 *   upstream GET /-/ping with valid credentials; 503 EXTERNAL_UNAVAILABLE +
 *   Retry-After 30 when the registry is unconfigured, unreachable, or refuses
 *   the credential (401/403) — neutral envelope, no mock 200s, secrets never
 *   in the payload).
 * - Health is surfaced via GET /health (`npmRegistry: up | down | skipped`,
 *   where down covers timeout/network AND auth failures 401/403).
 *
 * Auth doctrine: TOKEN (Bearer) wins, else USER/PASSWORD (Basic), else
 * anonymous. A ping-level 401 (bad credentials) / 403 (forbidden) counts as
 * 'down' (AUTH_401/AUTH_403 internally) and answers 503 outward — the
 * 401/403 detail stays in backend logs/monitoring only. The endpoint
 * therefore never answers 401/403/502 for upstream auth.
 *
 * Security (Card C3): Bearer-guarded read-only surface (JwtAuthGuard;
 * anonymous → 401). The 401 here is the guard (missing/invalid caller
 * Bearer), never the upstream credential state (still 503 outward).
 */
@ApiTags('npm-registry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('registry')
export class NpmRegistryController {
  constructor(private readonly registry: NpmRegistryService) {}

  @Get('npm/status')
  @Version('1')
  @V1Endpoint('DEPRECATED: use GET /api/v1/registry/npm — npm registry status (probe → Verdaccio /-/ping, 503 when unreachable or auth refused)')
  @ApiOperation({ deprecated: true })
  @ApiResponse({ status: 200, description: 'live npm status', type: NpmRegistryStatusDto })
  @ApiResponse({ status: 503, description: 'npm registry unreachable or auth refused (EXTERNAL_UNAVAILABLE, neutral message, Retry-After)', type: ApiErrorDto })
  async status(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<NpmRegistryStatusDto> {
    return this.registry.getStatusOrThrow(correlationId ?? '');
  }
}
