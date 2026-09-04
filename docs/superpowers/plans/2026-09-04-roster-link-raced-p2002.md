# One atomic writer for the TeacherStudent roster link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all five `teacherStudent.upsert({ update: {} })` call sites with one `linkTeacherStudent` helper that writes the roster link atomically, so a concurrent booking can no longer make a valid accept (or booking, or waitlist join) answer 409.

**Architecture:** A new single-function module, `src/services/roster-link.ts`, writes the link with `createMany({ data: [pair], skipDuplicates: true })` — Prisma's `INSERT … ON CONFLICT DO NOTHING`. One statement, so there is no read-then-write gap for a concurrent insert to land in and no `P2002` to escape. The five existing sites become calls to it. An ESLint rule keeps the count at one.

**Tech Stack:** TypeScript strict, Prisma 6.19.3 on PostgreSQL, Vitest (`unit-sweeps` project), ESLint flat config.

**Spec:** `docs/superpowers/specs/2026-09-04-roster-link-raced-p2002-design.md`

## Global Constraints

- **TypeScript strict — no `any`, no implicit types.** `@typescript-eslint/no-explicit-any` is `error` (`eslint.config.mjs:12`).
- **Transaction clients are typed `Prisma.TransactionClient`** — the house style, 7 uses across `src/services/`.
- **The verification tier is `unit-sweeps`, and it runs from this worktree.** It uses `DATABASE_URL_TEST` (`ethical_yoga_test`) with `globalSetup: ['./tests/setup/unit-db.ts']`; it needs no dev server. Command: `npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts`. Baseline before any change: **12 passed, 8.31s**.
- **The `integration` tier cannot run here** — it uses `devUrl` and needs the app on `:3000`. Nothing in this plan requires it. Do not start, stop, or restart a dev server.
- **Worktree-scoped verify** (the whole local gate for this branch):
  `npm run typecheck && npm run lint && npx vitest run --project unit --project components --project unit-sweeps`
  Do **not** run `npm run verify` — its `npm test` includes `--project integration`, which hangs on `ECONNREFUSED` here.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Comment Discipline (CLAUDE.md).** No prose counts or member rosters in comments; a claim reaching past its own file goes in `docs/` and the comment links to it.
- **Task order is load-bearing.** Task 1 produces a measured fact that Task 6 writes into `docs/lock-order.md`. Task 2 proves the mechanism on one site before Task 3 fans it out to four more.

---

### Task 1: Measure whether `ON CONFLICT DO NOTHING` keeps the wait edge

The spec leaves exactly one question open, and everything `docs/lock-order.md` says about #179 depends on the answer:

> Does `INSERT … ON CONFLICT DO NOTHING` wait on a conflicting **uncommitted** tuple the way a plain `INSERT` does?

If it waits, the `40P01` cycle between `acceptInvitation` and `POST /api/registrations` is unchanged and #179's reorder stays load-bearing. If it does not, the cycle is closed by construction too, and the doc must say so instead of crediting the reorder alone.

**Write the assertion to match what you measure.** This is a measurement, not a hypothesis to confirm. Run the test, observe the outcome three times, *then* write the assertion. Record the three-run result in the commit message.

**Files:**
- Modify: `src/services/invitations-lock-order.test.ts` (add one test to the first `describe`, which starts at `:39`)

**Interfaces:**
- Consumes: `makeLinkedStudentWithPendingInvite({ linked })` (`:138`), `prisma` (`:29`) — both already in the file.
- Produces: a recorded fact — "the wait edge survives" or "the wait edge is gone" — consumed by Task 6's rewrite of `docs/lock-order.md:977-1027`.

- [ ] **Step 1: Add the measurement test**

Add to the `describe('Invitation and TeacherStudent take one lock order (#174 task 7)')` block, after the test at `:307`:

