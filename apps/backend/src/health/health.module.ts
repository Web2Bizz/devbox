import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { OpencodeModule } from '../opencode/opencode.module';
import { DockerRegistryModule } from '../docker-registry/docker-registry.module';
import { NpmRegistryModule } from '../npm-registry/npm-registry.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule, OpencodeModule, DockerRegistryModule, NpmRegistryModule],
  controllers: [HealthController],
})
export class HealthModule {}
