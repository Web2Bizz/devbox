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
import { ExternalServiceError } from '../../../../../../common/external/external-error';
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
  await svc.getHost();
  assert.equal(svc.isUp(), true);
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-host-spec-'));
  try {
    const session = await svc.sessionCreate({ directory: dir });
    assert.ok(session.id, 'embedded host returned a session id');
    // Declared-4xx errors must not be masked as a retryable 503 (P1-1).
    let mapped: unknown;
    let interrupted = false;
    try {
      const answer = await svc.sessionInterrupt('ses_missing_for_spec');
      interrupted = true;
      assert.equal(answer.interrupted, false, 'missing session is an honest no-op');
    } catch (err) {
      mapped = err;
    }
    if (!interrupted) {
      assert.ok(mapped instanceof ExternalServiceError, 'interrupt error must be typed');
      assert.notEqual(
        (mapped as ExternalServiceError).code,
        'EXTERNAL_UNAVAILABLE',
        'a missing host session must not surface as a retryable outage',
      );
      assert.equal(
        (mapped as ExternalServiceError).isRetryable,
        false,
        'declared 4xx must be non-retryable',
      );
    }
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
