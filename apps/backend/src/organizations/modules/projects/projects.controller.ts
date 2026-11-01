import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { NoIndexInterceptor } from "../../../common/http/noindex.interceptor";
import { ZodValidationPipe } from "../../../common/validation";
import { JwtAuthGuard } from "../../../auth/jwt-auth.guard";
import { ReqUser } from "../../../auth/req-user.decorator";
import type { RequestIdentity } from "../../../auth/identity.service";
import { ProjectAccessService } from "./modules/project-access/project-access.service";
import {
  EffectiveConfigDto,
  GithubLinkStatusDto,
  ProjectDto,
  createProjectSchema,
  githubLinkSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type GithubLinkInput,
  type UpdateProjectInput,
} from "./projects.dto";
import { GithubLinkService } from "./modules/github/github-link.service";
import { ProjectsService } from "./projects.service";
import { ChatsService } from "./modules/chats/chats.service";
import { SessionsService } from "./modules/sessions/sessions.service";

/**
 * The single projects controller — serves BOTH project surfaces (one
 * controller per module, CODE_OF_CONDUCT):
 *
 * 1. Top-level: /projects CRUD + github link endpoints.
 *    Global 'api' prefix + URI versioning supply /api/v1.
 * 2. Canonical nested (1:1 model):
 *    GET /organizations/:id/projects (?includeDeleted, member-visible)
 *    POST /organizations/:id/projects (orgId forced from path)
 *    GET /organizations/:id/projects/:projectId (assertBelongs, mismatch → 404)
 *    PATCH/DELETE (soft) + POST .../restore (API only) + GET .../effective-config.
 *    Membership enforced via ProjectAccessService.getRole (404 for strangers).
 *
 * There is no router prefix on the class: every method spells out its full
 * path, so the URL set is exactly the union of the two former controllers.
 * Methods are ordered former-top-level first, then former-nested — Express
 * registers routes in declaration order.
 *
 * Security (Card C1, reuse of the Card 5 access layer):
 * - Class-level JwtAuthGuard + @ReqUser() identity only — there is no
 *   user-id header/query/body to tamper with (same rule as
 *   OpencodeKeysController.ownUserId: userId comes from the Bearer only).
 * - POST create forces ownerId = identity.id (a body ownerId is ignored,
 *   never trusted) — new rows always carry a real owner (no ownerless
 *   rows; see C5 deny-by-default).
 * - GET/PATCH/DELETE :id (+ github status) gate through
 *   ProjectAccessService.assertProjectAccess (org-linked → member,
 *   user-space → owner; strangers → 404, no existence leak — the same
 *   no-enumeration rule as memberOrThrow).
 * - Anonymous → 401 from the guard (before any DB touch).
 *
 * Swagger keeps the two former groups: @ApiTags("projects") on the
 * top-level methods, @ApiTags("org-projects") on the nested ones.
 */
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly github: GithubLinkService,
    private readonly chats: ChatsService,
    private readonly sessions: SessionsService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Top-level :id gate (reuse, not a new rule): load the row, then run the
   * shared Card 5 gate — org-linked projects admit any member of a linked
   * org, user-space projects admit only the owner; strangers get 404.
   */
  private async assertAccess(
    projectId: string,
    userId: string,
    correlationId?: string,
  ) {
    const project = await this.projects.getOrThrow(projectId, correlationId);
    await this.access.assertProjectAccess(
      project.id,
      project.ownerId,
      userId,
      correlationId,
    );
    return project;
  }

  private async memberOrThrow(orgId: string, userId: string, correlationId?: string): Promise<void> {
    const role = await this.access.getRole(orgId, userId, correlationId);
    if (!role) {
      const { NotFoundException } = await import("@nestjs/common");
      throw new NotFoundException(`Organization ${orgId} not found`);
    }
  }

  @ApiTags("projects")
  @Get("projects")
  @ApiOperation({ summary: "List projects (org-scoped — use /organizations/:id/projects)" })
  @ApiResponse({ status: 200, type: [ProjectDto] })
  async list(
    @Headers("x-correlation-id") correlationId?: string,
    @Query("orgId") _orgId?: string,
  ): Promise<ProjectDto[]> {
    // Canonical list is GET /organizations/:id/projects. The global list
    // cannot guess an org (no fallback to first org) → 400 ORG_REQUIRED.
    throw new BadRequestException({
      code: "ORG_REQUIRED",
      message: "orgId is required — list via GET /api/v1/organizations/:id/projects",
    });
  }

  @ApiTags("projects")
  @Post("projects")
  @ApiOperation({ summary: "Create project (use nested POST /organizations/:id/projects)" })
  @ApiResponse({ status: 201, type: ProjectDto })
  async create(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    // ownerId is never trusted from the body — the row is always owned by
    // the Bearer identity (same ownUserId doctrine as OpencodeKeysController).
    return (await this.projects.create(
      { ...body, ownerId: identity.id },
      correlationId,
    )) as ProjectDto;
  }

  @ApiTags("projects")
  @Get("projects/:id")
  @ApiOperation({ summary: "Get project by id" })
  @ApiResponse({ status: 200, type: ProjectDto })
  async get(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    const project = await this.assertAccess(id, identity.id, correlationId);
    return project as unknown as ProjectDto;
  }

  @ApiTags("projects")
  @Patch("projects/:id")
  @ApiOperation({ summary: "Update project" })
  @ApiResponse({ status: 200, type: ProjectDto })
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    await this.assertAccess(id, identity.id, correlationId);
    return (await this.projects.update(id, body, correlationId)) as ProjectDto;
  }

  @ApiTags("projects")
  @Delete("projects/:id")
  @ApiOperation({ summary: "Delete project (cascades chats/sessions)" })
  @ApiResponse({ status: 204 })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    // Gate first (404 for strangers), then the explicit cascade + row.
    // (Postgres FK cascade covers any leftovers).
    await this.assertAccess(id, identity.id, correlationId);
    await this.sessions.removeByProject(id, correlationId);
    await this.chats.removeByProject(id, correlationId);
    await this.projects.remove(id, correlationId);
  }

  @ApiTags("projects")
  @Post("projects/:id/github-link")
  @ApiOperation({ summary: "Link GitHub repository (removed — project github fields are authoritative)" })
  @HttpCode(HttpStatus.GONE)
  async linkGithub(): Promise<never> {
    throw new GoneException(
      "github-link removed — set githubOwner/githubRepo via PATCH (410, see /organizations/:id/projects/:projectId)",
    );
  }

  @ApiTags("projects")
  @Delete("projects/:id/github-link")
  @ApiOperation({ summary: "Unlink GitHub repository (removed)" })
  @HttpCode(HttpStatus.GONE)
  async unlinkGithub(): Promise<never> {
    throw new GoneException(
      "github-link removed — clear githubOwner/githubRepo via PATCH (410)",
    );
  }

  @ApiTags("projects")
  @Get("projects/:id/github-link")
  @ApiOperation({ summary: "GitHub link status" })
  @ApiResponse({ status: 200, type: GithubLinkStatusDto })
  async githubStatus(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubLinkStatusDto> {
    await this.assertAccess(id, identity.id, correlationId);
    return (await this.github.status(id, correlationId)) as GithubLinkStatusDto;
  }

  @ApiTags("org-projects")
  @Get("organizations/:id/projects")
  @ApiOperation({ summary: "List organization projects (canonical)" })
  @ApiResponse({ status: 200, type: [ProjectDto] })
  async listOrgProjects(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
    @Query("includeDeleted") includeDeleted?: string,
  ): Promise<ProjectDto[]> {
    await this.memberOrThrow(id, identity.id, correlationId);
    const flag = includeDeleted === "true" || includeDeleted === "1";
    return (await this.projects.list(correlationId, {
      orgId: id,
      includeDeleted: flag,
    })) as ProjectDto[];
  }

  @ApiTags("org-projects")
  @Post("organizations/:id/projects")
  @ApiOperation({ summary: "Create project in organization" })
  @ApiResponse({ status: 201, type: ProjectDto })
  async createOrgProject(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    await this.memberOrThrow(id, identity.id, correlationId);
    // ownerId is never trusted from the body — the row is always owned by
    // the Bearer identity (same rule as top-level POST /projects, C1).
    return (await this.projects.create(
      { ...body, orgId: id, ownerId: identity.id },
      correlationId,
    )) as ProjectDto;
  }

  @ApiTags("org-projects")
  @Get("organizations/:id/projects/:projectId")
  @ApiOperation({ summary: "Get organization project (mismatch → 404)" })
  @ApiResponse({ status: 200, type: ProjectDto })
  async getOrgProject(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
    @Query("includeDeleted") includeDeleted?: string,
  ): Promise<ProjectDto> {
    await this.memberOrThrow(id, identity.id, correlationId);
    const flag = includeDeleted === "true" || includeDeleted === "1";
    return (await this.projects.assertProjectBelongsToOrg(id, projectId, correlationId, {
      includeDeleted: flag,
    })) as unknown as ProjectDto;
  }

  @ApiTags("org-projects")
  @Patch("organizations/:id/projects/:projectId")
  @ApiOperation({ summary: "Update organization project" })
  @ApiResponse({ status: 200, type: ProjectDto })
  async updateOrgProject(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    await this.memberOrThrow(id, identity.id, correlationId);
    return (await this.projects.update(projectId, body, correlationId, { orgId: id })) as ProjectDto;
  }

  @ApiTags("org-projects")
  @Delete("organizations/:id/projects/:projectId")
  @ApiOperation({ summary: "Soft-delete organization project (stops containers)" })
  @ApiResponse({ status: 204 })
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOrgProject(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    await this.memberOrThrow(id, identity.id, correlationId);
    await this.projects.assertProjectBelongsToOrg(id, projectId, correlationId);
    await this.sessions.removeByProject(projectId, correlationId);
    await this.chats.removeByProject(projectId, correlationId);
    await this.projects.remove(projectId, correlationId);
  }

  @ApiTags("org-projects")
  @Post("organizations/:id/projects/:projectId/restore")
  @ApiOperation({ summary: "Restore soft-deleted project (API only, no UI)" })
  @ApiResponse({ status: 200, type: ProjectDto })
  async restoreOrgProject(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    await this.memberOrThrow(id, identity.id, correlationId);
    await this.projects.assertProjectBelongsToOrg(id, projectId, correlationId, { includeDeleted: true });
    return (await this.projects.restore(projectId, correlationId)) as ProjectDto;
  }

  @ApiTags("org-projects")
  @Get("organizations/:id/projects/:projectId/effective-config")
  @ApiOperation({ summary: "Effective config (project overrides org, secrets masked)" })
  @ApiResponse({ status: 200, type: [EffectiveConfigDto] })
  async effectiveConfig(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<EffectiveConfigDto[]> {
    await this.memberOrThrow(id, identity.id, correlationId);
    return (await this.projects.effectiveConfig(id, projectId, correlationId)) as EffectiveConfigDto[];
  }
}
