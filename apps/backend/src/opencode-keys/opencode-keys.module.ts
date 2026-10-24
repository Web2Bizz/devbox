import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { CryptoService } from "./crypto.service";
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
 */
@Module({
  imports: [DbModule],
  controllers: [OpencodeKeysController],
  providers: [CryptoService, OpencodeKeysService, OpencodeBillingService],
  exports: [OpencodeKeysService, OpencodeBillingService, CryptoService],
})
export class OpencodeKeysModule {}
