import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';

/**
 * ReposModule — readonly git-repo registry
 * (REPOS_ROOT/<user-space>/workspace/<repo>, GET only).
 * Top-level module registered in AppModule alongside ProjectsModule.
 */
@Module({
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
