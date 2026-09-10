# #537: acceptInvitation re-checks TeacherBlock inside its transaction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. This plan has one task — implementation includes writing the failing tests before the fix, per this repo's test-first principle (CLAUDE.md).

**Goal:** Close the race #537 describes: `acceptInvitation` (`src/services/invitations.ts`) reads `TeacherBlock` once, outside its transaction, and a block `unlinkTeacher` commits in the gap between that read and the transaction's own writes is invisible to it — so an accept can commit a roster link for a pair that is, by the time it lands, blocked.

**Spec:** `docs/superpowers/specs/2026-09-10-teacherblock-race-window-design.md` — read this first. It verifies the issue's premise, and **corrects one part of it**: only `unlinkTeacher` can produce this race (not `declineInvitation`, structurally — see the spec's "Premise correction" section), and the two tests this plan adds are distinguished by which pre-existing CAS branch they exercise, not by which function writes the block.

## Global constraints

- Test-first (CLAUDE.md): write the two failing tests below first, watch them fail against the unmodified code, then make the fix, then watch them pass.
- Never edit an applied migration — this task makes no schema change, so this doesn't apply, but note it because the file this touches sits beside `prisma/schema.prisma` changes elsewhere in this codebase's history.
- Match `src/services/invitations-lock-order.test.ts`'s existing style exactly: its `@serial-tier lock-contention` docblock, its `uniqueSuffix()` helper, its per-describe fixture-cleanup `afterAll`, its `prisma.$extends({ query: {...} })` handshake pattern (cast `as unknown as PrismaClient`), its `handshakeFired`/`calls` vacuous-pass guards.
- This file is reviewed harder than most in this codebase — CLAUDE.md's own Comment Discipline section cites this project's invitation-handling files by name for comment drift. Get the docblock rewrites exactly right; do not leave a stale claim standing beside a corrected one.

---

### Task 1: Add the in-transaction re-check, its two staged-race tests, and correct the two stale docblocks

**Files:**
- Edit: `src/services/invitations.ts`
- Edit: `src/services/invitations-lock-order.test.ts`
- Edit: `src/services/invitations.decline.test.ts`

#### Step 1: Write the two failing tests

Add a new `describe` block at the end of `src/services/invitations-lock-order.test.ts` (after the existing `describe('Invitation and TeacherBlock take one lock order (#522)', ...)` block, which ends the file today). It needs its own fixture helper — reusing `makeLinkedStudentWithPendingInvite` isn't possible, it's scoped inside the `#174 task 7` describe above and doesn't set `delivered: false`.

