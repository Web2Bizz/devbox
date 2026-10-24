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
  Version,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReqUser } from "../auth/req-user.decorator";
import type { RequestIdentity } from "../auth/identity.service";
import { NoIndexInterceptor } from "../common/noindex.interceptor";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { V1Endpoint } from "../api/version";
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
import { OrganizationsService } from "./organizations.service";

/**
 * Organizations CRUD + membership + persistent single-use invites + project links.
 * Global 'api' prefix + URI versioning supply /api/v1 — controller
 * declares only the resource segment. Every route is Bearer-guarded
 * (JwtAuthGuard); the service enforces member-only reads (404 for
 * strangers) and maintainer-only mutations (403 for plain members).
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
  @Version("1")
  @V1Endpoint("Create organization (caller becomes maintainer)")
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
  @Version("1")
  @V1Endpoint("List organizations of the caller (membership-scoped)")
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
  @Version("1")
  @V1Endpoint("Get organization by id (members only)")
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
  @Version("1")
  @V1Endpoint("Update organization settings (maintainer only)")
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
  @Version("1")
  @V1Endpoint("Delete organization (maintainer only, projects survive)")
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
  @Version("1")
  @V1Endpoint("List organization members (members only)")
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
  @Version("1")
  @V1Endpoint("Add organization member (maintainer only)")
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
  @Version("1")
  @V1Endpoint("Change member role (maintainer only)")
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
  @Version("1")
  @V1Endpoint("Remove organization member (maintainer only, never the last maintainer)")
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
  @Version("1")
  @V1Endpoint("Mint a persistent single-use invite (maintainer only, no TTL)")
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
  @Version("1")
  @V1Endpoint("Accept a persistent single-use invite (uuidv7, no TTL)")
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
  @Version("1")
  @V1Endpoint("Attach a project to the organization (maintainer only)")
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (org, membership, or project)" })
  @ApiResponse({ status: 409, description: "project is already linked to this organization" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @HttpCode(HttpStatus.NO_CONTENT)
  async linkProject(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<void> {
    await this.orgs.linkProject(id, identity.id, projectId, req?.correlationId);
  }

  @Delete(":id/projects/:projectId")
  @Version("1")
  @V1Endpoint("Detach a project from the organization (maintainer only)")
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 403, description: "member without the maintainer role" })
  @ApiResponse({ status: 404, description: "not found (org, membership, or link row)" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkProject(
    @Param("id") id: string,
    @Param("projectId") projectId: string,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<void> {
    await this.orgs.unlinkProject(id, identity.id, projectId, req?.correlationId);
  }
}
