import { Module } from "@nestjs/common";
import { CryptoModule } from "../../../../../organizations/modules/crypto/crypto.module";
import { KeysModule } from "../../../../../organizations/modules/keys/keys.module";
import { BillingService } from "./billing.service";

/**
 * BillingModule — live upstream Zen Go usage for the caller's own key.
 * Imports KeysModule (store) + CryptoModule (decrypt) from the
 * organizations modules (orgs own provider keys/tokens); ExternalClient
 * comes from the global CommonModule.
 */
@Module({
  imports: [KeysModule, CryptoModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
