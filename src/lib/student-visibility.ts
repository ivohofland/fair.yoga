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
 * Server-side gates only. `studentNameSelect`/`studentVisibilitySelect` return
 * Prisma selects, and a client running `projectStudentForTeacher` would mean
 * the raw row had already reached the browser, which is the exact leak this
 * module exists to prevent. `import type` from a client module stays free.
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
 * `teacherId` is not optional and is not a convenience. Before this shape
 * existed the projections read `studentPrivacy[0]`, trusting the nested
 * `where: { teacherId }` in the query fragments below without being able to
 * check it: delete a `where` and `tsc`, unit and integration all stayed green
 * while every teacher read whichever row sorted first — another teacher's
 * flags, opened.
 *
 * What the flags-plus-owner shape buys is that the projection can re-check.
 * Be precise about what that is worth, because an earlier version of this
 * comment was not — it claimed the `find` makes a dropped `where` "fail
 * closed", and that is not what happens. Measured on this branch:
 *
 * - Drop `where: { teacherId }` alone → the query returns every teacher's
 *   rows, the `find` still selects the requesting teacher's own row, and the
 *   output is byte-identical. Harmless, and no suite notices (verified:
 *   students-api stays 34/34). It only withholds — "fails closed" — in the
 *   sub-case where the requesting teacher has no row and some other teacher
 *   does. The guarantee is not that the mutation is caught; it is that it can
 *   never leak another teacher's flags.
 * - Revert the `find` to `[0]` alone → the `where` still scopes the row set to
 *   one row, so that is also output-identical in production. The unit suite
 *   catches it anyway (4 red) because it hands the functions unscoped arrays
 *   directly.
 * - Both together — the pre-#167 code — is the one that leaks, and
 *   `students-api.test.ts`'s two-privacy-row fixture goes red on it.
 *
 * The mutation that universally produces no-match-every-field-null is
 * dropping `teacherId: true` from the nested `select`. It cannot reach
 * runtime: `tsc` fails at every call site fed by either fragment that lost
 * it, because the row no longer satisfies `ScopedVisibilityFlags`. That is
 * this type's real enforcement — the shape, not the `find`.
 */
export type ScopedVisibilityFlags = VisibilityFlags & Pick<StudentPrivacy, 'teacherId'>;

/** The same scoping, for the name-only fragment. */
export type ScopedNameFlags = Pick<VisibilityFlags, 'shareFullName'> &
  Pick<StudentPrivacy, 'teacherId'>;

/**
 * Just enough to compose a display name. The name composition reads the names
 * and the flags; `id` and `claimedAt` ride along for
 * `StudentProjectionInput`, which extends this and returns both.
 */
export interface StudentNameInput {
  id: string;
  firstName: string;
  lastName: string;
  claimedAt: Date | null;
  studentPrivacy: ScopedNameFlags[];
}

/** Everything the full projection reads. */
export interface StudentProjectionInput extends StudentNameInput {
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
 * An unclaimed student is projected through its `StudentPrivacy` row exactly
 * like a claimed one.
 */
export function teacherVisibleName(student: StudentNameInput, teacherId: string): string {
  const flags = student.studentPrivacy.find((p) => p.teacherId === teacherId);
  return formatStudentName(student.firstName, student.lastName, flags?.shareFullName ?? false);
}

export function projectStudentForTeacher(
  student: StudentProjectionInput,
  teacherId: string,
): TeacherVisibleStudent {
  const flags = student.studentPrivacy.find((p) => p.teacherId === teacherId);
  const shared = <T>(flag: boolean | undefined, value: T): T | null =>
    flag ?? false ? value : null;

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
 * `ScopedNameFlags`, which also records what each half of that redundancy is
 * and is not worth. In short: the `where` keeps the row set to one row; the
 * `find` makes the projection independent of whether it did. Dropping the
 * `where` on its own changes no output and reddens nothing — it is dropping
 * `teacherId: true` here that fails, and it fails at compile time.
 */
export function studentNameSelect(teacherId: string) {
  return {
    id: true,
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