```ts
  /**
   * The statement #181 replaced the upsert with, in the OLD (pre-#179) order,
   * on an unlinked pair — the one interleaving where both sides genuinely
   * `INSERT`. `ON CONFLICT DO NOTHING` resolves a conflict with a COMMITTED
   * tuple without waiting; what this measures is the uncommitted case, where a
   * plain `INSERT` waits and that wait participates in deadlock detection.
   *
   * The assertion below was written to match a measurement, not the other way
   * round. See the commit that added it for the three-run result.
   */
  it('the pre-#179 order and ON CONFLICT DO NOTHING: does the wait edge survive?', async () => {
    const { teacherId, studentId, email, invitationId } =
      await makeLinkedStudentWithPendingInvite({ linked: false });

    let bReady!: () => void;
    const bHasLink = new Promise<void>((r) => { bReady = r; });

    // a: the OLD accept order — Invitation held, then the roster link.
    const a = prisma.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      await bHasLink;
      await tx.teacherStudent.createMany({
        data: [{ teacherId, studentId }],
        skipDuplicates: true,
      });
    }, { timeout: 15_000 });

    // b: the booking route's order — roster link held, then Invitation.
    const b = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.createMany({
        data: [{ teacherId, studentId }],
        skipDuplicates: true,
      });
      bReady();
      await new Promise((r) => setTimeout(r, 200));
      await tx.invitation.updateMany({
        where: { teacherId, email },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    const rejections = results.filter((r) => r.status === 'rejected');

    // eslint-disable-next-line no-console -- this test's output IS its purpose on first run
    console.log('MEASURED:', JSON.stringify(results.map((r) =>
      r.status === 'rejected' ? `REJECTED ${String(r.reason).slice(0, 80)}` : 'ok')));

    expect(rejections.length).toBeGreaterThanOrEqual(0); // replaced in Step 3
  }, 30_000);
```

- [ ] **Step 2: Run it three times and record the output**

```bash
npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t 'does the wait edge survive'
npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t 'does the wait edge survive'
npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t 'does the wait edge survive'
```

Read the `MEASURED:` line from each run. The two possible outcomes:

- **`REJECTED …40P01…` in one of the two slots, 3/3** → the wait edge survives.
- **both `ok`, 3/3** → the wait edge is gone.

A split result (some runs deadlock, some not) means the handshake is not forcing the interleaving — do not average it. Widen the `setTimeout(200)` to `500` and re-run three times.

Compare against the baseline the file already records at `:479-482` for the *upsert*: `old: {"accept":"REJECTED 40P01","booking":"ok"} x3`.

- [ ] **Step 3: Replace the placeholder assertion and the title with what was measured**

If the wait edge survives, the test becomes:

```ts
  it('the pre-#179 order still deadlocks with ON CONFLICT DO NOTHING — the wait edge survives the statement change', async () => {
```

with, in place of the `console.log` and placeholder:

```ts
    expect(rejections).toHaveLength(1);
    expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
```

If the wait edge is gone:

```ts
  it('the pre-#179 order no longer deadlocks with ON CONFLICT DO NOTHING — the statement closes the cycle by itself', async () => {
```

```ts
    expect(rejections).toHaveLength(0);
```

Delete the `console.log` and its eslint-disable either way. Rewrite the docblock's last paragraph to state the measured result rather than pose the question.

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts`
Expected: 13 passed (12 baseline + this one).

- [ ] **Step 5: Commit**

```bash
git add src/services/invitations-lock-order.test.ts
git commit -m "test(lock-order): measure whether ON CONFLICT DO NOTHING keeps the wait edge (#181)"
```

Put the three-run `MEASURED:` output verbatim in the commit body. Task 6 and the PR body both cite it.

---

### Task 2: The helper, and `acceptInvitation` as its first caller

TDD, and the RED test already exists in anticipation. `invitations-lock-order.test.ts:499` races a real accept against a real booking on an unlinked pair and asserts only the **absence of a deadlock** — deliberately tolerating the `P2002`. Its own docblock (`:490-497`) says: *"pinning it here would make this test fail the day it is fixed."* Tightening it to assert success is the RED test #181's acceptance criterion 2 asks for.

**Files:**
- Create: `src/services/roster-link.ts`
- Modify: `src/services/invitations.ts:855-860` (the upsert) and its surrounding comment at `:805-854`
- Modify: `src/services/invitations-lock-order.test.ts:468-553` (the test and its docblock)

**Interfaces:**
- Produces: `linkTeacherStudent(tx: Prisma.TransactionClient, pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput): Promise<void>` — Tasks 3 and 5 depend on this exact name and signature.

- [ ] **Step 1: Tighten the existing test to assert success, and make it fail loudly if its own instrument misfires**

In `invitations-lock-order.test.ts`, replace the body of the test at `:499`. Two changes: assert the accept's **returned value**, and prove the handshake actually fired.

```ts
  it('a real accept racing a real booking on an unlinked pair succeeds — the link exists, which is what both callers wanted (#181)', async () => {
    const { teacherId, studentId, email, invitationId } =
      await makeLinkedStudentWithPendingInvite({ linked: false });
    const cls = await makeOpenClass(teacherId);

    let bookingHasLink!: () => void;
    const linkInserted = new Promise<void>((r) => { bookingHasLink = r; });

    // The interceptor hooks a Prisma method BY NAME. If the source stops
    // calling this method, the handshake silently never fires, both
    // transactions run unsynchronised, and this test passes having exercised
    // nothing. `handshakeFired` is what turns that vacuous pass into a
    // failure — do not remove it.
    let handshakeFired = false;
    const accepting = prisma.$extends({
      query: {
        teacherStudent: {
          async createMany({ args, query }) {
            handshakeFired = true;
            await linkInserted;
            return query(args);
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    const booking = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
      await tx.class.findUnique({ where: { id: cls.id }, include: { calendarEntry: true } });
      await tx.registration.count({
        where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
      });
      await tx.registration.create({
        data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
      });
      await linkTeacherStudent(tx, { teacherId, studentId });
      bookingHasLink();
      await new Promise((r) => setTimeout(r, 300));
      // The real call, not a hand-rolled stand-in: TeacherBlock then
      // Invitation, which is where the cycle closes.
      await resolveInvitationOnLink(tx, { teacherId, studentEmail: email });
    }, { timeout: 15_000 });

    const [acceptResult, bookingResult] = await Promise.allSettled([
      acceptInvitation(accepting, { invitationId, studentId, accountEmail: email }),
      booking,
    ]);

    expect(handshakeFired).toBe(true);
    expect(acceptResult).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    expect(bookingResult.status).toBe('fulfilled');
    await expect(
      prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId } },
      }),
    ).resolves.not.toBeNull();
  }, 30_000);
