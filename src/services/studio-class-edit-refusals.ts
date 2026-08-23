/**
 * One refusal per reason, each naming the remedy — the shape
 * `STUDIO_CLASS_REFUSALS` uses, and for the same reason: a `Record` keyed by
 * the union makes adding a member a compile error until it has a message and
 * code of its own. Prose, not developer strings — `(teacher)` pages render
 * `error.message` verbatim (#197).
 *
 * Lives in its own import-free module so client components can value-import
 * the very words the API answers with: its sibling
 * `studio-class-editability.ts` reaches `@/lib/timezone`, whose transitive
 * chain ends in pino (`@/lib/log`), which is server-only. The disabled-date
 * explainer on the edit form is the same string as the API's refusal by
 * construction, not by two copies staying lucky.
 */
export type StudioClassEditRefusal = 'income_record' | 'generated_date';

export const STUDIO_CLASS_EDIT_REFUSALS: Record<
  StudioClassEditRefusal,
  { readonly message: string; readonly code: string }
> = {
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
};
