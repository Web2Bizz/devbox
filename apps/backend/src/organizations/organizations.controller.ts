import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
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
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReqUser } from "../auth/req-user.decorator";
import type { RequestIdentity } from "../auth/identity.service";
import { NoIndexInterceptor } from "../common/http/noindex.interceptor";
import { ZodValidationPipe } from "../common/validation";
import {
  OrganizationDto,
  OrganizationInviteDto,
  OrganizationMemberDto,
  acceptInviteSchema,
  addMemberSchema,
  createInviteSchema,
  createOrganizationSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
  type AcceptInviteInput,
  type AddMemberInput,
  type CreateInviteInput,
  type CreateOrganizationInput,
  type UpdateMemberRoleInput,
  type UpdateOrganizationInput,
} from "./dto";
import { OrganizationsGuard } from "./organizations.guard";
import { OrganizationsService } from "./organizations.service";

/**
 * Organizations CRUD + membership + persistent single-use invites + project links.
 * Global 'api' prefix + URI versioning supply /api/v1 — controller
 * declares only the resource segment. Every route is Bearer-guarded
 * (JwtAuthGuard); the gated `:id` routes additionally run
 * OrganizationsGuard (method-level: GET → member, mutations → maintainer),
 * and the service enforces the same rules again (defense in depth).
 * Routes without an org id (create, list, invite accept) and the two 410
 * stubs are not gated — the stubs keep answering 410 to members and
 * strangers alike.
 * Responses are private (`X-Robots-Tag: noindex` via NoIndexInterceptor).
 * Invites are uuidv7 rows with no TTL (single-use, replay → 404).
 * Swagger annotations mirror contracts/openapi.yaml (organizations section).
 */
@ApiTags("organizations")
@Controller("organizations")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: "Create organization (caller becomes maintainer)" })
  @ApiResponse({ status: 201, type: OrganizationDto })
  @ApiResponse({ status: 400, description: "bad request (validation)" })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 404, description: "owner user not found" })
  @ApiResponse({ status: 500, description: "storage unconfigured (REPOS_ROOT empty)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async create(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationDto> {
    return (await this.orgs.create(body, identity.id, req?.correlationId)) as OrganizationDto;
  }

  @Get()
  @ApiOperation({ summary: "List organizations of the caller (membership-scoped)" })
  @ApiResponse({ status: 200, type: [OrganizationDto] })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async list(
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationDto[]> {
    return (await this.orgs.listForUser(identity.id, req?.correlationId)) as OrganizationDto[];
  }

  @Get(":id")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Get organization by id (members only)" })
  @ApiResponse({ status: 200, type: OrganizationDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 404, description: "not found (or not a member)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async get(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationDto> {
    return (await this.orgs.get(id, identity.id, req?.correlationId)) as OrganizationDto;
  }

  @Patch(":id")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Update organization settings (maintainer only)" })
  @ApiResponse({ status: 200, type: OrganizationDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (or not a member)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationInput,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationDto> {
    return (await this.orgs.update(id, identity.id, body, req?.correlationId)) as OrganizationDto;
  }

  @Delete(":id")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Delete organization (maintainer only, projects survive)" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (or not a member)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<void> {
    await this.orgs.remove(id, identity.id, req?.correlationId);
  }

  @Get(":id/members")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "List organization members (members only)" })
  @ApiResponse({ status: 200, type: [OrganizationMemberDto] })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 404, description: "not found (or not a member)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async members(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationMemberDto[]> {
    return (await this.orgs.listMembers(id, identity.id, req?.correlationId)) as OrganizationMemberDto[];
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
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationMemberDto> {
    return (await this.orgs.addMember(id, identity.id, body, req?.correlationId)) as OrganizationMemberDto;
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
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationMemberDto> {
    return (await this.orgs.changeRole(id, identity.id, userId, body, req?.correlationId)) as OrganizationMemberDto;
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
    @Req() req?: { correlationId?: string },
  ): Promise<void> {
    await this.orgs.removeMember(id, identity.id, userId, req?.correlationId);
  }

  @Post(":id/invites")
  @UseGuards(OrganizationsGuard)
  @ApiOperation({ summary: "Mint a persistent single-use invite (maintainer only, no TTL)" })
  @ApiResponse({ status: 201, type: OrganizationInviteDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (or not a member)" })
  @ApiResponse({ status: 409, description: "org already has a maintainer (maintainer-role invite)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  async createInvite(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createInviteSchema)) body: CreateInviteInput,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationInviteDto> {
    return (await this.orgs.createInvite(id, identity.id, body, req?.correlationId)) as OrganizationInviteDto;
  }

  @Post("invites/accept")
  @ApiOperation({ summary: "Accept a persistent single-use invite (uuidv7, no TTL)" })
  @ApiResponse({ status: 200, type: OrganizationMemberDto })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 404, description: "invite not found or already used" })
  @ApiResponse({ status: 409, description: "already a member, or org already has a maintainer" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @HttpCode(HttpStatus.OK)
  async acceptInvite(
    @Body(new ZodValidationPipe(acceptInviteSchema)) body: AcceptInviteInput,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<OrganizationMemberDto> {
    return (await this.orgs.acceptInvite(body, identity.id, req?.correlationId)) as OrganizationMemberDto;
  }

  @Post(":id/projects/:projectId")
  @ApiOperation({ summary: "Attach a project (removed — 1:1, 410)" })
  @ApiResponse({ status: 410, description: "link/unlink removed (1:1 model)" })
  @HttpCode(HttpStatus.GONE)
  async linkProject(): Promise<void> {
    throw new GoneException("project links removed — project belongs to exactly one org");
  }

  @Delete(":id/projects/:projectId")
  @ApiOperation({ summary: "Detach a project (removed — 1:1, 410)" })
  @ApiResponse({ status: 410, description: "link/unlink removed (1:1 model)" })
  @HttpCode(HttpStatus.GONE)
  async unlinkProject(): Promise<void> {
    throw new GoneException("project links removed — project belongs to exactly one org");
  }
}
