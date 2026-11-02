import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../auth/jwt-auth.guard";
import { ReqUser } from "../../../auth/req-user.decorator";
import type { RequestIdentity } from "../../../auth/identity.service";
import { NoIndexInterceptor } from "../../../common/http/noindex.interceptor";
import { ZodValidationPipe } from "../../../common/validation";
import {
  OrganizationInviteDto,
  OrganizationMemberDto,
  acceptInviteSchema,
  createInviteSchema,
  type AcceptInviteInput,
  type CreateInviteInput,
} from "../../organizations.dto";
import { OrganizationsGuard } from "../../organizations.guard";
import { InvitesService } from "./invites.service";

/**
 * Organization invites HTTP surface — persistent single-use uuidv7 invites
 * (CoC §1.1: invites no longer sit in OrganizationsController).
 * Global 'api' prefix + URI versioning supply /api/v1 — the controller
 * declares only the resource segment, so the URLs are unchanged:
 * POST /organizations/:id/invites (maintainer) and
 * POST /organizations/invites/accept (any session user).
 * Every route is Bearer-guarded (JwtAuthGuard); minting additionally runs
 * OrganizationsGuard (maintainer), and InvitesService enforces the same rule
 * again (defense in depth). Accept carries no org id in the path, so it is
 * not gated — the token itself scopes the org. Responses are private
 * (`X-Robots-Tag: noindex` via NoIndexInterceptor). Swagger tags stay
 * "organizations", mirroring contracts/openapi.yaml.
 */
@ApiTags("organizations")
@Controller("organizations")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

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
    return (await this.invites.createInvite(
      id,
      identity.id,
      body,
      req?.correlationId,
    )) as OrganizationInviteDto;
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
    return (await this.invites.acceptInvite(
      body,
      identity.id,
      req?.correlationId,
    )) as OrganizationMemberDto;
  }

  @Post("invites/deny")
  @ApiOperation({ summary: "Deny a persistent single-use invite (uuidv7, no TTL)" })
  @ApiResponse({ status: 200, description: "invite denied" })
  @ApiResponse({ status: 401, description: "missing/invalid bearer" })
  @ApiResponse({ status: 404, description: "invite not found or already used" })
  @ApiResponse({ status: 503, description: "postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)" })
  @HttpCode(HttpStatus.OK)
  async denyInvite(): Promise<object | null> {
    return null
  }
}
