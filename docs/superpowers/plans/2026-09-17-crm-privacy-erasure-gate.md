# CRM/Privacy Erasure Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `acceptInvitation`, `unlinkTeacher` (both `src/services/invitations.ts`) and `PUT /api/students/[id]/privacy` each take `lockLiveStudent` as the first lock of their transaction, so none of the three can leave a `TeacherStudent` or `StudentPrivacy` row for a student whose erasure raced it (#626).

**Architecture:**
- **The fix.** One `lockLiveStudent(tx, studentId)` call, first statement of each transaction (before any other lock the transaction takes), plus a `StudentErasedError` branch in each function's existing `.catch`, surfaced as a new `'STUDENT_ERASED'` reason and mapped to a 409 at the route.
- **The privacy route is the one exception with no service layer today.** Since it is gaining real transactional business logic (the gate), this plan extracts its write into `src/services/student-privacy.ts` — consistent with CLAUDE.md's "Services are framework-agnostic" — which also makes it directly testable without HTTP or a session, the same way `acceptInvitation`/`unlinkTeacher` already are.
- **Why no new spec doc.** This is the identical, already-reviewed fix shape #625 used for the booking route, itself built on #183's `db-locks.ts` gate — there is exactly one reasonable design, and it is already recorded in `docs/lock-order.md` and the issue body. The issue body (#626) and `docs/lock-order.md`'s "The `Student` row is the erasure's gate" section together serve as the design record this plan implements.
- **The race tests.** `acceptInvitation` and `unlinkTeacher` are raced against a real `deleteStudentAccount` paused at its own `lockStudentForErasure` gate (`vi.spyOn`), in `src/services/invitations-lock-order.test.ts` — already registered in the `lock-contention` serial tier. `updateStudentPrivacy` gets a plain sequential test (erase, then leave a stray `TeacherStudent` link behind, then write) since it has no HTTP session in the way once extracted to a service.
- **The docs.** A final task moves all three writers from "not gated" to "gated" in `docs/lock-order.md`'s Student-gate table, closes the two reasoned-but-unproven cycles the doc currently tracks under #626, and recomputes the doc's grep-derived call-site census against the code as it stands after Tasks 1–3.

**Tech Stack:** Next.js 16 route handlers, Prisma on PostgreSQL, Vitest 4 (`unit` project for the new service test, `unit-sweeps`/lock-contention serial tier for the extended `invitations-lock-order.test.ts`).

