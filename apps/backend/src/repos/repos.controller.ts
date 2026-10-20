import { BadRequestException, Controller, Get, Headers, Param, Query, Version } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { V1Endpoint } from '../api/version';
import { RepoDto, reposQuerySchema, userSpaceSchema, type ReposQuery } from './dto';
import { ReposService } from './repos.service';

/**
 * Readonly git-repo registry — GET only (no POST/PUT/DELETE by design).
 * Layout on disk (organizations epic, no `workspace` segment):
 *   users/<user-uuid>/projects/<project-uuid>/content
 *   orgs/<org-uuid>/projects/<project-uuid>/content
 */
@ApiTags('repos')
@Controller('repos')
export class ReposController {
  constructor(private readonly repos: ReposService) {}

  @Get()
  @Version('1')
  @V1Endpoint('List valid git repos across all user-spaces (readonly, corrupted skipped)')
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'q', required: false, example: 'demo' })
  @ApiResponse({ status: 200, type: [RepoDto] })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async list(
    @Query(new ZodValidationPipe(reposQuerySchema)) query: ReposQuery,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RepoDto[]> {
    return this.repos.list(undefined, query, correlationId) as Promise<RepoDto[]>;
  }

  @Get(':userSpace')
  @Version('1')
  @V1Endpoint('List valid git repos for one user-space (readonly, corrupted skipped)')
  @ApiParam({ name: 'userSpace', example: 'alice' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'q', required: false, example: 'demo' })
  @ApiResponse({ status: 200, type: [RepoDto] })
  @ApiResponse({ status: 400, description: 'invalid userSpace' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async listBySpace(
    @Param('userSpace') userSpace: string,
    @Query(new ZodValidationPipe(reposQuerySchema)) query: ReposQuery,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RepoDto[]> {
    const parsed = userSpaceSchema.safeParse(userSpace);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Invalid userSpace',
      );
    }
    return this.repos.list(parsed.data, query, correlationId) as Promise<RepoDto[]>;
  }
}
