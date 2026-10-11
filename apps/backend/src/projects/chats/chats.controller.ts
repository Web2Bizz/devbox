import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
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
import { ChatsService } from "./chats.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import {
  ProjectChatDto,
  createChatSchema,
  type CreateChatInput,
} from "./dto.js";

/**
 * Project chats — Bearer-guarded (JwtAuthGuard, legacy mock fallback in
 * dev). User-facing ops scope through
 * OrganizationsService.assertProjectAccess (Card 5): org-linked projects
 * admit any member of a linked org, user-space projects admit only the
 * owner; strangers get 404 (existence is not leaked).
 */
@ApiTags("project-chats")
@Controller("projects/:projectId/chats")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class ChatsController {
  constructor(
    private readonly chats: ChatsService,
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  @Version("1")
  @V1Endpoint("List project chats")
  @ApiResponse({ status: 200, type: [ProjectChatDto] })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  async list(
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectChatDto[]> {
    return (await this.chats.list(
      projectId,
      correlationId,
      identity.id,
    )) as ProjectChatDto[];
  }

  @Post()
  @Version("1")
  @V1Endpoint("Create project chat")
  @ApiResponse({ status: 201, type: ProjectChatDto })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  async create(
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(createChatSchema)) body: CreateChatInput,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<ProjectChatDto> {
    return (await this.chats.create(
      projectId,
      body,
      correlationId,
      identity.id,
    )) as ProjectChatDto;
  }

  @Delete(":chatId")
  @Version("1")
  @V1Endpoint("Delete project chat")
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: "not found (or no access)" })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("projectId") projectId: string,
    @Param("chatId") chatId: string,
    @ReqUser() identity: RequestIdentity,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<void> {
    // Sessions survive with chat_id → NULL (FK SET NULL on Postgres;
    // explicit detach keeps explicit-delete paths consistent).
    await this.chats.remove(projectId, chatId, correlationId, identity.id);
    await this.sessions.detachChat(chatId, correlationId);
  }
}
