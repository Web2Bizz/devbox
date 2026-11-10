import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../auth/jwt-auth.guard";
import { ReqUser } from "../../../auth/req-user.decorator";
import type { RequestIdentity } from "../../../auth/identity.service";
import { NoIndexInterceptor } from "@common/http/noindex.interceptor";
import { ZodValidationPipe } from "@common/validation";
import {
  OrganizationMemberDto,
  addMemberSchema,
  updateMemberRoleSchema,
  type AddMemberInput,
  type UpdateMemberRoleInput,
} from "../../organizations.dto";
import { OrganizationsGuard } from "../../organizations.guard";
import { MembersService } from "./members.service";

/**
 * Organization membership HTTP surface — members only (CoC §1.1: the
 * controller serves exactly one entity, so members routes no longer sit in
 * OrganizationsController).
 * Global 'api' prefix + URI versioning supply /api/v1 — the controller
 * declares only the resource segment, so the URLs are unchanged:
 * GET/POST /organizations/:id/members, PATCH/DELETE
 * /organizations/:id/members/:userId.
 * Every route is Bearer-guarded (JwtAuthGuard); the gated `:id` routes
 * additionally run OrganizationsGuard (method-level: GET → member,
 * mutations → maintainer), and MembersService enforces the same rules again
 * (defense in depth). Responses are private (`X-Robots-Tag: noindex` via
 * NoIndexInterceptor). Swagger tags stay "organizations", mirroring
 * contracts/openapi.yaml.
 */
@ApiTags("organizations")
@Controller("organizations")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get(":id/members")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "List organization members (members only)" })
  @ApiResponse({ status: 200, type: [OrganizationMemberDto] })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 404, description: "not found (or not a member)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async listMembers(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<Array<OrganizationMemberDto>> {
    return (await this.members.listMembers(id, identity.id, request?.correlationId)) as Array<OrganizationMemberDto>;
  }

  @Post(":id/members")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Add organization member (maintainer only)" })
  @ApiResponse({ status: 201, type: OrganizationMemberDto })
  @ApiResponse({ status: 400, description: "bad request (validation)" })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (org, membership, or target user)" })
  @ApiResponse({ status: 409, description: "already a member, or org already has a maintainer" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async addMember(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<OrganizationMemberDto> {
    return (await this.members.addMember(id, identity.id, body, request?.correlationId)) as OrganizationMemberDto;
  }

  @Patch(":id/members/:userId")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Change member role (maintainer only)" })
  @ApiResponse({ status: 200, type: OrganizationMemberDto })
  @ApiResponse({ status: 400, description: "cannot demote the last maintainer (also validation)" })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (org, membership, or target member)" })
  @ApiResponse({ status: 409, description: "org already has a maintainer" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async changeRole(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<OrganizationMemberDto> {
    return (await this.members.changeRole(
      id,
      identity.id,
      userId,
      body,
      request?.correlationId,
    )) as OrganizationMemberDto;
  }

  @Delete(":id/members/:userId")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Remove organization member (maintainer only, never the last maintainer)" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 400, description: "cannot remove the last maintainer (also validation)" })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (org, membership, or target member)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: { correlationId?: string },
  ): Promise<void> {
    await this.members.removeMember(id, identity.id, userId, request?.correlationId);
  }
}
