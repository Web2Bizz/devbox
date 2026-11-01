import { Module } from "@nestjs/common";
import { ProjectAccessModule } from "../../../project-access/project-access.module";
import { ReposController } from "./repos.controller";
import { ReposService } from "./repos.service";

/**
 * ReposModule — readonly git-repo registry
 * (REPOS_ROOT/<scope>/projects/<project>/content, GET only).
 * Nested in the projects domain via RepositoryModule (CoC §2), never
 * registered in AppModule directly.
 *
 * Imports ProjectAccessModule for the C3 space gate: repos lives inside
 * projects, so it must not point back at the organizations root — the gate
 * (ProjectAccessService.getRole; own user-space or member org — strangers
 * get 404, no enumeration) is the projects-domain access layer itself.
 */
@Module({
  imports: [ProjectAccessModule],
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
