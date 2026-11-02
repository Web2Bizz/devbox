import { Module } from "@nestjs/common";
import { GithubAppService } from "./github-app.service";
import { GithubBindingService } from "./github-binding.service";
import { GithubInstallationsService } from "./github-installations.service";
import { GithubController } from "./github.controller";
import { GithubService } from "./github.service";

/**
 * Nested module — imported by ProjectsModule and WorkspacesModule, never
 * registered in AppModule directly. DbService comes from the global
 * CommonModule (503 when PG is down).
 * GithubAppService token cache stays memory-only (tokens never persisted).
 *
 * This module must stay dependency-free of the projects domain: it provides
 * only app auth, the per-user installation registry and repo listing.
 * `GithubLinkService` (which needs ProjectsService) is provided by
 * ProjectsModule instead — otherwise GitHubModule ⇄ ProjectsModule would form
 * an ESM import cycle that breaks direct module imports (TDZ on boot order).
 */
@Module({
  controllers: [GithubController],
  providers: [GithubAppService, GithubBindingService, GithubInstallationsService, GithubService],
  exports: [GithubAppService, GithubBindingService, GithubInstallationsService, GithubService],
})
export class GithubModule {}
