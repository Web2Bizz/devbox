/**
 * session-errors util checks — self-contained runner (plain node:assert).
 *
 * Runs against COMPILED dist:
 *   `bun run build && bun dist/processes/modules/ai/modules/sessions/utils/session-errors/__tests__/session-errors.spec.js`
 * Also executes under `bun test dist` (top-level run, throws on failure).
 *
 * Covers the direct runner's honest missing-key signal: only a 404 whose
 * response body carries `code: 'opencode_key_missing'` is a missing key.
 */
import assert from 'node:assert/strict';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { isMissingKey } from '..';

const checks: Array<{ name: string; run: () => void }> = [
  {
    name: '404 with code opencode_key_missing → true',
    run: () => {
      assert.equal(
        isMissingKey(new NotFoundException({ code: 'opencode_key_missing', message: 'nope' })),
        true,
      );
    },
  },
  {
    name: '404 with another code → false',
    run: () => {
      assert.equal(isMissingKey(new NotFoundException({ code: 'opencode_session_unbound' })), false);
      assert.equal(isMissingKey(new NotFoundException({ code: 'other' })), false);
      assert.equal(isMissingKey(new NotFoundException('not found')), false);
    },
  },
  {
    name: '401/400/500 with the same code → false (only 404 counts)',
    run: () => {
      assert.equal(isMissingKey(new UnauthorizedException({ code: 'opencode_key_missing' })), false);
      assert.equal(isMissingKey(new BadRequestException({ code: 'opencode_key_missing' })), false);
      assert.equal(
        isMissingKey(new InternalServerErrorException({ code: 'opencode_key_missing' })),
        false,
      );
    },
  },
  {
    name: 'plain Error / null / undefined → false',
    run: () => {
      assert.equal(isMissingKey(new Error('boom')), false);
      assert.equal(isMissingKey(null), false);
      assert.equal(isMissingKey(undefined), false);
      assert.equal(isMissingKey('opencode_key_missing'), false);
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
    console.error(`${failed}/${checks.length} session-errors checks failed`);
    process.exitCode = 1;
    throw new Error(`${failed}/${checks.length} session-errors checks failed`);
  }
  console.log(`${checks.length}/${checks.length} session-errors checks passed`);
}

main();
