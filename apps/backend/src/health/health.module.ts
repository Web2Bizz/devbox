import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { OpencodeModule } from '../opencode/opencode.module.js';
import { DockerRegistryModule } from '../docker-registry/docker-registry.module.js';
import { NpmRegistryModule } from '../npm-registry/npm-registry.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [DbModule, OpencodeModule, DockerRegistryModule, NpmRegistryModule],
  controllers: [HealthController],
})
export class HealthModule {}
