import { Module } from "@nestjs/common";
import { BillingService } from "./billing.service";

/**
 * BillingModule — live upstream Zen Go usage for the caller's own key.
 * BillingService's store (OpencodeKeysService) + decrypt (CryptoService)
 * come from the global CommonModule; ExternalClient/AppLogger too — no
 * explicit imports needed.
 */
@Module({
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
