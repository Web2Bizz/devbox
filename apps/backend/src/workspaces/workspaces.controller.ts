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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Inject, Optional, forwardRef } from '@nestjs/common';
import { DEFAULT_MOCK_USER_ID as DEFAULT_WORKSPACE_USER_ID } from '../auth/identity.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReqUser } from '../auth/req-user.decorator';
import type { RequestIdentity } from '../auth/identity.service';
import { ZodValidationPipe } from '../common/validation';
import { GithubInstallationsService } from '../organizations/modules/projects/modules/github/github-installations.service';
import { CloneJobsRepository } from './modules/clone/clone.repository';
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
import { WorkspaceCloneService } from './modules/clone/clone.service';
import { WorkspacesService } from './workspaces.service';

/** MVP mock user key (single copy lives in auth/identity.service.ts). */
export { DEFAULT_WORKSPACE_USER_ID };

/**
 * resolveUserId re-export kept for import compat only — the controller no
 * longer calls it (C2: userId comes from @ReqUser(), header/query
 * spoofing removed).
 */
export { resolveIdentityUserId as resolveUserId } from '../auth/identity.service';

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
 * Identity (C2): userId comes ONLY from @ReqUser() (Bearer via
 * JwtAuthGuard) — the legacy x-user-id header / ?userId query spoofing is
 * removed (same ownUserId doctrine as OpencodeKeysController). A forged
 * header is ignored, never trusted. When `installationId` is supplied it
 * must belong to the requesting identity
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
  @UseGuards(JwtAuthGuard)
  @HttpCode(202)
  @ApiOperation({ summary: 'Clone a repo into the per-user workspace (idempotent, per-user lock)' })
  @ApiBearerAuth()
  @ApiResponse({ status: 202, type: WorkspaceCloneJobDto })
  @ApiResponse({ status: 400, description: 'bad repoUrl/repoName' })
  @ApiResponse({ status: 403, description: 'installation belongs to another user' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async clone(
    @Body(new ZodValidationPipe(cloneWorkspaceSchema)) body: CloneWorkspaceInput,
    @ReqUser() identity: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WorkspaceCloneJobDto> {
    const userId = identity.id;
    await this.assertInstallationOwner(userId, body.installationId);
    const job = await this.clones.clone(userId, body.repoUrl, body.repoName, correlationId);
    return toJobDto(job);
  }

  @Get(':repo/clone-status')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Clone job status for a repo in the per-user workspace' })
  @ApiBearerAuth()
  @ApiParam({ name: 'repo', example: 'demo' })
  @ApiResponse({ status: 200, type: WorkspaceCloneJobDto })
  @ApiResponse({ status: 404, description: 'no clone job for this repo+user' })
  cloneStatus(
    @Param('repo') repo: string,
    @ReqUser() identity: RequestIdentity,
  ): WorkspaceCloneJobDto {
    const parsed = workspaceRepoSchema.safeParse(repo);
    if (!parsed.success) {
      throw new NotFoundException(`No clone job for repo ${repo}`);
    }
    const job = this.jobs.get(identity.id, parsed.data);
    if (!job) throw new NotFoundException(`No clone job for repo ${parsed.data}`);
    return toJobDto(job);
  }

  @Get(':repo/tree')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Readonly workspace file tree (jailed per-user, depth 0-5)' })
  @ApiBearerAuth()
  @ApiParam({ name: 'repo', example: 'demo' })
  @ApiQuery({ name: 'path', required: false, example: '.' })
  @ApiQuery({ name: 'depth', required: false, example: 1 })
  @ApiResponse({ status: 200, type: WorkspaceTreeNodeDto })
  @ApiResponse({ status: 403, description: 'traversal forbidden' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async tree(
    @Param('repo') repo: string,
    @Query(new ZodValidationPipe(workspaceTreeQuerySchema)) query: WorkspaceTreeQuery,
    @ReqUser() identity: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WorkspaceTreeNodeDto> {
    const parsed = workspaceRepoSchema.safeParse(repo);
    if (!parsed.success) {
      throw new NotFoundException(`Repo ${repo} not found`);
    }
    return (await this.workspaces.tree(
      identity.id,
      parsed.data,
      query.path ?? '.',
      Number(query.depth ?? 1),
      correlationId,
    )) as WorkspaceTreeNodeDto;
  }

  @Get(':repo/submodules')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Workspace repo submodules (.gitmodules + status, jailed paths)' })
  @ApiBearerAuth()
  @ApiParam({ name: 'repo', example: 'demo' })
  @ApiResponse({ status: 200, type: [WorkspaceSubmoduleDto] })
  @ApiResponse({ status: 404, description: 'repo not found' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async submodules(
    @Param('repo') repo: string,
    @ReqUser() identity: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WorkspaceSubmoduleDto[]> {
    const parsed = workspaceRepoSchema.safeParse(repo);
    if (!parsed.success) {
      throw new NotFoundException(`Repo ${repo} not found`);
    }
    return this.workspaces.submodules(identity.id, parsed.data, correlationId);
  }
}

// Re-exported so Swagger DTO parity tooling can import from the controller
// module without touching runtime wiring. Keeps CloneWorkspaceDto referenced
// (request-body shape mirrors cloneWorkspaceSchema 1:1).
export type { CloneWorkspaceDto };
