# Student Archive Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make archiving a student mean "nothing live with this teacher": refuse
archiving while money or billable classes are open (with an atomic
waive-and-archive), and clear the flag whenever the student becomes live again.

**Architecture:** One new locking primitive, `activateTeacherStudentLink`
(`services/roster-link.ts`), is called by every path that makes something live;
one new service, `archiveStudent` (`services/student-archive.ts`), takes the
same row lock first and checks the invariant. Both serialise on the
`TeacherStudent` row. The route and the button are thin over the service.

**Tech Stack:** Next.js 16 route handlers, Prisma interactive transactions,
PostgreSQL row locks, vitest (`unit`, `integration`, `components` projects),
React client component.

**Spec:** `docs/superpowers/specs/2026-09-27-student-archive-semantics-design.md`
— read it before any task. Every task argues from it.

## Global Constraints

- TypeScript `strict`; no `any`, no `as` widening casts on status arrays.
- Services in `src/services/` import no Next.js/HTTP code.
- Every 409 carries a code registered in `src/lib/api-error-codes.ts`; tests
  assert it with `expectRefusal` (`tests/api-assertions.ts`), never a message.
  No test may assert `error.message` text.
- "Goal already holds" answers `respondUnchanged`, placed after ownership.
- Lock order after this change:
  `Student → Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Payment → Invitation → TeacherBlock`.
- "Live registration" uses `CHARGED_STATUSES` (`services/class-lifecycle.ts`),
  never `ACTIVE_REGISTRATION_STATUSES`.
- Comments state what is true now and annotate only their own code; wider
  claims go in `docs/` (CLAUDE.md, *Comment Discipline*). No counts or rosters
  in comments.
- Stage exact paths; never `git add -A`/`.`. Quote paths containing `(teacher)`.
- In this worktree: `pnpm install --frozen-lockfile`, `pnpm run worktree:setup`,
  `pnpm run worktree:up` once before any `--project integration` run. Never
  touch the dev server on :3000.
- Every guard gets a mutation step: break it, run the named test, record the
  exact failing assertion text in the task report, restore, `git status` clean.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `src/services/roster-link.ts` | `activateTeacherStudentLink`; `linkTeacherStudent` calls it | 1 |
| `src/app/api/registrations/route.ts` | teacher roster add activates the link in-tx | 2 |
| `src/services/payments.ts` | `reopenPayment` becomes a transaction that reactivates | 3 |
| `src/lib/api-error-codes.ts` | two new codes | 4 |
| `src/services/student-archive.ts` (new) | `archiveStudent`, the invariant check + waive | 4 |
| `src/app/api/students/[id]/route.ts` | PATCH delegates to the service | 4 |
| `src/lib/schemas.ts` | `archiveStudentBodySchema` | 4 |
| `src/app/api/announcements/route.ts` | all-students send skips archived | 5 |
| `src/components/students/archive-student-button.tsx`, `src/app/(teacher)/students/[id]/page.tsx` | confirm + waive UI | 6 |
| `src/services/student-archive-lock-order.test.ts` (new), `docs/lock-order.md` | race proofs + lock docs | 7 |
| `docs/data-model.md`, `docs/product-concept.md` | the invariant, for readers | 4 |

**Task order is load-bearing:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 4's service
takes the lock Task 1 introduces; Task 7's race tests need Tasks 1, 3 and 4.

---

### Task 1: `activateTeacherStudentLink`, and every link un-archives

**Files:**
- Modify: `src/services/roster-link.ts`
- Test: `src/services/roster-link.test.ts` (extend), `tests/integration/student-archive-reactivation.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type LockedLink = { id: string; isArchived: boolean };
  export async function lockTeacherStudentLink(
    tx: Prisma.TransactionClient,
    pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
  ): Promise<LockedLink | null>;               // SELECT … FOR UPDATE; writes nothing

  export type LinkActivation = 'active' | 'reactivated' | 'missing';
  export async function activateTeacherStudentLink(
    tx: Prisma.TransactionClient,
    pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
  ): Promise<LinkActivation>;                  // lockTeacherStudentLink, then clear the flag
  ```
  Two functions because Task 3 (`reopenPayment`) and Task 4 (`archiveStudent`)
  need the lock without the un-archive. `linkTeacherStudent`'s signature and
  `LinkOutcome` return are unchanged.