```

Add the import at the top of the file, beside the `resolveInvitationOnLink` import at `:5`:

```ts
import { linkTeacherStudent } from './roster-link';
```

Rewrite the docblock at `:468-497`. Delete the paragraph beginning *"The assertion is the ABSENCE of `40P01`"* entirely — it describes a tolerance this test no longer has. Replace with a sentence stating what the test now owns: that a lost `INSERT` race leaves the accept succeeding, because the link is not the thing being decided. Keep the `old`/`new` measured block at `:479-482`; it is the record of the defect and stays true of the code as it was.

- [ ] **Step 2: Run it and verify it fails for the right reason**

Run: `npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t 'a real accept racing a real booking'`

Expected: **FAIL**, twice over —
- `Cannot find module './roster-link'` on the import (fix by writing Step 3's file, then re-run), and then
- `expected { status: 'rejected', reason: PrismaClientKnownRequestError … P2002 … } to match object { status: 'fulfilled', value: { ok: true } }`

The second failure is the defect. If you see `handshakeFired` false instead, the interceptor is hooked to a method the source does not call — fix that before continuing, because every later step's RED depends on this instrument.

- [ ] **Step 3: Write the helper**

Create `src/services/roster-link.ts`:

```ts
import { Prisma } from '@prisma/client';

/**
 * Put this student on this teacher's roster, whether or not they already are.
 *
 * `createMany` with `skipDuplicates`, not `upsert`: it compiles to `INSERT …
 * ON CONFLICT DO NOTHING`, one statement, so there is no gap between a read
 * and a write for a concurrent writer to land in. `upsert({ where, update: {},
 * create })` has that gap — Prisma compiles an empty `update` to a `SELECT`
 * followed by an `INSERT` — and a caller that lost the race got a `P2002`,
 * which reaches the client as a 409 saying the thing it just asked for
 * already exists (#181, and `docs/lock-order.md`).
 *
 * The parameter is the generated compound-unique type rather than a hand-
 * written `{ teacherId, studentId }`. Prisma emits that type only for a
 * declared compound unique, and `skipDuplicates` sends a target-less `ON
 * CONFLICT` that relies on one existing — so dropping or renaming the key
 * fails this file to compile instead of quietly leaving an unguarded insert.
 *
 * Returns nothing on purpose: whether this call was the one that inserted is
 * not a distinction any caller has a use for. They all want the link to
 * exist afterwards, which it does either way.
 */
export async function linkTeacherStudent(
  tx: Prisma.TransactionClient,
  pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
): Promise<void> {
  await tx.teacherStudent.createMany({ data: [pair], skipDuplicates: true });
}
```

This module imports nothing from `invitations.ts` or `waitlist.ts` and must not — those two already import each other's neighbours, and `link-consent.ts:5-18` documents the cycle that discipline exists to prevent.

- [ ] **Step 4: Swap `acceptInvitation`'s call site**

In `src/services/invitations.ts`, add to the imports:

```ts
import { linkTeacherStudent } from './roster-link';
```

Replace the upsert at `:855-860`:

```ts
    await linkTeacherStudent(tx, { teacherId: invitation.teacherId, studentId: input.studentId });
