import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '@common/health/health-registry';
import { NpmRegistryService } from './npm-registry.service';
import { NpmRegistryController } from './npm-registry.controller';

export { NpmRegistryService, NpmRegistryController };

/**
 * Global npm-registry module (mirrors DockerRegistryModule/OpencodeModule) —
 * NpmRegistryService is injectable in any provider without explicit
 * imports. Health is inverted: this module registers its own 'npmRegistry'
 * probe in the shared HealthRegistry (HealthModule imports no domain).
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
    private readonly service: NpmRegistryService,
  ) {}

  onModuleInit(): void {
    this.health.register('npmRegistry', () => this.service.checkConnectivity());
  }
}