- [ ] **Step 1: Failing unit tests** in `roster-link.test.ts` (it already has a
  DB-backed setup; follow its fixtures):
  - `activateTeacherStudentLink` on an archived link returns `'reactivated'` and
    the row reads `isArchived: false` afterwards.
  - On an active link returns `'active'`, row unchanged (`updatedAt` equal if the
    model has one; otherwise `isArchived` still false).
  - With no row returns `'missing'` and creates no row
    (`teacherStudent.count` for the pair is 0).
  - `lockTeacherStudentLink` returns `{ id, isArchived }` for an existing row and
    `null` for none, and never changes `isArchived`.
  - `linkTeacherStudent` on an archived existing link returns `'already-linked'`
    AND leaves `isArchived: false`.

- [ ] **Step 2: Run** `pnpm exec vitest run src/services/roster-link.test.ts` —
  expect FAIL: `activateTeacherStudentLink` is not exported.

- [ ] **Step 3: Implement** in `roster-link.ts`:
  ```ts
  /**
   * Lock this pair's link row and make sure it is not archived. Never inserts:
   * a teacher may not create a link on their own (`docs/data-model.md`,
   * TeacherStudent), so a missing row is reported, not repaired.
   *
   * The `FOR UPDATE` is the point. `archiveStudent` takes the same lock before
   * checking that the pair has nothing live, so a transaction that makes
   * something live and calls this serialises against an archive in either
   * order (`docs/lock-order.md`, "The `TeacherStudent` row is the archive's
   * gate").
   */
  export async function activateTeacherStudentLink(
    tx: Prisma.TransactionClient,
    pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
  ): Promise<LinkActivation> {
    const row = await lockTeacherStudentLink(tx, pair);
    if (!row) return 'missing';
    if (!row.isArchived) return 'active';
    await tx.teacherStudent.update({ where: { id: row.id }, data: { isArchived: false } });
    return 'reactivated';
  }

  /** The link row, locked for this transaction; `null` when the pair has none. Writes nothing. */
  export async function lockTeacherStudentLink(
    tx: Prisma.TransactionClient,
    pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
  ): Promise<LockedLink | null> {
    const rows = await tx.$queryRaw<LockedLink[]>`
      SELECT id, "isArchived" FROM "TeacherStudent"
      WHERE "teacherId" = ${pair.teacherId} AND "studentId" = ${pair.studentId}
      FOR UPDATE`;
    return rows[0] ?? null;
  }
  ```
  The `activateTeacherStudentLink` docblock above carries the "why the lock";
  `lockTeacherStudentLink`'s stays one line. In `linkTeacherStudent`, after the `createMany`, call
  `await activateTeacherStudentLink(tx, pair);` before returning. Add one
  sentence to its docblock: it also un-archives the pair, under the link's row
  lock, pointing at `activateTeacherStudentLink`. Do not change the
  `LinkOutcome` computation.

- [ ] **Step 4: Run** the unit file — PASS.

- [ ] **Step 5: Failing integration tests**, new file
  `tests/integration/student-archive-reactivation.test.ts`. One teacher, a room,
  an open future class (`createClassFixture`, status `open`), and per test a fresh
  student with an archived link (`teacherStudent.create({ data: { teacherId,
  studentId, isArchived: true } })`). One `it` per act, each asserting the link
  reads `isArchived: false` afterwards:
  - self-booking: student session `POST /api/registrations { classId }`;
  - walk-in of an existing linked student (the route's walk-in subject, as
    `tests/integration/registrations-*.test.ts` drive it);
  - waitlist join: full class (`maxStudents` reached by other registrations),
    student `POST` to the waitlist route;
  - invitation accept: create the invitation through the teacher API, accept it
    through the student API, as `tests/integration/invitations-api.test.ts` does.
  `promoteNext` and `claimSpot` are covered at service level in
  `src/services/waitlist*.test.ts`: add one test each there, calling the service
  with an archived link and reading the flag.
  Use `freshIp()` on every request; tear down with `teardownStudent`.

