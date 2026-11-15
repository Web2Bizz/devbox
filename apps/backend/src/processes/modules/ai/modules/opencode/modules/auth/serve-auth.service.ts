import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AppLogger } from "@common/logger";
import { uuidSchema } from "@common/validation";

/**
 * ServeAuthService — real-user gate for the session paths.
 *
 * Keeps exactly one job: reject non-uuid caller ids (mock identities like
 * 'default') with 401 `unauthorized` / "Authentication required" BEFORE any
 * durable or host work, so only real users reach sessions. The legacy server
 * Basic password is gone with the embedded runner — the embedded host needs
 * no upstream credentials.
 * Billing is untouched — BillingService keeps its own vault pick → decrypt
 * lookup and never used this service.
 */
@Injectable()
export class ServeAuthService {
  constructor(
    private readonly logger: AppLogger = new AppLogger(ServeAuthService.name),
  ) {}

  assertServeUser(userId: string, correlationId?: string): void {
    if (!uuidSchema.safeParse(userId).success) {
      this.logger.debug("[serve-auth] non-uuid identity status=401 code=unauthorized", correlationId);
      throw new UnauthorizedException({
        code: "unauthorized",
        message: "Authentication required",
      });
    }
  }
}
