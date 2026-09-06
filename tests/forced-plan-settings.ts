/**
 * The GUC names the forced-index-order recipe turns off, shared by the three
 * lock-order suites (`db-locks-lock-order.test.ts`,
 * `template-lock-order.test.ts`, `gdpr-lock-order.test.ts`) so the four names
 * live in one place instead of five hand-listed copies.
 *
 * This module owns only the list. It is not a helper and not a fixture, and
 * it issues nothing itself — each call site still builds and runs its own
 * `SET LOCAL` statements from these names, because two of the five sites have
 * no `Prisma.TransactionClient` to hand a shared executor. Why these four
 * settings specifically, and what index-driven vs. index-ordered means, stays
 * in `forceIndexOrderedPlan`'s docblock (`db-locks-lock-order.test.ts`), which
 * this module does not replace.
 */
export const FORCED_PLAN_SETTINGS = [
  'enable_hashjoin',
  'enable_mergejoin',
  'enable_seqscan',
  'enable_bitmapscan',
] as const;