```

Delete the comment at `:852-854` — *"`upsert`, not `create`: this student may already share this teacher's roster… accepting must not throw on that overlap"* — outright. It is the false claim #181 names, and the helper's own docblock now carries what is true. Do not replace it with a note about what it used to say; that belongs in the PR body.

Leave the rest of the `:805-850` comment for Task 6, which rewrites it with Task 1's measurement in hand.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t 'a real accept racing a real booking'`
Expected: PASS.

Then the whole file: `npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts`
Expected: 13 passed.

- [ ] **Step 6: Prove the guard bites — mutation, source only**

Restore the upsert in `src/services/invitations.ts` *without touching the test*:

```ts
    await tx.teacherStudent.upsert({
      where: {
        teacherId_studentId: { teacherId: invitation.teacherId, studentId: input.studentId },
      },
      update: {},
      create: { teacherId: invitation.teacherId, studentId: input.studentId },
    });
```

Run the test. Record the exact failure text. **The expected failure is `expected false to be true` on `handshakeFired`** — because the interceptor is hooked to `createMany` and the source now calls `upsert`. That is the vacuity guard doing its job: without it this mutation would have passed silently.

This is the realistic regression — someone reverting to the familiar idiom — and it is exactly the mutation that a test hooked to the wrong method cannot see.

Restore the `linkTeacherStudent` call. Re-run and confirm PASS again.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/services/roster-link.ts src/services/invitations.ts src/services/invitations-lock-order.test.ts
git commit -m "fix(invitations): write the roster link atomically, so a raced accept succeeds (#181)"
```

Put the mutation's exact failure text in the commit body.

---

### Task 3: The remaining four call sites

Four sites, byte-identical to the one Task 2 replaced, on the same key. Task 2 proved the mechanism; this fans it out.

**Files:**
- Modify: `src/app/api/registrations/route.ts:234-238`
- Modify: `src/services/waitlist.ts:276-280`, `:555-559`, `:678-682`
- Test: `src/services/roster-link.test.ts` (create)

**Interfaces:**
- Consumes: `linkTeacherStudent` from Task 2.

- [ ] **Step 1: Write the helper's own concurrency test**

Create `src/services/roster-link.test.ts`. This is what covers the three waitlist callers directly — they are the same one statement, and a per-caller race test would re-measure the helper four times.

The fixture below mirrors `invitations-lock-order.test.ts:138-183`, which is the
shape that actually compiles: `Teacher` takes `firstName`/`lastName` (not
`name`) and a **required** `bio` with no default; `Student` likewise splits the
name and gets an `Account` plus `claimedAt`, because #166 left nothing that
creates an unclaimed `Student` row. Cleanup runs child-first — `TeacherStudent`,
then `Student`/`Teacher`, then `Account` — or the foreign keys refuse.

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { linkTeacherStudent } from './roster-link';

const prisma = new PrismaClient();

const teacherIds: string[] = [];
const studentIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  if (teacherIds.length) {
    await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: teacherIds } } });
  }
  if (studentIds.length) {
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  }
  if (teacherIds.length) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  if (accountIds.length) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

async function makeUnlinkedPair() {
  const local = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacherEmail = `roster-link-teacher-${local}@test.local`;
  const studentEmail = `roster-link-student-${local}@test.local`;

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Roster', lastName: 'Link',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: '#181 roster-link fixture teacher',
      pageSlug: `roster-link-${local}`,
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(teacher.id);
  accountIds.push(teacher.accountId);

  const student = await prisma.student.create({
    data: {
      firstName: 'Roster', lastName: 'Link',
      email: studentEmail, claimedAt: new Date(),
      account: { create: { email: studentEmail } },
    },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  accountIds.push(student.accountId as string);

  return { teacherId: teacher.id, studentId: student.id };
}

describe('linkTeacherStudent', () => {
  it('creates the link when there is none', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    await linkTeacherStudent(prisma, { teacherId, studentId });

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link).not.toBeNull();
  });

  it('is a no-op when the link already exists, and does not disturb it', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();
    await linkTeacherStudent(prisma, { teacherId, studentId });
    const first = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });

    await linkTeacherStudent(prisma, { teacherId, studentId });

    const second = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
  });

  /**
   * The defect itself, at the helper's own level. A writer that loses the
   * `INSERT` race must return, not throw — an `upsert({ update: {} })` here
   * raises `P2002` on `["teacherId","studentId"]`, which `classifyApiError`
   * turns into a 409 telling the caller that the link they asked for already
   * exists (#181).
   *
   * The holder's transaction stays open until after the second writer has
   * issued its statement, so the second writer genuinely waits on an
   * uncommitted tuple rather than seeing a committed one.
   */
  it('returns rather than throwing when a concurrent writer wins the insert race', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    let holderInserted!: () => void;
    const inserted = new Promise<void>((r) => { holderInserted = r; });
    let releaseHolder!: () => void;
    const released = new Promise<void>((r) => { releaseHolder = r; });

    const holder = prisma.$transaction(async (tx) => {
      await linkTeacherStudent(tx, { teacherId, studentId });
      holderInserted();
      await released;
    }, { timeout: 15_000 });

    await inserted;
    const loser = linkTeacherStudent(prisma, { teacherId, studentId });
    await new Promise((r) => setTimeout(r, 200));
    releaseHolder();

    await expect(loser).resolves.toBeUndefined();
    await holder;

    const links = await prisma.teacherStudent.findMany({ where: { teacherId, studentId } });
    expect(links).toHaveLength(1);
  }, 30_000);
});
```

