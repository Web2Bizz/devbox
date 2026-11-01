import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { OpencodeKeysService } from "./keys.service";

/**
 * KeysModule — Postgres-backed per-user OpenCode API-key store (strict,
 * no memory fallback). Exports OpencodeKeysService for billing/keys
 * controller. The HTTP controller lives on the root OpencodeModule to
 * avoid a keys↔billing import cycle (controller needs billing, billing
 * needs the store).
 */
@Module({
  imports: [DbModule],
  providers: [OpencodeKeysService],
  exports: [OpencodeKeysService],
})
export class KeysModule {}
