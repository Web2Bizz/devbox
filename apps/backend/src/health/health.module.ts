import { Module } from '@nestjs/common';
import { DbModule } from '../common/db/db.module';
import { OpencodeModule } from '../ai/modules/opencode/opencode.module';
import { DockerModule } from '../organizations/modules/registries/modules/docker/docker.module';
import { NpmModule } from '../organizations/modules/registries/modules/npm/npm.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule, OpencodeModule, DockerModule, NpmModule],
  controllers: [HealthController],
})
export class HealthModule {}
