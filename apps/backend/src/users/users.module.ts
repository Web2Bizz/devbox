import { Global, Module } from "@nestjs/common";
import { PasswordService } from "./password.service";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

/**
 * UsersModule — Postgres-backed user registry + password hashing + own-profile read.
 * Global: UsersService/PasswordService injectable anywhere (auth provider,
 * JwtAuthGuard, organizations access layer). Imported by AuthModule.
 */
@Global()
@Module({
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}
