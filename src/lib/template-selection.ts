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
  scheduleRule: { isActive: true, isArchived: false },
} as const;

/**
 * The same question `ACTIVE_TEMPLATE_WHERE` asks of a row set, asked of one
 * row and answered with a NAME rather than a boolean (#194).
 *
 * A boolean would have been enough for the gate that needs it — the edit
 * probe in `updateClassTemplate` runs only when the answer is `'active'` —
 * but not for the sentence built from it. A paused recurring class and an
 * archived one both generate nothing, and the remedies differ: one needs
 * resuming, the other needs un-archiving AND then resuming
 * (`archiveOrUnarchiveTemplate` forces `isActive: false` on both directions,
 * which is what `UNARCHIVE_MESSAGE` already exists to explain). Two states
 * collapsed into one `false` cannot tell a teacher which.
 *
 * Lives here, beside the constant, so the rule has ONE definition. The gate
 * `isActive && !isArchived` is already written twice in the generator — the
 * `findMany` selection and `claimTemplateForGeneration`'s re-check under the
 * row lock — and a third copy inside a copy layer, where nobody would think
 * to look when the rule changes, is how these drift. `template-selection.test.ts`
 * pins that `ACTIVE_TEMPLATE_WHERE` itself maps to `'active'`, so the two
 * cannot answer differently.
 *
 * `isArchived` is checked FIRST and the order is load-bearing: both archive
 * directions force `isActive: false`, so an archived template is always also
 * inactive, and testing `isActive` first would report every archived template
 * as merely `'paused'` — the strictly less-informative of the two answers,
 * and the one whose remedy does not work.
 */
export type TemplateGenerationState = 'active' | 'paused' | 'archived';

export function templateGenerationState(template: {
  isActive: boolean;
  isArchived: boolean;
}): TemplateGenerationState {
  if (template.isArchived) return 'archived';
  return template.isActive ? 'active' : 'paused';
}
