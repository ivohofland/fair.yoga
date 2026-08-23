/**
 * One refusal per reason, each naming the remedy — the shape
 * `STUDIO_CLASS_REFUSALS` uses, and for the same reason: a `Record` keyed by
 * the union makes adding a member a compile error until it has a message and
 * code of its own. Prose, not developer strings — `(teacher)` pages render
 * `error.message` verbatim (#197).
 *
 * Lives in its own import-free module so client components can value-import
 * the very words the API answers with — its sibling
 * `studio-class-editability.ts` reaches a server-only chain (see
 * `docs/technical-architecture.md`). The disabled-date explainer on the edit
 * form is the same string as the API's refusal by construction, not by two
 * copies staying lucky.
 *
 * `as const satisfies` rather than a `Record` annotation: the annotation
 * checked exhaustiveness but widened every `code` back to `string`, so nothing
 * downstream could narrow on one.
 */
export type StudioClassEditRefusal = 'income_record' | 'generated_date' | 'past_date';

export const STUDIO_CLASS_EDIT_REFUSALS = {
  income_record: {
    message:
      'This class is in the past, so only its student count and cancellation can still change.',
    code: 'STUDIO_CLASS_INCOME_RECORD',
  },
  generated_date: {
    message:
      'This class comes from a recurring template, so it cannot move to another date. Cancel it and log a manual class on the new date instead.',
    code: 'STUDIO_CLASS_GENERATED_DATE',
  },
  /**
   * A date move that would land strictly before the teacher's today. Refused
   * because it is one-way through this editor: the row arrives already frozen
   * by `income_record`, so the typo that caused it cannot be undone here.
   * Logging a past class outright stays open — `/studio-class/new` bounds its
   * date field at neither end.
   */
  past_date: {
    message:
      'A class cannot move to a date in the past — it would become an income record and could not be edited again. Log a separate class on that date instead.',
    code: 'STUDIO_CLASS_PAST_DATE',
  },
} as const satisfies Record<StudioClassEditRefusal, { message: string; code: string }>;
