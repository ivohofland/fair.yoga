/**
 * The GUC names the forced-index-order recipe turns off, shared by this
 * repo's lock-order suites.
 *
 * This module owns only the list. It is not a helper and not a fixture, and
 * it issues nothing itself — each call site still builds and runs its own
 * `SET LOCAL` statements from these names, because some sites see only a
 * Prisma `$extends` hook's `(args, query)`, with no `Prisma.TransactionClient`
 * to hand a shared executor. Why these settings specifically, and what
 * index-driven vs. index-ordered means, stays in `forceIndexOrderedPlan`'s
 * docblock (`db-locks-lock-order.test.ts`), which this module does not
 * replace.
 */
export const FORCED_PLAN_SETTINGS = [
  'enable_hashjoin',
  'enable_mergejoin',
  'enable_seqscan',
  'enable_bitmapscan',
] as const;
