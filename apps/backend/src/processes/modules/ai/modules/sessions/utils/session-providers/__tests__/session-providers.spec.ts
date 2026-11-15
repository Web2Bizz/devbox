/**
 * session-providers util checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/utils/session-providers/__tests__/session-providers.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the artifact Provider.Info → domain projection (required subset
 * only, bad shape fails loud with EXTERNAL_UNAVAILABLE) and the Go/Zen model
 * inventory filter.
 */
import assert from 'node:assert/strict';
import { ExternalServiceError } from '@common/external/external-error';
import { isProviderActivation, projectModels, projectProviders } from '..';

/** Predicate for `assert.throws`: the exact EXTERNAL_UNAVAILABLE envelope. */
function externalUnavailable(operation: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ExternalServiceError, 'expected ExternalServiceError');
    assert.equal(error.code, 'EXTERNAL_UNAVAILABLE');
    assert.equal(error.service, 'opencode');
    assert.equal(error.operation, operation);
    assert.equal(error.isRetryable, false);
    return true;
  };
}

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: 'isProviderActivation accepts auto/enabled/disabled only',
    run: () => {
      assert.equal(isProviderActivation('auto'), true);
      assert.equal(isProviderActivation('enabled'), true);
      assert.equal(isProviderActivation('disabled'), true);
      assert.equal(isProviderActivation('other'), false);
      assert.equal(isProviderActivation(undefined), false);
      assert.equal(isProviderActivation(null), false);
      assert.equal(isProviderActivation(1), false);
    },
  },
  {
    name: 'projectProviders keeps the required subset and drops extra fields',
    run: () => {
      const rows = [
        {
          id: 'opencode',
          name: 'OpenCode',
          activation: 'enabled',
          package: '@opencode/ai',
          settings: { secret: 'x' },
        },
        { id: 'opencode-go', name: 'Go', activation: 'auto', package: 'pkg' },
        { id: 'opencode-zen', name: 'Zen', activation: 'disabled', package: 'pkg2' },
      ];
      assert.deepEqual(projectProviders(rows), [
        { id: 'opencode', name: 'OpenCode', activation: 'enabled', package: '@opencode/ai' },
        { id: 'opencode-go', name: 'Go', activation: 'auto', package: 'pkg' },
        { id: 'opencode-zen', name: 'Zen', activation: 'disabled', package: 'pkg2' },
      ]);
      assert.deepEqual(projectProviders([]), []);
    },
  },
  {
    name: 'projectProviders rejects a non-array payload',
    run: () => {
      assert.throws(() => projectProviders({}), externalUnavailable('sessionProviders'));
      assert.throws(() => projectProviders(undefined), externalUnavailable('sessionProviders'));
    },
  },
  {
    name: 'projectProviders rejects rows violating the required set',
    run: () => {
      assert.throws(
        () => projectProviders([{ id: '', name: 'x', activation: 'auto', package: 'p' }]),
        externalUnavailable('sessionProviders'),
      );
      assert.throws(
        () => projectProviders([{ id: 'x', name: 1, activation: 'auto', package: 'p' }]),
        externalUnavailable('sessionProviders'),
      );
      assert.throws(
        () => projectProviders([{ id: 'x', name: 'x', activation: 'weird', package: 'p' }]),
        externalUnavailable('sessionProviders'),
      );
      assert.throws(
        () => projectProviders([{ id: 'x', name: 'x', activation: 'auto' }]),
        externalUnavailable('sessionProviders'),
      );
    },
  },
  {
    name: 'projectModels filters foreign providers and projects id/name/providerID',
    run: () => {
      const rows = [
        { providerID: 'opencode', modelID: 'gpt-5', name: 'GPT-5', extra: true },
        { providerID: 'opencode-go', id: 'glm-4.6', name: 'GLM 4.6' },
        { providerID: 'opencode-zen', id: 'qwen', name: 'Qwen' },
        { providerID: 'anthropic', id: 'claude', name: 'Claude' },
        { providerID: 'other', modelID: 'x', name: 'X' },
        { providerID: 'opencode', modelID: 'only-model' },
      ];
      assert.deepEqual(projectModels(rows), [
        { id: 'gpt-5', name: 'GPT-5', providerID: 'opencode' },
        { id: 'glm-4.6', name: 'GLM 4.6', providerID: 'opencode-go' },
        { id: 'qwen', name: 'Qwen', providerID: 'opencode-zen' },
        { id: 'only-model', name: 'only-model', providerID: 'opencode' },
      ]);
      assert.deepEqual(projectModels([]), []);
    },
  },
  {
    name: 'projectModels prefers modelID over id and falls back to modelID for name',
    run: () => {
      assert.deepEqual(projectModels([{ providerID: 'opencode', modelID: 'm1', id: 'm2' }]), [
        { id: 'm1', name: 'm1', providerID: 'opencode' },
      ]);
    },
  },
  {
    name: 'projectModels throws on an empty model id in the family',
    run: () => {
      assert.throws(
        () => projectModels([{ providerID: 'opencode' }]),
        externalUnavailable('sessionModels'),
      );
      assert.throws(
        () => projectModels([{ providerID: 'opencode-go', modelID: '', id: '' }]),
        externalUnavailable('sessionModels'),
      );
    },
  },
  {
    name: 'projectModels rejects a non-array payload',
    run: () => {
      assert.throws(() => projectModels({}), externalUnavailable('sessionModels'));
      assert.throws(() => projectModels(null), externalUnavailable('sessionModels'));
    },
  },
];

function main(): void {
  let failed = 0;
  for (const c of checks) {
    try {
      c.run();
      console.log(`ok - ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${c.name}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${checks.length} session-providers checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} session-providers checks failed`);
  }
  console.log(`${checks.length}/${checks.length} session-providers checks passed`);
}

main();
