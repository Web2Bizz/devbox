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

/**
 * Top-level project surface — /projects* only (CoC §1.1: the canonical
 * nested /organizations/:id/projects* surface lives in its own
 * `org-projects.controller.ts`, so one controller serves one entity).
 *
 * 1. /projects CRUD + github link endpoints.
 *    Global 'api' prefix + URI versioning supply /api/v1.
 *
 * There is no router prefix on the class: every method spells out its full
 * path, so the URL set is unchanged. Methods keep the former declaration
 * order — Express registers routes in declaration order.
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
 * Swagger keeps @ApiTags("projects") on every method.
 */
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly github: GithubLinkService,
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
    opts?: { includeDeleted?: boolean },
  ) {
    const project = await this.projects.getOrThrow(projectId, correlationId, opts);
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
    await this.memberOrThrow(body.orgId, identity.id, correlationId);
    // ownerId is never trusted from the body — the row is always owned by
    // the Bearer identity (same ownUserId doctrine as OpencodeKeysController).
    return this.projects.create(
      { ...body, ownerId: identity.id },
      correlationId,
    );
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
    return project;
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
    return this.projects.update(id, body, correlationId);
  }

  @ApiTags("projects")
  @Delete("projects/:id")
  @ApiOperation({ summary: "Soft-delete project (rows are never physically removed)" })
  @ApiResponse({ status: 204 })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    // Gate first (404 for strangers), then the single soft-delete write.
    // Chats/sessions are owned by the project: they are not touched here and
    // hide together with the project (no physical DELETE anywhere). The gate
    // includes deleted rows so a repeated DELETE stays idempotent (204).
    await this.assertAccess(id, identity.id, correlationId, {
      includeDeleted: true,
    });
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
}
