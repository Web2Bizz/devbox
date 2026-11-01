import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';
import { OrganizationsModule } from '../../../organizations/organizations.module';

/**
 * ReposModule — readonly git-repo registry
 * (REPOS_ROOT/<user-space>/workspace/<repo>, GET only).
 * Top-level module registered in AppModule alongside ProjectsModule.
 * Imports OrganizationsModule for the C3 space gate (own user-space or
 * member org — strangers get 404, no enumeration).
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
