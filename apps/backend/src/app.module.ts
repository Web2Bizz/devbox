import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { ApiModule } from './api/api.module';
import { CommonModule } from './common/common.module';
import { DockerRegistryModule } from './docker-registry/docker-registry.module';
import { NpmRegistryModule } from './npm-registry/npm-registry.module';
import { OpencodeModule } from './opencode/opencode.module';
import { OpencodeKeysModule } from './opencode-keys/opencode-keys.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ProjectsModule } from './projects/projects.module';
import { ReposModule } from './repos/repos.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { AuthModule } from './auth/auth.module';
import { validateConfigForNest } from './env';

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
