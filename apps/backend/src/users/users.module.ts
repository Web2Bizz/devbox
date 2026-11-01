import { Global, Module } from "@nestjs/common";
import { PasswordModule } from "./modules/password/password.module";
import { UsersController } from "./users.controller";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";

// SCOPE: Common
/**
 * UsersModule — Postgres-backed user registry + own-profile read; password
 * hashing lives in the nested PasswordModule (CoC §2: `users/modules/password/`).
 *
 * @Global() stays on purpose (decision recorded in .plans/password-service/PLAN.md
 * § Решения): UsersService is injected by auth/, organizations/ and processes/
 * without explicit imports; PasswordService reaches auth via the re-exported
 * PasswordModule. UsersModule never imports AuthModule (module graph stays acyclic).
 */
@Global()
@Module({
  controllers: [UsersController],
  imports: [PasswordModule],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, PasswordModule],
})
export class UsersModule {}
