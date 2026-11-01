import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from '../common/db/db.module';
import { HealthModule } from '../health/health.module';
import { CommonModule } from '../common/common.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ReposModule } from '../organizations/projects/repository/repos.module';
import { WorkspacesModule } from '../organizations/projects/repository/workspaces.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ProcessesModule } from '../processes/processes.module';
import { validateConfigForNest } from '../common/env/env';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail-fast without logging secrets.
      validate: validateConfigForNest,
    }),
    CommonModule,
    DbModule,
    HealthModule,
    OrganizationsModule,
    ReposModule,
    UsersModule,
    AuthModule,
    ProcessesModule,
  ],
})
export class AppModule {}
