import assert from "node:assert/strict";
import { UnauthorizedException } from "@nestjs/common";
import type { AppLogger } from "../../../../../../../../common/logger";
import { ServeAuthService } from "../serve-auth.service";

function silentLogger(): AppLogger {
  return {
    debug() {},
    info() {},
    log() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as AppLogger;
}

type Case = { name: string; run: () => void };
const cases: Array<Case> = [];

cases.push({
  name: "real uuid identity passes the gate",
  run: () => {
    const service = new ServeAuthService(silentLogger());
    service.assertServeUser("123e4567-e89b-12d3-a456-426614174091", "cid");
  },
});

cases.push({
  name: "non-uuid mock identity → 401 unauthorized",
  run: () => {
    const service = new ServeAuthService(silentLogger());
    assert.throws(
      () => service.assertServeUser("default", "cid"),
      (err: unknown) => {
        assert.ok(err instanceof UnauthorizedException);
        const body = err.getResponse() as { code?: string; message?: string };
        assert.equal(body.code, "unauthorized");
        assert.equal(body.message, "Authentication required");
        return true;
      },
    );
  },
});

let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} serve auth checks passed`);
if (failed > 0) process.exitCode = 1;
