import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { AgentsModule } from '../agents/agents.module';
import { OpencodeModule } from '../opencode/opencode.module';
import { ToolsModule } from '../tools/tools.module';
import { SessionHarnessService } from './session-harness.service';
import { SessionHistoryRepository } from './session-history.repository';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionTurnRunnerService } from './modules/runner/runner.service';
import { RevertService } from './modules/revert/revert.service';
import { SnapshotsService } from './modules/snapshots/snapshots.service';

/**
 * Domain sessions module — /api/v1/sessions* (the product contract replacing
 * the removed /api/opencode/* mirror; see SessionHarnessService for the
 * orchestration + translation and gate composition, SessionsService as the
 * thin domain facade over the SessionHarness interface).
 *
 * OpencodeModule (OpencodeHostService — the in-process embedded host the
 * harness prompts, plus ServeAuthService for the real-user gate) and
 * OrganizationsModule (C4 gate, reaching ProjectAccessService transitively
 * via OrganizationsModule → ProjectsModule → ProjectAccessModule) are
 * imported explicitly to document the dependencies (same convention as
 * HealthModule). SessionRunnerService (the direct per-user Zen transport the
 * harness selects when a key exists) comes from the global CommonModule — no
 * import needed. The project directory jail rides
 * ProjectAccessService.resolveProjectDirectory.
 */
@Module({
  imports: [AgentsModule, OpencodeModule, ToolsModule, OrganizationsModule],
  controllers: [SessionsController],
  providers: [
    SessionHarnessService,
    SessionHistoryRepository,
    SessionTurnRunnerService,
    SessionsService,
    RevertService,
    SnapshotsService,
    WorkspacePathService,
  ],
})
export class SessionsModule {}