- [ ] **Step 2: Register the file in the serial tier**

This file holds a transaction open for hundreds of milliseconds while another statement waits on it. That is lock timing, so it belongs with the other files that create it.

In `vitest.config.ts`, add to `LOCK_CONTENTION_TESTS` (the array starting at `:52`), keeping the list's existing shape:

```ts
  'src/services/roster-link.test.ts',
```

- [ ] **Step 3: Run it and verify the race test fails against an upsert**

First confirm the suite passes as written:

Run: `npx vitest run --project unit-sweeps src/services/roster-link.test.ts`
Expected: 3 passed.

Then mutate `src/services/roster-link.ts` to the old statement — this is the RED that proves the third test is not vacuous:

```ts
  await tx.teacherStudent.upsert({
    where: { teacherId_studentId: pair },
    update: {},
    create: pair,
  });
```

Run again. Expected: **FAIL** on `returns rather than throwing when a concurrent writer wins the insert race`, with a `PrismaClientKnownRequestError` naming `P2002` and `target: [ 'teacherId', 'studentId' ]`. Record the exact text.

Restore `createMany`. Re-run: 3 passed.

- [ ] **Step 4: Swap the four remaining call sites**

`src/app/api/registrations/route.ts` — add the import beside the existing service imports:

```ts
import { linkTeacherStudent } from '@/services/roster-link';
```

Replace `:234-238`:

```ts
        await linkTeacherStudent(tx, { teacherId: cls.calendarEntry.teacherId, studentId });
```

`src/services/waitlist.ts` — add the import:

```ts
import { linkTeacherStudent } from './roster-link';
```

Replace `:276-280` (`addToWaitlist`):

```ts
    await linkTeacherStudent(tx, { teacherId: cls.calendarEntry.teacherId, studentId });
```

Replace `:555-559` (`promoteNext`):

```ts
    await linkTeacherStudent(tx, {
      teacherId: cls.calendarEntry.teacherId,
      studentId: nextEntry.studentId,
    });
```

Replace `:678-682` (`claimSpot`):

```ts
    await linkTeacherStudent(tx, { teacherId: cls.calendarEntry.teacherId, studentId });
```

Leave every surrounding comment alone — Task 6 rewrites them as one sweep, so that the sweep can be derived from this task's diff rather than from a keyword.

- [ ] **Step 5: Run the full local gate**

```bash
npm run typecheck && npm run lint
npx vitest run --project unit --project components --project unit-sweeps
```

Expected: all green. If a waitlist or invitations test fails, read it before changing it — a genuine behaviour change here would be a plan defect worth surfacing, not something to bend the test around.

- [ ] **Step 6: Commit**

```bash
git add src/services/roster-link.test.ts vitest.config.ts src/app/api/registrations/route.ts src/services/waitlist.ts
git commit -m "fix(roster): route the remaining four link writes through linkTeacherStudent (#181)"
```

Put Step 3's exact `P2002` text in the commit body.

---

### Task 4: Narrow the bare `P2002` catch at `POST /api/registrations`

