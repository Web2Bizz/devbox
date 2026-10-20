import { Injectable } from "@nestjs/common";
import { AppLogger } from "../common/app-logger.service";
import type { GithubLinkInput } from "./dto";
import { ProjectsService } from "./projects.service";

/**
 * GithubLinkService — pure validation + link assembly, lives inside
 * ProjectsModule. Never stores tokens/credentials (only owner/repo/branch
 * text on the project row). Format-only checks; no outbound network.
 * Async passthrough over the strict-Postgres ProjectsService. No path
 * resolver use: disk homes resolve inside ProjectsService (users/
 * <ownerUuid>/projects/<id>/content), so the organizations layout migration
 * (Card 3) needs no change here.
 */
@Injectable()
export class GithubLinkService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly logger: AppLogger = new AppLogger("GithubLinkService"),
  ) {}

  async link(
    projectId: string,
    input: GithubLinkInput,
    correlationId?: string,
  ) {
    // Owner/repo/branch shape already enforced by githubLinkSchema;
    // service keeps a defensive second check without echoing secrets.
    for (const [key, value] of Object.entries(input)) {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 100
      ) {
        throw new Error(`Invalid github link field: ${key}`);
      }
    }
    // Validation-only request marker → debug (not info); cid-bound.
    this.logger.debug(`[projects] github-link request`, correlationId);
    return this.projects.linkGithub(projectId, input, correlationId);
  }

  async unlink(projectId: string, correlationId?: string) {
    return this.projects.unlinkGithub(projectId, correlationId);
  }

  async status(projectId: string, correlationId?: string) {
    const p = await this.projects.getOrThrow(projectId, correlationId);
    const linked = Boolean(p.githubOwner && p.githubRepo);
    return {
      linked,
      owner: p.githubOwner,
      repo: p.githubRepo,
      branch: p.githubBranch,
      url: p.githubUrl,
    };
  }
}
