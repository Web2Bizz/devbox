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
  Version,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { NoIndexInterceptor } from "../../common/http/noindex.interceptor";import { ZodValidationPipe } from "../../common/validation";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { ReqUser } from "../../auth/req-user.decorator";
import type { RequestIdentity } from "../../auth/identity.service";
import { OrganizationsService } from "../../organizations/organizations.service";
import {
  GithubLinkStatusDto,
  ProjectDto,
  createProjectSchema,
  githubLinkSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type GithubLinkInput,
  type UpdateProjectInput,
} from "./dto";
import { V1Endpoint } from "../../common/http/api/version";
import { GithubLinkService } from "./github-link/github-link.service";
import { ProjectsService } from "./projects.service";
import { ChatsService } from "./chats/chats.service";
import { SessionsService } from "./sessions/sessions.service";

/**
 * Projects CRUD + github link endpoints.
 * Global 'api' prefix + URI versioning supply /api/v1 — controller
 * declares only the resource segment.
 *
 * Security (Card C1, reuse of the Card 5 access layer):
 * - Class-level JwtAuthGuard + @ReqUser() identity only — there is no
 *   user-id header/query/body to tamper with (same rule as
 *   OpencodeKeysController.ownUserId: userId comes from the Bearer only).
 * - POST create forces ownerId = identity.id (a body ownerId is ignored,
 *   never trusted) — new rows always carry a real owner (no ownerless
 *   rows; see C5 deny-by-default).
 * - GET/PATCH/DELETE :id (+ github status) gate through
 *   OrganizationsService.assertProjectAccess (org-linked → member,
 *   user-space → owner; strangers → 404, no existence leak — the same
 *   no-enumeration rule as OrgProjectsController.memberOrThrow).
 * - Anonymous → 401 from the guard (before any DB touch).
 */
@ApiTags("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly github: GithubLinkService,
    private readonly chats: ChatsService,
    private readonly sessions: SessionsService,
    private readonly orgs: OrganizationsService,
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
    await this.orgs.assertProjectAccess(
      project.id,
      project.ownerId,
      userId,
      correlationId,
    );
    return project;
  }

  @Get()
  @Version("1")
  @V1Endpoint("List projects (org-scoped — use /organizations/:id/projects)")
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

  @Post()
  @Version("1")
  @V1Endpoint("Create project (use nested POST /organizations/:id/projects)")
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

  @Get(":id")
  @Version("1")
  @V1Endpoint("Get project by id")
  @ApiResponse({ status: 200, type: ProjectDto })
  async get(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    const project = await this.assertAccess(id, identity.id, correlationId);
    return project as unknown as ProjectDto;
  }

  @Patch(":id")
  @Version("1")
  @V1Endpoint("Update project")
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

  @Delete(":id")
  @Version("1")
  @V1Endpoint("Delete project (cascades chats/sessions)")
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

  @Post(":id/github-link")
  @Version("1")
  @V1Endpoint(
    "Link GitHub repository (removed — project github fields are authoritative)",
  )
  @HttpCode(HttpStatus.GONE)
  async linkGithub(): Promise<never> {
    throw new GoneException(
      "github-link removed — set githubOwner/githubRepo via PATCH (410, see /organizations/:id/projects/:projectId)",
    );
  }

  @Delete(":id/github-link")
  @Version("1")
  @V1Endpoint("Unlink GitHub repository (removed)")
  @HttpCode(HttpStatus.GONE)
  async unlinkGithub(): Promise<never> {
    throw new GoneException(
      "github-link removed — clear githubOwner/githubRepo via PATCH (410)",
    );
  }

  @Get(":id/github-link")
  @Version("1")
  @V1Endpoint("GitHub link status")
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
