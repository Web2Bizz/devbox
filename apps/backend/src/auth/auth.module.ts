import { Global, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { AuthController } from './auth.controller.js';
import {
  GithubAppProviderStub,
  LocalAuthProvider,
  SsoOauthProviderStub,
} from './auth-provider.js';
import { IdentityService } from './identity.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';

/**
 * AuthModule — internal accounts (email+password, argon2id + HS256 JWT).
 * Global: JwtAuthGuard + IdentityService are injectable anywhere (github /
 * workspaces controllers use them to replace the duplicated mock
 * resolveUserId). Registered in AppModule imports.
 */
@Global()
@Module({
  imports: [DbModule],
  controllers: [AuthController, UsersController],
  providers: [
    PasswordService,
    TokenService,
    UsersService,
    LocalAuthProvider,
    SsoOauthProviderStub,
    GithubAppProviderStub,
    IdentityService,
    JwtAuthGuard,
  ],
  exports: [UsersService, TokenService, IdentityService, JwtAuthGuard, PasswordService],
})
export class AuthModule {}
