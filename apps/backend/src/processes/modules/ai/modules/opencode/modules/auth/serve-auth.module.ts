import { Module } from "@nestjs/common";
import { ServeAuthService } from "./serve-auth.service";

/**
 * ServeAuthModule — real-user gate for the session paths (non-uuid mock
 * identities → 401 before any durable/host work). Standalone (no imports).
 * Named ServeAuth* to avoid collision with the global auth module.
 */
@Module({
  providers: [ServeAuthService],
  exports: [ServeAuthService],
})
export class ServeAuthModule {}