```typescript
describe('acceptInvitation re-checks TeacherBlock inside its transaction (#537)', () => {
  const raceTeacherIds: string[] = [];
  const raceTeacherAccountIds: string[] = [];
  const raceStudentIds: string[] = [];
  const raceStudentAccountIds: string[] = [];

  afterAll(async () => {
    if (raceTeacherIds.length) {
      await prisma.invitation.deleteMany({ where: { teacherId: { in: raceTeacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: raceTeacherIds } } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: raceTeacherIds } } });
    }
    if (raceStudentIds.length) {
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: raceStudentIds } } });
      await prisma.student.deleteMany({ where: { id: { in: raceStudentIds } } });
    }
    if (raceTeacherIds.length) {
      await prisma.teacher.deleteMany({ where: { id: { in: raceTeacherIds } } });
    }
    const accountIds = [...raceTeacherAccountIds, ...raceStudentAccountIds];
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
  });

  /**
   * A teacher and student already linked, with a `pending`,
   * `delivered: false` invitation between them — #412's gate for
   * re-inviting an already-linked pair, the same reachability
   * `makeBlockedPendingInvite` above names for `unlinkTeacher`'s
   * `delivered: true` scoping.
   */
  async function makeLinkedUndeliveredInvite() {
    const local = uniqueSuffix();
    const email = `block-race-${local}@test.local`;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Block', lastName: 'Race',
        email: `block-race-teacher-${local}@test.local`,
        account: { create: { email: `block-race-teacher-${local}@test.local` } },
        bio: '#537 acceptInvitation/TeacherBlock race fixture teacher',
        pageSlug: `block-race-${local}`,
      },
      select: { id: true, accountId: true },
    });
    raceTeacherIds.push(teacher.id);
    raceTeacherAccountIds.push(teacher.accountId);

    const student = await prisma.student.create({
      data: {
        firstName: 'Block', lastName: 'Race', email, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    raceStudentIds.push(student.id);
    raceStudentAccountIds.push(student.accountId as string);

    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });

    const invitation = await prisma.invitation.create({
      data: {
        teacherId: teacher.id, email, firstName: 'Block', lastName: 'Race',
        delivered: false,
      },
      select: { id: true },
    });

    return { teacherId: teacher.id, studentId: student.id, email, invitationId: invitation.id };
  }

  /**
   * The race #537 measured: the outside pre-check reads `TeacherBlock`
   * before this transaction opens, sees nothing, and proceeds — then
   * `unlinkTeacher` commits, in the gap, a block AND deletes the roster
   * link, but (scoped to `delivered: true`, #412) leaves this `pending`
   * invitation's status untouched. Without an in-transaction re-check, the
   * roster-link write (`linkTeacherStudent`, now a genuine `INSERT` since
   * unlink just deleted the row) and the CAS below both go on to succeed
   * against a pair that is, by the time either runs, blocked.
   *
   * Forced via a handshake on the outside `teacherBlock.findUnique`, not
   * left to timing. `calls` pins that the hook sees exactly two
   * `teacherBlock.findUnique`s: the outside pre-check (which triggers
   * `unlinkTeacher`) and the in-transaction re-check this fix adds. Remove
   * the fix and only the first ever fires — `calls` would stay at 1 and the
   * result would be `{ ok: true }`.
   */
  it('a TeacherBlock unlinkTeacher commits after the outside pre-check is not missed inside the transaction', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedUndeliveredInvite();

    let calls = 0;
    let handshakeFired = false;
    const accepting = prisma.$extends({
      query: {
        teacherBlock: {
          async findUnique({ args, query }) {
            calls += 1;
            const result = await query(args);
            if (calls === 1) {
              handshakeFired = true;
              const unlinkResult = await unlinkTeacher(prisma, {
                teacherId, studentId, accountEmail: email,
              });
              expect(unlinkResult).toEqual({ ok: true });
            }
            return result;
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    const acceptResult = await acceptInvitation(accepting, {
      invitationId, studentId, accountEmail: email,
    });

    expect(handshakeFired).toBe(true);
    expect(calls).toBe(2);
    expect(acceptResult).toEqual({ ok: false, reason: 'NOT_PENDING' });
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    })).toBeNull();
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { status: true },
    });
    expect(row.status).toBe('pending');
  }, 15_000);

  /**
   * The same window, reached by the OTHER pre-existing branch the CAS below
   * can take. `invitations.decline.test.ts`'s "answers NOT_PENDING for an
   * accepted row on a blocked pair" pins this same row shape WITHOUT a
   * race — there, the block already stands before the second
   * `acceptInvitation` call's outside pre-check ever runs, so that
   * pre-check alone refuses it. Here the block lands AFTER that pre-check
   * instead, so it's the pre-existing CAS-miss + idempotent-re-read branch
   * — which, on its own, treats an `accepted` row as success — that would
   * otherwise leak.
   *
   * The first accept below is real and sequential, not part of the race —
   * it is what makes this row `accepted, delivered: false` the way the
   * codebase actually reaches it, the same construction
   * `invitations.decline.test.ts` uses.
   */
  it('the same block is not missed when a retried accept hits the idempotent already-accepted branch instead', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedUndeliveredInvite();

    expect(await acceptInvitation(prisma, { invitationId, studentId, accountEmail: email }))
      .toEqual({ ok: true });

    let calls = 0;
    let handshakeFired = false;
    const accepting = prisma.$extends({
      query: {
        teacherBlock: {
          async findUnique({ args, query }) {
            calls += 1;
            const result = await query(args);
            if (calls === 1) {
              handshakeFired = true;
              const unlinkResult = await unlinkTeacher(prisma, {
                teacherId, studentId, accountEmail: email,
              });
              expect(unlinkResult).toEqual({ ok: true });
            }
            return result;
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    const acceptResult = await acceptInvitation(accepting, {
      invitationId, studentId, accountEmail: email,
    });

    expect(handshakeFired).toBe(true);
    expect(calls).toBe(2);
    expect(acceptResult).toEqual({ ok: false, reason: 'NOT_PENDING' });
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    })).toBeNull();
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { status: true },
    });
    expect(row.status).toBe('accepted');
  }, 15_000);
});
```

