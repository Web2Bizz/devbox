import "reflect-metadata";
import assert from "node:assert/strict";
import { VERSION_NEUTRAL } from "@nestjs/common";
import { PATH_METADATA, VERSION_METADATA } from "@nestjs/common/constants";
import type { HealthRegistry, HealthFlag, HealthProbeKey } from "@common/health/health-registry";
import type { DbService } from "@common/db/db.service";
import { HealthController } from "../health.controller";

type Case = { name: string; run: () => Promise<void> | void };

const cases: Array<Case> = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: currentSuite ? `${currentSuite} :: ${name}` : name, run });
}

function fakeDb(result: "up" | "down", calls?: Array<string>): DbService {
  return {
    async checkDb() {
      calls?.push("db");
      return result;
    },
  } as unknown as DbService;
}

function fakeRegistry(
  flags: Partial<Record<HealthProbeKey, HealthFlag>>,
  calls?: Array<HealthProbeKey>,
): HealthRegistry {
  return {
    async probe(key: HealthProbeKey) {
      calls?.push(key);
      return flags[key];
    },
  } as unknown as HealthRegistry;
}

function controller(
  db: "up" | "down",
  flags: Partial<Record<HealthProbeKey, HealthFlag>>,
): HealthController {
  return new HealthController(fakeDb(db), fakeRegistry(flags));
}

describe("HealthController GET /health", () => {
  it("reports every dependency as up", async () => {
    const ctl = controller("up", {
      opencode: "up",
      registry: "up",
      npmRegistry: "up",
    });
    assert.deepEqual(await ctl.getHealth(), {
      status: "ok",
      db: "up",
      opencode: "up",
      registry: "up",
      npmRegistry: "up",
    });
  });

  it("keeps status ok and db down instead of failing the probe", async () => {
    const ctl = controller("down", {
      opencode: "up",
      registry: "up",
      npmRegistry: "up",
    });
    const body = await ctl.getHealth();
    assert.deepEqual(body, {
      status: "ok",
      db: "down",
      opencode: "up",
      registry: "up",
      npmRegistry: "up",
    });
    assert.deepEqual(Object.keys(body).sort(), [
      "db",
      "npmRegistry",
      "opencode",
      "registry",
      "status",
    ]);
  });

  it("falls back to opencode down and registries skipped when probes are unregistered", async () => {
    const ctl = controller("down", {});
    assert.deepEqual(await ctl.getHealth(), {
      status: "ok",
      db: "down",
      opencode: "down",
      registry: "skipped",
      npmRegistry: "skipped",
    });
  });

  it("passes mixed up/down/skipped flags through verbatim", async () => {
    const ctl = controller("up", {
      opencode: "down",
      registry: "up",
      npmRegistry: "skipped",
    });
    assert.deepEqual(await ctl.getHealth(), {
      status: "ok",
      db: "up",
      opencode: "down",
      registry: "up",
      npmRegistry: "skipped",
    });
  });

  it("probes db, opencode, registry and npmRegistry exactly once per request", async () => {
    const dbCalls: Array<string> = [];
    const probeCalls: Array<HealthProbeKey> = [];
    const ctl = new HealthController(
      fakeDb("up", dbCalls),
      fakeRegistry({ opencode: "up", registry: "up", npmRegistry: "up" }, probeCalls),
    );
    await ctl.getHealth();
    assert.deepEqual(dbCalls, ["db"]);
    assert.deepEqual(probeCalls, ["opencode", "registry", "npmRegistry"]);
  });

  it("getVersionedHealth returns the same payload as getHealth", async () => {
    const ctl = controller("down", {
      opencode: "down",
      registry: "skipped",
      npmRegistry: "skipped",
    });
    assert.deepEqual(await ctl.getVersionedHealth(), await ctl.getHealth());
  });

  it("exposes both routes as VERSION_NEUTRAL", () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, HealthController.prototype.getHealth),
      "health",
    );
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, HealthController.prototype.getVersionedHealth),
      "v1/health",
    );
    assert.equal(
      Reflect.getMetadata(VERSION_METADATA, HealthController.prototype.getHealth),
      VERSION_NEUTRAL,
    );
    assert.equal(
      Reflect.getMetadata(VERSION_METADATA, HealthController.prototype.getVersionedHealth),
      VERSION_NEUTRAL,
    );
  });
});

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`ok   - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} health controller checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`health controller checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
