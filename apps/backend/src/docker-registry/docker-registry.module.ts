import { Global, Module } from '@nestjs/common';
import { DockerRegistryService } from './docker-registry.service';
import { DockerRegistryController } from './docker-registry.controller';

/**
 * Global docker-registry module (mirrors OpencodeModule) —
 * DockerRegistryService is injectable in any provider (HealthController,
 * …) without explicit imports. HealthModule still imports it explicitly
 * to document the dependency.
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
export class DockerRegistryModule {}