Run `pnpm exec vitest run --project integration src/services/invitations-lock-order.test.ts` (this file lives in the `integration` tier per its own top-of-file docblock, despite the name — needs the worktree's dev server up via `pnpm run worktree:up` first, per this repo's hazards doc). Confirm both new tests fail against the unmodified source — and confirm they fail because `acceptResult` is `{ ok: true }` with a live `TeacherStudent` row (the actual bug), not because of a typo or a broken fixture. `calls` will be `1`, not `2`, at this point (no in-transaction re-check exists yet to be the second call).

#### Step 2: The fix

In `acceptInvitation`, inside its `$transaction` callback, immediately after the `linkTeacherStudent` call and before `tx.invitation.updateMany`:

```typescript
    await linkTeacherStudent(tx, { teacherId: invitation.teacherId, studentId: input.studentId });

    // The outside pre-check above reads TeacherBlock before this transaction
    // opens; a block `unlinkTeacher` commits in the gap between that read
    // and here is invisible to it. `unlinkTeacher`'s own Invitation write is
    // scoped to `delivered: true` (#412), so on a `delivered: false` row it
    // can commit a block while leaving this row's status untouched — the CAS
    // below (or its idempotent re-read, when this row is already `accepted`)
    // would otherwise go on to succeed against a pair that is, by now,
    // blocked. Re-reading here, after the roster-link write and before
    // either success return, closes that window (#537).
    const blockedNow = await tx.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: invitation.teacherId, email } },
      select: { id: true },
    });
    if (blockedNow) throw new NotPendingError();

    const updated = await tx.invitation.updateMany({
```

Run the two new tests again; confirm both pass.

#### Step 3: Prove the guard bites (mutation test)

