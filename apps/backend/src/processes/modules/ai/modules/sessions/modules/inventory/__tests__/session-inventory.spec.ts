import assert from 'node:assert/strict';
import { ExternalServiceError } from '@common/external/external-error';
import type { AppLogger } from '@common/logger';
import type { OpencodeHostService } from '../../../../opencode/opencode-host.service';
import { SessionInventoryService } from '../session-inventory.service';

type Case = { name: string; run: () => Promise<void> | void };
const cases: Array<Case> = [];
let suite = '';

function describe(name: string, fn: () => void): void {
  suite = name;
  fn();
  suite = '';
}

function it(name: string, run: () => Promise<void> | void): void {
  cases.push({ name: suite ? `${suite} :: ${name}` : name, run });
}

function recordingLogger(): {
  logger: AppLogger;
  warns: Array<string>;
  debugs: Array<string>;
  infos: Array<string>;
} {
  const warns: Array<string> = [];
  const debugs: Array<string> = [];
  const infos: Array<string> = [];
  const logger = {
    debug(message: unknown) {
      debugs.push(String(message));
    },
    info(message: unknown) {
      infos.push(String(message));
    },
    log() {},
    warn(message: unknown) {
      warns.push(String(message));
    },
    error() {},
    fatal() {},
  } as unknown as AppLogger;
  return { logger, warns, debugs, infos };
}

describe('SessionInventoryService', () => {
  it('providers delegates the gated directory and projects the required subset', async () => {
    const calls: Array<string> = [];
    const host = {
      providerList: async (directory: string): Promise<unknown> => {
        calls.push(directory);
        return {
          data: [
            {
              id: 'opencode-go',
              name: 'OpenCode Go',
              activation: 'enabled',
              package: '@opencode/go',
              settings: { token: 'secret' },
              headers: { authorization: 'Bearer secret' },
            },
          ],
        };
      },
    } as unknown as OpencodeHostService;
    const { logger } = recordingLogger();
    const inventory = new SessionInventoryService(host, logger);
    const rows = await inventory.providers('/repo/content', 'cid-1');
    assert.deepEqual(calls, ['/repo/content']);
    assert.deepEqual(rows, [
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        activation: 'enabled',
        package: '@opencode/go',
      },
    ]);
    assert.ok(!JSON.stringify(rows).includes('secret'), 'credential-bearing fields leaked');
  });

  it('providers rethrows the host failure after one warn/debug line', async () => {
    const failure = new Error('host-down');
    const host = {
      providerList: async (): Promise<unknown> => {
        throw failure;
      },
    } as unknown as OpencodeHostService;
    const { logger, warns, debugs } = recordingLogger();
    const inventory = new SessionInventoryService(host, logger);
    await assert.rejects(
      inventory.providers('/repo/content', 'cid-2'),
      (err: unknown) => err === failure,
    );
    assert.deepEqual(warns, ['[sessions] providers list failed']);
    assert.deepEqual(debugs, ['host-down']);
  });

  it('providers answers EXTERNAL_UNAVAILABLE for a non-array payload and for a broken row', async () => {
    const { logger } = recordingLogger();
    const assertBadShape = (error: unknown): boolean => {
      assert.ok(error instanceof ExternalServiceError, 'expected ExternalServiceError');
      assert.equal(error.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(error.operation, 'sessionProviders');
      assert.equal(error.isRetryable, false);
      return true;
    };
    const nonArray = new SessionInventoryService(
      { providerList: async (): Promise<unknown> => ({ data: { nope: true } }) } as unknown as OpencodeHostService,
      logger,
    );
    await assert.rejects(nonArray.providers('/repo', 'cid'), assertBadShape);
    const brokenRow = new SessionInventoryService(
      {
        providerList: async (): Promise<unknown> => ({
          data: [{ id: 'p', name: 'P', activation: 'enabled' }],
        }),
      } as unknown as OpencodeHostService,
      logger,
    );
    await assert.rejects(brokenRow.providers('/repo', 'cid'), assertBadShape);
  });

  it('models delegates, filters to the Go/Zen family and logs the list', async () => {
    const calls: Array<string> = [];
    const host = {
      modelList: async (directory: string): Promise<unknown> => {
        calls.push(directory);
        return {
          data: [
            { providerID: 'opencode-go', modelID: 'glm-4.6', name: 'GLM 4.6' },
            { providerID: 'opencode-zen', id: 'zen-1', name: 'Zen 1' },
            { providerID: 'anthropic', modelID: 'claude', name: 'Claude' },
          ],
        };
      },
    } as unknown as OpencodeHostService;
    const { logger, infos } = recordingLogger();
    const inventory = new SessionInventoryService(host, logger);
    const rows = await inventory.models('/repo/content', 'cid-3');
    assert.deepEqual(calls, ['/repo/content']);
    assert.deepEqual(rows, [
      { id: 'glm-4.6', name: 'GLM 4.6', providerID: 'opencode-go' },
      { id: 'zen-1', name: 'Zen 1', providerID: 'opencode-zen' },
    ]);
    assert.deepEqual(infos, ['[sessions] models listed']);
  });

  it('models rethrows the host failure after one warn/debug line', async () => {
    const failure = new Error('models-down');
    const host = {
      modelList: async (): Promise<unknown> => {
        throw failure;
      },
    } as unknown as OpencodeHostService;
    const { logger, warns, debugs, infos } = recordingLogger();
    const inventory = new SessionInventoryService(host, logger);
    await assert.rejects(
      inventory.models('/repo', 'cid-4'),
      (err: unknown) => err === failure,
    );
    assert.deepEqual(warns, ['[sessions] models list failed']);
    assert.deepEqual(debugs, ['models-down']);
    assert.deepEqual(infos, [], 'no success log on a failed list');
  });

  it('models answers EXTERNAL_UNAVAILABLE for a non-array payload and for a family row without id', async () => {
    const { logger } = recordingLogger();
    const assertBadShape = (error: unknown): boolean => {
      assert.ok(error instanceof ExternalServiceError, 'expected ExternalServiceError');
      assert.equal(error.code, 'EXTERNAL_UNAVAILABLE');
      assert.equal(error.operation, 'sessionModels');
      assert.equal(error.isRetryable, false);
      return true;
    };
    const nonArray = new SessionInventoryService(
      { modelList: async (): Promise<unknown> => ({ data: 'nope' }) } as unknown as OpencodeHostService,
      logger,
    );
    await assert.rejects(nonArray.models('/repo', 'cid'), assertBadShape);
    const brokenRow = new SessionInventoryService(
      {
        modelList: async (): Promise<unknown> => ({
          data: [{ providerID: 'opencode-go', name: 'no id' }],
        }),
      } as unknown as OpencodeHostService,
      logger,
    );
    await assert.rejects(brokenRow.models('/repo', 'cid'), assertBadShape);
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
  console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(`session inventory checks failed to run: ${(err as Error).message}`);
  process.exit(1);
});
