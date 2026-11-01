import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  Version,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReqUser } from "../auth/req-user.decorator";
import type { RequestIdentity } from "../auth/identity.service";
import { NoIndexInterceptor } from "../common/http/noindex.interceptor";
import { ZodValidationPipe } from "../common/validation";
import { V1Endpoint } from "../common/http/api/version";
import { OrganizationsService } from "./organizations.service";
import {
  ProjectDto,
  EffectiveConfigDto,
  createProjectSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "./modules/projects/dto";
import { ProjectsService } from "./modules/projects/projects.service";
import { ChatsService } from "./modules/projects/modules/chats/chats.service";
import { SessionsService } from "./modules/projects/modules/sessions/sessions.service";

/**
 * Canonical nested project surface (1:1 model):
 * GET /organizations/:id/projects (?includeDeleted, member-visible)
 * POST /organizations/:id/projects (orgId forced from path)
 * GET /:id/projects/:projectId (assertBelongs, mismatch → 404)
 * PATCH /:id/projects/:projectId, DELETE (soft), POST .../restore (API only).
 * Membership enforced via OrganizationsService.getRole (404 for strangers).
 */
@ApiTags("org-projects")
@Controller("organizations/:id/projects")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class OrgProjectsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly projects: ProjectsService,
    private readonly chats: ChatsService,
    private readonly sessions: SessionsService,
  ) {}

  private async memberOrThrow(orgId: string, userId: string, correlationId?: string): Promise<void> {
    const role = await this.orgs.getRole(orgId, userId, correlationId);
    if (!role) {
      const { NotFoundException } = await import("@nestjs/common");
      throw new NotFoundException(`Organization ${orgId} not found`);
    }
  }

  @Get()
  @Version("1")
  @V1Endpoint("List organization projects (canonical)")
  @ApiResponse({ status: 200, type: [ProjectDto] })
  async list(
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

  @Post()
  @Version("1")
  @V1Endpoint("Create project in organization")
  @ApiResponse({ status: 201, type: ProjectDto })
  async create(
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

  @Get(":projectId")
  @Version("1")
  @V1Endpoint("Get organization project (mismatch → 404)")
  @ApiResponse({ status: 200, type: ProjectDto })
  async get(
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

  @Patch(":projectId")
  @Version("1")
  @V1Endpoint("Update organization project")
  @ApiResponse({ status: 200, type: ProjectDto })
  async update(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    await this.memberOrThrow(id, identity.id, correlationId);
    return (await this.projects.update(projectId, body, correlationId, { orgId: id })) as ProjectDto;
  }

  @Delete(":projectId")
  @Version("1")
  @V1Endpoint("Soft-delete organization project (stops containers)")
  @ApiResponse({ status: 204 })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
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

  @Post(":projectId/restore")
  @Version("1")
  @V1Endpoint("Restore soft-deleted project (API only, no UI)")
  @ApiResponse({ status: 200, type: ProjectDto })
  async restore(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    await this.memberOrThrow(id, identity.id, correlationId);
    await this.projects.assertProjectBelongsToOrg(id, projectId, correlationId, { includeDeleted: true });
    return (await this.projects.restore(projectId, correlationId)) as ProjectDto;
  }

  @Get(":projectId/effective-config")
  @Version("1")
  @V1Endpoint("Effective config (project overrides org, secrets masked)")
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
