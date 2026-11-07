import { Injectable } from "@nestjs/common";
import { ProjectsService } from "../../projects.service";

/**
 * GithubLinkService — read-only GitHub link status, lives inside
 * GithubModule. Never stores tokens/credentials (only owner/repo/branch
 * text on the project row). Format-only checks; no outbound network.
 * No path resolver use: disk homes resolve inside ProjectsService
 * (orgs/<orgUuid>/projects/<id>/content).
 *
 * Write paths (link/unlink) were removed with their routes: PATCH
 * githubOwner/githubRepo/githubBranch is the only way to change the link.
 */
@Injectable()
export class GithubLinkService {
  constructor(private readonly projects: ProjectsService) {}

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
