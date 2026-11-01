import { Global, Module } from '@nestjs/common';
import { DockerModule } from './modules/docker/docker.module';
import { NpmModule } from './modules/npm/npm.module';
import { RegistryController } from './registry.controller';

/**
 * Registries — aggregate module for external package registries.
 *
 * Re-exports `modules/docker` (Docker Registry HTTP API v2, read-only) and
 * `modules/npm` (Verdaccio observe-only probe). Canonical routes:
 * - GET /api/v1/registry/docker
 * - GET /api/v1/registry/npm
 * Legacy routes (deprecated, use the canonical ones):
 * - GET /api/v1/registry/catalog
 * - GET /api/v1/registry/npm/status
 *
 * Submodules stay `@Global()` so their services remain injectable anywhere
 * (e.g. HealthController) without explicit imports.
 */
@Global()
@Module({
  imports: [DockerModule, NpmModule],
  controllers: [RegistryController],
  exports: [DockerModule, NpmModule],
})
export class RegistriesModule {}
