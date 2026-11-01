import { Module } from "@nestjs/common";
import { CryptoModule } from "../../../../../common/crypto/crypto.module";
import { KeysModule } from "../../../../../common/keys/keys.module";
import { BillingService } from "./billing.service";

/**
 * BillingModule — live upstream Zen Go usage for the caller's own key.
 * Imports KeysModule (store) + CryptoModule (decrypt) from common (crypto +
 * keys modules); ExternalClient comes from the global CommonModule.
 */
@Module({
  imports: [KeysModule, CryptoModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
