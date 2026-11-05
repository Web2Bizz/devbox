/**
 * OpencodeHostService smoke spec — self-contained runner (no new deps, plain
 * node:assert), same constraint as the other *.spec.ts runners:
 *   `bun run build && bun dist/processes/modules/ai/modules/opencode/__tests__/opencode-host.spec.js`
 * Also executes under `bun run test` (compiled dist specs, top-level run).
 *
 * Starts the embedded OpenCode V2 host in-process, creates one SDK session in
 * a throwaway directory, and closes the host through the service lifecycle
 * (`onModuleDestroy` → `host.close()`), so no listener/child process leaks
 * after the check.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppLogger } from '../../../../../../common/logger';
import { OpencodeHostService } from '../opencode-host.service';

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

async function main(): Promise<void> {
  const svc = new OpencodeHostService(silentLogger());
  const host = await svc.getHost();
  assert.equal(svc.isUp(), true);
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-host-spec-'));
  try {
    const session = await host.sessions.create({ location: { directory: dir } });
    assert.ok(session.id, 'embedded host returned a session id');
  } finally {
    await svc.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(svc.isUp(), false);
  console.log('opencode host spec: ok');
}

main().catch((err) => {
  console.error(`opencode host spec: FAIL ${(err as Error).message}`);
  process.exitCode = 1;
  throw err;
});
