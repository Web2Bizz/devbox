import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
  ProjectDto,
  createProjectSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "./projects.dto";
import { ProjectsService } from "./projects.service";

/**
 * Canonical nested project surface — /organizations/:id/projects* belongs to
 * the projects domain (CoC §1.1: the data is served by projects, so the
 * routes live in their own `org-projects.controller.ts`, not in the
 * organizations controller and not mixed into ProjectsController).
 * Global 'api' prefix + URI versioning supply /api/v1; there is no router
 * prefix on the class — every method spells out its full path, so the URL
 * set is unchanged:
 *
 *   GET    /organizations/:id/projects (?includeDeleted, member-visible)
 *   POST   /organizations/:id/projects (orgId forced from path)
 *   GET    /organizations/:id/projects/:projectId (assertBelongs, mismatch → 404)
 *   PATCH/DELETE (soft) + POST .../restore (API only) + GET .../effective-config
 *
 * Membership enforced via ProjectAccessService.getRole (404 for strangers).
 * Class-level JwtAuthGuard + @ReqUser() identity only — there is no
 * user-id header/query/body to tamper with, and ownerId is always forced
 * from the Bearer identity. Responses are private (`X-Robots-Tag: noindex`
 * via NoIndexInterceptor). Swagger keeps @ApiTags("org-projects"), mirroring
 * contracts/openapi.yaml.
 */
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class OrgProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly access: ProjectAccessService,
  ) {}

  private async memberOrThrow(orgId: string, userId: string, correlationId?: string): Promise<void> {
    const role = await this.access.getRole(orgId, userId, correlationId);
    if (!role) {
      throw new NotFoundException(`Organization ${orgId} not found`);
    }
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
  ): Promise<Array<ProjectDto>> {
    await this.memberOrThrow(id, identity.id, correlationId);
    const flag = includeDeleted === "true" || includeDeleted === "1";
    return this.projects.list(correlationId, {
      orgId: id,
      includeDeleted: flag,
    });
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
    return this.projects.create(
      { ...body, orgId: id, ownerId: identity.id },
      correlationId,
    );
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
    return this.projects.assertProjectBelongsToOrg(id, projectId, correlationId, {
      includeDeleted: flag,
    });
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
    return this.projects.update(projectId, body, correlationId, { orgId: id });
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
    // includeDeleted keeps a repeated DELETE idempotent (204) instead of 404.
    await this.projects.assertProjectBelongsToOrg(id, projectId, correlationId, {
      includeDeleted: true,
    });
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
    return this.projects.restore(projectId, correlationId);
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
  ): Promise<Array<EffectiveConfigDto>> {
    await this.memberOrThrow(id, identity.id, correlationId);
    return (await this.projects.effectiveConfig(id, projectId, correlationId)) as Array<EffectiveConfigDto>;
  }
}
