import type { CancelDeadline, AutoCancelCheck } from '@prisma/client';
import type { NoneOf } from '@/lib/type-pins';

/**
 * The cancellation options a teacher is offered, and the single home for the
 * teacher-facing pickers: `template-form.tsx` and `class/new/new-class-form.tsx` both
 * read them from here, so the pins below guarantee every screen that renders
 * these choices *for teacher input*.
 *
 * Not the only place these four labels are rendered, full stop:
 * `cancel-booking-button.tsx` has its own `DEADLINE_LABELS`, unpinned. That
 * copy is display-only and student-facing — it shows a student the deadline
 * a class already has, not a set of choices — so it is out of scope here,
 * but it means an enum member added above is not guaranteed to get a matching
 * label there.
 *
 * The dropdown is the list. An enum member with no option here fails the build,
 * so no consumer of this module can offer a stale set of choices.
 *
 * Consequence worth knowing before deleting an entry: removing an option to
 * hide a choice from teachers now fails the build. Hiding a choice means
 * removing it from the enum, or gating it at render.
 */
export const CANCEL_DEADLINE_OPTIONS = [
  { value: 'HOURS_48', label: '48 hours' },
  { value: 'HOURS_24', label: '24 hours' },
  { value: 'HOURS_12', label: '12 hours' },
  { value: 'HOURS_6', label: '6 hours' },
] as const;

export const AUTO_CANCEL_OPTIONS = [
  { value: 'HOURS_4', label: '4 hours before' },
  { value: 'HOURS_2', label: '2 hours before' },
  { value: 'HOURS_1', label: '1 hour before' },
] as const;

/** What the "Cancellation deadline" picker means, for the line under it. */
export function cancelDeadlineHint(value: CancelDeadlineOption): string {
  const label = CANCEL_DEADLINE_OPTIONS.find((o) => o.value === value)?.label ?? value;
  return `Students can cancel for free until ${label} before the class starts. After that they are still charged their share of the class cost.`;
}

/**
 * What the "Auto-cancel check" picker means, for the line under it. Names the
 * minimum from the pricing step so the teacher reads the actual threshold.
 */
export function autoCancelHint(value: AutoCancelOption, minStudents: number): string {
  const label = AUTO_CANCEL_OPTIONS.find((o) => o.value === value)?.label ?? value;
  const lead = `${label.charAt(0).toUpperCase()}${label.slice(1)} the class starts, we check the registrations.`;
  const outcome = 'the class is cancelled and everyone is notified.';
  const lateCancellations = ' Late cancellations count, because they still pay.';
  if (!Number.isInteger(minStudents) || minStudents < 1) {
    return `${lead} If they are below the minimum number of students, ${outcome}${lateCancellations}`;
  }
  const shortfall =
    minStudents === 1 ? 'nobody has registered' : `fewer than ${minStudents} students have registered`;
  return `${lead} If ${shortfall}, ${outcome}${lateCancellations}`;
}

export type CancelDeadlineOption = (typeof CANCEL_DEADLINE_OPTIONS)[number]['value'];
export type AutoCancelOption = (typeof AUTO_CANCEL_OPTIONS)[number]['value'];

const _offersEveryDeadline: NoneOf<Exclude<CancelDeadline, CancelDeadlineOption>> = true;
const _noStaleDeadline: NoneOf<Exclude<CancelDeadlineOption, CancelDeadline>> = true;
const _offersEveryCheck: NoneOf<Exclude<AutoCancelCheck, AutoCancelOption>> = true;
const _noStaleCheck: NoneOf<Exclude<AutoCancelOption, AutoCancelCheck>> = true;
void _offersEveryDeadline;
void _noStaleDeadline;
void _offersEveryCheck;
void _noStaleCheck;
