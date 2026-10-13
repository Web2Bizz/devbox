import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { CryptoService } from "./crypto.service.js";
import { OpencodeBillingService } from "./opencode-billing.service.js";
import { OpencodeKeysController } from "./opencode-keys.controller.js";
import { OpencodeKeysService } from "./opencode-keys.service.js";

/**
 * OpencodeKeysModule — per-user OpenCode API keys (encrypted at rest) +
 * live per-user usage.
 *
 * JwtAuthGuard comes from the global AuthModule, ExternalClient/AppLogger
 * from the global CommonModule — only DbModule is imported explicitly.
 * Registered in AppModule imports.
 */
@Module({
  imports: [DbModule],
  controllers: [OpencodeKeysController],
  providers: [CryptoService, OpencodeKeysService, OpencodeBillingService],
  exports: [OpencodeKeysService, OpencodeBillingService, CryptoService],
})
export class OpencodeKeysModule {}
