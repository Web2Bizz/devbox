import { Module } from "@nestjs/common";
import { ServeAuthService } from "./serve-auth.service";

/**
 * ServeAuthModule — real-user gate for the serve paths (non-uuid mock
 * identities → 401 before any upstream call) + serveBasicAuthHeader
 * (server Basic from OPENCODE_PASSWORD, single source for all serve
 * paths). Standalone (no imports). Named ServeAuth* to avoid collision
 * with the global auth module.
 */
@Module({
  providers: [ServeAuthService],
  exports: [ServeAuthService],
})
export class ServeAuthModule {}
