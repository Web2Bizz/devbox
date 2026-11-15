import { Module } from '@nestjs/common';
import { OrganizationsGuard } from '../../../organizations/organizations.guard';
import { VaultOrganizationsController } from './vault-organizations.controller';

/**
 * VaultOrganizationsModule — HTTP surface for organization-scoped vault
 * secrets (nested module, CoC §1.1).
 *
 * VaultService comes from the global CommonModule. OrganizationsGuard is
 * stateless and only needs the global DbService/AppLogger, so a per-module
 * instance is safe (same pattern as OrganizationsModule and its nested
 * modules — no import cycle).
 */
@Module({
  controllers: [VaultOrganizationsController],
  providers: [OrganizationsGuard],
})
export class VaultOrganizationsModule {}
