import { Module } from "@nestjs/common";
import { WorkspacePathService } from "../common/storage/workspace-path.service";
import { ProjectsModule } from "./modules/projects/projects.module";
import { RegistriesModule } from "./modules/registries/registries.module";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

/**
 * OrganizationsModule — org CRUD + membership + invites + project links.
 * Owns ProjectsModule + RegistriesModule as nested modules (projects and
 * external package registries live under orgs).
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
  providers: [OrganizationsService, WorkspacePathService],
  exports: [OrganizationsService, ProjectsModule, RegistriesModule],
})
export class OrganizationsModule {}
