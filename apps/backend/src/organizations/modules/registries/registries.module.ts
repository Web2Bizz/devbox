import { Global, Module } from '@nestjs/common';
import { DockerModule } from './modules/docker/docker.module';
import { NpmModule } from './modules/npm/npm.module';

/**
 * Registries — aggregate module for external package registries.
 *
 * Re-exports `modules/docker` (Docker Registry HTTP API v2, read-only) and
 * `modules/npm` (Verdaccio observe-only probe). No controller lives here:
 * each entity owns its own routes (CoC §1.1). Canonical + deprecated
 * duplicates are served by the submodules:
 * - docker: GET /api/v1/registry/docker (canonical),
 *   GET /api/v1/registry/catalog (deprecated);
 * - npm: GET /api/v1/registry/npm (canonical),
 *   GET /api/v1/registry/npm/status (deprecated).
 *
 * Submodules stay `@Global()` so their services remain injectable anywhere
 * (e.g. HealthController) without explicit imports.
 */
@Global()
@Module({
  imports: [DockerModule, NpmModule],
  exports: [DockerModule, NpmModule],
})
export class RegistriesModule {}
