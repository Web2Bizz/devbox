import { Global, Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";

// SCOPE: Common
/**
 * UsersModule — Postgres-backed user registry + own-profile read.
 *
 * @Global() stays on purpose (decision recorded in .plans/password-service/PLAN.md
 * § Решения): UsersService is injected by auth/, organizations/ and processes/
 * without explicit imports. Password hashing is a stateless util
 * (`users/utils/password/`), not a provider — no nested Nest module involved.
 * UsersModule never imports AuthModule (module graph stays acyclic).
 */
@Global()
@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
