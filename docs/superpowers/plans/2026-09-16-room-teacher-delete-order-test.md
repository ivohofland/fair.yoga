# Room/TeacherRoom/Teacher Delete Order Integration Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CI-visible (unconditional, non-e2e) integration test that pins the `Room`/`TeacherRoom`/`Teacher` delete order — the invariant that #617 violated and that nothing in CI currently protects, since the only prior regression test lives inside a Playwright `describe` block that self-skips on Linux CI.

**Architecture:** One new vitest file under `tests/integration/`, using a direct `PrismaClient` (no HTTP), matching the existing style of `tests/integration/room-identity-index.test.ts`. Two cases against a shared minimal fixture-maker (`Teacher` + `Room` with `createdById` + `TeacherRoom`):
1. Deleting in the app's real order (`teacherRoom` → `room` → `teacher`) resolves cleanly.
2. Deleting `teacher` before `room` rejects — asserted via the existing `isRestrictViolationOn(err, ['Room_createdById_fkey'])` helper (`src/lib/api-errors.ts`), which pins the *specific* constraint rather than "any error was thrown," so the test cannot pass vacuously if the FK is ever loosened or a different constraint starts firing first.

**Tech Stack:** TypeScript, vitest (`integration` project — runs against the same database the dev app reads, per `vitest.config.ts`), Prisma Client, existing helpers `uniqueSuffix()` (`tests/helpers.ts`) and `isRestrictViolationOn()` (`src/lib/api-errors.ts`).

**Spec:** No separate spec doc — classified as a Bounded change during brainstorming (single file, single obvious design, no data-model change). Premise verified directly against `prisma/schema.prisma`, the applied migration SQL, `src/lib/api-errors.ts`, and `.github/workflows/ci.yml` (see conversation record / PR body for the arithmetic).

## Global Constraints

