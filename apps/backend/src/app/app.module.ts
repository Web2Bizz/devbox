import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from '../health/health.module';
import { CommonModule } from '../common/common.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ReposModule } from '../repos/repos.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AiModule } from '../ai/ai.module';
import { validateConfigForNest } from '../common/env/env';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail-fast without logging secrets.
      validate: validateConfigForNest,
    }),
    CommonModule,
    HealthModule,
    OrganizationsModule,
    ReposModule,
    UsersModule,
    AuthModule,
    AiModule,
  ],
})
export class AppModule {}