Temporarily remove the `blockedNow` check added in Step 2 (comment it out or delete it), re-run the two tests from Step 1, and confirm both fail again — record the exact failing assertions (should be the `acceptResult` / `TeacherStudent` row assertions, same as Step 1's initial red run). Restore the fix, re-run, confirm both pass again. This step doesn't need to survive in the codebase — it's verification, not a permanent test artifact — but the PR body should state what was observed (pass → fail → pass), per this repo's "prove every guard bites" discipline.

#### Step 4: Correct the two stale docblocks

**`NotPendingError`'s docblock** (`src/services/invitations.ts`, directly above `class NotPendingError extends Error {}`) — replace only its first paragraph (the "Declared ABOVE `acceptInvitation`'s docblock..." paragraph is unaffected and stays as-is):

Replace:
```
 * Rolls back `acceptInvitation`'s transaction when the invitation is no
 * longer pending. A plain `return false` would commit the roster-link write
 * taken above it — including, on the create path, a genuine
 * `INSERT` — so the link would exist for an invitation nobody accepted.
 * Only a throw, caught outside `$transaction`, rolls that write back with
 * everything else. `invitations-lock-order.test.ts` proves the negative
 * directly: a NOT_PENDING refusal leaves no `TeacherStudent` row even though
 * that write already ran by the time this fires.
```
with:
```
 * Rolls back `acceptInvitation`'s transaction whenever it must give up
 * after the roster-link write has already run — the invitation is no
 * longer pending, or a `TeacherBlock` has landed in the gap between the
 * outside pre-check and this transaction (#537). A plain `return false`
 * would commit that write regardless — including, on the create path, a
 * genuine `INSERT` — so the link would exist for a pair that never should
 * have gotten one. Only a throw, caught outside `$transaction`, rolls that
 * write back with everything else. `invitations-lock-order.test.ts` proves
 * the negative directly: a NOT_PENDING refusal leaves no `TeacherStudent`
 * row even though that write already ran by the time this fires.
```

**`acceptInvitation`'s own docblock** — the three paragraphs from "The block check below is defence in depth..." through "...the `accepted` one is the arm that goes red." need replacing (everything from the "The block check below" paragraph to the end of the "Which is also why only one of the two answered arms..." paragraph, inclusive). Replace with:

```
 * The block check below is defence in depth for the pending case — the
 * student-side pending query (Task 11) already excludes a blocked pair, so
 * this id should never reach here for one. But the id travels in a URL, not
 * a secret, and this whole function exists because that can't be trusted.
 *
 * What it answers turns on the row's own status, and it may: the email match
 * above has already proved the caller owns the address, so the only block
 * anyone can reach this branch about is one on their own address. Nothing
 * here can hand a stranger the bit `inviteContact` above withholds. A
 * `pending` row on a blocked pair is one the student is never offered —
 * `listPendingInvitations` drops it — so `NOT_FOUND` is the true answer:
 * there is nothing here for them. Anything the CAS below would refuse to
 * write over answers `NOT_PENDING` instead: the guard names the row's own
 * state rather than the block, so it discloses nothing the caller does not
 * already hold, and a new `InvitationStatus` member inherits that
 * conservative answer without this paragraph having to be revisited.
 *
 * This guard alone is NOT what keeps the roster-link write from committing
 * for a blocked pair — it reads `TeacherBlock` once, before the transaction
 * opens, and a block `unlinkTeacher` commits in the gap between that read
 * and the transaction's own writes is invisible to it. `unlinkTeacher`'s own
 * Invitation write is scoped to `delivered: true` (#412), so on a
 * `delivered: false` row it can commit a block while leaving this row's
 * status untouched — pending, if nobody has answered it yet, or `accepted`,
 * if a prior call already had. Either way the CAS below (or its idempotent
 * re-read, for the `accepted` case) would go on to succeed against a pair
 * that is, by then, blocked. Closing that window is the in-transaction
 * re-check's job (#537), not this guard's — see it in the `$transaction`
 * callback below, and `NotPendingError`'s own docblock. Delete THIS guard
 * (the one below, not the in-transaction one) and every case in
 * `invitations.decline.test.ts` still passes — the in-transaction re-check
 * now refuses each of them independently. What changes is that a
 * still-pending, still-blocked row gets the less conservative `NOT_PENDING`
 * this function otherwise avoids for a row nobody has answered (see the
 * paragraph above), and this function opens, then rolls back, a transaction
 * it would otherwise have skipped. `declineInvitation` cannot reach this
 * hole at all: its own `TeacherBlock` write is gated behind its own CAS
 * moving this same row to `declined` in the same transaction, so a block it
 * writes is never visible without that status change alongside it — which
 * the CAS/re-read below already catches on its own.
```

Then verify the sweep: `grep -n "arm that goes red\|Delete this guard" src/services/invitations.ts` should return nothing once this is applied (both phrases were only ever in this one docblock).

**`invitations.decline.test.ts`**, the inline comment inside `'answers NOT_PENDING for an accepted row on a blocked pair, and commits no link'` (around line 381) — replace:
```
      // The arm `acceptInvitation`'s block guard is load-bearing for, and the
      // only one a test can tell apart from its absence: delete the guard and
      // the CAS's own re-read treats an already-`accepted` row as success, so
      // the call returns `{ ok: true }` having committed a roster link for a
      // blocked pair. The `declined` case above answers NOT_PENDING either
      // way, because `NotPendingError` rolls that link write back.
```
with:
```
      // The in-transaction re-check #537 added (see `acceptInvitation`'s own
      // docblock, and `NotPendingError`'s) is what actually refuses this arm
      // now: it reads `TeacherBlock` again right before either success
      // return, so it catches an already-`accepted` row on a blocked pair
      // whether or not the outside guard above ever ran first.
      // `invitations-lock-order.test.ts`'s "#537" describe races that
      // in-transaction check directly, without needing this test's
      // sequential setup. The `declined` case above stays safe either way,
      // because `NotPendingError` rolls the link write back regardless of
      // which guard reaches it.
```

Verify the sweep for this one too: `grep -n "load-bearing for, and the" src/services/invitations.decline.test.ts` should return nothing once applied.

#### Step 5: Full verification

- `pnpm exec vitest run --project integration src/services/invitations-lock-order.test.ts src/services/invitations.decline.test.ts` — both files green, including every pre-existing test (the docblock edits touch no code, but the mutation-test step in Step 3 modified and restored the source, so re-run to confirm no residual mutation survived).
- `pnpm run verify` — full suite, typecheck, lint. Needs the worktree's dev server up (`pnpm run worktree:up`, already running per this repo's worktree hazard).
- Confirm the two grep sweeps in Step 4 both return nothing.
- Confirm `docs/lock-order.md` needs no edit (per the spec's reasoning) — this is a decision to record in the PR body, not a file to touch.

**Review focus for this task:** does the in-transaction re-check actually sit between `linkTeacherStudent` and `tx.invitation.updateMany` (not after the CAS, where it would miss the `count === 0` idempotent-success return)? Do both new tests' `calls` assertions actually distinguish "fix present" from "fix absent" (i.e., would genuinely go red under the Step 3 mutation, not just under a broken fixture)? Do the three corrected docblocks/comments read as internally consistent with the code as it now stands, not merely "not wrong" in isolation?
