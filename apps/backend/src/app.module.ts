import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { ApiModule } from './api/api.module.js';
import { CommonModule } from './common/common.module.js';
import { DockerRegistryModule } from './docker-registry/docker-registry.module.js';
import { NpmRegistryModule } from './npm-registry/npm-registry.module.js';
import { OpencodeModule } from './opencode/opencode.module.js';
import { OpencodeKeysModule } from './opencode-keys/opencode-keys.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { ReposModule } from './repos/repos.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { AuthModule } from './auth/auth.module.js';
import { validateConfigForNest } from './env.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail-fast without logging secrets.
      validate: validateConfigForNest,
    }),
    CommonModule,
    OpencodeModule,
    OpencodeKeysModule,
    DockerRegistryModule,
    NpmRegistryModule,
    DbModule,
    HealthModule,
    ApiModule,
    ProjectsModule,
    OrganizationsModule,
    ReposModule,
    AuthModule,
  ],
})
export class AppModule {}
