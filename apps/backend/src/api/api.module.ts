import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { ProxyService } from './proxy.service';
import { OpencodeModule } from '../opencode/opencode.module';
import { OpencodeKeysModule } from '../opencode-keys/opencode-keys.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WorkspacePathService } from '../workspaces/workspace-path.service';

@Module({
  // OpencodeModule (global: OpencodeService/OpencodeSdkClient) documents the
  // upstream dependency; OpencodeKeysModule provides OpencodeAuthService
  // (real-user gate for ProxyService — serve auth itself is the server Basic).
  // OrganizationsModule provides the C4 project gate
  // (assertProjectAccessById — no cycle, orgs imports only DbModule);
  // WorkspacePathService is provided directly (stateless, same pattern as
  // ProjectsModule) for the C4 project directory jail.
  imports: [OpencodeModule, OpencodeKeysModule, OrganizationsModule],
  controllers: [ApiController],
  providers: [ProxyService, WorkspacePathService],
})
export class ApiModule {}
