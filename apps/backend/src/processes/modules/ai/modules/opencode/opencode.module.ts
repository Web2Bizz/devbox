import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../../../../common/health/health-registry';
import { ServeAuthModule } from './modules/auth/serve-auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { OpencodeKeysController } from './keys.controller';
import { OpencodeHostService } from './opencode-host.service';
import { OrganizationsModule } from '../../../../../organizations/organizations.module';

/**
 * Global opencode module (mirrors CommonModule) — OpencodeHostService is
 * injectable in any provider (SessionsService, …) without explicit imports.
 * Health is inverted: this module registers its own 'opencode' probe in the
 * shared HealthRegistry (HealthModule imports no domain) reading the embedded
 * host's liveness (`isUp()`).
 *
 * The legacy HTTP transport (external runner dial + Basic auth + the pinned
 * @opencode-ai/sdk client) is gone: there is no external runner anymore.
 * OpencodeHostService starts OpenCode V2 in-process (no listener) and is the
 * only transport.
 *
 * Decomposed into modules/* submodules (each with its own Nest module):
 * billing (BillingService, live usage), auth (ServeAuthService real-user gate:
 * non-uuid mock → 401 before any transport call).
 * The keys HTTP surface (keys.controller/keys.dto: /api/v1/key) lives here,
 * while GET /api/v1/usage is owned by BillingController in BillingModule;
 * the reusable crypto envelope (common/crypto) and key store (common/keys)
 * come from the global CommonModule — no explicit imports.
 *
 * JwtAuthGuard comes from the global auth module, AppLogger from the global
 * CommonModule.
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
  controllers: [OpencodeKeysController],
  providers: [OpencodeHostService],
  exports: [BillingModule, ServeAuthModule, OpencodeHostService],
})
export class OpencodeModule implements OnModuleInit {
  constructor(
    private readonly health: HealthRegistry,
    private readonly host: OpencodeHostService,
  ) {}

  onModuleInit(): void {
    this.health.register('opencode', async () => (this.host.isUp() ? 'up' : 'down'));
  }
}
