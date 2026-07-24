# `updateClass` Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `PUT /api/classes/[id]`'s update logic into an `updateClass`
service function whose result type distinguishes "the lock blocked you" from
"the row is gone", fixing the misleading 409 in issue #72.

**Architecture:** A new `updateClass(db, classId, data)` in
`src/services/class-lifecycle.ts`, beside the existing `transitionClass` and
`completeClass`, returning a discriminated union. The route becomes a thin
wrapper that maps each `reason` to a status code and message. The route's
duplicate `ECONOMIC_FIELDS` array is deleted in favour of the service's frozen,
already-unit-tested one.

**Tech Stack:** TypeScript strict mode, Prisma, Vitest (the `unit` project for
service tests, `integration` for the HTTP suite).

## Global Constraints

- **TypeScript `strict: true`, no `any`.** The one permitted cast is
  `as unknown as PrismaClient` for the stub in Task 2, confined to the test file.
- **`tests/integration/classes-api.test.ts` must NOT be modified.** It passing
  unchanged is the evidence that the extraction preserved behaviour. If a change
  there seems necessary, stop and report — it means behaviour changed.
- The only intended behaviour change in this whole plan: a non-economic edit
  racing a class deletion now returns **404 `Class not found`** instead of
  **409 `Cannot update economic fields when settings are locked: `**.
- Error message strings live in the **route**, not the service. The service
  returns structured reasons; the route formats user-facing copy.
- Existing message text must be reproduced **exactly** — `classes-api.test.ts`
  asserts substrings of it.
- Dev server on `localhost:3000` for the integration suite. Don't run
  `tests/integration/signup-api.test.ts` — its per-IP limiter 429s on repeated
  local runs.

---

### Task 1: The `updateClass` service

**Files:**
- Modify: `src/services/class-lifecycle.ts` (append a new section at the end)
- Test: `src/services/class-lifecycle.test.ts` (append a new `describe` at the end)

**Interfaces:**
- Consumes: `ECONOMIC_FIELDS` and `EconomicField`, both already exported from
  `src/services/class-lifecycle.ts`.
- Produces: `updateClass`, `UpdateClassResult`, `ClassUpdateData` — all used by
  Task 2's tests and Task 3's route.

Read `src/app/api/classes/[id]/route.ts`'s `PUT` handler first — this task moves
its logic, and the existing behaviour is the specification.

Note `class-lifecycle.ts` currently imports `import type { PrismaClient, ClassStatus, RegistrationStatus } from '@prisma/client';`
— add `Class` to that list.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/services/class-lifecycle.test.ts`. The file already
defines `const prisma = new PrismaClient();` and `const uniqueSuffix = Date.now();`
near its `transitionClass (DB)` block — reuse both; do not redeclare them.

```ts
// ===========================================================================