- Every row this test creates must be deleted by the end of the run — the `integration` project points `DATABASE_URL` at the same database the dev app uses, not a throwaway test DB (`vitest.config.ts`, `integration` project comment).
- Never edit `tests/e2e/visual.spec.ts`, `tests/room-fixtures.ts`, or any of the other 9 e2e files that hand-copy this ordering — out of scope for this issue (the issue's "consider... one owner" line is explicitly a "consider," not part of the stated Acceptance section). Note this exclusion in the PR body.
- Use the project's own `isRestrictViolationOn` helper rather than a bare `.rejects.toThrow()` — a bare throw-check would also pass if an unrelated error occurred, defeating the point of pinning the *direction*.
- TypeScript strict mode — no `any`.

---

### Task 1: Add the delete-order integration test

**Files:**
- Create: `tests/integration/room-teacher-delete-order.test.ts`

**Interfaces:**
- Consumes: `uniqueSuffix` from `tests/helpers.ts` (returns `string`, e.g. `"1700000000000-a1b2c3"`); `isRestrictViolationOn(error: unknown, constraints: readonly string[]): boolean` from `src/lib/api-errors.ts`.
- Produces: nothing consumed by later tasks — this is the only task in the plan.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/room-teacher-delete-order.test.ts` with the following content:

```typescript
/**
 * Pins the delete order `TeacherRoom -> Room -> Teacher` against
 * `Room_createdById_fkey` (`ON DELETE RESTRICT`, non-cascading). #617:
 * `tests/e2e/visual.spec.ts`'s `afterAll` deleted `Teacher` before `Room`
 * and tripped this constraint, but its only regression coverage lives
 * inside a Playwright `describe` that self-skips on Linux CI (no
 * `-linux` baselines, #542's `hasBaselines` check) — so nothing in CI
 * caught it, and nothing catches its reintroduction. This file does,
 * unconditionally, in the `test-integration` job.
 *
 * `TeacherRoom -> Teacher` and `TeacherRoom -> Room` are both `ON DELETE
 * CASCADE` (`prisma/schema.prisma`), so only `Room.createdById -> Teacher`
 * can refuse a delete here — which is why the wrong-order case below
 * deletes `teacher` directly rather than needing a separate cascade case.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { uniqueSuffix } from '../helpers';
import { isRestrictViolationOn } from '@/lib/api-errors';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
let seq = 0;

interface Fixture {
  teacherId: string;
  roomId: string;
  teacherRoomId: string;
  accountEmail: string;
}

async function makeFixture(): Promise<Fixture> {
  const tag = `roomorder-${suffix}-${seq++}`;
  const email = `${tag}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Order',
      lastName: 'Fixture',
      email,
      account: { create: { email } },
      bio: 'room delete order fixture',
      pageSlug: tag,
    },
  });
  const room = await prisma.room.create({
    data: {
      venueName: `Venue ${tag}`,
      address: `${tag} Street`,
      city: 'Amsterdam',
      postcode: '1011AB',
      maxCapacity: 10,
      createdById: teacher.id,
    },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: {
      teacherId: teacher.id,
      roomId: room.id,
      capacityOverride: 10,
      rentalRate: new Prisma.Decimal(20),
    },
  });
  return { teacherId: teacher.id, roomId: room.id, teacherRoomId: teacherRoom.id, accountEmail: email };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Room/TeacherRoom/Teacher delete order (Room_createdById_fkey)', () => {
  it('resolves when deleted in the app\'s order: teacherRoom -> room -> teacher', async () => {
    const f = await makeFixture();
    await expect(prisma.teacherRoom.delete({ where: { id: f.teacherRoomId } })).resolves.toBeDefined();
    await expect(prisma.room.delete({ where: { id: f.roomId } })).resolves.toBeDefined();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).resolves.toBeDefined();
    await prisma.account.deleteMany({ where: { email: f.accountEmail } });
  });

  it('rejects on Room_createdById_fkey when teacher is deleted before room', async () => {
    const f = await makeFixture();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).rejects.toSatisfy((e: unknown) =>
      isRestrictViolationOn(e, ['Room_createdById_fkey']),
    );

    // The failed delete rolled back, so teacher/room/teacherRoom all still
    // exist — clean up in the order the test above just proved works.
    await prisma.teacherRoom.delete({ where: { id: f.teacherRoomId } });
    await prisma.room.delete({ where: { id: f.roomId } });
    await prisma.teacher.delete({ where: { id: f.teacherId } });
    await prisma.account.deleteMany({ where: { email: f.accountEmail } });
  });
});
```

- [ ] **Step 2: Run the file once as written to confirm both cases pass**

Run: `pnpm exec vitest run --project integration tests/integration/room-teacher-delete-order.test.ts`
Expected: `2 passed`.

- [ ] **Step 3: Mutation-test case 1 — prove it fails on the pre-#618 (buggy) statement order**

This is the acceptance criterion stated in the issue verbatim: "fails on the pre-#618 statement order (teacher-before-room) and passes on the current order." Temporarily swap the last two deletes in the first `it` block from:

```typescript
    await expect(prisma.room.delete({ where: { id: f.roomId } })).resolves.toBeDefined();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).resolves.toBeDefined();
```

to the pre-#618 order:

```typescript
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).resolves.toBeDefined();
    await expect(prisma.room.delete({ where: { id: f.roomId } })).resolves.toBeDefined();
```

Run: `pnpm exec vitest run --project integration tests/integration/room-teacher-delete-order.test.ts -t "app's order"`
Expected: **FAIL** — the `teacher.delete` call now throws `PrismaClientKnownRequestError` (P2003, `Room_createdById_fkey`), since `room` is still there referencing it. Record the exact error text in the task report, then revert the swap back to the correct order.

- [ ] **Step 4: Mutation-test case 2 — prove the constraint-identity check is load-bearing, not a bare throw-check**

Temporarily change the constraint name in the second `it` block from `'Room_createdById_fkey'` to a name that cannot match, e.g. `'Nonexistent_fkey'`.

Run: `pnpm exec vitest run --project integration tests/integration/room-teacher-delete-order.test.ts -t "Room_createdById_fkey when teacher"`
Expected: **FAIL** — `isRestrictViolationOn` returns `false` because the thrown error's real constraint (`Room_createdById_fkey`) doesn't match the wrong name, proving the assertion actually inspects *which* constraint fired rather than merely that *something* threw. Revert the name back to `'Room_createdById_fkey'`.

- [ ] **Step 5: Re-run the file to confirm both cases pass again after reverting both mutations**

Run: `pnpm exec vitest run --project integration tests/integration/room-teacher-delete-order.test.ts`
Expected: `2 passed`.

- [ ] **Step 6: Run the whole integration project to confirm no collateral breakage**

Run: `pnpm exec vitest run --project integration`
Expected: all integration tests pass (this file adds 2 to the prior total — state the before/after count in the task report).

- [ ] **Step 7: Commit**

```bash
git add tests/integration/room-teacher-delete-order.test.ts
git commit -m "test(integration): pin Room/TeacherRoom/Teacher delete order (#619)"
```
