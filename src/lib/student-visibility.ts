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
 * Every `share*` column on `StudentPrivacy` must be classified — either as a
 * visibility flag above, or in the explicit exclusion list here. A new column
 * (say `shareIncomeTier`) fails this pin by name rather than being silently
 * ignored by every projection in the app.
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

/** Just enough to compose a display name. */
export interface StudentNameInput {
  firstName: string;
  lastName: string;
  claimedAt: Date | null;
  studentPrivacy: Pick<VisibilityFlags, 'shareFullName'>[];
}

/** Everything the full projection reads. */
export interface StudentProjectionInput extends StudentNameInput {
  id: string;
  email: string;
  phone: string | null;
  birthday: Date | null;
  address: string | null;
  studentPrivacy: VisibilityFlags[];
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
 * No raw name or tier field may rejoin the projection. This is the exact
 * regression #167 closed, and it would otherwise reappear silently the first
 * time someone "just needs the surname here".
 */
const _projectionCarriesNoRawIdentity: NoneOf<
  Extract<
    keyof TeacherVisibleStudent,
    'firstName' | 'lastName' | 'incomeTier' | 'tierAtBooking' | 'tierRatio'
  >
> = true;
void _projectionCarriesNoRawIdentity;

/**
 * #166 retired the unclaimed student: nothing creates a `Student` row without
 * `claimedAt` any more, every `TeacherStudent` writer requires a
 * `session.studentId`, and `Student_claim_link_check` ties `accountId` to
 * `claimedAt`. There is no production deployment, so no legacy unclaimed rows
 * exist anywhere for this branch to expose.
 *
 * It is kept rather than deleted because removing it means removing the claim
 * path (`lib/auth/account.ts:34-50`), the `Student_claim_link_check`
 * constraint and `Student.claimedAt` together — one decision, not five edits.
 * Before #167 this comment stood in five places and each copy claimed the
 * question was "filed as a leaf"; no such issue existed. It is not filed, and
 * this is deliberate: it is dead code with a complete explanation, not a
 * defect anyone can reach.
 */
function bypassesPrivacy(student: { claimedAt: Date | null }): boolean {
  return !student.claimedAt;
}

export function teacherVisibleName(student: StudentNameInput): string {
  const shareFullName =
    bypassesPrivacy(student) || (student.studentPrivacy[0]?.shareFullName ?? false);
  return formatStudentName(student.firstName, student.lastName, shareFullName);
}

export function projectStudentForTeacher(
  student: StudentProjectionInput,
): TeacherVisibleStudent {
  const flags = student.studentPrivacy[0];
  const ungated = bypassesPrivacy(student);
  const shared = <T>(flag: boolean | undefined, value: T): T | null =>
    ungated || (flag ?? false) ? value : null;

  return {
    id: student.id,
    displayName: teacherVisibleName(student),
    email: shared(flags?.shareEmail, student.email),
    phone: shared(flags?.sharePhone, student.phone),
    birthday: shared(flags?.shareBirthday, student.birthday),
    address: shared(flags?.shareAddress, student.address),
    claimedAt: student.claimedAt,
  };
}

/** Query fragment for `teacherVisibleName`'s input. */
export function studentNameSelect(teacherId: string) {
  return {
    firstName: true,
    lastName: true,
    claimedAt: true,
    studentPrivacy: {
      where: { teacherId },
      select: { shareFullName: true },
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
        shareFullName: true,
        shareEmail: true,
        sharePhone: true,
        shareBirthday: true,
        shareAddress: true,
      },
    },
  } satisfies Prisma.StudentSelect;
}
