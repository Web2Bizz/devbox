import { Module, forwardRef } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { WorkspacePathService } from "../workspaces/workspace-path.service.js";
import { GithubLinkService } from "./github-link.service.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { ChatsModule } from "./chats/chats.module.js";
import { ProjectFilesModule } from "./files/project-files.module.js";
import { GithubModule } from "./github/github.module.js";
import { SessionsModule } from "./sessions/sessions.module.js";

/**
 * ProjectsModule — module-in-module composition:
 * ProjectsModule imports ChatsModule + SessionsModule + ProjectFilesModule
 * + GithubModule (each nested, never registered in AppModule directly) and
 * owns GithubLinkService. Cascades: project delete removes chats/sessions via
 * the nested services (see ProjectsController.remove note + services).
 * GithubModule adds GET /api/v1/projects/github/repos (GitHub App
 * installation token, in-memory only); format-only GithubLinkService untouched.
 * DbModule wires the strict-Postgres ProjectsService (503 when PG is down).
 * WorkspacePathService is provided directly (not via WorkspacesModule) to
 * avoid a module cycle (ProjectsModule → WorkspacesModule → GithubModule →
 * ProjectsModule); the service is stateless so a second instance is safe.
 */
@Module({
  imports: [
    DbModule,
    forwardRef(() => ChatsModule),
    forwardRef(() => SessionsModule),
    forwardRef(() => GithubModule),
    ProjectFilesModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, GithubLinkService, WorkspacePathService],
  exports: [ProjectsService, GithubLinkService],
})
export class ProjectsModule {}
