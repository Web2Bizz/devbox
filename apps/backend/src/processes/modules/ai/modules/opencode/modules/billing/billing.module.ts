import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";

/**
 * BillingModule — live upstream Zen Go usage for the caller's own key.
 * BillingService's store (VaultService, round-robin per provider) + decrypt
 * (CryptoService) come from the global CommonModule; ExternalClient/AppLogger
 * too — no explicit imports needed. The HTTP surface (GET /api/v1/usage) is
 * owned by BillingController in this module.
 */
@Module({
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
