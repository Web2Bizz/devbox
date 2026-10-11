import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
  Version,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard.js";
import { ReqUser } from "../../auth/req-user.decorator.js";
import type { RequestIdentity } from "../../auth/identity.service.js";
import { NoIndexInterceptor } from "../../common/noindex.interceptor.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { V1Endpoint } from "../../api/version.js";
import { SessionsService } from "./sessions.service.js";
import {
  ProjectSessionDto,
  createSessionSchema,
  type CreateSessionInput,
} from "./dto.js";

/**
 * Project sessions — Bearer-guarded (JwtAuthGuard, legacy mock fallback in
 * dev). Every op scopes through OrganizationsService.assertProjectAccess
 * (Card 5): org-linked projects admit any member of a linked org,
 * user-space projects admit only the owner; strangers get 404 (existence
 * is not leaked — no 403 enumeration oracle).
 */
@ApiTags("project-sessions")
@Controller("projects/:projectId/sessions")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @Version("1")
  @V1Endpoint("List project sessions")
  @ApiResponse({ status: 200, type: [ProjectSessionDto] })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  async list(
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectSessionDto[]> {
    return (await this.sessions.list(
      projectId,
      correlationId,
      identity.id,
    )) as ProjectSessionDto[];
  }

  @Post()
  @Version("1")
  @V1Endpoint("Create project session (binds projectId + optional chatId)")
  @ApiResponse({ status: 201, type: ProjectSessionDto })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  async create(
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(createSessionSchema)) body: CreateSessionInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectSessionDto> {
    return (await this.sessions.create(
      projectId,
      body,
      correlationId,
      identity.id,
    )) as ProjectSessionDto;
  }

  @Get(":sessionId")
  @Version("1")
  @V1Endpoint("Get project session")
  @ApiResponse({ status: 200, type: ProjectSessionDto })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  async get(
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectSessionDto> {
    return (await this.sessions.get(
      projectId,
      sessionId,
      correlationId,
      identity.id,
    )) as ProjectSessionDto;
  }

  @Patch(":sessionId/close")
  @Version("1")
  @V1Endpoint("Close project session")
  @ApiResponse({ status: 200, type: ProjectSessionDto })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  async close(
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectSessionDto> {
    return (await this.sessions.close(
      projectId,
      sessionId,
      correlationId,
      identity.id,
    )) as ProjectSessionDto;
  }
}
