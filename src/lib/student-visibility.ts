import type { Prisma, StudentPrivacy } from '@prisma/client';
import type { NoneOf } from './type-pins';
import { formatStudentName } from './format';

/**
 * One answer to "what may this teacher see about this student".
 *
 * Before #167 this rule had five implementations — `api/students/route.ts`,
 * `api/students/[id]/route.ts`, and three teacher server pages — and eight
 * further handlers that simply did not consult it. The route-only census in
 * the issue could not see the three pages, which is how a helper meant to
 * replace two copies would have become a sixth.
 *
 * Type-only `@prisma/client` import, same as `contacts.ts` and
 * `payment-status.ts`: this stays safe to import from a `'use client'` module
 * without pulling the Prisma runtime into the browser bundle.
 */

/**
 * The flags that gate *field visibility*.
 *
 * `receiveComms` is deliberately absent. It gates message delivery
 * (`api/announcements/route.ts`), not what a teacher may read — folding it in
 * here would invite a call site to hide a student's phone number because they
 * opted out of optional email.
 */
export type VisibilityFlags = Pick<
  StudentPrivacy,
  'shareFullName' | 'shareEmail' | 'sharePhone' | 'shareBirthday' | 'shareAddress'
>;

/**
 * Every column on `StudentPrivacy` must be classified — either as a
 * visibility flag above, or in the explicit exclusion list here. That
 * includes non-`share*` columns like `receiveComms`, `id`, and the
 * timestamps: this pin does not only watch for new `share*` columns, it
 * watches the whole model. A new column (say `shareIncomeTier`) fails this
 * pin by name rather than being silently ignored by every projection in the
 * app.
 *
 * #167 decided against `shareIncomeTier` specifically: on `/class/[id]`,
 * `PricingBreakdown` renders "Tier 4 · €15.20" and `PaymentChecklist` renders
 * "Anna B. — €15.20" in adjacent sections, and the five `TIER_RATIOS` are
 * distinct, so the tier of any student who books is legible by name regardless.
 * If that display ever changes, this pin is where the decision gets revisited.
 */
const _visibilityFlagsAreExhaustive: NoneOf<
  Exclude<
    keyof StudentPrivacy,
    | 'id' | 'studentId' | 'teacherId' | 'createdAt' | 'updatedAt'
    | 'receiveComms'
    | keyof VisibilityFlags
  >
> = true;
void _visibilityFlagsAreExhaustive;

/**
 * A `StudentPrivacy` row as a projection reads it: the flags, plus the
 * `teacherId` that says whose flags they are.
 *
 * `teacherId` is not optional and is not a convenience. Both query fragments
 * below scope their nested `studentPrivacy` with `where: { teacherId }`, and
 * before this shape existed the projections trusted that scope blindly by
 * reading `studentPrivacy[0]`. Deleting either `where` therefore left `tsc`,
 * the unit suite and the integration suite all green while handing a teacher
 * whatever privacy row happened to sort first — i.e. *opening* another
 * teacher's flags. Carrying the owner in the row and matching on it here makes
 * that mutation fail closed instead: no match, every field `null`.
 */
export type ScopedVisibilityFlags = VisibilityFlags & Pick<StudentPrivacy, 'teacherId'>;

/** The same scoping, for the name-only fragment. */
export type ScopedNameFlags = Pick<VisibilityFlags, 'shareFullName'> &
  Pick<StudentPrivacy, 'teacherId'>;

/** Just enough to compose a display name. */
export interface StudentNameInput {
  firstName: string;
  lastName: string;
  claimedAt: Date | null;
  studentPrivacy: ScopedNameFlags[];
}

/** Everything the full projection reads. */
export interface StudentProjectionInput extends StudentNameInput {
  id: string;
  email: string;
  phone: string | null;
  birthday: Date | null;
  address: string | null;
  studentPrivacy: ScopedVisibilityFlags[];
}

/**
 * What a teacher may see. Every key is always present; a withheld field is
 * `null`, never absent — an absent key is indistinguishable from a route that
 * forgot to select the field, which is the failure #167 existed to close.
 *
 * No `firstName`, no `lastName`: the un-truncated surname is not in this object
 * at all, so a new call site cannot leak it by forgetting to truncate.
 */
export interface TeacherVisibleStudent {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  birthday: Date | null;
  address: string | null;
  claimedAt: Date | null;
}

/**
 * The projection carries these seven keys and nothing else — an allowlist, in
 * the same shape as `_visibilityFlagsAreExhaustive` above. Adding a key to
 * `TeacherVisibleStudent` without adding it here fails the build *by that
 * key's name*, which is what forces the "may a teacher see this?" question to
 * be answered deliberately rather than by whoever needed the field.
 *
 * This was a denylist until the PR review of #167: `Extract<…, 'firstName' |
 * 'lastName' | 'incomeTier' | 'tierAtBooking' | 'tierRatio'>`, which only ever
 * fired on those five spellings. A reviewer added `surname: string` populated
 * from `student.lastName` and `tsc` exited 0 — the pin named the regression it
 * was written against and certified everything else. A guard that can only
 * catch the bug that already happened is not a guard.
 */
