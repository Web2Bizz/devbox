import { Global, Module } from '@nestjs/common';
import { UsersModule } from '@users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import {
  GithubAppProviderStub,
  LocalAuthProvider,
  SsoOauthProviderStub,
} from './auth-provider';
import { IdentityService } from './identity.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

// SCOPE: Common
/**
 * AuthModule — internal accounts (email+password, argon2id + HS256 JWT).
 * Common-scope sibling of users/ (top-level src/auth, not nested): JWT guard,
 * token/password providers and identity live here, user profiles stay in
 * src/users. Global: JwtAuthGuard + IdentityService are injectable anywhere
 * (github / workspaces controllers use them to replace the duplicated mock
 * resolveUserId). User registry lives in the global UsersModule
 * (src/users) — imported here so the local provider and guard resolve;
 * UsersModule never imports AuthModule (module graph stays acyclic).
 * Registered in AppModule imports.
 */
@Global()
@Module({
  imports: [UsersModule, OrganizationsModule],
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
