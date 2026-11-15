import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { NoIndexInterceptor } from "@common/http/noindex.interceptor";
import { ReqUser } from "../auth/req-user.decorator";
import type { RequestIdentity } from "../auth/identity.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { UserDto } from "./users.dto";
import { UsersService, toPublicUser } from "./users.service";
import type { RequestCorrelation, StoredUser } from "./users.types";

/**
 * UsersController — minimal private profile read (Card 6 privacy).
 *
 * - GET /api/v1/users/:id returns the caller's OWN profile only:
 *   `identity.id === :id`, otherwise 403 (another user's row is never
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
  constructor(private readonly usersService: UsersService) {}

  @Get(":id")
  @ApiOperation({ summary: "Get own user profile (403 for anyone else)" })
  @ApiResponse({ status: 200, type: UserDto })
  @ApiResponse({ status: 403, description: "not your profile" })
  @ApiResponse({ status: 404, description: "own profile missing" })
  async getOne(
    @Param("id") id: string,
    @ReqUser() identity: RequestIdentity,
    @Req() request?: RequestCorrelation,
  ): Promise<UserDto> {
    if (identity.id !== id) {
      throw new ForbiddenException("Access denied");
    }
    // correlationId etalon: auth.controller.ts (`request?.correlationId`).
    const correlationId: string | undefined = request?.correlationId;
    const user: StoredUser | null = await this.usersService.findById(
      identity.id,
      correlationId,
    );
    if (!user) {
      throw new NotFoundException(`User ${identity.id} not found`);
    }
    return toPublicUser(user);
  }
}
