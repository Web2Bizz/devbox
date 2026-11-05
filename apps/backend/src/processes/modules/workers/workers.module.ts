import { Module } from '@nestjs/common';
import { WorkspacePathService } from '../../../common/storage/workspace-path.service';
import { RunsModule } from '../runs/runs.module';
import { RunsClaimLoop } from './modules/claim-loop';
import { ExecutorRegistry } from './modules/executor';
import { RunWorktreeService } from './modules/git';
import { ModelGateway, StubModelGateway } from './modules/model-gateway';
import { SandboxProvider } from './modules/sandbox';
import { SkillLoader } from './modules/skills';
import { McpToolSource, ToolRegistry } from './modules/tool-registry';

/**
 * WorkersModule — the in-process run engine (agent-harness prototype).
 *
 * RunsModule is imported for the claim/step repository (the workers append to
 * the same journal the HTTP surface reads); WorkspacePathService is provided
 * directly, the same stateless "safe second instance" pattern as RunsModule.
 *
 * The claim loop is deliberately in-process and single-role: one holder per
 * backend instance, lease renewed by step transactions, and shutdown only
 * drains the current tick. That survives a GRACEFUL restart (the lease expires
 * and another instance claims the run); a hard crash may leave one attempt to
 * be replayed by the operator — TODO(full-fencing) adds epochs. The model port
 * is the stub (one provider, normalized response journaled as the step
 * result); ExecutorRegistry wraps it as the step-level agent seam (`ask` /
 * `default`), and SkillLoader resolves the definitions pinned by the run's
 * definitionSetHash (skill bodies read strictly at that commit; allowed-tools
 * is deny-by-default). Tools reach the model as filtered ToolView projections
 * only (D3).
 *
 * sandbox.exec goes through the opencode runner (SandboxProvider →
 * OpencodeService; it is @Global, so no OpencodeModule import is added here);
 * MCP is consumption-only (McpToolSource registers the remote server's tools
 * at boot, MCP_SERVER_URL unset disables it) — the harness never serves MCP.
 */
@Module({
  imports: [RunsModule],
  providers: [
    WorkspacePathService,
    RunWorktreeService,
    ToolRegistry,
    SkillLoader,
    { provide: ModelGateway, useClass: StubModelGateway },
    ExecutorRegistry,
    SandboxProvider,
    McpToolSource,
    RunsClaimLoop,
  ],
})
export class WorkersModule {}
