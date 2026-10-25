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
  UseInterceptors,
  Version,
} from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { NoIndexInterceptor } from "../common/noindex.interceptor";import { ZodValidationPipe } from "../common/zod-validation.pipe";
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
import { V1Endpoint } from "../api/version";
import { GithubLinkService } from "./github-link.service";
import { ProjectsService } from "./projects.service";
import { ChatsService } from "./chats/chats.service";
import { SessionsService } from "./sessions/sessions.service";

/**
 * Projects CRUD + github link endpoints.
 * Global 'api' prefix + URI versioning supply /api/v1 — controller
 * declares only the resource segment.
 */
@ApiTags("projects")
@Controller("projects")
@UseInterceptors(NoIndexInterceptor)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly github: GithubLinkService,
    private readonly chats: ChatsService,
    private readonly sessions: SessionsService,
  ) {}

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
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    return (await this.projects.create(body, correlationId)) as ProjectDto;
  }

  @Get(":id")
  @Version("1")
  @V1Endpoint("Get project by id")
  @ApiResponse({ status: 200, type: ProjectDto })
  async get(
    @Param("id") id: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    return (await this.projects.getOrThrow(id, correlationId)) as ProjectDto;
  }

  @Patch(":id")
  @Version("1")
  @V1Endpoint("Update project")
  @ApiResponse({ status: 200, type: ProjectDto })
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    return (await this.projects.update(id, body, correlationId)) as ProjectDto;
  }

  @Delete(":id")
  @Version("1")
  @V1Endpoint("Delete project (cascades chats/sessions)")
  @ApiResponse({ status: 204 })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id") id: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    // Explicit cascade first, then the project row itself
    // (Postgres FK cascade covers any leftovers).
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
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<GithubLinkStatusDto> {
    return (await this.github.status(id, correlationId)) as GithubLinkStatusDto;
  }
}
