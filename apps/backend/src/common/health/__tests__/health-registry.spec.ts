/**
 * HealthRegistry unit checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist (same constraint as the *.e2e.ts runners):
 *   `bun run build && bun dist/common/health/__tests__/health-registry.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the inverted health contract: an unregistered probe answers
 * `undefined` (controller falls back to its documented default), a
 * registered probe answers its live flag, and a duplicate registration
 * throws instead of silently overwriting the first probe.
 */
import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { HealthRegistry } = await import("../health-registry");

  let passed = 0;
  const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };

  await check("unregistered probe answers undefined", async () => {
    const registry = new HealthRegistry();
    assert.equal(await registry.probe("opencode"), undefined);
    assert.equal(await registry.probe("registry"), undefined);
    assert.equal(await registry.probe("npmRegistry"), undefined);
  });

  await check("registered probe answers its live flag", async () => {
    const registry = new HealthRegistry();
    let calls = 0;
    registry.register("opencode", async () => {
      calls += 1;
      return "up";
    });
    registry.register("registry", async () => "skipped");
    registry.register("npmRegistry", async () => "down");
    assert.equal(await registry.probe("opencode"), "up");
    assert.equal(await registry.probe("registry"), "skipped");
    assert.equal(await registry.probe("npmRegistry"), "down");
    assert.equal(calls, 1);
  });

  await check("duplicate registration throws", async () => {
    const registry = new HealthRegistry();
    registry.register("opencode", async () => "up");
    assert.throws(() => registry.register("opencode", async () => "down"));
    // The first probe stays authoritative.
    assert.equal(await registry.probe("opencode"), "up");
  });

  console.log(`health registry spec: ${passed} checks run`);
}

void main();
