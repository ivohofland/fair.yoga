import type { z } from 'zod';

/**
 * Inputs for the timing guards in `input-bounds.test.ts` and
 * `schemas.test.ts`: about a megabyte each, the size of body nginx admits,
 * and each shaped to make a backtracking pattern rescan. `a…` and `ab-…` are
 * one long run of host-label characters; `a.…` puts a dot after every
 * character; `a@…` puts an `@` after every character with no dot to end the
 * email-shaped search.
 *
 * Named without a `.test.` suffix so vitest does not collect it as a suite.
 */
export const ADVERSARIAL_MEGABYTE = {
  'a × 1M': 'a'.repeat(1_000_000),
  'ab- × 333,333': 'ab-'.repeat(333_333),
  'a. × 500k': 'a.'.repeat(500_000),
  'a@ × 500k': 'a@'.repeat(500_000),
} as const;

/** What a timing guard allows one parse. A linear parse of a megabyte takes tens of milliseconds. */
export const PARSE_BUDGET_MS = 200;

/**
 * The vitest timeout for a timing guard. A synchronous parse cannot be
 * interrupted, so this does not stop a slow one; it makes sure the test's own
 * elapsed-time assertion is what decides.
 */
export const TIMING_TEST_TIMEOUT_MS = 5000;

/** Parses `value` once and returns how long it took and whether it succeeded. */
export function millisecondsToParse(schema: z.ZodType, value: string): { ms: number; success: boolean } {
  const start = performance.now();
  const { success } = schema.safeParse(value);
  return { ms: performance.now() - start, success };
}
