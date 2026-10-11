import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
  Version,
} from "@nestjs/common";
import { ApiBearerAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { V1Endpoint } from "../api/version.js";
import { NoIndexInterceptor } from "../common/noindex.interceptor.js";
import { AuthUserDto } from "./auth.dto.js";
import { ReqUser } from "./req-user.decorator.js";
import type { RequestIdentity } from "./identity.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { UsersService, toPublicUser } from "./users.service.js";

/**
 * UsersController — minimal private profile read (Card 6 privacy).
 *
 * - GET /api/v1/users/:id returns the caller's OWN profile only:
 *   `req.user.id === :id`, otherwise 403 (another user's row is never
 *   returned — no enumeration oracle: the 403 fires before any DB lookup,
 *   so strangers cannot probe for account existence).
 * - Own-but-missing (deleted after token issue) → 404.
 * - Bearer-guarded (JwtAuthGuard, legacy mock fallback in dev).
 * - `X-Robots-Tag: noindex` via NoIndexInterceptor (private response).
 * Secrets never logged; error envelope stays { code, message, correlationId }.
 */
@ApiTags("users")
@Controller("users")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":id")
  @Version("1")
  @V1Endpoint("Get own user profile (403 for anyone else)")
  @ApiResponse({ status: 200, type: AuthUserDto })
  @ApiResponse({ status: 403, description: "not your profile" })
  @ApiResponse({ status: 404, description: "own profile missing" })
  async getOne(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() req?: { correlationId?: string },
  ): Promise<AuthUserDto> {
    if (identity.id !== id) {
      throw new ForbiddenException("Access denied");
    }
    const user = await this.users.findById(identity.id, req?.correlationId);
    if (!user) {
      throw new NotFoundException(`User ${identity.id} not found`);
    }
    return toPublicUser(user) as AuthUserDto;
  }
}
