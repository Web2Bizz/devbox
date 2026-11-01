import { Global, Module } from '@nestjs/common';
import { DbModule } from '../common/db/db.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import {
  GithubAppProviderStub,
  LocalAuthProvider,
  SsoOauthProviderStub,
} from './auth-provider';
import { IdentityService } from './identity.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

/**
 * AuthModule — internal accounts (email+password, argon2id + HS256 JWT).
 * Global: JwtAuthGuard + IdentityService are injectable anywhere (github /
 * workspaces controllers use them to replace the duplicated mock
 * resolveUserId). User registry lives in the global UsersModule
 * (src/users) — imported here so the local provider and guard resolve.
 * Registered in AppModule imports.
 *
 * SCOPE: Common — sibling of users/, injects only DbService + UsersModule;
 * never imports organizations/ or processes/.
 */
@Global()
@Module({
  imports: [DbModule, UsersModule],
  controllers: [AuthController],
  providers: [
    TokenService,
    LocalAuthProvider,
    SsoOauthProviderStub,
    GithubAppProviderStub,
    IdentityService,
    JwtAuthGuard,
  ],
  exports: [TokenService, IdentityService, JwtAuthGuard],
})
export class AuthModule {}
