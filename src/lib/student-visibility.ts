import type { Prisma, StudentPrivacy } from '@prisma/client';
import type { NoneOf } from './type-pins';
import { formatStudentName } from './format';
import { log } from './log';

/**
 * One answer to "what may this teacher see about this student".
 *
 * Before #167 this rule had five implementations — `api/students/route.ts`,
 * `api/students/[id]/route.ts`, and three teacher server pages — and eight
 * further handlers that simply did not consult it. The route-only census in
 * the issue could not see the three pages, which is how a helper meant to
 * replace two copies would have become a sixth.
 *
 * Server-only. The `@prisma/client` import is type-only (same as `contacts.ts`
 * and `payment-status.ts`), but `./log` is pino and is a *value* import, so
 * this module must not be value-imported from a `'use client'` component —
 * `tiers.ts` documents the same hazard and answers it with a `tiers.server.ts`
 * split. No such split is needed here: everything this module exports is a
 * server-side gate. `studentNameSelect`/`studentVisibilitySelect` return Prisma
 * selects, and a client running `projectStudentForTeacher` would mean the raw
 * row had already reached the browser, which is the exact leak this module
 * exists to prevent. `import type` from a client module stays free, as always.
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
 * runtime: `tsc` fails at every external call site fed by whichever fragment
 * lost it, because the row no longer satisfies `ScopedVisibilityFlags`.
 * Measured: 8 errors from `studentVisibilitySelect` alone, 4 from
 * `studentNameSelect` alone, 12 from both — which is the module's own
 * call-site census, enumerated below. That is this type's real enforcement —
 * the shape, not the `find`.
 */
export type ScopedVisibilityFlags = VisibilityFlags & Pick<StudentPrivacy, 'teacherId'>;

/** The same scoping, for the name-only fragment. */
export type ScopedNameFlags = Pick<VisibilityFlags, 'shareFullName'> &
  Pick<StudentPrivacy, 'teacherId'>;

/**
 * Just enough to compose a display name.
 *
 * `id` is here only so `bypassesPrivacy` can name the student in the warning
 * it logs — see its docblock. It is not read by the name composition itself.
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
 * false. Four of the five link-creating upsert sites do
 * (`api/registrations/route.ts:202`,
 * `services/invitations.ts:535`, `services/waitlist.ts:234` and `:530`), but
 * `promoteNext` (`services/waitlist.ts:411`) links `nextEntry.studentId` off a
 * persisted `WaitlistEntry`, during a cancellation someone else initiated
 * (`api/registrations/[id]/route.ts:190`, `services/gdpr.ts:385`) — and its
 * own docblock says it is there to repair rows "written by hand (fixtures, a
 * psql fix-up)", i.e. precisely the rows no session produced. The conclusion
 * survives on the two supports above; the support that did not survive is what
 * a census of writers looks like when the writers are counted, not read.
 *
 * "Five" counts the upserts that can *create* a link, which is the only set
 * this argument is about. `TeacherStudent` has a sixth writer —
 * `api/students/[id]/route.ts`'s `teacherStudent.update`, the archive toggle —
 * which only flips a flag on a link that already exists.
 *
 * It is kept rather than deleted because removing it means removing the claim
 * path (`lib/auth/account.ts:37-52`), the `Student_claim_link_check`
 * constraint and `Student.claimedAt` together — one decision, not five edits.
 * Before #167 this comment stood in six places and each copy claimed the
 * question was "filed as a leaf"; no such issue existed. Five were the
 * privacy-rule copies this module replaced. The sixth is in
 * `components/students/student-directory.tsx`, where the same branch gates an
 * "unlinked" caption rather than a field — it still stands, corrected in place
 * rather than deleted, and points here for the canonical argument. Counting by
 * `git grep "Filed as a leaf"` found only five of those six copies, because
 * one wrapped the phrase across two lines; that is how the count in this
 * comment was wrong for the whole of #167. The same grep over `src/` now
 * returns a single hit — this sentence — because every copy but the directory
 * one is gone and that one no longer uses the phrase. It is not filed, and
 * this is deliberate: it is dead code with a complete explanation, not a
 * defect anyone can reach.
 *
 * The proof above is a comment, and comments do not run. The `log.warn` is
 * what makes the day it stops holding show up in a log line rather than in a
 * student's complaint. At the eight `projectStudentForTeacher` call sites this
 * branch ungates *every* field; at the four `teacherVisibleName` ones only
 * `shareFullName` is in play, since the name is all those sites read. Either
 * way a silent failure here is the largest one in the module.
 * Outside this module that is 12 call sites: 5 API routes (`api/payments/[id]`,
 * `api/classes/[id]/registrations`, `api/students`, `api/students/[id]`,
 * `api/registrations/[id]`), 5 across the three teacher pages
 * (`settings/payments` once, `students/[id]` once, `class/[id]` three times),
 * and 2 in `services/payments.ts`. Add the module-internal `teacherVisibleName`
 * call inside `projectStudentForTeacher` below and the total is 13. This
 * comment has already stated a wrong count once — before trusting either
 * number, recount with a grep for `teacherVisibleName` and
 * `projectStudentForTeacher` across `src/`.
 *
 * The payload carries both ids because either alone leaves the incident
 * unanswerable: `studentId` says whose data was bypassed, `teacherId` says who
 * received it. Both are UUIDs and neither is PII — no name, no email — so this
 * line is safe to keep at `warn` in a log anyone operating the box can read.
 *
 * Projecting an unclaimed student logs twice (once through `teacherVisibleName`);
 * deduplicating that would mean either threading a flag through the public
 * signature or composing the display name a second time here, and a doubled
 * line on a should-never-happen event is cheaper than either.
 *
 * `student-visibility.test.ts` asserts both directions — that it fires with
 * both ids for an unclaimed student, and that it stays silent for a claimed
 * one. Until #167's round-two review nothing asserted it at all, so the one
 * runtime tripwire on this branch could have been deleted silently.
 */
function bypassesPrivacy(
  student: { id: string; claimedAt: Date | null },
  teacherId: string,
): boolean {
  if (student.claimedAt) return false;
  log.warn(
    { studentId: student.id, teacherId },
    'unclaimed Student reached the teacher projection — every privacy flag is being bypassed',
  );
  return true;
}

export function teacherVisibleName(student: StudentNameInput, teacherId: string): string {
  const flags = student.studentPrivacy.find((p) => p.teacherId === teacherId);
  const shareFullName = bypassesPrivacy(student, teacherId) || (flags?.shareFullName ?? false);
  return formatStudentName(student.firstName, student.lastName, shareFullName);
}

export function projectStudentForTeacher(
  student: StudentProjectionInput,
  teacherId: string,
): TeacherVisibleStudent {
  const flags = student.studentPrivacy.find((p) => p.teacherId === teacherId);
  const ungated = bypassesPrivacy(student, teacherId);
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
