import { Module } from '@nestjs/common';
import { DbModule } from '../common/db/db.module';
import { HealthController } from './health.controller';

/**
 * HealthModule — Common scope: imports DbModule only.
 *
 * opencode/registry/npmRegistry reachability arrives through the global
 * HealthRegistry (CommonModule), which each domain module populates on boot
 * (OpencodeModule/DockerModule/NpmModule) — health never imports a domain.
 */
@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class HealthModule {}