const _projectionCarriesNoRawIdentity: NoneOf<
  Exclude<
    keyof TeacherVisibleStudent,
    'id' | 'displayName' | 'email' | 'phone' | 'birthday' | 'address' | 'claimedAt'
  >
> = true;
void _projectionCarriesNoRawIdentity;

/**
 * #166 retired the unclaimed student, and the bypass is unreachable because of
 * what creates a `Student`, not because of what links one. Exactly two sites
 * create the row — `api/auth/student-signup/route.ts:41` and
 * `api/account/student-profile/route.ts:54` — and both set `claimedAt` in the
 * creating statement. There is therefore no unclaimed `Student` for any
 * `TeacherStudent` writer to link, however that writer gets its `studentId`.
 * There is no production deployment either, so no legacy unclaimed rows exist
 * anywhere for this branch to expose.
 *
 * `Student_claim_link_check` is *not* a third support, though an earlier
 * version of this comment leaned on it as one. It is
 * `CHECK (("claimedAt" IS NULL) = ("accountId" IS NULL))`, which `(null, null)`
 * satisfies: it forbids a row where claim and link disagree, not a row that is
 * unclaimed. A future write that sets neither column passes it. The two
 * creation sites are what make the branch dead; the constraint only keeps
 * `claimedAt` and `accountId` telling the same story.
 *
 * An earlier draft of this comment argued it from the link side instead —
 * "every `TeacherStudent` writer requires a `session.studentId`" — and that is
 * false. Four of the five do (`api/registrations/route.ts:202`,
 * `services/invitations.ts:535`, `services/waitlist.ts:234` and `:530`), but
 * `promoteNext` (`services/waitlist.ts:411`) links `nextEntry.studentId` off a
 * persisted `WaitlistEntry`, during a cancellation someone else initiated
 * (`api/registrations/[id]/route.ts:190`, `services/gdpr.ts:385`) — and its
 * own docblock says it is there to repair rows "written by hand (fixtures, a
 * psql fix-up)", i.e. precisely the rows no session produced. The conclusion
 * survives on the two supports above; the support that did not survive is what
 * a census of writers looks like when the writers are counted, not read.
 *
 * It is kept rather than deleted because removing it means removing the claim
 * path (`lib/auth/account.ts:34-50`), the `Student_claim_link_check`
 * constraint and `Student.claimedAt` together — one decision, not five edits.
 * Before #167 this comment stood in six places and each copy claimed the
 * question was "filed as a leaf"; no such issue existed. Five were the
 * privacy-rule copies this module replaced. The sixth is in
 * `components/students/student-directory.tsx`, where the same branch gates an
 * "unlinked" caption rather than a field — it still stands, corrected in place
 * rather than deleted, and points here for the canonical argument. Counting by
 * `git grep "Filed as a leaf"` finds only five, because that copy wraps the
 * phrase across two lines; that is how the count in this comment was wrong for
 * the whole of #167. It is not filed, and this is deliberate: it is dead code
 * with a complete explanation, not a defect anyone can reach.
 */
function bypassesPrivacy(student: { claimedAt: Date | null }): boolean {
  return !student.claimedAt;
}

export function teacherVisibleName(student: StudentNameInput, teacherId: string): string {
  const flags = student.studentPrivacy.find((p) => p.teacherId === teacherId);
  const shareFullName = bypassesPrivacy(student) || (flags?.shareFullName ?? false);
  return formatStudentName(student.firstName, student.lastName, shareFullName);
}

export function projectStudentForTeacher(
  student: StudentProjectionInput,
  teacherId: string,
): TeacherVisibleStudent {
  const flags = student.studentPrivacy.find((p) => p.teacherId === teacherId);
  const ungated = bypassesPrivacy(student);
  const shared = <T>(flag: boolean | undefined, value: T): T | null =>
    ungated || (flag ?? false) ? value : null;

  return {
    id: student.id,
    displayName: teacherVisibleName(student, teacherId),
    email: shared(flags?.shareEmail, student.email),
    phone: shared(flags?.sharePhone, student.phone),
    birthday: shared(flags?.shareBirthday, student.birthday),
    address: shared(flags?.shareAddress, student.address),
    claimedAt: student.claimedAt,
  };
}

/**
 * Query fragment for `teacherVisibleName`'s input.
 *
 * `teacherId: true` inside the nested select is what lets the projection
 * re-check the scope it was handed rather than trusting it — see
 * `ScopedNameFlags`. The `where` and the `find` are deliberately redundant:
 * the `where` keeps the row set small, the `find` is what fails closed if the
 * `where` is ever dropped.
 */
export function studentNameSelect(teacherId: string) {
  return {
    firstName: true,
    lastName: true,
    claimedAt: true,
    studentPrivacy: {
      where: { teacherId },
      select: { teacherId: true, shareFullName: true },
    },
  } satisfies Prisma.StudentSelect;
}

/** Query fragment for `projectStudentForTeacher`'s input. */
export function studentVisibilitySelect(teacherId: string) {
  return {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    birthday: true,
    address: true,
    claimedAt: true,
    studentPrivacy: {
      where: { teacherId },
      select: {
        teacherId: true,
        shareFullName: true,
        shareEmail: true,
        sharePhone: true,
        shareBirthday: true,
        shareAddress: true,
      },
    },
  } satisfies Prisma.StudentSelect;
}
