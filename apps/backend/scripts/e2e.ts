/// <reference types="node" />
/**
 * e2e runner: executes compiled suites from `dist` one by one with a hard
 * per-suite timeout.
 *
 * Why not a plain `&&` chain: an SSE/async suite can hang forever (the
 * sessions events reader used to), and a chain gives no budget at all — the
 * whole run and CI stall instead of failing.
 *
 * Usage (from apps/backend):
 *   bun scripts/e2e.ts                 # every suite
 *   bun scripts/e2e.ts auth.e2e        # suites whose path contains a filter
 *   bun scripts/e2e.ts repos.service submodules
 *
 * Env:
 *   E2E_SUITE_TIMEOUT_MS — per-suite budget (default 300000).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SUITES = [
  "dist/app/__tests__/versioning.e2e.js",
  "dist/common/health/__tests__/health-registry.spec.js",
  "dist/common/db/__tests__/schema-integrity.spec.js",
  "dist/common/env/__tests__/env.spec.js",
  "dist/common/env/__tests__/env-failfast.spec.js",
  "dist/common/external/__tests__/external-client.spec.js",
  "dist/common/external/__tests__/external-error.spec.js",
  "dist/common/external/__tests__/retry.spec.js",
  "dist/common/crypto/__tests__/crypto.service.spec.js",
  "dist/common/crypto/__tests__/crypto.service.hardening.spec.js",
  "dist/common/storage/__tests__/workspace-path.spec.js",
  "dist/auth/__tests__/auth.e2e.js",
  "dist/common/vault/__tests__/vault.service.spec.js",
  "dist/vault/__tests__/vault.e2e.js",
  "dist/processes/modules/ai/modules/opencode/modules/billing/__tests__/billing-key-rotation.spec.js",
  "dist/processes/modules/ai/modules/sessions/__tests__/sessions.e2e.js",
  "dist/processes/modules/runs/__tests__/runs.e2e.js",
  "dist/organizations/modules/projects/modules/repository/modules/repos/__tests__/repos.service.spec.js",
  "dist/organizations/modules/projects/modules/repository/utils/repos-git/__tests__/repos-git.spec.js",
  "dist/organizations/modules/projects/modules/repository/utils/submodules/__tests__/submodules.spec.js",
  "dist/organizations/modules/projects/modules/repository/modules/workspaces/modules/clone/__tests__/clone-jobs.repository.spec.js",
  "dist/organizations/modules/projects/modules/repository/modules/repos/__tests__/repos.e2e.js",
  "dist/organizations/__tests__/storage-unavailable.spec.js",
  "dist/organizations/utils/pg-error/__tests__/pg-error.spec.js",
  "dist/organizations/utils/organization-member/__tests__/organization-member.spec.js",
  "dist/organizations/__tests__/organizations.guard.spec.js",
  "dist/organizations/modules/invites/__tests__/invites.service.spec.js",
  "dist/organizations/__tests__/organizations.e2e.js",
  "dist/organizations/modules/projects/__tests__/project-disk-mapping.spec.js",
  "dist/organizations/modules/projects/__tests__/project-nested.spec.js",
  "dist/organizations/modules/projects/__tests__/project-strict-root.spec.js",
  "dist/organizations/modules/projects/modules/project-access/__tests__/project-access.service.spec.js",
  "dist/organizations/modules/projects/__tests__/projects.e2e.js",
  "dist/organizations/modules/projects/modules/github/__tests__/github.e2e.js",
  "dist/organizations/modules/projects/modules/github/utils/webhook/__tests__/webhook.spec.js",
  "dist/organizations/modules/registries/modules/docker/__tests__/docker-registry.service.spec.js",
  "dist/organizations/modules/registries/modules/docker/__tests__/docker.e2e.js",
  "dist/organizations/modules/registries/modules/npm/__tests__/npm-registry.service.spec.js",
  "dist/organizations/modules/registries/modules/npm/__tests__/npm.e2e.js",
];

const filters = process.argv.slice(2);
const suites = filters.length
  ? SUITES.filter((suite) => filters.some((filter) => suite.includes(filter)))
  : SUITES;

if (suites.length === 0) {
  console.error(`[e2e] no suite matches: ${filters.join(", ")}`);
  process.exit(1);
}

const timeoutRaw = Number(process.env.E2E_SUITE_TIMEOUT_MS ?? "300000");
const budget = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 300_000;
const cwd = resolve(process.cwd());

const runSuite = (suite: string): Promise<{ code: number | null; timedOut: boolean }> =>
  new Promise((resolveRun) => {
    const child = spawn("bun", [suite], {
      cwd,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, budget);
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      resolveRun({ code, timedOut });
    };
    child.once("error", (err) => {
      console.error(`[e2e] cannot spawn ${suite}: ${err.message}`);
      finish(1);
    });
    child.once("close", (code) => finish(code));
  });

async function main(): Promise<void> {
  let passed = 0;
  for (const suite of suites) {
    const startedAt = Date.now();
    console.log(`\n[e2e] ${passed + 1}/${suites.length} ${suite}`);
    const { code, timedOut } = await runSuite(suite);
    const took = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

    if (code !== 0) {
      const reason = timedOut ? `timed out after ${budget}ms` : `exit ${code}`;
      console.error(`[e2e] FAILED ${suite} (${reason}, ${took})`);
      process.exit(1);
    }
    passed += 1;
    console.log(`[e2e] ok ${suite} (${took})`);
  }

  console.log(`\n[e2e] ${passed}/${suites.length} suites passed`);
}

void main();
