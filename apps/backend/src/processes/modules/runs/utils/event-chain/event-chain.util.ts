import { createHash } from 'node:crypto';
import { canonicalJson } from '@common/canonical-json/canonical-json';

/** First journal row carries no predecessor. */
export const GENESIS_HASH: string = 'genesis';

/**
 * Tamper-evident chain link: sha256 over the PREVIOUS hash + this row's
 * seq/type/data. The next row stores this value as its prevHash, so editing
 * any committed row breaks every later link (ADR-0001 §9.9). Deterministic:
 * canonicalJson over the caller's data object — Postgres jsonb reorders
 * object keys on read, so plain JSON.stringify would hash a different digest
 * after a round-trip and break the chain.
 */
export function hashRunEvent(event: {
  seq: number | bigint;
  type: string;
  prevHash: string;
  data: unknown;
}): string {
  const payload: string = `${event.prevHash}|${String(event.seq)}|${event.type}|${canonicalJson(event.data)}`;
  return createHash('sha256').update(payload).digest('hex');
}

/** prevHash of the NEXT row given the current last row (or null for an empty journal). */
export function nextPrevHash(last: {
  seq: number | bigint;
  type: string;
  prevHash: string;
  data: unknown;
} | null): string {
  return last ? hashRunEvent(last) : GENESIS_HASH;
}