- [ ] **Step 6: Run** them against the code *before* Step 3 to see them fail:
  `git stash push -m 265-t1-red -- src/services/roster-link.ts`, run
  `pnpm exec vitest run --project integration tests/integration/student-archive-reactivation.test.ts`,
  expect FAIL (`isArchived` true), then `git stash apply` the entry's SHA and drop
  it (see the worktree stash rule — never bare `stash pop`). Re-run: PASS.

- [ ] **Step 7: Mutation.** Delete the `activateTeacherStudentLink` call inside
  `linkTeacherStudent`; run the reactivation file; record which tests fail and
  their assertion text; restore; `git status` clean.

- [ ] **Step 8: Commit**
  ```bash
  git add src/services/roster-link.ts src/services/roster-link.test.ts tests/integration/student-archive-reactivation.test.ts <waitlist test file(s) touched>
  git commit -m "feat(students): every roster link un-archives the pair under its row lock (#265)"
  ```

---

### Task 2: teacher roster add activates the link inside its transaction

**Files:**
- Modify: `src/app/api/registrations/route.ts`
- Test: `tests/integration/student-archive-reactivation.test.ts` (extend)

**Interfaces:**
- Consumes: `activateTeacherStudentLink` from Task 1.

- [ ] **Step 1: Failing tests** in the reactivation file:
  - Teacher `POST /api/registrations` with the roster subject for an archived
    linked student → 201, link reads `isArchived: false`.
  - No link at all → 403 and no `Registration` for the pair (today's
    pre-transaction check; stays green throughout).

  The in-transaction `'missing'` branch is reachable only when an unlink lands
  between the pre-transaction check and the lock. An integration test cannot
  pause the server between the two, so that branch is **not pinned by a test**;
  say so in the task report and the PR body rather than writing a test that
  cannot fail.

- [ ] **Step 2: Run** — the first fails (`isArchived` true).

- [ ] **Step 3: Implement.** Add near the other error classes:
  ```ts
  class NotInRosterError extends Error {}
  ```
  In the transaction, after the `completeWalkIn` block and before the
  self-booking link block:
  ```ts
  // A roster add links no one — the teacher may not create a link — but it
  // makes the pair live, so it takes the link's lock and un-archives it like
  // every linking act. `'missing'`: the student unlinked after the check
  // above; the registration rolls back.
  if (target.kind === 'roster') {
    const activation = await activateTeacherStudentLink(tx, {
      teacherId: cls.calendarEntry.teacherId,
      studentId,
    });
    if (activation === 'missing') throw new NotInRosterError();
  }
  ```
  Map `NotInRosterError` to `respondError('Student is not in your roster', 403)`
  wherever the route maps `ClassFullError` and its siblings. Check the actual
  discriminant name of the roster target in this file (`target.kind`) before
  writing — use the one the file uses.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Mutation.** Remove the `if (target.kind === 'roster')` block;
  run; record the failure (the un-archive test); restore; clean.

- [ ] **Step 6: Commit**
  ```bash
  git add src/app/api/registrations/route.ts tests/integration/student-archive-reactivation.test.ts
  git commit -m "feat(registrations): a teacher roster add un-archives the student in its transaction (#265)"
  ```

---

### Task 3: reopening a payment un-archives

**Files:**
- Modify: `src/services/payments.ts` (`reopenPayment`)
- Test: `src/services/payments.test.ts` (extend)

**Interfaces:**
- Consumes: `lockTeacherStudentLink` (Task 1).
- Produces: `reopenPayment(db: PrismaClient, paymentId: string): Promise<PaymentOutcome>` — signature unchanged.

