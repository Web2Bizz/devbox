import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { DockerRegistryService } from './docker.service';
import { DockerRegistryController } from './docker.controller';
import { HealthRegistry } from '../../../../common/health/health-registry';

export { DockerRegistryService, DockerRegistryController };

/**
 * Global docker-registry module (mirrors OpencodeModule) —
 * DockerRegistryService is injectable in any provider without explicit
 * imports. HealthModule does not import it: this module registers
 * `registry` in the Common-owned HealthRegistry on boot (Common never
 * imports a domain).
 *
 * Boot is never blocked: onModuleInit pings GET /v2/ with retry and
 * settles on 'down' (skipped when unconfigured) instead of throwing.
 */
@Global()
@Module({
  controllers: [DockerRegistryController],
  providers: [DockerRegistryService],
  exports: [DockerRegistryService],
})
export class DockerModule implements OnModuleInit {
  constructor(
    private readonly health: HealthRegistry,
    private readonly docker: DockerRegistryService,
  ) {}

  onModuleInit(): void {
    // Self-registration keeps the arrow Common → Organization absent.
    this.health.register('registry', () => this.docker.checkConnectivity());
  }
}
