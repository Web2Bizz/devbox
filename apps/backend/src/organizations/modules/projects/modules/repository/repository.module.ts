import { Module } from "@nestjs/common";
import { ReposModule } from "./modules/repos/repos.module";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module";

/**
 * RepositoryModule — the repository (git-on-disk) domain of a project
 * (CoC §2: nested under `organizations/modules/projects/modules/`).
 *
 * Owns the readonly repo catalog (modules/repos), the per-user project
 * content surface — clone lifecycle, jailed tree, submodules
 * (modules/workspaces) — and the shared git/submodule utils
 * (utils/repos-git, utils/submodules). This is the ONLY place that touches
 * repo disk paths: the single jail is WorkspacePathService (common/storage),
 * the fs primitives it exposes are the only fs access outside common.
 *
 * Nested modules are never registered in AppModule directly and are not
 * re-exported outside the projects domain — the parent ProjectsModule imports
 * RepositoryModule, so /repos and /workspaces routes stay mounted through
 * ProjectsModule → RepositoryModule.
 */
@Module({
  imports: [ReposModule, WorkspacesModule],
  exports: [ReposModule, WorkspacesModule],
})
export class RepositoryModule {}
