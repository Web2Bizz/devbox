import { Global, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthController } from './auth.controller';
import {
  GithubAppProviderStub,
  LocalAuthProvider,
  SsoOauthProviderStub,
} from './auth-provider';
import { IdentityService } from './identity.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

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
