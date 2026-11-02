import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../../../../common/health/health-registry';
import { ServeAuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { OpencodeKeysController } from './keys.controller';
import { OpencodeSdkClient } from './opencode-sdk-client';
import { OpencodeController } from './opencode.controller';
import { OpencodeConfig } from './opencode.config';
import { OpencodeService } from './opencode.service';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';

/**
 * Global opencode module (mirrors CommonModule) — OpencodeService is
 * injectable in any provider (SessionsService, …) without explicit imports.
 * Health is inverted: this module registers its own 'opencode' probe in the
 * shared HealthRegistry (HealthModule imports no domain).
 *
 * OpencodeSdkClient wraps the pinned @opencode-ai/sdk (transport via
 * ExternalClient timeout/retry); OpencodeController mirrors the upstream
 * opencode OpenAPI under VERSION_NEUTRAL /api/opencode/* so the frontend
 * uses the same sdk against the backend with no new contracts.
 *
 * Decomposed into modules/* submodules (each with its own Nest module):
 * billing (BillingService, live usage), auth (ServeAuthService
 * real-user gate: non-uuid mock → 401 before any upstream call +
 * serveBasicAuthHeader, server Basic from OPENCODE_PASSWORD).
 * The keys HTTP surface (keys.controller/keys.dto: /api/v1/key +
 * /api/v1/usage) lives here, while the reusable crypto envelope
 * (common/crypto) and key store (common/keys) come from the global
 * CommonModule — no explicit imports. Root providers: OpencodeConfig (dial
 * url + REQUEST_TIMEOUT_MS budget, shared by the two below without an import
 * cycle), OpencodeService (upstream fetch) + OpencodeSdkClient (pinned
 * @opencode-ai/sdk instance). The per-user DB Bearer is gone from the serve
 * path: no stored key → no 404 anymore; without OPENCODE_PASSWORD the
 * upstream 401 is the honest signal.
 *
 * JwtAuthGuard comes from the global auth module, ExternalClient/AppLogger
 * from the global CommonModule.
 *
 * OrganizationsModule is imported for the C4 project gate, which reaches
 * ProjectAccessService transitively (OrganizationsModule → ProjectsModule →
 * ProjectAccessModule; assertProjectAccessById — no cycle, orgs has no ai
 * import). The project directory jail (gate + WorkspacePathService) lives
 * in ProjectAccessService.resolveProjectDirectory.
 */
@Global()
@Module({
  imports: [BillingModule, ServeAuthModule, OrganizationsModule],
  controllers: [OpencodeController, OpencodeKeysController],
  providers: [OpencodeService, OpencodeConfig, OpencodeSdkClient],
  exports: [BillingModule, ServeAuthModule, OpencodeService, OpencodeConfig, OpencodeSdkClient],
})
export class OpencodeModule implements OnModuleInit {
  constructor(
    private readonly health: HealthRegistry,
    private readonly service: OpencodeService,
  ) {}

  onModuleInit(): void {
    this.health.register('opencode', () => this.service.checkConnectivity());
  }
}