describe('updateClass (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;

  // `settingsLocked` is written directly here because it is an INPUT
  // precondition for this function, not the behaviour under test. The genuine
  // flip — a real registration setting it — is covered by
  // registrations-api's `locks settings atomically with the first
  // registration`. Do not copy this shortcut into a test that claims to cover
  // the flip itself.
  const makeClass = (settingsLocked: boolean) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'draft',
        settingsLocked,
      },
    });

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Update',
        lastName: 'Teacher',
        email: `update-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `update-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for updateClass tests',
        pageSlug: `update-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Update Studio',
        address: `${uniqueSuffix} Update St`,
        city: 'Amsterdam',
        postcode: '1234AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 35 },
    });
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    // Guarded: an undefined filter turns deleteMany into an unfiltered
    // delete-all across the table.
    if (teacherId) {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    }
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('returns not_found for an unknown class', async () => {
    const result = await updateClass(prisma, 'non-existent-id', { classType: 'Vinyasa' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('applies a non-economic edit to an unlocked class', async () => {
    const cls = await makeClass(false);

    const result = await updateClass(prisma, cls.id, { description: 'Updated' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cls.description).toBe('Updated');

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.description).toBe('Updated');
  });

  it('applies an economic edit to an unlocked class', async () => {
    const cls = await makeClass(false);

    const result = await updateClass(prisma, cls.id, { roomCost: 42, minStudents: 2 });
    expect(result.ok).toBe(true);

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(stored.roomCost)).toBe(42);
    expect(stored.minStudents).toBe(2);
  });

  it('rejects an economic edit to a locked class, naming the fields sent', async () => {
    const cls = await makeClass(true);

    // Sent in the reverse of ECONOMIC_FIELDS' own declaration order, so the
    // returned tuple's ordering is shown to come from the constant rather
    // than from the caller.
    const result = await updateClass(prisma, cls.id, { minRate: 1, roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost', 'minRate'] });

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(stored.roomCost)).toBe(35);
    expect(Number(stored.minRate)).toBe(15);
  });

  it('allows a non-economic edit to a locked class — the lock is scoped to economics', async () => {
    const cls = await makeClass(true);

    const result = await updateClass(prisma, cls.id, { description: 'Still editable' });
    expect(result.ok).toBe(true);

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.description).toBe('Still editable');
    expect(Number(stored.roomCost)).toBe(35);
  });

  it('rejects a mixed economic + non-economic body atomically', async () => {
    const cls = await makeClass(true);

    const result = await updateClass(prisma, cls.id, { description: 'x', roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost'] });

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.description).toBeNull();
    expect(Number(stored.roomCost)).toBe(35);
  });

  it('returns no_fields for an empty body', async () => {
    const cls = await makeClass(false);

    const result = await updateClass(prisma, cls.id, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
  });
});
```

