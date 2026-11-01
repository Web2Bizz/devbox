import { Module } from "@nestjs/common";
import { CryptoService } from "./crypto.service";

/**
 * CryptoModule — AES-256-GCM envelope for per-user OpenCode API keys.
 * Standalone (no imports); exports CryptoService for keys/billing.
 */
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
