import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';
import { OpencodeModule } from '../opencode/opencode.module';
import { SessionHarnessService } from './session-harness.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * Domain sessions module — /api/sessions* (the product contract replacing
 * the deprecated /api/opencode/* mirror; see SessionHarnessService for the
 * orchestration + translation and gate composition, SessionsService as the
 * thin domain facade over the SessionHarness interface).
 *
 * OpencodeModule (OpencodeService + OpencodeSdkClient + ServeAuthService —
 * the real-user gate the raw prompt path asserts below the sdk) and
 * OrganizationsModule (C4 gate, reaching ProjectAccessService transitively
 * via OrganizationsModule → ProjectsModule → ProjectAccessModule) are
 * imported explicitly to document the dependencies (same convention as
 * HealthModule). SessionRunnerService (the direct per-user Zen transport the
 * harness selects when a key exists) comes from the global CommonModule — no
 * import needed. The project directory jail rides
 * ProjectAccessService.resolveProjectDirectory.
 */
@Module({
  imports: [OpencodeModule, OrganizationsModule],
  controllers: [SessionsController],
  providers: [SessionHarnessService, SessionsService],
})
export class SessionsModule {}