**Spec:** None — see "Why no new spec doc" above. This plan argues directly from the issue (#626) and `docs/lock-order.md`.

## Global Constraints

- TypeScript `strict`, no `any`.
- **Refusal message:** every new 409, on every route, uses the exact string `This account has been deleted` — the same string the booking gate (#625) uses for its student-path refusal. All three writers here are always called by the student acting on their own profile, so there is no teacher-path variant to add.
- **Error bodies** have the shape `{ error: { message, code } }` (`respondError`, `src/lib/api-utils.ts`). Pass no `code` for this refusal — the booking route's precedent passes none either.
- **New reason literal:** `'STUDENT_ERASED'`, added to each function's existing discriminated-union return type.
- **Comments** describe the code they sit on. Anything wider goes in `docs/`, and the comment links to it. No counts or member rosters in comments (CLAUDE.md, *Comment Discipline*).
- **Staging:** stage exact paths. Never run `git add -A` or `git add .`.
- **Dev server:** never restart the dev server on `:3000`. `pnpm exec vitest run --project integration <path>` and `pnpm run verify` both read `INTEGRATION_BASE_URL` automatically once `pnpm run worktree:up` has been run in this worktree.
- **Shell:** this session refuses compound shell (loops, subshells, `$(...)`, variables) around git and docker. Run plain single commands.
- **Commit messages** end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Task order is load-bearing

Task 2 reuses fixture and race-staging helpers (`makeGateFixture`, `cleanupGateFixture`, `awaitHandshake`, `waitUntilBlockedBy`, `ownPid`, `HANDSHAKE_TIMEOUT_MS`) that Task 1 adds to `src/services/invitations-lock-order.test.ts`. Run Task 1 before Task 2. Task 3 touches unrelated files and can run before or after Tasks 1–2. Task 4 rewrites doc prose and a grep-derived census that depend on the final shape of Tasks 1–3's code, so it must run last.

---

### Task 1: Gate `acceptInvitation`

**Files:**
- Modify: `src/services/invitations.ts` — the import block (lines 11–24), `acceptInvitation`'s signature (line 1209), the top of its transaction (line 1227), and its `.catch`/return (lines 1341–1346).
- Modify: `src/app/api/invitations/[id]/respond/route.ts` — the `!result.ok` branch (lines 45–48).
- Modify: `src/services/invitations-lock-order.test.ts` — imports (lines 7–14), and a new describe block appended at the end of the file (after line 1748).

**Interfaces:**
- Produces: `acceptInvitation`'s return type becomes `Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'STUDENT_ERASED' }>`. Task 2 does the same shape of edit to `unlinkTeacher` and reuses this task's new test-file helpers, so keep their names exactly as below.

- [ ] **Step 1: Write the failing tests**

In `src/services/invitations-lock-order.test.ts`, first widen the top imports. Find (the file's current first ten lines, right after its opening docblock):

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { acceptInvitation, declineInvitation, unlinkTeacher } from './invitations';
import { resolveInvitationOnLink } from './link-consent';
import { linkTeacherStudent } from './roster-link';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
```

Replace with:

```typescript
import { describe, it, expect, afterAll, onTestFinished, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { acceptInvitation, declineInvitation, unlinkTeacher } from './invitations';
import { resolveInvitationOnLink } from './link-consent';
import { linkTeacherStudent } from './roster-link';
import { deleteStudentAccount } from './gdpr';
import * as dbLocks from '@/lib/db-locks';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
```

Then append this whole block at the end of the file (after the final `});` on the current last line):

```typescript

/**
 * How long a paused racer may take to report it is in place, before a test
 * fails naming the statement that never arrived — the bare `await` this
 * replaces could hang until vitest's own 30s test timeout instead, which
 * names the `it`, not the missing handshake.
 */
const HANDSHAKE_TIMEOUT_MS = 2_000;

async function awaitHandshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never issued within ${HANDSHAKE_TIMEOUT_MS}ms`)),
          HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolves once some backend is waiting on a lock `holderPid` holds. Bounded
 * well inside the 2s `lock_timeout` the waiter runs under.
 */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing waited behind backend ${holderPid} within 1500ms`);
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/**
 * A bare teacher/student pair, no link between them yet — the precondition
 * `acceptInvitation` needs to genuinely INSERT the roster link, and
 * `unlinkTeacher`'s tests below add their own link on top of this.
 */
async function makeGateFixture() {
  const local = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `gate-626-${local}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Gate', lastName: 'Teacher',
      email: `gate-626-teacher-${local}@test.local`,
      account: { create: { email: `gate-626-teacher-${local}@test.local` } },
      bio: '#626 Student-gate fixture',
      pageSlug: `gate-626-${local}`,
    },
    select: { id: true, accountId: true },
  });
  const student = await prisma.student.create({
    data: {
      firstName: 'Gate', lastName: 'Student', email, claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  const studentAccountId = student.accountId;
  if (studentAccountId === null) throw new Error('fixture student has no account');
  return {
    teacherId: teacher.id,
    teacherAccountId: teacher.accountId,
    studentId: student.id,
    studentAccountId,
    email,
  };
}

type GateFixture = Awaited<ReturnType<typeof makeGateFixture>>;

async function cleanupGateFixture(fx: GateFixture): Promise<void> {
  await prisma.invitation.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.teacherBlock.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.studentPrivacy.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.teacherStudent.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.student.deleteMany({ where: { id: fx.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: [fx.teacherAccountId, fx.studentAccountId] } } });
}

/**
 * Pauses `deleteStudentAccount` right after it acquires the `Student` gate,
 * before any of its writes — the same technique
 * `src/app/api/registrations/route-lock-order.test.ts` uses for the booking
 * route's own version of this gate (#625).
 */
function pauseErasureAtGate(studentId: string): {
  reached: Promise<void>;
  pid: () => number;
  release: () => void;
} {
  let atGate!: () => void;
  const reached = new Promise<void>((r) => { atGate = r; });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let pid = 0;
  let paused = false;
  const original = dbLocks.lockStudentForErasure;
  const spy = vi.spyOn(dbLocks, 'lockStudentForErasure').mockImplementation(async (tx, id) => {
    await original(tx, id);
    if (id === studentId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      atGate();
      await held;
    }
  });
  onTestFinished(() => spy.mockRestore());
  return { reached, pid: () => pid, release };
}

describe('acceptInvitation and unlinkTeacher take the Student gate (#626)', () => {
  it('refuses acceptInvitation for an already-erased student', async () => {
    const fx = await makeGateFixture();
    try {
      const invitation = await prisma.invitation.create({
        data: {
          teacherId: fx.teacherId, email: fx.email,
          firstName: 'Gate', lastName: 'Student', status: 'pending',
        },
        select: { id: true },
      });
      await deleteStudentAccount(prisma, fx.studentId);

      const result = await acceptInvitation(prisma, {
        invitationId: invitation.id, studentId: fx.studentId, accountEmail: fx.email,
      });

      expect(result).toEqual({ ok: false, reason: 'STUDENT_ERASED' });
      expect(
        await prisma.teacherStudent.count({ where: { teacherId: fx.teacherId, studentId: fx.studentId } }),
      ).toBe(0);
    } finally {
      await cleanupGateFixture(fx);
    }
  }, 15_000);

  it('refuses acceptInvitation for a student erased mid-transaction, and writes nothing', async () => {
    const fx = await makeGateFixture();
    try {
      const invitation = await prisma.invitation.create({
        data: {
          teacherId: fx.teacherId, email: fx.email,
          firstName: 'Gate', lastName: 'Student', status: 'pending',
        },
        select: { id: true },
      });

      const erasure = pauseErasureAtGate(fx.studentId);
      const erasing = deleteStudentAccount(prisma, fx.studentId).then(
        () => 'erased' as const,
        (err: unknown) => ({ error: String(err) }),
      );
      let accepting: Promise<unknown> | undefined;
      try {
        await awaitHandshake(erasure.reached, 'erasure Student lock');
        accepting = acceptInvitation(prisma, {
          invitationId: invitation.id, studentId: fx.studentId, accountEmail: fx.email,
        });
        await waitUntilBlockedBy(erasure.pid());
      } finally {
        erasure.release();
        await Promise.all([erasing, accepting]);
      }

      expect(await erasing).toBe('erased');
      expect(await accepting).toEqual({ ok: false, reason: 'STUDENT_ERASED' });
      expect(
        await prisma.teacherStudent.count({ where: { teacherId: fx.teacherId, studentId: fx.studentId } }),
      ).toBe(0);
    } finally {
      await cleanupGateFixture(fx);
    }
  }, 20_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t "Student gate (#626)"`

Expected: both new tests FAIL. The first fails on `expect(result).toEqual({ ok: false, reason: 'STUDENT_ERASED' })` — today `acceptInvitation` returns `{ ok: true }` because it never checks the student's `deletedAt`. The second fails the same way once the erasure is released (`accepting` resolves `{ ok: true }`, not the erased refusal) — the `waitUntilBlockedBy` call itself will still pass, because the *unrelated* `linkTeacherStudent` insert genuinely does wait on the erasure's held `Student` row today (that wait is real, from `linkTeacherStudent`'s own `FOR KEY SHARE`); what fails is the outcome once released.

- [ ] **Step 3: Implement the gate in `acceptInvitation`**

In `src/services/invitations.ts`, add the lock import. Change:

```typescript
import { withdrawWaitingEntriesForTeacher } from './waitlist';
import { linkTeacherStudent } from './roster-link';
```

to:

```typescript
import { withdrawWaitingEntriesForTeacher } from './waitlist';
import { linkTeacherStudent } from './roster-link';
import { lockLiveStudent, StudentErasedError } from '@/lib/db-locks';
```

Change `acceptInvitation`'s signature. Find:

```typescript
export async function acceptInvitation(
  db: PrismaClient,
  input: { invitationId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
```

Replace with:

```typescript
export async function acceptInvitation(
  db: PrismaClient,
  input: { invitationId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'STUDENT_ERASED' }> {
```

Insert the gate as the transaction's first statement. Find:

```typescript
  const accepted = await db.$transaction(async (tx) => {
    // `TeacherStudent` BEFORE `Invitation`. `unlinkTeacher`,
```

Replace with:

```typescript
  const accepted = await db.$transaction(async (tx) => {
    // The Student gate (#183, #626): this transaction's first lock, before
    // its roster-link insert below — a child-row insert that takes `FOR KEY
    // SHARE` on the student and would otherwise wait on a `Student` row the
    // erasure has already committed past. Who holds the other half, and why
    // this mode and order: `docs/lock-order.md`, "The `Student` row is the
    // erasure's gate".
    await lockLiveStudent(tx, input.studentId);

    // `TeacherStudent` BEFORE `Invitation`. `unlinkTeacher`,
```

Update the `.catch` and the return below it. Find:

```typescript
  }).catch((err: unknown) => {
    if (err instanceof NotPendingError) return false;
    throw err;
  });
  if (!accepted) return { ok: false, reason: 'NOT_PENDING' };
  return { ok: true };
```

Replace with:

```typescript
  }).catch((err: unknown) => {
    if (err instanceof StudentErasedError) return 'STUDENT_ERASED' as const;
    if (err instanceof NotPendingError) return 'NOT_PENDING' as const;
    throw err;
  });
  if (accepted !== true) return { ok: false, reason: accepted };
  return { ok: true };