Add `updateClass` to the existing import block at the top of the file (which
already imports `transitionClass`, `completeClass`, `ECONOMIC_FIELDS` and
others from `./class-lifecycle`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: FAIL — the import of `updateClass` does not resolve, so the file
fails to load. That is the correct failure at this point.

- [ ] **Step 3: Implement `updateClass`**

Append to the end of `src/services/class-lifecycle.ts`:

```ts
// ---------------------------------------------------------------------------
// Class updates
// ---------------------------------------------------------------------------

/**
 * The fields a teacher may change on an existing class.
 *
 * Declared here rather than derived from `updateClassSchema` so the service
 * stays independent of the wire format — the schema's `date` is a
 * `YYYY-MM-DD` string, which the route converts before calling in.
 */
export type ClassUpdateData = {
  classType?: string;
  description?: string | null;
  date?: Date;
  startTime?: string;
  durationMinutes?: number;
  roomCost?: number;
  minRate?: number;
  targetRate?: number;
  minStudents?: number;
  maxStudents?: number;
};

/**
 * Why an update did or did not happen.
 *
 * `locked` carries a NON-EMPTY tuple of offending fields deliberately. The bug
 * this type replaced (#72) returned a "locked" response naming no fields at
 * all, for a request that touched none — the compiler now refuses to construct
 * that. Callers own the user-facing wording; this type owns the distinction.
 */
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'no_fields' };

/**
 * Apply a partial update to a class, enforcing the economic-field lock.
 *
 * The lock is enforced twice on purpose: once against the row we read (so the
 * caller gets a precise list of offending fields), and once inside the write
 * as a compare-and-swap (so a first registration landing in between still
 * blocks the edit).
 */
export async function updateClass(
  db: PrismaClient,
  classId: string,
  data: ClassUpdateData,
): Promise<UpdateClassResult> {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) return { ok: false, reason: 'not_found' };

  // Destructured rather than length-checked, so the non-empty tuple below is
  // proven to the compiler instead of asserted.
  const [firstEconomic, ...otherEconomic] = ECONOMIC_FIELDS.filter(
    (f) => data[f] !== undefined,
  );
  const sentEconomic: readonly [EconomicField, ...EconomicField[]] | null =
    firstEconomic === undefined ? null : [firstEconomic, ...otherEconomic];

  if (cls.settingsLocked && sentEconomic !== null) {
    return { ok: false, reason: 'locked', fields: sentEconomic };
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, reason: 'no_fields' };
  }

  const result = await db.class.updateMany({
    where: sentEconomic !== null ? { id: classId, settingsLocked: false } : { id: classId },
    data,
  });

  if (result.count === 0) {
    // Two different events land here, and #72 was them sharing one response:
    //   economic fields sent -> the compare-and-swap lost its race, the lock
    //                           flipped between our read and this write
    //   none sent            -> the where was just { id }, so the only way to
    //                           match nothing is that the row was deleted
    return sentEconomic !== null
      ? { ok: false, reason: 'locked', fields: sentEconomic }
      : { ok: false, reason: 'not_found' };
  }

  return { ok: true, cls: await db.class.findUniqueOrThrow({ where: { id: classId } }) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: PASS — all pre-existing tests in the file plus the seven new ones.

- [ ] **Step 5: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0, no output.

If `tsc` rejects passing `data` to `updateMany`, do **not** widen it with a
cast — report the exact error. It would mean `ClassUpdateData` and Prisma's
generated input type genuinely disagree, which is a design question, not a
mechanical fix.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "feat: updateClass service distinguishes a lost lock race from a deleted class (#72)"
```

---

### Task 2: Cover the two `count === 0` branches

**Files:**
- Test: `src/services/class-lifecycle.test.ts` (append a second new `describe`)

**Interfaces:**
- Consumes: `updateClass` and `UpdateClassResult` from Task 1.
- Produces: nothing.

These two branches are the reason the issue exists. Reaching either requires
the row to change between the service's read and its write, which no
arrangement of a real database reproduces deterministically — so a stub is the
only way in. Task 1's real-database tests cover every path that a real database
*can* reach; this task covers the two it cannot.

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/services/class-lifecycle.test.ts`:

```ts
describe('updateClass — the count === 0 branches', () => {
  // Reaching `count === 0` needs the row to change between updateClass's read
  // and its write. Against a real database that is a genuine race with no
  // deterministic trigger — which is exactly why #72's wrong status shipped
  // unnoticed. A stub is the only way to exercise these two lines.
  //
  // `settingsLocked: false` on the read is essential to the first case: a
  // locked row would be caught by the earlier check and never reach the
  // compare-and-swap at all.
  function stubDb(): PrismaClient {
    return {
      class: {
        findUnique: async () => ({ id: 'stub-class', settingsLocked: false }),
        updateMany: async () => ({ count: 0 }),
        findUniqueOrThrow: async () => {
          throw new Error('findUniqueOrThrow must not be reached when count === 0');
        },
      },
    } as unknown as PrismaClient;
  }

  it('reports locked when economic fields were sent — the compare-and-swap lost', async () => {
    const result = await updateClass(stubDb(), 'stub-class', { roomCost: 42 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost'] });
  });

  it('reports not_found when no economic field was sent — the row was deleted (#72)', async () => {
    // The whole point of the issue. Before the fix this returned the `locked`
    // reason with an empty field list, which the route rendered as
    // "Cannot update economic fields when settings are locked: " with a 409.
    const result = await updateClass(stubDb(), 'stub-class', { description: 'x' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: PASS. Task 1 already implemented both branches, so these do not fail
first — they are the proof that Task 1's classification is correct. Note this
in your report rather than treating the immediate pass as a mistake.

- [ ] **Step 3: Verify the second test actually detects the bug**

Temporarily reintroduce the defect in `src/services/class-lifecycle.ts` by
collapsing the classification back to the single branch the route shipped:

```ts
  if (result.count === 0) {
    return sentEconomic !== null
      ? { ok: false, reason: 'locked', fields: sentEconomic }
      : { ok: false, reason: 'locked', fields: ['roomCost'] };  // TEMPORARY
  }
```

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: the `not_found` test FAILS, and nothing else does.

Then revert:

```bash
git checkout -- src/services/class-lifecycle.ts
```

Run: `git status --short src/` → must be **empty**. Report both outputs.

(The original bug returned `fields: []`, which this plan's type makes
impossible to write; the placeholder above is the nearest legal equivalent and
exercises the same wrong classification.)

- [ ] **Step 4: Commit**

```bash
git add src/services/class-lifecycle.test.ts
git commit -m "test: cover both count === 0 classifications with a stubbed db (#72)"
```

---

### Task 3: Make the route a thin wrapper

**Files:**
- Modify: `src/app/api/classes/[id]/route.ts`
- Modify: `src/lib/schemas.ts:251` (one comment)

**Interfaces:**
- Consumes: `updateClass`, `type ClassUpdateData` from `@/services/class-lifecycle`.
- Produces: nothing.

- [ ] **Step 1: Delete the route's duplicate `ECONOMIC_FIELDS`**

Remove this block entirely from `src/app/api/classes/[id]/route.ts` (it sits
between the `GET` and `PUT` handlers):

```ts
const ECONOMIC_FIELDS = [
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const;
```

It duplicates the frozen, unit-tested `ECONOMIC_FIELDS` in
`src/services/class-lifecycle.ts`. Two copies can drift, and a drifted copy
silently stops protecting a field.

- [ ] **Step 2: Replace the `PUT` handler body**

Replace the whole `export const PUT = ...` block with:

```ts
export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

  const parsed = await parseBody(request, updateClassSchema);
  if ('error' in parsed) return parsed.error;
  // The schema validates date as a YYYY-MM-DD string; Prisma needs a Date
  // (UTC midnight, same as class creation). Latent until the edit UI —
  // nothing ever PUT a date before.
  const { date: dateString, ...rest } = parsed.data;
  const data: ClassUpdateData = {
    ...rest,
    ...(dateString !== undefined ? { date: new Date(dateString) } : {}),
  };

  const result = await updateClass(prisma, id, data);
  if (result.ok) return respondOk(result.cls);

  // Narrowed one reason at a time so the `locked` branch below can read
  // `result.fields` without a cast.
  if (result.reason === 'not_found') return respondError('Class not found', 404);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  return respondError(
    `Cannot update economic fields when settings are locked: ${result.fields.join(', ')}`,
    409,
  );
});
```

Add the import alongside the existing ones:

```ts
import { updateClass, type ClassUpdateData } from '@/services/class-lifecycle';
```

- [ ] **Step 3: Fix the now-false comment in `src/lib/schemas.ts`**

Line 251 currently reads:

```ts
  // Economic fields — only accepted when settings not locked (checked in route)
```

Replace with:

```ts
  // Economic fields — only accepted when settings not locked (enforced by
  // updateClass in src/services/class-lifecycle.ts)
```

- [ ] **Step 4: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0, no output.

- [ ] **Step 5: The behaviour-preservation gate**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: ALL pass, with the file **unmodified**.

Then confirm it really is unmodified:

Run: `git status --short tests/integration/classes-api.test.ts`
Expected: **empty output**.

If any test there fails, the extraction changed behaviour — do not edit the
test. Fix the service or route so the existing assertions hold, or stop and
report if you believe the test is wrong.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/classes/[id]/route.ts src/lib/schemas.ts
git commit -m "refactor: PUT /api/classes/[id] delegates to updateClass (#72)"
```

---

### Task 4: Verify and open the PR

- [ ] **Step 1: Full gate**

```bash
npx tsc --noEmit && npx eslint src tests
npx vitest run --project unit
npx vitest run --project integration
```

Expected: tsc and eslint exit 0; both projects green. If `signup-api.test.ts`
429s, note it — that is the local per-IP limiter from repeated runs, unrelated
to this branch. Any other failure is real; report it rather than proceeding.

- [ ] **Step 2: Confirm the diff's shape**

Run: `git diff --stat main...HEAD`

Expected files, and no others: `src/services/class-lifecycle.ts`,
`src/services/class-lifecycle.test.ts`, `src/app/api/classes/[id]/route.ts`,
`src/lib/schemas.ts`, and the two `docs/superpowers/` files. If
`tests/integration/classes-api.test.ts` appears, stop and report.

- [ ] **Step 3: Push and open the PR** — closes #72:

```bash
git push -u origin fix/update-class-service
gh pr create --title "fix: distinguish a deleted class from a locked one on PUT (#72)" --body "$(cat <<'BODY'
Closes #72. Spec: `docs/superpowers/specs/2026-07-24-update-class-service-design.md`

## The bug
`PUT /api/classes/[id]` ended with a conditional update whose `count === 0` handler served two different situations. For an **economic** edit it is a compare-and-swap catching a registration that landed mid-request — correct. For a **non-economic** edit the `where` is just `{ id }`, so `count === 0` can only mean the class was **deleted** between the read and the write. That caller got:

```
409 Cannot update economic fields when settings are locked:
```

An empty field list, a trailing colon, and a lock blamed for a request that touched no economic field, where **404** was the answer. Rare, but the message sends you debugging the lock when the real event was a deletion.

## The fix, and why it is bigger than three lines
Two things turned up while investigating:

- **The route duplicated a service constant.** `class-lifecycle.ts` exports a frozen `ECONOMIC_FIELDS` with unit tests pinning its contents; the route declared an identical private copy and never imported it. Add a sixth economic field to the service — with its test — and the route's lock would silently stop covering it. That is a worse latent bug than the one filed.
- **The buggy branch was unreachable by any test.** The services take an injectable `db`; the route does not. That is *why* this shipped.

So the logic moved into `updateClass(db, classId, data)` in `class-lifecycle.ts`, beside `transitionClass` and `completeClass`, matching the architecture `CLAUDE.md` describes. The route is now a thin wrapper mapping reasons to statuses.

## The type does the work

```ts
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'no_fields' };
```

`fields` is a **non-empty tuple**. The shipped bug was a `locked` result naming no fields; the compiler now rejects one. The fix is structural rather than a corrected `if` — the malformed message is unwriteable.

## Testing
Every path a real database can reach is unit-tested against a real `PrismaClient`. The two `count === 0` branches cannot be reached that way — that is precisely why the bug went unnoticed — so they use a stubbed `db`, and the `not_found` test was verified to fail when the defect is temporarily reintroduced.

`tests/integration/classes-api.test.ts` passes **unmodified**. Since it pins the 409 message, the scoped lock, the ownership guard, and atomic rejection of mixed bodies, an unchanged pass is the evidence that the extraction preserved behaviour.

## Deliberately unchanged
After a successful update the service re-reads with `findUniqueOrThrow`, which can itself race a delete and surface as a 500. True before this change and unchanged by it — a much narrower window than the one fixed, recorded so its survival is a decision.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 4: Report the PR URL. Do NOT merge.**

---

## Self-Review

**Spec coverage:** the result type and non-empty tuple → Task 1 Step 3; the
signature and behaviour order → Task 1 Step 3; the route/service split table →
Task 3 Step 2; `ECONOMIC_FIELDS` de-duplication → Task 3 Step 1; reachable-path
tests → Task 1 Step 1; the two stubbed `count === 0` branches → Task 2;
`classes-api.test.ts` unmodified as the preservation gate → Task 3 Step 5 and
Task 4 Step 2; the `schemas.ts` comment → Task 3 Step 3; the `findUniqueOrThrow`
non-goal → carried into the PR body. The spec's own `## Correction` (the
step 3/4 ordering being unobservable) is honoured by the absence of a test for
it — deliberately, since no input can distinguish the two orders.

**Placeholder scan:** none. Every step carries literal code or an exact command
with its expected output. Task 1 Step 5 and Task 3 Step 5 name what to do when
the expectation fails (report; do not cast, do not edit the test) rather than
leaving it to judgment.

**Type consistency:** `updateClass(db, classId, data)`, `UpdateClassResult`,
`ClassUpdateData`, and the `reason` values `'not_found' | 'locked' | 'no_fields'`
are spelled identically in Tasks 1, 2 and 3. `result.cls` is the success
payload in the service, the tests, and the route. `EconomicField` is imported
from nowhere new — it is already exported by the file Task 1 edits.
