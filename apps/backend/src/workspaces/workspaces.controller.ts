import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Inject, Optional, forwardRef } from '@nestjs/common';
import { V1Endpoint } from '../api/version';
import {
  DEFAULT_MOCK_USER_ID as DEFAULT_WORKSPACE_USER_ID,
  resolveIdentityUserId as resolveUserId,
} from '../auth/identity.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReqUser } from '../auth/req-user.decorator';
import type { RequestIdentity } from '../auth/identity.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GithubInstallationsService } from '../projects/github/github-installations.service';
import { CloneJobsRepository } from './clone-jobs.repository';
import {
  CloneWorkspaceDto,
  WorkspaceCloneJobDto,
  WorkspaceSubmoduleDto,
  WorkspaceTreeNodeDto,
  cloneWorkspaceSchema,
  workspaceRepoSchema,
  workspaceTreeQuerySchema,
  type CloneWorkspaceInput,
  type WorkspaceTreeQuery,
} from './dto';
import { WorkspaceCloneService } from './workspace-clone.service';
import { WorkspacesService } from './workspaces.service';

/** MVP mock user key (single copy lives in auth/identity.service.ts). */
export { DEFAULT_WORKSPACE_USER_ID };
export { resolveUserId };

function toJobDto(job: {
  userSpace: string;
  repoName: string;
  status: string;
  progress: number;
  error: string | null;
  updatedAt: string;
}): WorkspaceCloneJobDto {
  return {
    userSpace: job.userSpace,
    repoName: job.repoName,
    status: job.status,
    progress: job.progress,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

/**
 * WorkspacesController — per-user project-content surface (organizations
 * layout, no `workspace` segment).
 *
 * - POST /api/v1/workspaces/clone — enqueue (idempotent) a
 *   `git clone --recurse-submodules` into
 *   REPOS_ROOT/users/<userUuid>/projects/<projectUuid>/content (both ids
 *   uuid-validated, 400 on garbage)
 * - GET /api/v1/workspaces/:repo/clone-status — queued/cloning/ready/failed
 * - GET /api/v1/workspaces/:repo/tree — jailed readonly listing (path+depth)
 * - GET /api/v1/workspaces/:repo/submodules — parsed .gitmodules + status
 *
 * Identity: x-user-id header wins over ?userId (same MVP rule as GitHub).
 * When `installationId` is supplied it must belong to the requesting userId
 * (GithubInstallationsService binding) — otherwise 403. Existing
 * repos/projects/opencode routes are untouched.
 */
@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly clones: WorkspaceCloneService,
    private readonly jobs: CloneJobsRepository,
    @Optional()
    @Inject(forwardRef(() => GithubInstallationsService))
    private readonly installations?: GithubInstallationsService,
  ) {}

  private async assertInstallationOwner(userId: string, installationId?: number): Promise<void> {
    if (installationId === undefined) return;
    const stored = (await this.installations?.findByInstallationId(installationId)) ?? null;
    // Unknown installation → treat as foreign (never leak which ids exist
    // beyond the 403; the callback is the only way to bind one).
    if (!stored || stored.userId !== userId) {
      throw new ForbiddenException('GitHub installation does not belong to this user');
    }
  }

  @Post('clone')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @HttpCode(202)
  @V1Endpoint('Clone a repo into the per-user workspace (idempotent, per-user lock)')
  @ApiBearerAuth()
  @ApiHeader({ name: 'x-user-id', required: false, description: 'MVP mock user key (wins over ?userId)' })
  @ApiResponse({ status: 202, type: WorkspaceCloneJobDto })
  @ApiResponse({ status: 400, description: 'bad repoUrl/repoName' })
  @ApiResponse({ status: 403, description: 'installation belongs to another user' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async clone(
    @Body(new ZodValidationPipe(cloneWorkspaceSchema)) body: CloneWorkspaceInput,
    @Req() req: unknown,
    @Query('userId') queryUserId?: string,
    @Headers('x-user-id') _headerUserId?: string,
    @ReqUser() _identity?: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WorkspaceCloneJobDto> {
    void _headerUserId;
    void _identity;
    const userId = resolveUserId(req, queryUserId);
    await this.assertInstallationOwner(userId, body.installationId);
    const job = await this.clones.clone(userId, body.repoUrl, body.repoName, correlationId);
    return toJobDto(job);
  }

  @Get(':repo/clone-status')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @V1Endpoint('Clone job status for a repo in the per-user workspace')
  @ApiBearerAuth()
  @ApiParam({ name: 'repo', example: 'demo' })
  @ApiHeader({ name: 'x-user-id', required: false, description: 'MVP mock user key (wins over ?userId)' })
  @ApiResponse({ status: 200, type: WorkspaceCloneJobDto })
  @ApiResponse({ status: 404, description: 'no clone job for this repo+user' })
  cloneStatus(
    @Param('repo') repo: string,
    @Req() req: unknown,
    @Query('userId') queryUserId?: string,
    @ReqUser() _identity?: RequestIdentity,
  ): WorkspaceCloneJobDto {
    void _identity;
    const parsed = workspaceRepoSchema.safeParse(repo);
    if (!parsed.success) {
      throw new NotFoundException(`No clone job for repo ${repo}`);
    }
    const userId = resolveUserId(req, queryUserId);
    const job = this.jobs.get(userId, parsed.data);
    if (!job) throw new NotFoundException(`No clone job for repo ${parsed.data}`);
    return toJobDto(job);
  }

  @Get(':repo/tree')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @V1Endpoint('Readonly workspace file tree (jailed per-user, depth 0-5)')
  @ApiBearerAuth()
  @ApiParam({ name: 'repo', example: 'demo' })
  @ApiQuery({ name: 'path', required: false, example: '.' })
  @ApiQuery({ name: 'depth', required: false, example: 1 })
  @ApiHeader({ name: 'x-user-id', required: false, description: 'MVP mock user key (wins over ?userId)' })
  @ApiResponse({ status: 200, type: WorkspaceTreeNodeDto })
  @ApiResponse({ status: 403, description: 'traversal forbidden' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async tree(
    @Param('repo') repo: string,
    @Query(new ZodValidationPipe(workspaceTreeQuerySchema)) query: WorkspaceTreeQuery,
    @Req() req: unknown,
    @Query('userId') queryUserId?: string,
    @ReqUser() _identity?: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WorkspaceTreeNodeDto> {
    void _identity;
    const parsed = workspaceRepoSchema.safeParse(repo);
    if (!parsed.success) {
      throw new NotFoundException(`Repo ${repo} not found`);
    }
    const userId = resolveUserId(req, queryUserId);
    return (await this.workspaces.tree(
      userId,
      parsed.data,
      query.path ?? '.',
      Number(query.depth ?? 1),
      correlationId,
    )) as WorkspaceTreeNodeDto;
  }

  @Get(':repo/submodules')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @V1Endpoint('Workspace repo submodules (.gitmodules + status, jailed paths)')
  @ApiBearerAuth()
  @ApiParam({ name: 'repo', example: 'demo' })
  @ApiHeader({ name: 'x-user-id', required: false, description: 'MVP mock user key (wins over ?userId)' })
  @ApiResponse({ status: 200, type: [WorkspaceSubmoduleDto] })
  @ApiResponse({ status: 404, description: 'repo not found' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async submodules(
    @Param('repo') repo: string,
    @Req() req: unknown,
    @Query('userId') queryUserId?: string,
    @ReqUser() _identity?: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WorkspaceSubmoduleDto[]> {
    void _identity;
    const parsed = workspaceRepoSchema.safeParse(repo);
    if (!parsed.success) {
      throw new NotFoundException(`Repo ${repo} not found`);
    }
    const userId = resolveUserId(req, queryUserId);
    return this.workspaces.submodules(userId, parsed.data, correlationId);
  }
}

// Re-exported so Swagger DTO parity tooling can import from the controller
// module without touching runtime wiring. Keeps CloneWorkspaceDto referenced
// (request-body shape mirrors cloneWorkspaceSchema 1:1).
export type { CloneWorkspaceDto };
