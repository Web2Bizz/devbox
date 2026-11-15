import { Module } from '@nestjs/common';
import { VaultController } from './vault.controller';
import { VaultOrganizationsModule } from './modules/organizations/vault-organizations.module';

/**
 * VaultModule — HTTP surface for the per-consumer vault store.
 *
 * VaultService/VaultRepository come from the global CommonModule (registered
 * there once). The user resource is served by VaultController; the
 * organization scope lives in its own nested module (CoC §1.1) so each
 * controller owns exactly one resource.
 */
@Module({
  imports: [VaultOrganizationsModule],
  controllers: [VaultController],
})
export class VaultModule {}
