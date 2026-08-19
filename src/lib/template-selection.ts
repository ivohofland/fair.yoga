/**
 * Which recurring templates are live — i.e. which ones will actually put
 * classes on the calendar.
 *
 * Shared by `class-generator.ts` (which selects templates to run) and
 * `services/room-archive.ts` (which blocks archiving a room a template would
 * still generate into). Those two ask the SAME question, so they must not be
 * able to answer it differently: this constant is what keeps them from
 * drifting apart silently — divergence takes a deliberate edit at a call
 * site. NOT "impossible", which this docblock and `room-archive.ts` both
 * claimed until PR review disproved it in one edit: re-inlining the predicate
 * at the generator and dropping the `isArchived` half compiles clean and
 * leaves the test below green, because it pins this constant's VALUE and
 * never that either consumer reads it. The edit is caught behaviourally
 * instead, by `class-generator.test.ts`'s stale-`isActive` case and its
 * mirror in `room-archive.test.ts`.
 *
 * IMPORT-FREE ON PURPOSE, like `lib/tiers.ts` and `lib/class-fields.ts`.
 * `class-generator.ts` value-imports `@/lib/log` (pino, server-only), so a
 * constant living there and imported by other modules would drag pino into
 * their graphs. Nothing here imports anything, so either side can take it.
 */
export const ACTIVE_TEMPLATE_WHERE = {
  isActive: true,
  isArchived: false,
} as const;
