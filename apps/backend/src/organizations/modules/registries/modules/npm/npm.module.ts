import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { NpmRegistryService } from './npm.service';
import { NpmRegistryController } from './npm.controller';
import { HealthRegistry } from '../../../../../common/health/health-registry';

export { NpmRegistryService, NpmRegistryController };

/**
 * Global npm-registry module (mirrors DockerRegistryModule/OpencodeModule) —
 * NpmRegistryService is injectable in any provider without explicit imports.
 * HealthModule does not import it: this module registers `npmRegistry` in
 * the Common-owned HealthRegistry on boot (Common never imports a domain).
 *
 * Observe-only: the module never publishes/installs, only probes Verdaccio
 * availability (GET /-/ping). Boot is never blocked: onModuleInit pings
 * with retry and settles on 'down' (skipped when unconfigured) instead of
 * throwing.
 */
@Global()
@Module({
  controllers: [NpmRegistryController],
  providers: [NpmRegistryService],
  exports: [NpmRegistryService],
})
export class NpmModule implements OnModuleInit {
  constructor(
    private readonly health: HealthRegistry,
    private readonly npm: NpmRegistryService,
  ) {}

  onModuleInit(): void {
    // Self-registration keeps the arrow Common → Organization absent.
    this.health.register('npmRegistry', () => this.npm.checkConnectivity());
  }
}
