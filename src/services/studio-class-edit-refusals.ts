import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';

/**
 * One refusal per reason, each naming the remedy — the shape
 * `STUDIO_CLASS_REFUSALS` uses, and for the same reason: a `Record` keyed by
 * the union makes adding a member a compile error until it has a message and
 * code of its own. Prose, not developer strings — `(teacher)` pages render
 * `error.message` verbatim (#197).
 *
 * Imports only `codedRefusal`/`CodedRefusal` from the zero-import
 * `api-error-codes.ts` (see that module's own header), so client components
 * can still value-import this module directly — its sibling
 * `studio-class-editability.ts` reaches a server-only chain (see
 * `docs/technical-architecture.md`). The disabled-date explainer on the edit
 * form is the same string as the API's refusal by construction, not by two
 * copies staying lucky.
 *
 * `as const satisfies Record<StudioClassEditRefusal, CodedRefusal>`: each
 * entry is built with `codedRefusal`, which derives `status` from the code
 * rather than letting it be hand-typed beside it, and `CodedRefusal` keeps
 * `code` narrow per member rather than widened to the whole union.
 */
export type StudioClassEditRefusal = 'income_record' | 'generated_date' | 'past_date';

export const STUDIO_CLASS_EDIT_REFUSALS = {
  income_record: codedRefusal(
    'STUDIO_CLASS_INCOME_RECORD',
    'This class is in the past, so only its student count and cancellation can still change.',
  ),
  generated_date: codedRefusal(
    'STUDIO_CLASS_GENERATED_DATE',
    'This class comes from a recurring template, so it cannot move to another date. Cancel it and log a manual class on the new date instead.',
  ),
  /**
   * A date move that would land strictly before the teacher's today. Refused
   * because it is one-way through this editor: the row arrives already frozen
   * by `income_record`, so the typo that caused it cannot be undone here.
   * Logging a past class outright stays open — `/studio-class/new` bounds its
   * date field at neither end.
   */
  past_date: codedRefusal(
    'STUDIO_CLASS_PAST_DATE',
    'A class cannot move to a date in the past — it would become an income record and could not be edited again. Log a separate class on that date instead.',
  ),
} as const satisfies Record<StudioClassEditRefusal, CodedRefusal>;
