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
  UseInterceptors,
  Version,
} from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { NoIndexInterceptor } from "../common/noindex.interceptor.js";import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  GithubLinkStatusDto,
  ProjectDto,
  createProjectSchema,
  githubLinkSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type GithubLinkInput,
  type UpdateProjectInput,
} from "./dto.js";
import { V1Endpoint } from "../api/version.js";
import { GithubLinkService } from "./github-link.service.js";
import { ProjectsService } from "./projects.service.js";
import { ChatsService } from "./chats/chats.service.js";
import { SessionsService } from "./sessions/sessions.service.js";

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
  @V1Endpoint("List projects")
  @ApiResponse({ status: 200, type: [ProjectDto] })
  async list(
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto[]> {
    return (await this.projects.list(correlationId)) as ProjectDto[];
  }

  @Post()
  @Version("1")
  @V1Endpoint("Create project")
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
    "Link GitHub repository (format validation only, no tokens stored)",
  )
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, type: ProjectDto })
  async linkGithub(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(githubLinkSchema)) body: GithubLinkInput,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    return (await this.github.link(
      id,
      body,
      correlationId,
    )) as unknown as ProjectDto;
  }

  @Delete(":id/github-link")
  @Version("1")
  @V1Endpoint("Unlink GitHub repository")
  @ApiResponse({ status: 200, type: ProjectDto })
  async unlinkGithub(
    @Param("id") id: string,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectDto> {
    return (await this.github.unlink(
      id,
      correlationId,
    )) as unknown as ProjectDto;
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