- [ ] **Step 1: Failing tests** in `payments.test.ts`, beside the existing
  `reopenPayment` tests:
  - A `not_charged` payment for a student whose link with the class's teacher is
    archived → outcome `applied`, link `isArchived: false`.
  - Same with `paid`.
  - An already-`pending` payment with an archived link → `unchanged`, link stays
    archived (nothing was made live).
  - A `not_charged` payment whose student has NO link → `applied` (no refusal).

- [ ] **Step 2: Run** `pnpm exec vitest run src/services/payments.test.ts` — the
  first two FAIL.

- [ ] **Step 3: Implement.** Wrap the body in `db.$transaction(async (tx) => …)`:
  1. `tx.payment.findUnique({ where: { id }, select: { registration: { select:
     { studentId: true, class: { select: { calendarEntry: { select: { teacherId:
     true } } } } } } } })`; `null` → `{ kind: 'refused', refusal: PAYMENT_GONE }`.
  2. `const link = await lockTeacherStudentLink(tx, { teacherId, studentId })` —
     **before** the CAS, so the order is `TeacherStudent → Payment`. Not
     `activateTeacherStudentLink`: that clears the flag unconditionally, and an
     `unchanged` or refused reopen makes nothing live.
  3. The existing CAS `updateMany`, through `tx`. If `count === 1` and
     `link?.isArchived`, `tx.teacherStudent.update({ where: { id: link.id },
     data: { isArchived: false } })`. A `null` link (student unlinked) writes
     nothing and does not refuse.
  4. The existing `count === 0` classification stays as is, reading through `tx`.
  Update the docblock: reopening makes the payment outstanding again, so it
  un-archives the pair (`docs/data-model.md`, TeacherStudent), under the link's
  lock taken first.

- [ ] **Step 4: Run** `payments.test.ts` — PASS. Also
  run `pnpm exec vitest run --project integration tests/integration/payments-api.test.ts`
  — PASS unedited.

- [ ] **Step 5: Mutation.** Remove the un-archive write; run; record; restore.

- [ ] **Step 6: Commit**
  ```bash
  git add src/services/payments.ts src/services/payments.test.ts
  git commit -m "feat(payments): reopening a payment un-archives the student, link locked first (#265)"
  ```

---

### Task 4: `archiveStudent` — refuse while live, waive-and-archive atomically

**Files:**
- Create: `src/services/student-archive.ts`, `src/services/student-archive.test.ts`
- Modify: `src/lib/api-error-codes.ts`, `src/lib/schemas.ts`, `src/app/api/students/[id]/route.ts`, `docs/data-model.md`, `docs/product-concept.md`, `docs/technical-architecture.md` (only if it keeps a code register — check `grep -n "PAYMENT_WAIVED" docs/technical-architecture.md`)
- Test: `tests/integration/students-api.test.ts` (extend the PATCH describe)

**Interfaces:**
- Consumes: `lockTeacherStudentLink` (Task 3), `CHARGED_STATUSES`, `OUTSTANDING_STATUSES`.
- Produces:
  ```ts
  export type ArchiveOutcome =
    | { kind: 'archived'; waivedCount: number }
    | { kind: 'unchanged' }
    | { kind: 'not-linked' }
    | { kind: 'refused'; refusal: CodedRefusal };
  export async function archiveStudent(
    db: PrismaClient,
    input: { teacherId: string; studentId: string; waivePaymentIds?: readonly string[] },
  ): Promise<ArchiveOutcome>;
  ```
  Codes: `STUDENT_HAS_UNBILLED_CLASSES: 409`, `STUDENT_HAS_OUTSTANDING_PAYMENTS: 409`.

- [ ] **Step 1: Register the codes** in `API_ERROR_STATUS`, alphabetical, both
  409. Find how `CodedRefusal`/`codedRefusal` are imported in `payments.ts` and
  use the same.

