import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../../../../common/health/health-registry';
import { DockerRegistryService } from './docker.service';
import { DockerRegistryController } from './docker.controller';

export { DockerRegistryService, DockerRegistryController };

/**
 * Global docker-registry module (mirrors OpencodeModule) —
 * DockerRegistryService is injectable in any provider without explicit
 * imports. Health is inverted: this module registers its own 'registry'
 * probe in the shared HealthRegistry (HealthModule imports no domain).
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
    private readonly service: DockerRegistryService,
  ) {}

  onModuleInit(): void {
    this.health.register('registry', () => this.service.checkConnectivity());
  }
}