`registrations/route.ts:289-294` catches a bare `P2002` and answers `'Student is already registered for this class'`. Until Task 3, a `TeacherStudent` collision arrived here and was reported as a **false statement** about a different table. Task 3 makes that unreachable; this makes it structurally impossible to re-arm.

**Honest scope note, to be carried into the PR body rather than papered over:** this change is **not independently provable by test**. Provoking a non-`Registration` `P2002` inside that transaction now requires a second unique key that does not exist. What the existing duplicate-booking integration coverage pins is the positive path — that a genuine repeat booking still answers this message. The negative is argued from `isUniqueConflictOn`'s column-set semantics, not measured. Do not invent a test that appears to cover it.

**Files:**
- Modify: `src/app/api/registrations/route.ts:289-294`

**Interfaces:**
- Consumes: `isUniqueConflictOn` from `@/lib/unique-conflict` — `(err: unknown, columns: readonly string[]) => boolean`.

- [ ] **Step 1: Narrow the catch**

Add the import:

```ts
import { isUniqueConflictOn } from '@/lib/unique-conflict';
```

Replace `:289-294`:

```ts
    // The column set, not a bare `P2002`. `Registration @@unique([classId,
    // studentId])` is the only conflict this message is true of; a bare check
    // would put these words on any unique violation the transaction can raise,
    // which is how a roster-link collision used to be reported as a booking
    // the student did not have (#181). An unmatched `P2002` falls through to
    // `withErrorHandler`, which answers 409 and logs `warn` naming
    // `meta.target` — the right family for a unique violation, and observable.
    if (
      err instanceof AlreadyRegisteredError ||
      isUniqueConflictOn(err, ['classId', 'studentId'])
    ) {
      return respondError('Student is already registered for this class', 409);
    }
```

Remove the now-unused `Prisma` import **only if** nothing else in the file uses it — check first:

```bash
grep -n "Prisma\." src/app/api/registrations/route.ts
```

- [ ] **Step 2: Verify the positive path still holds**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Run: `npx vitest run --project unit --project components --project unit-sweeps`
Expected: all green.

The duplicate-booking assertion lives in `tests/integration/registrations-api.test.ts`, which cannot run from this worktree. It is a CI signal for this branch — say so in the PR body and cite the run.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/registrations/route.ts
git commit -m "fix(registrations): match the conflict's column set, not any P2002 (#181)"
```

---

### Task 5: Keep the count at one

`src/lib/student-visibility.ts`'s argument (Task 6 rewrites it) depends on the set of link-creating sites being exactly the callers of `linkTeacherStudent`. That is a membership claim, and CLAUDE.md's *Comment Discipline* says to tether one rather than assert it. Lint is the cheapest tether that already runs in both `npm run verify` and CI.

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Add the rule**

In `eslint.config.mjs`, insert a config object after the existing `rules` block (`:10-15`) and before `globalIgnores`:

```js
  // `TeacherStudent` rows are created in exactly one place, and
  // `src/lib/student-visibility.ts` reasons about the set of callers that
  // reach it. Before #181 the same statement was written at five call sites,
  // each with its own read-then-write race; collapsing them is only durable
  // if a sixth cannot quietly appear. Tests are exempt: the lock-order suite
  // writes this table directly on purpose, to pin Prisma's own behaviour.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/services/roster-link.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='teacherStudent'][callee.property.name=/^(create|createMany|upsert)$/]",
          message:
            'Create the roster link with linkTeacherStudent (src/services/roster-link.ts) — a direct create/upsert here reopens the #181 race.',
        },
      ],
    },
  },
```

- [ ] **Step 2: Verify it passes on the current tree**

Run: `npm run lint`
Expected: clean. If it flags `roster-link.ts`, the `ignores` path is wrong; if it flags a call site, Task 3 missed one — go fix that, which is the rule earning its place immediately.

- [ ] **Step 3: Prove the rule bites**

A rule that cannot fail certifies nothing, and a selector is easy to get subtly wrong. Add a real violation temporarily — in `src/services/waitlist.ts`, immediately after the `linkTeacherStudent` call in `claimSpot`:

```ts
    await tx.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId: cls.calendarEntry.teacherId, studentId } },
      update: {},
      create: { teacherId: cls.calendarEntry.teacherId, studentId },
    });
```

Run: `npm run lint`
Expected: **FAIL**, naming `src/services/waitlist.ts` and the message above. Record the exact output.

Then check the selector is not over-narrow — replace that mutation with the `create` form and re-run:

```ts
    await tx.teacherStudent.create({
      data: { teacherId: cls.calendarEntry.teacherId, studentId },
    });
```

Expected: **FAIL** again. A rule that catches `upsert` but not `create` would let the next contributor through on the more obvious spelling.

Remove the mutation. Run `npm run lint`: clean.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): keep TeacherStudent creation to its one owner (#181)"
```

Put both mutation outputs in the commit body.

---

### Task 6: The comment and doc sweep

**Derive this task's list from the diff of Tasks 1-5, not from a keyword.** A keyword sweep scoped to one claim cannot see another's twin. Start with:

```bash
git diff main...HEAD --stat
grep -rn "upsert" src/services/invitations.ts src/services/waitlist.ts src/app/api/registrations/route.ts src/lib/student-visibility.ts
grep -rn "upsert" docs/lock-order.md
```

Give every hit a verdict. Expect legitimate survivors — `StudentPrivacy`'s and `TeacherBlock`'s upserts are untouched by this branch and their comments stay true.

**Files:**
- Modify: `src/services/invitations.ts` (`:722`, `:727`, `:773`, `:805-850`, `:985`)
- Modify: `src/services/waitlist.ts` (`:263`, `:445`, `:550`, `:989`, `:1068`, `:1076`)
- Modify: `src/app/api/registrations/route.ts` (`:111`, and the comment above the link write)
- Modify: `src/lib/student-visibility.ts:190-209`
- Re-run (expect no edit): `src/lib/student-visibility.test.ts`
- Modify: `docs/lock-order.md` (`:359`, `:694`, `:977-1027`, `:1583-1611`, `:1793`, `:1868-1876`)
- Modify: `src/services/invitations-lock-order.test.ts` (docblocks at `:194-247`, `:283-306`)

- [ ] **Step 1: Rewrite `invitations.ts`'s lock-order comment (`:805-850`)**

The paragraph at `:812-837` explains that the upsert compiles to three non-locking `SELECT`s, that this is "an accident of how Prisma compiles an empty `update`", and that it is "one real column away from vanishing". None of that describes this code any more.

Replace it — do not annotate it — with what is true now: the write order is `TeacherStudent` before `Invitation`, matching `unlinkTeacher`, `deleteStudentAccount` and `deleteTeacherAccount`; the link write is `linkTeacherStudent`, one atomic statement; and **whatever Task 1 measured** about the wait edge. Keep the reproduction record at `:838-851` (old order `40P01` 3/3) — it is history that stays true of the code as it was, and `docs/lock-order.md` cites it.

Keep `:852`'s neighbour paragraph about upserting first being safe unconditionally (`:846-851`) — that reasoning is about ordering and `NotPendingError`, not about the statement, and survives intact.

- [ ] **Step 2: Rewrite `student-visibility.ts:190-209`**

This is the one that is a rewrite rather than a rename. Today it argues from a **prose roster of five sites** — "Four of the five link-creating upsert sites do… but `promoteNext`'s own `teacherStudent.upsert`…" — and defends the number at `:206`.

**Measured: nothing tests this claim.** `src/lib/student-visibility.test.ts` has 18 tests and none mention `five`, `upsert`, `promoteNext` or `session`. The census lives only in the docblock, which is why Task 5's lint rule is the tether it never had. Re-run that file after the rewrite; expect no change to it.

The argument survives; the census stops being prose. Replace `:190-209` with:

```ts
 * An earlier draft of this comment argued it from the link side instead —
 * "every `TeacherStudent` writer requires a `session.studentId`" — and that is
 * false. Every site that can CREATE a link goes through `linkTeacherStudent`
 * (`services/roster-link.ts`), and an ESLint rule keeps it that way, so the set
 * to check is that function's callers rather than a roster written down here.
 * Most of them do hold a session — the student is acting for themselves. But
 * `promoteNext` (`services/waitlist.ts`) links a `studentId` read off a
 * persisted `WaitlistEntry`, during a cancellation someone else initiated
 * (`promoteAfterCancel` in `api/registrations/[id]/route.ts`;
 * `deleteStudentAccount`'s `handleSpotFreed` call in `services/gdpr.ts`) — and
 * its own docblock says it is there to repair rows "written by hand (fixtures,
 * a psql fix-up)", i.e. precisely the rows no session produced. The conclusion
 * survives on the two supports above; the support that did not survive is what
 * a census of writers looks like when the writers are counted, not read.
 *
 * `TeacherStudent` has one writer that is not a creator and so not in that set
 * — `api/students/[id]/route.ts`'s `teacherStudent.update`, the archive toggle,
 * which only flips a flag on a link that already exists.
```

No number, and no roster: the set is one function's call sites, and Task 5's rule is what stops a sixth appearing. That is the difference between a claim with an owner and a claim without one.

- [ ] **Step 3: Rewrite `docs/lock-order.md:977-1027`**

The section is titled *"The empty-`update` upsert quirk — read this before 'tidying' one"* and lists five `TeacherStudent` sites plus `unlinkTeacher`'s `TeacherBlock` one. After this branch there are **no** `TeacherStudent` upserts; `TeacherBlock`'s is the only real code the quirk still governs.

Rewrite so that:
- The Prisma behaviour itself (`:979-987`) stays — it is a measured fact about the ORM and still true.
- The five-site list goes. In its place: the roster link is written by `linkTeacherStudent` with `ON CONFLICT DO NOTHING`, and Task 1's measured result about the wait edge.
- The standing warning at `:1017-1022` narrows to `unlinkTeacher`'s `TeacherBlock` upsert, which still depends on the quirk.
- `:1024-1027`'s note about `StudentPrivacy` stays.

Add `createMany` to the Prisma write-verb grep pattern at `:359`, or that pattern stops finding these sites.

Update `:694`, `:1583-1611`, `:1793` and `:1868-1876` for the statement's name. At `:1868-1876` specifically, add that this branch does **not** trip that section's stated trigger — neither upsert's `update` payload is touched, and the `TeacherStudent` statement that changed is a different lock node, so the `{TeacherBlock, Invitation}` ordering is unchanged.

- [ ] **Step 4: Re-aim the quirk tests' prose**

`invitations-lock-order.test.ts:236-247` and `:283-306` describe their synthetic `update: { isArchived: false }` as showing that `acceptInvitation`'s `update: {}` is "one payload away" from deadlocking. The tests stay — they document real Prisma behaviour — but that sentence is now false of `acceptInvitation`.

Re-aim the prose at `unlinkTeacher`'s `TeacherBlock` upsert, the remaining real code the quirk governs. Do not change the test bodies; their subject is the ORM's behaviour, not this branch's code.

- [ ] **Step 5: Name changes across the rest**

`invitations.ts:722`, `:727`, `:773`, `:985`; `waitlist.ts:263`, `:445`, `:550`, `:989`, `:1068`, `:1076`; `registrations/route.ts:111` and the comment above its link write. Each says "upsert" about a statement that is now a `linkTeacherStudent` call. `waitlist.ts:1068` ("`teacherStudent.upsert` waited on the row — a deadlock instead of a race") is contingent on Task 1's measurement — check it against what was measured rather than renaming it blind.

- [ ] **Step 6: Reconcile the sweep against the diff**

List what changed; list what was supposed to change; reconcile. Then sweep for what was **invalidated**, not just what was edited:

```bash
grep -rn "teacherStudent.upsert\|update: {}" src docs --include="*.ts" --include="*.md" | grep -v "\.test\."
```

Every remaining hit must be a legitimate survivor — `TeacherBlock`'s and `StudentPrivacy`'s — or a miss. Name each verdict.

- [ ] **Step 7: Full local gate and commit**

```bash
npm run typecheck && npm run lint
npx vitest run --project unit --project components --project unit-sweeps
git add src/services/invitations.ts src/services/waitlist.ts src/app/api/registrations/route.ts src/lib/student-visibility.ts src/services/invitations-lock-order.test.ts docs/lock-order.md
git commit -m "docs(lock-order): the roster link is one atomic writer, not five upserts (#181)"
```

---

## After the tasks

- **Whole-branch review** (the plan has 6 tasks, so this is required): one review on the most capable model, one fix wave, one scoped re-review. The cross-task risks worth naming in the dispatch: a comment corrected in one file whose twin still stands in another; the ESLint selector passing while matching nothing real; and `docs/lock-order.md` describing a wait edge different from the one Task 1 measured.
- **Push and open the PR.** Integration and e2e are CI signals for this branch — cite the CI run for those tiers, never a local `verify`.
- **PR body must carry:** the three enumerations that agreed on five sites; Task 1's measured wait-edge result with its three runs; every mutation's exact failure text; what the deleted comments used to say; that Task 4's narrowing is argued rather than measured, and why; and that **#183, #418 and #197 are unaffected** by this branch's code, with the note owed to #197 posted separately.
