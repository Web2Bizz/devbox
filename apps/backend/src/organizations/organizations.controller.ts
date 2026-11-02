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
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReqUser } from "../auth/req-user.decorator";
import type { RequestIdentity } from "../auth/identity.service";
import { NoIndexInterceptor } from "../common/http/noindex.interceptor";
import { ZodValidationPipe } from "../common/validation";
import {
  OrganizationDto,
  createOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
} from "./organizations.dto";
import { OrganizationsGuard } from "./organizations.guard";
import { OrganizationsService } from "./organizations.service";

/**
 * Organizations CRUD — exactly one entity (CoC §1.1). Membership lives in
 * `modules/members/members.controller.ts`, invites in
 * `modules/invites/invites.controller.ts` and the project surfaces in
 * `modules/projects/` (ProjectsController + OrgProjectsController).
 * Global 'api' prefix + URI versioning supply /api/v1 — controller
 * declares only the resource segment, so the URLs are unchanged:
 * POST/GET /organizations, GET/PATCH/DELETE /organizations/:id.
 * Every route is Bearer-guarded (JwtAuthGuard); the gated `:id` routes
 * additionally run OrganizationsGuard (method-level: GET → member,
 * mutations → maintainer), and the service enforces the same rules again
 * (defense in depth). Routes without an org id (create, list) are not
 * gated. Responses are private (`X-Robots-Tag: noindex` via
 * NoIndexInterceptor). Swagger annotations mirror contracts/openapi.yaml
 * (organizations section).
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
}