- [ ] **Step 2: Failing service tests** (`student-archive.test.ts`, DB-backed like
  `payments.test.ts`). Fixture: teacher, room, one student with an active link.
  Helpers inside the file: `liveClass(status)`, `completedClassWithPayment(status)`.
  Cases, each asserting the outcome AND the resulting `isArchived`/payment rows:
  - nothing live → `archived`, `waivedCount: 0`, link archived.
  - registration `registered` on an `open` class → refused
    `STUDENT_HAS_UNBILLED_CLASSES`, link not archived.
  - registration `late_cancel` on an `open` class → same refusal.
  - registration `registered` on a class whose entry `cancelledAt` is set → archived.
  - `attended` on a `completed` class with a `paid` payment → archived.
  - `pending` payment → refused `STUDENT_HAS_OUTSTANDING_PAYMENTS`, payment still pending.
  - `overdue` payment → same.
  - both a live registration and a pending payment → `STUDENT_HAS_UNBILLED_CLASSES`.
  - `waivePaymentIds` = exactly the two open ids → `archived`, `waivedCount: 2`,
    both `not_charged` with `notChargedAt` set, link archived.
  - `waivePaymentIds` = one of two → refused OUTSTANDING, both still open, link active.
  - `waivePaymentIds` = both plus a third open payment of the same student with a
    **different teacher** → refused, nothing written (the foreign payment untouched).
  - `waivePaymentIds` = both plus a `paid` one of this pair → refused.
  - already archived → `unchanged`, even with `waivePaymentIds`.
  - no link → `not-linked`.
  - an open payment of the same student with a different teacher only → archived
    (scope is the pair).

- [ ] **Step 3: Run** — FAIL (module missing).

