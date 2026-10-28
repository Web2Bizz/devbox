import { BadRequestException, Controller, Get, Headers, NotFoundException, Param, Query, UseGuards, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { V1Endpoint } from '../api/version';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReqUser } from '../auth/req-user.decorator';
import type { RequestIdentity } from '../auth/identity.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RepoDto, reposQuerySchema, userSpaceSchema, type ReposQuery } from './dto';
import { ReposService } from './repos.service';

/**
 * Readonly git-repo registry — GET only (no POST/PUT/DELETE by design).
 * Layout on disk (organizations epic, no `workspace` segment):
 *   users/<user-uuid>/projects/<project-uuid>/content
 *   orgs/<org-uuid>/projects/<project-uuid>/content
 *
 * Security (Card C3, reuse of the Card 5 access layer):
 * - Bearer-guarded (JwtAuthGuard); anonymous → 401.
 * - Callers see only their own space: GET /repos scopes to the Bearer
 *   identity's user-space; GET /repos/:userSpace admits the owner's own
 *   space or a member org (OrganizationsService.getRole) — strangers get
 *   404 (existence is not leaked, same no-enumeration rule as
 *   OrganizationsService member reads).
 */
@ApiTags('repos')
@Controller('repos')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ReposController {
  constructor(
    private readonly repos: ReposService,
    private readonly orgs: OrganizationsService,
  ) {}

  @Get()
  @Version('1')
  @V1Endpoint('List valid git repos in your own space (readonly, corrupted skipped)')
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'q', required: false, example: 'demo' })
  @ApiResponse({ status: 200, type: [RepoDto] })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async list(
    @Query(new ZodValidationPipe(reposQuerySchema)) query: ReposQuery,
    @ReqUser() identity: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RepoDto[]> {
    // Own space only — org spaces are reachable via GET /repos/:userSpace
    // behind the member gate below (paging semantics stay per-space).
    return this.repos.list(identity.id, query, correlationId) as Promise<RepoDto[]>;
  }

  @Get(':userSpace')
  @Version('1')
  @V1Endpoint('List valid git repos for one space you can access (readonly, corrupted skipped)')
  @ApiParam({ name: 'userSpace', example: 'alice' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'q', required: false, example: 'demo' })
  @ApiResponse({ status: 200, type: [RepoDto] })
  @ApiResponse({ status: 400, description: 'invalid userSpace' })
  @ApiResponse({ status: 404, description: 'space not found (or no access)' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async listBySpace(
    @Param('userSpace') userSpace: string,
    @Query(new ZodValidationPipe(reposQuerySchema)) query: ReposQuery,
    @ReqUser() identity: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RepoDto[]> {
    const parsed = userSpaceSchema.safeParse(userSpace);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Invalid userSpace',
      );
    }
    // Own user-space passes directly; any other space must be a member org
    // (reuse of the OrganizationsService.getRole member rule — strangers 404).
    if (parsed.data !== identity.id) {
      const role = await this.orgs.getRole(parsed.data, identity.id, correlationId);
      if (!role) throw new NotFoundException(`Repo space ${parsed.data} not found`);
    }
    return this.repos.list(parsed.data, query, correlationId) as Promise<RepoDto[]>;
  }
}
