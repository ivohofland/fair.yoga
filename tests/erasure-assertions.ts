import type { ErasureOutcome } from '@/services/gdpr';

/**
 * Resolves only when the erasure actually erased; an `erased: false` outcome
 * rejects. For a test whose erasure runs on a live profile, so "resolved"
 * keeps meaning "erased".
 */
export async function expectErased(erasure: Promise<ErasureOutcome>): Promise<void> {
  const outcome = await erasure;
  if (!outcome.erased) throw new Error(`expected an erasure, got ${JSON.stringify(outcome)}`);
}
