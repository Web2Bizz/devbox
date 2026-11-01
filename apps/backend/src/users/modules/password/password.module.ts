import { Module } from "@nestjs/common";
import { PasswordService } from "./password.service";

/**
 * PasswordModule — argon2id hashing nested in the users domain (CoC §2).
 * Nested modules are never registered in AppModule and never exported outside
 * the parent domain: UsersModule imports and re-exports this module so
 * LocalAuthProvider (auth) keeps resolving PasswordService.
 */
@Module({
  providers: [PasswordService],
  exports: [PasswordService],
})
export class PasswordModule {}