- [ ] **Step 4: Implement** `src/services/student-archive.ts`:
  ```ts
  export async function archiveStudent(db, { teacherId, studentId, waivePaymentIds }) {
    return db.$transaction(async (tx) => {
      const link = await lockTeacherStudentLink(tx, { teacherId, studentId });
      if (!link) return { kind: 'not-linked' };
      if (link.isArchived) return { kind: 'unchanged' };

      const unbilled = await tx.registration.count({
        where: {
          studentId,
          status: { in: [...CHARGED_STATUSES] },
          class: { status: { not: 'completed' }, calendarEntry: { teacherId, cancelledAt: null } },
        },
      });
      if (unbilled > 0) return { kind: 'refused', refusal: unbilledRefusal(unbilled) };

      const open = await tx.payment.findMany({
        where: {
          status: { in: [...OUTSTANDING_STATUSES] },
          registration: { studentId, class: { calendarEntry: { teacherId } } },
        },
        select: { id: true, amount: true },
      });
      if (open.length > 0) {
        if (!waivePaymentIds || !sameIdSet(waivePaymentIds, open.map((p) => p.id))) {
          return { kind: 'refused', refusal: outstandingRefusal(open, waivePaymentIds !== undefined) };
        }
        await tx.payment.updateMany({
          where: { id: { in: open.map((p) => p.id) }, status: { in: [...OUTSTANDING_STATUSES] } },
          data: { status: 'not_charged', notChargedAt: new Date() },
        });
      }
      await tx.teacherStudent.update({ where: { id: link.id }, data: { isArchived: true } });
      return { kind: 'archived', waivedCount: open.length };
    });
  }
  ```
  - `sameIdSet(a, b)`: equal size after de-duplication and every member of `a` in `b`.
  - Refusal copy (the service owns it; the button shows it verbatim):
    - unbilled: `` `This student is booked on ${n} ${n === 1 ? 'class' : 'classes'} that ${n === 1 ? "hasn't" : "haven't"} been billed yet. Remove them from ${n === 1 ? 'it' : 'those classes'}, or archive once ${n === 1 ? "it's" : "they're"} completed.` ``
    - outstanding, first ask: `` `This student still owes ${formatEuro(total)} across ${n} ${n === 1 ? 'payment' : 'payments'}. Waive ${n === 1 ? 'it' : 'them'} to archive.` ``
    - outstanding, ids no longer match: `` `What this student owes has changed — now ${formatEuro(total)} across ${n} ${n === 1 ? 'payment' : 'payments'}. Check it and try again.` ``
    Use the repo's existing money formatter (`grep -rn "export function format" src/lib | grep -i "eur\|money\|price"`); do not write a new one. Sum `amount` as `Prisma.Decimal` or via the formatter's expected input, not float addition, matching how `settings/payments/page.tsx` totals.
  - The `updateMany` keeps its status filter because `markPaymentPaid` does not
    take the link lock: a payment read open above can turn paid before the
    write. If `count !== open.length`, throw a module-private
    `OutstandingChangedError` inside the callback so the transaction rolls back
    (nothing waived, nothing archived); catch it outside `db.$transaction`, re-read
    the open set with `db`, and return the "has changed" refusal built from it.
    Add a service test: stub nothing — instead mark one waived-set payment `paid`
    directly before calling, with `waivePaymentIds` naming both → refused (this
    exercises the equality check; the `count` branch is the race's backstop and
    is covered by Task 7's reasoning, not a test — say so in the report).

- [ ] **Step 5: Run** the service tests — PASS.

- [ ] **Step 6: Route.** In `src/lib/schemas.ts` add:
  ```ts
  export const archiveStudentBodySchema = z.object({
    waivePaymentIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  }).strict();
  ```
  In `PATCH /api/students/[id]`: after parsing the query, when
  `state === 'archived'` read the body (empty body → `{}`; malformed JSON or
  schema failure → 400 `respondError('Invalid request body', 400)`), keep the
  teacher gate, then call `archiveStudent(prisma, { teacherId, studentId: id,
  waivePaymentIds })` and map: `not-linked` → 403 `Student not in your contacts`
  (as today); `unchanged` → `respondUnchanged<{ isArchived: boolean }>({ isArchived: true })`;
  `refused` → `respondRefusal`; `archived` → `respondOk({ isArchived: true,
  action: 'archived', waivedCount })`. The `unarchived` branch keeps its current
  read/update but answers `respondUnchanged` when already active.

- [ ] **Step 7: Integration tests** in `students-api.test.ts`, the PATCH describe
  (update the existing test that expects `action: 'unchanged'` to use
  `expectUnchanged`):
  - pending payment → `expectRefusal(res, 'STUDENT_HAS_OUTSTANDING_PAYMENTS')`.
  - PATCH with body `{ waivePaymentIds: [id] }` → `expectApplied`, `data.waivedCount === 1`, payment `not_charged`.
  - open class registration → `expectRefusal(res, 'STUDENT_HAS_UNBILLED_CLASSES')`.
  - already archived → `expectUnchanged`.
  - `{ waivePaymentIds: 'x' }` → 400.
  Run `pnpm exec vitest run --project integration tests/integration/students-api.test.ts` — PASS.

- [ ] **Step 8: Mutations**, each run against `student-archive.test.ts`, record
  the failing test and assertion text, restore, clean:
  - `CHARGED_STATUSES` → `ACTIVE_REGISTRATION_STATUSES` (expect the `late_cancel` case red).
  - `sameIdSet` → subset check (expect the "one of two" case red).
  - drop `cancelledAt: null` (expect the cancelled-class case red).
  - drop `teacherId` from the payment filter (expect the other-teacher-only case red).

- [ ] **Step 9: Docs.**
  - `docs/data-model.md`: add a `### TeacherStudent` section where line ~186's
    "the `TeacherStudent` link (above)" expects one: fields, the invariant
    "an archived link has nothing live", the live predicate (both halves, naming
    `CHARGED_STATUSES` and `OUTSTANDING_STATUSES`), what un-archives, and that
    the refusals are `STUDENT_HAS_UNBILLED_CLASSES` / `STUDENT_HAS_OUTSTANDING_PAYMENTS`.
  - `docs/product-concept.md`, CRM section (~`:173-195`): two or three sentences
    on what archiving means for the teacher and that booking brings a student back.
  - Re-read `src/app/api/students/[id]/privacy/route.ts:23` and
    `src/components/student/teacher-privacy-card.tsx:41` comments; correct any
    that describe archiving as filing-only.

- [ ] **Step 10: Commit**
  ```bash
  git add src/services/student-archive.ts src/services/student-archive.test.ts src/lib/api-error-codes.ts src/lib/schemas.ts 'src/app/api/students/[id]/route.ts' tests/integration/students-api.test.ts docs/data-model.md docs/product-concept.md <privacy comment files if changed>
  git commit -m "feat(students): archiving refuses while anything is live, and can waive what is owed (#265)"
  ```

---

### Task 5: the all-students announcement skips archived students

**Files:**
- Modify: `src/app/api/announcements/route.ts`
- Test: the announcements integration test (`grep -rln "api/announcements" tests/integration`)

- [ ] **Step 1: Failing test:** teacher with two students who each have a
  `registered` registration on a class of theirs, one link archived. All-students
  send (no `classId`) → a `Notification` exists for the active student and none
  for the archived one. Also: a class-scoped send is unaffected (existing tests
  cover it — run them).

- [ ] **Step 2: Run** — FAIL (archived student notified).

- [ ] **Step 3: Implement.** In the all-students branch's `where`, add:
  ```ts
  student: { teacherStudents: { none: { teacherId: session.teacherId, isArchived: true } } },
  ```
  with a one-line comment: archiving means no longer this teacher's active
  student (`docs/data-model.md`, TeacherStudent).

- [ ] **Step 4: Run** — PASS. **Mutation:** remove the clause, confirm red, restore.

- [ ] **Step 5: Commit**
  ```bash
  git add src/app/api/announcements/route.ts <test file>
  git commit -m "feat(announcements): message-all-students skips archived students (#265)"
  ```

---

### Task 6: archive button — confirm and waive

**Files:**
- Modify: `src/components/students/archive-student-button.tsx`, `src/app/(teacher)/students/[id]/page.tsx`
- Test: `src/components/students/archive-student-button.test.tsx`

**Interfaces:**
- Props become:
  ```ts
  interface ArchiveStudentButtonProps {
    studentId: string;
    studentName: string;
    isArchived: boolean;
    outstanding: { ids: string[]; total: number };
  }
  ```

- [ ] **Step 1: Failing component tests** (follow the file's existing `fetch`
  mocking):
  - `outstanding.ids` empty, click → one PATCH with no body; on 200 navigates.
  - `outstanding.ids` = `['p1','p2']`, total 45 → click shows the confirm naming
    `€45.00` and 2 payments; no request yet. **Keep** closes it with no request.
    **Waive and archive** sends PATCH with JSON body `{ waivePaymentIds: ['p1','p2'] }`.
  - 409 `STUDENT_HAS_OUTSTANDING_PAYMENTS` → shows the server message and calls
    `router.refresh()`; does not navigate.
  - 409 `STUDENT_HAS_UNBILLED_CLASSES` → shows the server message; no confirm,
    no refresh.
  - Unarchive path unchanged (existing tests stay green).

- [ ] **Step 2: Run** `pnpm exec vitest run --project components src/components/students/archive-student-button.test.tsx` — FAIL.

- [ ] **Step 3: Implement** with the inline `confirming` state pattern of
  `remove-student-button.tsx` (read it first; reuse its class names and `readError`
  code branching). Confirm copy: `{studentName} still owes {€total} across {n}
  payment(s). Archiving waives {it|them}.` Buttons: **Waive and archive**
  (primary, not danger — waiving is lenience) and **Keep**. Use the repo money
  formatter.

- [ ] **Step 4: Page.** In `students/[id]/page.tsx`, derive `outstanding` from the
  registrations already loaded for `StudentPaymentList`: payments whose status
  `isOutstanding(...)` (`lib/payment-status.ts`), ids and summed amount. Pass
  `studentName` from the name the page already renders.

- [ ] **Step 5: Run** the component file — PASS. Run
  `pnpm exec vitest run --project integration tests/integration/student-detail-page.test.ts` — PASS.

- [ ] **Step 6: Verify in the running app** (`verify` skill): archive a student
  with an outstanding payment, see the confirm, waive, land on `/students`, find
  them under archived with the payment shown as not charged. Screenshot at 100%.

- [ ] **Step 7: Commit**
  ```bash
  git add src/components/students/archive-student-button.tsx src/components/students/archive-student-button.test.tsx 'src/app/(teacher)/students/[id]/page.tsx'
  git commit -m "feat(students): archive confirms and waives what is still owed (#265)"
  ```

---

### Task 7: race proofs and the lock-order record

**Files:**
- Create: `src/services/student-archive-lock-order.test.ts`
- Modify: `docs/lock-order.md`

- [ ] **Step 1: Read** `src/app/api/registrations/route-lock-order.test.ts:94-330`
  and `src/services/invitations-lock-order.test.ts` for the local `latch` /
  `handshake` / `ownPid` / `waiterOf` pattern and `joinOrThrow`
  (`tests/lock-order-teardown.ts`). Copy the pattern; there is no shared harness.

- [ ] **Step 2: Write the tests** (service-level, two Prisma clients):
  - **Booking first:** open transaction A: `activateRegistration` for an open
    class then `linkTeacherStudent` (the booking's tail), then hold on a latch.
    Start `archiveStudent` on client B; assert via `waiterOf` that B's backend
    is waiting on a `Lock`. Release A, commit. Assert B's outcome is refused
    `STUDENT_HAS_UNBILLED_CLASSES` and the link is not archived.
  - **Archive first:** hold a transaction that has run `lockTeacherStudentLink`
    and set `isArchived: true` (spy/pause `archiveStudent` after its update — or
    run its statements by hand in a held tx). Start the booking tail on B; assert
    B waits. Release; assert link `isArchived: false` and the registration
    exists.
  - **Reopen vs archive:** archive holds; `reopenPayment` on a `not_charged`
    payment waits; after release the link is active and the payment pending.
  Use `LOCK_TIMEOUT`-bounded waits the way the existing lock-order tests do, and
  assert settled-within-hold (see the lock-timeout memory in the repo docs if
  present), never a bare timing.

- [ ] **Step 3: Run** `pnpm exec vitest run src/services/student-archive-lock-order.test.ts` — PASS.

- [ ] **Step 4: Mutation — the one that matters.** Remove `FOR UPDATE` from
  `lockTeacherStudentLink`. Run: the booking-first test must fail (B does not
  wait, and/or ends archived with a live registration). Record the exact
  assertion text. Restore; clean. If it does NOT fail, the test is not proving
  the race — fix the test, not the mutation.

- [ ] **Step 5: `docs/lock-order.md`.**
  - Canonical line: insert `Payment` after `TeacherStudent`.
  - New section "The `TeacherStudent` row is the archive's gate (#265)": the race
    from the spec's *Concurrency*, both serialisation orders, and the census of
    `lockTeacherStudentLink` callers with its re-derivation command:
    `git grep -n -E '(lockTeacherStudentLink|activateTeacherStudentLink|linkTeacherStudent)\(' -- src ':!*.test.ts'`.
  - Payment census, with its command and arithmetic:
    `grep -rnE "payment\.(create|update|updateMany|delete|deleteMany|upsert)\(" src | grep -v "\.test\."`
    — record the count the command gives on the branch and which of those sites
    also lock `TeacherStudent` (`reopenPayment`, `archiveStudent`). Read
    `src/services/gdpr.ts` erasure paths for `Payment` and `TeacherStudent`
    writes in one transaction and state the finding.
  - Conformance entries for `archiveStudent` and `reopenPayment`; amend the
    `acceptInvitation` entry: its insert still takes no lock on a committed
    conflict, and `linkTeacherStudent` now follows it with an explicit
    `FOR UPDATE`.

- [ ] **Step 6: Commit**
  ```bash
  git add src/services/student-archive-lock-order.test.ts docs/lock-order.md
  git commit -m "test(students): prove archive serialises against booking and reopen on the link row (#265)"
  ```

---

## Finish

- [ ] `pnpm run verify` green (worktree app up). Record the per-project test
  counts for the PR body.
- [ ] `pnpm run build` (CI runs it; `verify` does not).
