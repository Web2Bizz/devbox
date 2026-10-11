import { Global, Module } from '@nestjs/common';
import { NpmRegistryService } from './npm-registry.service.js';
import { NpmRegistryController } from './npm-registry.controller.js';

/**
 * Global npm-registry module (mirrors DockerRegistryModule/OpencodeModule) —
 * NpmRegistryService is injectable in any provider (HealthController,
 * …) without explicit imports. HealthModule still imports it explicitly
 * to document the dependency.
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
export class NpmRegistryModule {}
