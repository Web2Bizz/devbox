import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { AgentsModule } from '../agents/agents.module';
import { OpencodeModule } from '../opencode/opencode.module';
import { ToolRuntimeModule } from '../tool-runtime/tool-runtime.module';
import { SessionHistoryRepository } from './session-history.repository';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionTurnRunnerService } from './modules/runner/runner.service';
import { RevertService } from './modules/revert/revert.service';
import { SnapshotsService } from './modules/snapshots/snapshots.service';
import { SessionRuntimeStateService } from './modules/state/session-runtime-state.service';
import { SessionFrameBufferService } from './modules/events/session-frame-buffer.service';
import { SessionStreamService } from './modules/events/session-stream.service';
import { AssistantRecorderService } from './modules/recorder/assistant-recorder.service';
import { SessionInventoryService } from './modules/inventory/session-inventory.service';
import { TurnWorkspaceService } from './modules/workspace/turn-workspace.service';
import { DirectTurnService } from './modules/messaging/direct-turn.service';
import { HostTurnService } from './modules/messaging/host-turn.service';
import { InProcessTurnService } from './modules/messaging/in-process-turn.service';
import { FileCommandTurnService } from './modules/messaging/file-command.turn';
import { SessionMessagingService } from './modules/messaging/session-messaging.service';

/**
 * Domain sessions module — /api/v1/sessions* (the product contract replacing
 * the removed /api/opencode/* mirror). SessionsService is the domain
 * orchestrator; the work itself runs in the domain zones: messaging
 * (file/in-process-auto/direct/host turns), streaming (SSE re-stream),
 * inventory (provider/model projections), workspace (snapshots/revert/diff),
 * plus the ephemeral runtime state and live frame buffer.
 *
 * OpencodeModule (OpencodeHostService — the in-process embedded host the
 * turns prompt, plus ServeAuthService for the real-user gate) and
 * OrganizationsModule (C4 gate, reaching ProjectAccessService transitively
 * via OrganizationsModule → ProjectsModule → ProjectAccessModule) are
 * imported explicitly to document the dependencies (same convention as
 * HealthModule). SessionRunnerService (the direct per-user Zen transport the
 * messaging zone selects when a key exists) comes from the global
 * CommonModule — no import needed. The project directory jail rides
 * ProjectAccessService.resolveProjectDirectory. ToolRuntimeModule supplies the
 * registry and the dispatcher the runner settles model tool calls through —
 * the handlers themselves are registered by the sibling ToolsModule, so the
 * sessions domain never depends on the handler implementations.
 */
@Module({
  imports: [AgentsModule, OpencodeModule, ToolRuntimeModule, OrganizationsModule],
  controllers: [SessionsController],
  providers: [
    SessionHistoryRepository,
    SessionTurnRunnerService,
    SessionRuntimeStateService,
    SessionFrameBufferService,
    AssistantRecorderService,
    SessionStreamService,
    SessionInventoryService,
    TurnWorkspaceService,
    DirectTurnService,
    HostTurnService,
    InProcessTurnService,
    FileCommandTurnService,
    SessionMessagingService,
    SessionsService,
    RevertService,
    SnapshotsService,
    WorkspacePathService,
  ],
})
export class SessionsModule {}
