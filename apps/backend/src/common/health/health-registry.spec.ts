/**
 * HealthRegistry — unit checks (plain node:assert runner, same shape as the
 * other `*.spec.ts` files: executes directly under `bun dist/**`).
 *
 * Pins the inversion contract used by the health controller: unknown keys
 * resolve to `undefined` (controller supplies the fallback), a registered
 * probe is called lazily and returns its flag, and a duplicate registration
 * is a wiring bug that throws instead of silently overriding.
 */
import assert from "node:assert/strict";
import { HealthRegistry } from "./health-registry";

async function main(): Promise<void> {
  let passed = 0;
  const check = async (
    name: string,
    fn: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };

  await check("probe of an unregistered key → undefined", async () => {
    const registry = new HealthRegistry();
    assert.equal(await registry.probe("opencode"), undefined);
    assert.equal(await registry.probe("registry"), undefined);
    assert.equal(await registry.probe("npmRegistry"), undefined);
  });

  await check("register then probe returns the registered flag", async () => {
    const registry = new HealthRegistry();
    registry.register("opencode", async () => "up");
    assert.equal(await registry.probe("opencode"), "up");
    registry.register("registry", async () => "down");
    assert.equal(await registry.probe("registry"), "down");
    registry.register("npmRegistry", async () => "skipped");
    assert.equal(await registry.probe("npmRegistry"), "skipped");
  });

  await check("probe is evaluated per call (no cached value)", async () => {
    const registry = new HealthRegistry();
    let calls = 0;
    registry.register("opencode", async () => {
      calls += 1;
      return calls === 1 ? "up" : "down";
    });
    assert.equal(await registry.probe("opencode"), "up");
    assert.equal(await registry.probe("opencode"), "down");
    assert.equal(calls, 2);
  });

  await check("duplicate register throws and keeps the first probe", async () => {
    const registry = new HealthRegistry();
    registry.register("registry", async () => "up");
    assert.throws(
      () => registry.register("registry", async () => "down"),
      /already registered: registry/,
    );
    assert.equal(await registry.probe("registry"), "up");
  });

  console.log(`health-registry spec: ${passed} checks run`);
}

void main();
