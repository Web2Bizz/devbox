import { Module } from "@nestjs/common";
import { WorkspacePathService } from "../common/storage/workspace-path.service";
import { InvitesService } from "./invites.service";
import { MembersService } from "./members.service";
import { OrgGuardService } from "./org-guard.service";
import { ProjectsModule } from "./modules/projects/projects.module";
import { RegistriesModule } from "./modules/registries/registries.module";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

/**
 * OrganizationsModule — org CRUD + membership + invites + project links.
 * Owns ProjectsModule + RegistriesModule as nested modules (projects and
 * external package registries live under orgs).
 *
 * Membership/invites and the shared access gate are domain-root services
 * per CoC v2 (MembersService, InvitesService, OrgGuardService) — they are
 * providers here; OrganizationsService delegates to them so its public API
 * (and the thin controller) stays unchanged.
 *
 * UsersService comes from the global UsersModule — no import needed, no
 * cycle; DbService is a provider of the global CommonModule. CryptoService
 * and OpencodeKeysService are global too (their HTTP surface lives in ai).
 * WorkspacePathService is provided directly (stateless, common/storage).
 * Re-exports ProjectsModule + RegistriesModule so existing consumers keep
 * working.
 */
@Module({
  imports: [ProjectsModule, RegistriesModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    OrgGuardService,
    MembersService,
    InvitesService,
    WorkspacePathService,
  ],
  exports: [OrganizationsService, ProjectsModule, RegistriesModule],
})
export class OrganizationsModule {}