```

In `src/app/api/invitations/[id]/respond/route.ts`, find:

```typescript
  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') return respondError('Invitation not found', 404);
    return respondError('This invitation has already been answered', 409, 'ALREADY_ANSWERED');
  }
```

Replace with:

```typescript
  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') return respondError('Invitation not found', 404);
    if (result.reason === 'STUDENT_ERASED') {
      return respondError('This account has been deleted', 409);
    }
    return respondError('This invitation has already been answered', 409, 'ALREADY_ANSWERED');
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t "Student gate (#626)"`

Expected: both PASS.

- [ ] **Step 5: Run the whole file to check nothing existing broke**

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts`

Expected: every test in the file PASSES — the pre-existing `acceptInvitation` tests (idempotent-accept, NOT_PENDING races, the #537 block re-check describe) still pass unchanged, since none of them erase the student.

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`

Expected: no errors. In particular, confirm `accepted`'s inferred type (`true | 'STUDENT_ERASED' | 'NOT_PENDING'`) narrows cleanly at `if (accepted !== true) return { ok: false, reason: accepted };` — `accepted` there is `'STUDENT_ERASED' | 'NOT_PENDING'`, a subset of the function's declared `reason` union.

- [ ] **Step 7: Prove the gate actually bites (mutation test)**

Temporarily comment out the one line `await lockLiveStudent(tx, input.studentId);` added in Step 3 (leave the surrounding comment in place). Run:

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t "Student gate (#626)"`

Expected: both new tests now FAIL — record the exact assertion failure text (it should be the same `{ ok: false, reason: 'STUDENT_ERASED' }` vs `{ ok: true }` mismatch from Step 2) for the PR body. Then restore the line and re-run Step 4 to confirm it's green again.

- [ ] **Step 8: Commit**

```bash
git add src/services/invitations.ts src/app/api/invitations/[id]/respond/route.ts src/services/invitations-lock-order.test.ts
git commit -m "fix(invitations): gate acceptInvitation on the Student erasure lock (#626)"
```

---

### Task 2: Gate `unlinkTeacher`

**Files:**
- Modify: `src/services/invitations.ts` — `unlinkTeacher`'s signature (line 1449), the top of its transaction (line 1474), and its `.catch`/return (lines 1585–1604).
- Modify: `src/app/api/teacher-links/[teacherId]/route.ts` — the `!result.ok` branch (line 45).
- Modify: `src/services/invitations-lock-order.test.ts` — two more tests appended inside the `describe('acceptInvitation and unlinkTeacher take the Student gate (#626)', ...)` block Task 1 created.

**Interfaces:**
- Consumes: `makeGateFixture`, `cleanupGateFixture`, `pauseErasureAtGate`, `awaitHandshake`, `waitUntilBlockedBy` from Task 1 (same file).
- Produces: `unlinkTeacher`'s return type becomes `Promise<{ ok: true } | { ok: false; reason: 'NOT_LINKED' | 'STUDENT_ERASED' }>`.

- [ ] **Step 1: Write the failing tests**

In `src/services/invitations-lock-order.test.ts`, add these two tests inside the `describe('acceptInvitation and unlinkTeacher take the Student gate (#626)', ...)` block from Task 1, right after the closing `}, 20_000);` of `'refuses acceptInvitation for a student erased mid-transaction...'` and before that describe's own closing `});`:

```typescript

  it('refuses unlinkTeacher for an erased student even when a stray TeacherStudent link survives', async () => {
    const fx = await makeGateFixture();
    try {
      await deleteStudentAccount(prisma, fx.studentId);
      // A link that outlived the erasure, as an ungated writer or a
      // pre-existing row could leave (`docs/lock-order.md`, "Who is not
      // gated yet").
      await prisma.teacherStudent.create({ data: { teacherId: fx.teacherId, studentId: fx.studentId } });

      const result = await unlinkTeacher(prisma, {
        teacherId: fx.teacherId, studentId: fx.studentId, accountEmail: fx.email,
      });

      expect(result).toEqual({ ok: false, reason: 'STUDENT_ERASED' });
      expect(
        await prisma.teacherStudent.count({ where: { teacherId: fx.teacherId, studentId: fx.studentId } }),
      ).toBe(1);
      expect(await prisma.teacherBlock.count({ where: { teacherId: fx.teacherId } })).toBe(0);
    } finally {
      await cleanupGateFixture(fx);
    }
  }, 15_000);

  it('refuses unlinkTeacher for a student erased mid-transaction, and leaves the link untouched', async () => {
    const fx = await makeGateFixture();
    try {
      await prisma.teacherStudent.create({ data: { teacherId: fx.teacherId, studentId: fx.studentId } });
      await prisma.studentPrivacy.create({
        data: { studentId: fx.studentId, teacherId: fx.teacherId, shareFullName: true },
      });

      const erasure = pauseErasureAtGate(fx.studentId);
      const erasing = deleteStudentAccount(prisma, fx.studentId).then(
        () => 'erased' as const,
        (err: unknown) => ({ error: String(err) }),
      );
      let unlinking: Promise<unknown> | undefined;
      try {
        await awaitHandshake(erasure.reached, 'erasure Student lock');
        unlinking = unlinkTeacher(prisma, {
          teacherId: fx.teacherId, studentId: fx.studentId, accountEmail: fx.email,
        });
        await waitUntilBlockedBy(erasure.pid());
      } finally {
        erasure.release();
        await Promise.all([erasing, unlinking]);
      }

      expect(await erasing).toBe('erased');
      expect(await unlinking).toEqual({ ok: false, reason: 'STUDENT_ERASED' });
    } finally {
      await cleanupGateFixture(fx);
    }
  }, 20_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t "unlinkTeacher"`

Expected: both new tests FAIL. The first fails on the `STUDENT_ERASED` expectation — today `unlinkTeacher` deletes the stray link and silences privacy unconditionally. The second: watch its actual failure mode carefully — the erasure's own `teacherStudent.deleteMany`/`studentPrivacy.deleteMany` may race the ungated `unlinkTeacher`'s identical writes and could plausibly throw a `P2025` (record not found on the delete-by-id) or resolve `{ ok: true }`, rather than deadlock — either way it will not be `{ ok: false, reason: 'STUDENT_ERASED' }`. Record whichever it is; that is the "before" evidence for the PR body.

- [ ] **Step 3: Implement the gate in `unlinkTeacher`**

In `src/services/invitations.ts`, find:

```typescript
): Promise<{ ok: true } | { ok: false; reason: 'NOT_LINKED' }> {
```

Replace with:

```typescript
): Promise<{ ok: true } | { ok: false; reason: 'NOT_LINKED' | 'STUDENT_ERASED' }> {
```

Insert the gate as the transaction's first statement, before `withdrawWaitingEntriesForTeacher` (which takes `Class` locks — the Student-before-Class order `docs/lock-order.md` requires). Find:

```typescript
  const unlinked = await db.$transaction(async (tx) => {
    // FIRST, before any write below. A `waiting` entry for one of this
```

Replace with:

```typescript
  const unlinked = await db.$transaction(async (tx) => {
    // The Student gate (#183, #626): this transaction's first lock, before
    // `withdrawWaitingEntriesForTeacher`'s `Class` locks below and before the
    // `StudentPrivacy` upsert further down — a child-row insert that takes
    // `FOR KEY SHARE` on the student and would otherwise wait on a
    // `Student` row the erasure has already committed past. Who holds the
    // other half, and why this mode and order: `docs/lock-order.md`, "The
    // `Student` row is the erasure's gate".
    await lockLiveStudent(tx, input.studentId);

    // FIRST, before any write below. A `waiting` entry for one of this
```

Update the `.catch` and the return below it. Find:

```typescript
  }).catch((err: unknown) => {
    // A concurrent erasure deleted the link out from under this transaction.
    // `NOT_LINKED` is what `DELETE /api/teacher-links/[teacherId]` turns into
    // a 404, which is the same answer the caller would have got a moment
    // earlier from the `findUnique` above: there is no link. Losing that race
    // should not read differently from never having had the row.
    //
    // No sentinel-error class is needed here, unlike `acceptInvitation`'s
    // `NotPendingError` above. That one exists because OUR code decides to
    // give up mid-transaction, where a bare `return` would commit the writes
    // taken before it. Here Prisma throws, which already aborts the
    // transaction and rolls back the withdrawal and the privacy write with
    // it — this catch is outside `$transaction`, so all it does is translate
    // an outcome that has already happened.
    if (isRecordNotFound(err)) return false;
    throw err;
  });
  if (!unlinked) return { ok: false, reason: 'NOT_LINKED' };
  return { ok: true };
```

Replace with:

```typescript
  }).catch((err: unknown) => {
    // The Student gate refusing (#626): a `TeacherStudent` row can survive
    // an erasure that missed it — an ungated writer, or a row created before
    // this gate existed — and this refuses writing onto it rather than
    // silencing shares nobody can read and blocking an address whose
    // `Student` row is gone.
    if (err instanceof StudentErasedError) return 'STUDENT_ERASED' as const;

    // A concurrent erasure deleted the link out from under this transaction.
    // `NOT_LINKED` is what `DELETE /api/teacher-links/[teacherId]` turns into
    // a 404, which is the same answer the caller would have got a moment
    // earlier from the `findUnique` above: there is no link. Losing that race
    // should not read differently from never having had the row.
    //
    // No sentinel-error class is needed here, unlike `acceptInvitation`'s
    // `NotPendingError` above. That one exists because OUR code decides to
    // give up mid-transaction, where a bare `return` would commit the writes
    // taken before it. Here Prisma throws, which already aborts the
    // transaction and rolls back the withdrawal and the privacy write with
    // it — this catch is outside `$transaction`, so all it does is translate
    // an outcome that has already happened.
    if (isRecordNotFound(err)) return 'NOT_LINKED' as const;
    throw err;
  });
  if (unlinked !== true) return { ok: false, reason: unlinked };
  return { ok: true };
```

In `src/app/api/teacher-links/[teacherId]/route.ts`, find:

```typescript
  const result = await unlinkTeacher(prisma, {
    teacherId, studentId: session.studentId, accountEmail: account.email,
  });
  if (!result.ok) return respondError('Teacher link not found', 404);
```

Replace with:

```typescript
  const result = await unlinkTeacher(prisma, {
    teacherId, studentId: session.studentId, accountEmail: account.email,
  });
  if (!result.ok) {
    if (result.reason === 'STUDENT_ERASED') {
      return respondError('This account has been deleted', 409);
    }
    return respondError('Teacher link not found', 404);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t "unlinkTeacher"`

Expected: both PASS.

- [ ] **Step 5: Run the whole file**

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts`

Expected: every test in the file PASSES, including the pre-existing `unlinkTeacher` describes ("StudentPrivacy and TeacherStudent take one lock order", the hand-rolled deadlock tests, "does not deadlock when the real unlinkTeacher races an erasure-shaped transaction...", "reports NOT_LINKED when an erasure deletes the link between the read and the delete").

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`

Expected: no errors.

- [ ] **Step 7: Prove the gate actually bites (mutation test)**

Comment out the `await lockLiveStudent(tx, input.studentId);` line added in Step 3 for `unlinkTeacher` (leave `acceptInvitation`'s alone). Run:

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts -t "unlinkTeacher"`

Expected: both tests added in this task FAIL again — record the exact failure text for the PR body. Restore the line, re-run Step 4 to confirm green.

- [ ] **Step 8: Commit**

```bash
git add src/services/invitations.ts src/app/api/teacher-links/[teacherId]/route.ts src/services/invitations-lock-order.test.ts
git commit -m "fix(invitations): gate unlinkTeacher on the Student erasure lock (#626)"
```

---

### Task 3: Extract and gate the privacy route's write

**Files:**
- Create: `src/services/student-privacy.ts`
- Create: `src/services/student-privacy.test.ts`
- Modify: `src/app/api/students/[id]/privacy/route.ts` — the `PUT` handler's imports and its upsert (lines 91–133).

**Interfaces:**
- Produces: `updateStudentPrivacy(db: PrismaClient, input: { studentId: string; teacherId: string; fields: StudentPrivacyFields }): Promise<{ ok: true; value: StudentPrivacy } | { ok: false; reason: 'STUDENT_ERASED' }>`, exported from `src/services/student-privacy.ts`, alongside the exported `StudentPrivacyFields` interface (all six fields optional booleans, matching `updatePrivacySchema`'s output shape minus `teacherId`).

- [ ] **Step 1: Write the failing test**

Create `src/services/student-privacy.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { updateStudentPrivacy } from './student-privacy';
import { deleteStudentAccount } from './gdpr';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('updateStudentPrivacy takes the Student gate (#626)', () => {
  it('refuses a write for an erased student even when a stray TeacherStudent link survives', async () => {
    const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const email = `student-privacy-gate-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'Student', email, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'Teacher',
        email: `student-privacy-gate-teacher-${suffix}@test.local`,
        account: { create: { email: `student-privacy-gate-teacher-${suffix}@test.local` } },
        bio: '#626 privacy-route fixture',
        pageSlug: `student-privacy-gate-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    try {
      await deleteStudentAccount(prisma, student.id);
      // A link that outlived the erasure, as an ungated writer or a
      // pre-existing row could leave (`docs/lock-order.md`, "Who is not
      // gated yet").
      await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });

      const result = await updateStudentPrivacy(prisma, {
        studentId: student.id,
        teacherId: teacher.id,
        fields: { shareFullName: true },
      });

      expect(result).toEqual({ ok: false, reason: 'STUDENT_ERASED' });
      expect(
        await prisma.studentPrivacy.count({ where: { studentId: student.id, teacherId: teacher.id } }),
      ).toBe(0);
    } finally {
      await prisma.studentPrivacy.deleteMany({ where: { teacherId: teacher.id } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: teacher.id } });
      await prisma.student.deleteMany({ where: { id: student.id } });
      await prisma.teacher.deleteMany({ where: { id: teacher.id } });
      const studentAccountId = student.accountId;
      if (studentAccountId === null) throw new Error('fixture student has no account');
      await prisma.account.deleteMany({ where: { id: { in: [studentAccountId, teacher.accountId] } } });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project unit src/services/student-privacy.test.ts`

Expected: FAIL with "Cannot find module './student-privacy'" — the module does not exist yet.

- [ ] **Step 3: Write the service**

Create `src/services/student-privacy.ts`:

```typescript
import type { PrismaClient, StudentPrivacy } from '@prisma/client';
import { lockLiveStudent, StudentErasedError } from '@/lib/db-locks';

/** The six per-teacher share/mute flags `PUT /api/students/[id]/privacy` writes. */
export interface StudentPrivacyFields {
  shareFullName?: boolean;
  shareEmail?: boolean;
  sharePhone?: boolean;
  shareBirthday?: boolean;
  shareAddress?: boolean;
  receiveComms?: boolean;
}

/**
 * Writes a student's per-teacher privacy settings.
 *
 * Gated by the Student erasure lock (#183, #626): this transaction's first
 * lock, before the upsert below — a child-row insert that takes `FOR KEY
 * SHARE` on the student and would otherwise wait on a `Student` row the
 * erasure has already committed past, leaving privacy settings on a profile
 * that no longer exists. Who holds the other half, and why this mode and
 * order: `docs/lock-order.md`, "The `Student` row is the erasure's gate".
 *
 * Authorization (does the caller own this profile, is this teacher linked to
 * it) is the route's job, not this function's — it writes whatever
 * `(studentId, teacherId)` pair it is given.
 */
export async function updateStudentPrivacy(
  db: PrismaClient,
  input: { studentId: string; teacherId: string; fields: StudentPrivacyFields },
): Promise<{ ok: true; value: StudentPrivacy } | { ok: false; reason: 'STUDENT_ERASED' }> {
  return db.$transaction(async (tx) => {
    await lockLiveStudent(tx, input.studentId);
    const value = await tx.studentPrivacy.upsert({
      where: {
        studentId_teacherId: { studentId: input.studentId, teacherId: input.teacherId },
      },
      update: input.fields,
      create: {
        studentId: input.studentId,
        teacherId: input.teacherId,
        shareFullName: input.fields.shareFullName ?? false,
        shareEmail: input.fields.shareEmail ?? false,
        sharePhone: input.fields.sharePhone ?? false,
        shareBirthday: input.fields.shareBirthday ?? false,
        shareAddress: input.fields.shareAddress ?? false,
        receiveComms: input.fields.receiveComms ?? true,
      },
    });
    return { ok: true, value } as const;
  }).catch((err: unknown) => {
    if (err instanceof StudentErasedError) return { ok: false, reason: 'STUDENT_ERASED' } as const;
    throw err;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project unit src/services/student-privacy.test.ts`

Expected: PASS.

- [ ] **Step 5: Wire the route to the new service**

In `src/app/api/students/[id]/privacy/route.ts`, add the import. Change:

```typescript
import { updatePrivacySchema } from '@/lib/schemas';
import { log } from '@/lib/log';
```

to:

```typescript
import { updatePrivacySchema } from '@/lib/schemas';
import { log } from '@/lib/log';
import { updateStudentPrivacy } from '@/services/student-privacy';
```

Replace the `PUT` handler's upsert and return. Find:

```typescript
  const privacy = await prisma.studentPrivacy.upsert({
    where: {
      studentId_teacherId: {
        studentId: id,
        teacherId,
      },
    },
    update: privacyFields,
    create: {
      studentId: id,
      teacherId,
      shareFullName: privacyFields.shareFullName ?? false,
      shareEmail: privacyFields.shareEmail ?? false,
      sharePhone: privacyFields.sharePhone ?? false,
      shareBirthday: privacyFields.shareBirthday ?? false,
      shareAddress: privacyFields.shareAddress ?? false,
      receiveComms: privacyFields.receiveComms ?? true,
    },
  });

  return respondOk(privacy);
});
```

Replace with:

```typescript
  const result = await updateStudentPrivacy(prisma, { studentId: id, teacherId, fields: privacyFields });
  if (!result.ok) return respondError('This account has been deleted', 409);
  return respondOk(result.value);
});
```

- [ ] **Step 6: Run the privacy-route integration suite**

Run: `pnpm exec vitest run --project integration tests/integration/privacy-api.test.ts`

Expected: every existing test PASSES unchanged — the route's observable behavior for a live, linked student is identical; only the write now goes through the new service. This needs `pnpm run worktree:up` to have been run first in this worktree (see the plan's Global Constraints and the skill's project hazards).

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc --noEmit`

Expected: no errors.

- [ ] **Step 8: Prove the gate actually bites (mutation test)**

Comment out the `await lockLiveStudent(tx, input.studentId);` line in `src/services/student-privacy.ts`. Run:

Run: `pnpm exec vitest run --project unit src/services/student-privacy.test.ts`

Expected: FAILS — record the exact failure text for the PR body (the write will succeed against the erased row instead of refusing). Restore the line, re-run Step 4 to confirm green.

- [ ] **Step 9: Commit**

```bash
git add src/services/student-privacy.ts src/services/student-privacy.test.ts src/app/api/students/[id]/privacy/route.ts
git commit -m "fix(students): extract privacy writes to a service, gate on the Student erasure lock (#626)"
```

---

### Task 4: Update `docs/lock-order.md`

**Files:**
- Modify: `docs/lock-order.md` — the Student-gate table (currently 3 rows, around "The `Student` row is the erasure's gate (#183)"), the "What still escalates" section's reasoned-cycle paragraph, the "Who is not gated yet" section, and the gate's call-site census at the end of that section.

**Interfaces:**
- Consumes: the final code from Tasks 1–3 — this task re-derives every count it writes by actually running the greps below against the branch as it stands, not by copying numbers from this plan.

- [ ] **Step 1: Add three rows to the Student-gate table**

Find the table under "The `Student` row is the erasure's gate (#183)" — it currently has this exact row for the booking route:

```
| `POST /api/registrations` (`src/app/api/registrations/route.ts`) | `lockLiveStudent` | first statement of its transaction, on the student's booking and the teacher's roster add alike | `FOR SHARE` | refuses: 409, `This account has been deleted` to the student, `This student's account no longer exists` to the teacher; an absent one is answered 404 `Student not found` before the transaction opens |
```

Add three rows immediately after it, in the same table (same column order: writer, lock call, when taken, mode, outcome):

```
| `acceptInvitation` (`src/services/invitations.ts`) | `lockLiveStudent` | first statement of its transaction, before its roster-link insert | `FOR SHARE` | refuses: 409, `This account has been deleted` (`POST /api/invitations/[id]/respond`) |
| `unlinkTeacher` (`src/services/invitations.ts`) | `lockLiveStudent` | first statement of its transaction, before its `Class` locks and its `StudentPrivacy` upsert | `FOR SHARE` | refuses: 409, `This account has been deleted` (`DELETE /api/teacher-links/[teacherId]`) |
| `updateStudentPrivacy` (`src/services/student-privacy.ts`) | `lockLiveStudent` | first statement of its transaction | `FOR SHARE` | refuses: 409, `This account has been deleted` (`PUT /api/students/[id]/privacy`) |
```

- [ ] **Step 2: Close the two reasoned-but-unproven cycles**

Find this paragraph (under "What still escalates", after the `student.updateMany` census):

```
An ungated writer can be. Any ungated writer that inserts a `Student` child
row, taking `FOR KEY SHARE`, and then waits on a row the erasure has already
written closes a cycle with that closing `UPDATE`:

- `acceptInvitation` (`src/services/invitations.ts`) inserts the roster link
  and then updates an `Invitation` row the erasure anonymises. Tracked in
  #626.
- `unlinkTeacher` (same file), when its `StudentPrivacy` upsert inserts,
  then deletes a `TeacherStudent` row the erasure has deleted. Tracked in
  #626.

Each case above is reasoned from the code, none has been reproduced, and each
predates the gate. The booking's case is closed by #625. Its cycle was
reproduced against the ungated route on 2026-09-16, by the test
`src/app/api/registrations/route-lock-order.test.ts` ("refuses a booking whose
roster link the erasure has already deleted"): the booking's roster-link
insert failed with `40P01`, and the route answered 503.
```

Replace with:

```
An ungated writer can. Any ungated writer that inserts a `Student` child row,
taking `FOR KEY SHARE`, and then waits on a row the erasure has already
written closes a cycle with that closing `UPDATE` — three writers were
reasoned into this shape, none reproduced before its gate landed, and all
three are now gated:

- The booking route (`POST /api/registrations`), closed by #625. Its cycle
  WAS reproduced against the ungated route on 2026-09-16, by the test
  `src/app/api/registrations/route-lock-order.test.ts` ("refuses a booking
  whose roster link the erasure has already deleted"): the booking's
  roster-link insert failed with `40P01`, and the route answered 503.
- `acceptInvitation` (`src/services/invitations.ts`), which inserts the
  roster link and then updates an `Invitation` row the erasure anonymises.
  Closed by #626, unreproduced.
- `unlinkTeacher` (same file), whose `StudentPrivacy` upsert inserts, then
  deletes a `TeacherStudent` row the erasure has deleted. Closed by #626,
  unreproduced.
```

- [ ] **Step 3: Update "Who is not gated yet"**

Find:

```
### Who is not gated yet

The inserters into tables with a foreign key to `Student`, other than
`addToWaitlist` and `POST /api/registrations`:

- `acceptInvitation` and `unlinkTeacher` (`src/services/invitations.ts`), and
  `PUT /api/students/[id]/privacy` — ungated, tracked in #626.
- `promoteNext` and `claimSpot` (`src/services/waitlist.ts`) — ungated and
  not tracked, because they need no gate: each inserts only for a student
  holding a `waiting` entry in the class it has locked, which puts that class
  in the erasure's lock set, so the `Class` row already serialises the two.
```

Replace with:

```
### Who is not gated yet

The inserters into tables with a foreign key to `Student`, other than the
five gated writers above:

- `promoteNext` and `claimSpot` (`src/services/waitlist.ts`) — ungated and
  not tracked, because they need no gate: each inserts only for a student
  holding a `waiting` entry in the class it has locked, which puts that class
  in the erasure's lock set, so the `Class` row already serialises the two.
```

- [ ] **Step 4: Re-derive and update the two grep censuses in this section**

Re-run, from the repo root:

```
git grep -n -E '\.(studentPrivacy|teacherStudent|registration|waitlistEntry)\.(create|createMany|createManyAndReturn|upsert)\(' -- src ':!*.test.ts'
git grep -n -E '(linkTeacherStudent|activateRegistration)\(' -- src ':!*.test.ts' \
  | grep -vE ':[0-9]+: *(\*|//)'
```

These two commands' OWN result counts do not change from Tasks 1–3 (no new insert/upsert statement or new call to `linkTeacherStudent`/`activateRegistration` was added — `updateStudentPrivacy`'s upsert is the same statement the route used to make, just moved to a new file). Confirm this by running them and update ONLY the file name in the sentence that currently reads "the privacy route" if `student-privacy.ts` is now where that statement lives — check the paragraph below the two commands (starting "On 2026-09-16 the first returned five statement sites — the privacy route, `unlinkTeacher`'s privacy upsert...") and change "the privacy route" to "`student-privacy.ts`" if the grep hit's file path changed. Do NOT change the count (still five) unless your own re-run of the command disagrees — if it does, trust the re-run over this instruction and update the count with the new arithmetic shown.

Then re-run:

```
grep -rn 'lockStudentForErasure\|lockLiveStudent' src/ --include='*.ts' \
  | grep -v '\.test\.ts:' \
  | grep -vE ':[0-9]+: *(\*|//)' \
  | grep -vE ':[0-9]+: +[A-Za-z]+,$' \
  | grep -vE ':[0-9]+:import '
```

This one DOES change: Tasks 1–3 added three new `lockLiveStudent` call sites (`acceptInvitation`, `unlinkTeacher`, `updateStudentPrivacy`). Find:

```
On 2026-09-16 it returned five lines: the two definitions in `db-locks.ts`, and
one call each in `gdpr.ts`, `waitlist.ts` and `src/app/api/registrations/route.ts`.
A new gated writer is a sixth.
```

Replace with the actual re-run output's line count and file list — do not guess it. As of writing this plan (before Tasks 1–3 land) the expected shape is 2 definitions + 6 call sites = 8 lines (the pre-existing 3 plus `invitations.ts` twice plus `student-privacy.ts` once), but run the command yourself after Tasks 1–3 are committed and write down what it actually says, e.g.:

```
On <today's date> it returned eight lines: the two definitions in
`db-locks.ts`, and one call each in `gdpr.ts`, `waitlist.ts`,
`src/app/api/registrations/route.ts`, `student-privacy.ts`, and two in
`invitations.ts` (`acceptInvitation` and `unlinkTeacher`).
```

Adjust the trailing sentence "A new gated writer is a sixth." to name the correct next ordinal (a seventh, given six lines are now call sites rather than five) — or drop it if it no longer reads naturally; check the sentence in context before deciding.

- [ ] **Step 5: Check `docs/data-model.md` for any claim this fix invalidates**

Run:

```
git grep -n "acceptInvitation\|unlinkTeacher\|StudentPrivacy" docs/data-model.md
```

Read every hit's surrounding paragraph. None of these functions' liveness behavior is described there as of this plan's writing (only their write-ordering and disclosure semantics are), so no edit is expected — but confirm this directly rather than trusting this plan, since Comment/doc discipline (CLAUDE.md, *Comment Discipline*) requires correcting a claim in every artifact it appears in, and this plan cannot see the file as it will read after Tasks 1–3 land.

- [ ] **Step 6: Read the whole "The `Student` row is the erasure's gate (#183)" section once more, end to end**

After Steps 1–4, read `docs/lock-order.md` from "## The `Student` row is the erasure's gate (#183)" through the end of "### Who is not gated yet" (roughly lines 1110–1374 before this task's edits) in one pass. Confirm: the table lists six writers total (three pre-existing plus three new), every writer named in "What still escalates" is described as gated, no sentence still says `acceptInvitation`/`unlinkTeacher`/the privacy route are ungated, and the two census commands' documented outputs match what you got when you actually ran them in Step 4.

- [ ] **Step 7: Typecheck and full verify**

Run: `pnpm exec tsc --noEmit`

Expected: no errors (this task only touches a `.md` file, so this is a sanity check that nothing else regressed).

Run: `pnpm run verify`

Expected: green. Report the arithmetic behind "green `pnpm run verify` is the whole integration suite" in the PR body, per the skill's own instructions (`105 = 46 unit + 32 components + 27 integration`-style breakdown, re-derived from this branch's actual `verify` output, not copied from that example).

- [ ] **Step 8: Commit**

```bash
git add docs/lock-order.md
git commit -m "docs(lock-order): move acceptInvitation, unlinkTeacher and the privacy route from ungated to gated (#626)"
```
