import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { CryptoService } from "./crypto.service";
import { OpencodeAuthService } from "./opencode-auth.service";
import { OpencodeBillingService } from "./opencode-billing.service";
import { OpencodeKeysController } from "./opencode-keys.controller";
import { OpencodeKeysService } from "./opencode-keys.service";

/**
 * OpencodeKeysModule — per-user OpenCode API keys (encrypted at rest) +
 * live per-user usage.
 *
 * JwtAuthGuard comes from the global AuthModule, ExternalClient/AppLogger
 * from the global CommonModule — only DbModule is imported explicitly.
 * Registered in AppModule imports.
 *
 * OpencodeAuthService (real-user gate for the serve paths + the shared
 * serveBasicAuthHeader: server Basic from OPENCODE_PASSWORD) is exported
 * alongside the store so the upstream auth path (OpencodeSdkClient,
 * ProxyService) shares the one source instead of reimplementing it.
 * Billing keeps its own findByUserId → decrypt lookup and never uses it.
 */
@Module({
  imports: [DbModule],
  controllers: [OpencodeKeysController],
  providers: [CryptoService, OpencodeKeysService, OpencodeBillingService, OpencodeAuthService],
  exports: [OpencodeKeysService, OpencodeBillingService, CryptoService, OpencodeAuthService],
})
export class OpencodeKeysModule {}
