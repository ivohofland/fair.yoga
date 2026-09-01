# Raced-Create Coded Conflicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every check-then-create in the API answers a lost race with the same status *and* error `code` its pre-check answers with, instead of falling through to `withErrorHandler`'s code-less `"Resource already exists"`.

**Architecture:** Per site, wrap the `create` in a `try`/`catch` and match the thrown `P2002` on its **column set** via `isUniqueConflictOn` (`src/lib/unique-conflict.ts`), returning the route's own coded 409. An unrecognised `P2002` is logged at `error` and rethrown as a plain `Error` — never as a `P2002`, which `classifyApiError` would turn back into the code-less 409 this work exists to remove. No change to `withErrorHandler` or `classifyApiError` behaviour; only a stale comment on the latter.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (integration project runs over HTTP against the dev server on `:3000`).

**Spec:** `docs/superpowers/specs/2026-09-01-raced-create-coded-conflicts-design.md`

## Global Constraints

- **Match column sets, never bare `P2002`.** Use `isUniqueConflictOn(err, [...])` from `src/lib/unique-conflict.ts`. A bare `err.code === 'P2002'` check would swallow a future constraint on the same create under reasoning established only for today's keys.
- **Never rethrow an unrecognised `P2002` as a `P2002`.** `classifyApiError` maps any `P2002` to the code-less 409. Follow `src/app/api/auth/student-signup/route.ts:86-93`: log at `error` with `rawTarget: err.meta?.target`, then `throw new Error(...)` so it classifies 500.
- **Copy is byte-identical to the pre-check it mirrors.** The race path and the sequential path must be indistinguishable to the client — that is the acceptance criterion.
- **Tests force a real race with the uncommitted-holder lever**, modelled on `tests/integration/signup-api.test.ts:196-272`. Do not stub the `create`; these tests run over HTTP and route internals are not reachable.
- **Every request in a test gets its own IP** via `freshIp()` from `tests/helpers.ts` — `POST /api/teachers` is IP-rate-limited to 3/hour.
- **No comment states a count or a roster of things in other files** (CLAUDE.md, *Comment Discipline*).
- **Never `git add -A` or `git add .`** — stage exact paths.
- Fast inner loop: `npx vitest run --project integration <path>`. Full gate before pushing: `npm run verify`.

**Task order is load-bearing.** Task 5 replaces a comment whose honest wording depends on Tasks 1–4 having closed the windows it describes. Run 1–4 in any order; run 5 last.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/app/api/teacher-rooms/route.ts` | Catch the `TeacherRoom` link collision → `DUPLICATE` | 1 |
| `tests/integration/teacher-rooms-api.test.ts` | Race test for the above | 1 |
| `src/services/invitations.ts` | Catch the `Invitation` collision → `ALREADY_INVITED` | 2 |
| `tests/integration/students-api.test.ts` | Race test for the above | 2 |
| `src/app/api/teachers/route.ts` | Catch `['email']` → `EMAIL_TAKEN`, `['pageSlug']` → `SLUG_TAKEN` | 3 |
| `tests/integration/teachers-api.test.ts` | Two race tests for the above | 3 |
| `src/app/api/account/student-profile/route.ts` | Catch `['accountId']` or `['email']` → `ALREADY_STUDENT` | 4 |
| `tests/integration/account-api.test.ts` | Race test for the above | 4 |
| `src/lib/api-errors.ts` | Replace the stale cross-file count on the `P2002` branch | 5 |

---

### Task 1: `POST /api/teacher-rooms` answers a raced duplicate with `DUPLICATE`

**Files:**
- Modify: `src/app/api/teacher-rooms/route.ts:69-79`
- Test: `tests/integration/teacher-rooms-api.test.ts` (append a new `describe` at end of file)

**Interfaces:**
- Consumes: `isUniqueConflictOn(err: unknown, columns: readonly string[]): boolean` from `@/lib/unique-conflict`; `respondError(message: string, status: number, code?: string)` from `@/lib/api-utils`.
- Produces: nothing later tasks depend on. Establishes the shape Tasks 2–4 repeat.

Background: `TeacherRoom` declares two unique keys — `@@unique([teacherId, roomId])` and `@@unique([id, isArchived])`. The second is on a freshly-minted uuid and cannot collide from this create.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/teacher-rooms-api.test.ts`. It needs `freshIp` — extend the existing import from `'../helpers'` to include it only if a later step shows it is needed; this test does not need it (the route is session-limited, not IP-limited), so leave the imports alone and add:

```ts
/**
 * The pre-check at `:56` is a plain `findUnique`, so under READ COMMITTED a
 * concurrent attach to the same (teacher, room) passes it and loses on
 * `TeacherRoom_teacherId_roomId_key`. Unhandled, that `P2002` reaches
 * `withErrorHandler` and answers 409 with NO `code` — the same status the
 * pre-check gives, without the field a client can branch on (#161).
 *
 * The lever is an UNCOMMITTED HOLDER, the one worked out in
 * `signup-api.test.ts` for the same shape: a second client inserts the
 * conflicting row inside an open transaction, the request sails past its
 * pre-check (uncommitted rows are invisible), parks on the pending unique
 * index entry, and the holder commits so the request loses. Deterministic —
 * the interleaving is forced, not raced for.
 */
describe('POST /api/teacher-rooms answers a raced duplicate with DUPLICATE (#161)', () => {
  let raceRoomId: string;

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue',
        address: `${suffix} Race Street 1`,
        city: 'Amsterdam',
        postcode: '1011AB',
        floor: '1',
        roomName: 'Race Room',
        maxCapacity: 10,
        equipment: [],
        isPublic: true,
        createdById: ownerId,
      },
    });
    raceRoomId = room.id;
  });

  afterAll(async () => {
    await prisma.teacherRoom.deleteMany({ where: { roomId: raceRoomId } });
    await prisma.room.deleteMany({ where: { id: raceRoomId } });
  });

  it('returns 409 DUPLICATE when the create loses to a concurrent link', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.teacherRoom.create({
          data: { teacherId: ownerId, roomId: raceRoomId, rentalRate: 25 },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = fetch(`${BASE_URL}/api/teacher-rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ roomId: raceRoomId, rentalRate: 30 }),
    });

    // Asserted, not assumed: the holder's insert proves the index entry
    // exists, not that the request reached it. A request that answered inside
    // this second skipped the create on a committed row and raced nothing.
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('DUPLICATE');
    expect(body.error.message).toBe('Teacher-room link already exists');

    // One link, and it is the holder's — proof the request lost the insert
    // rather than serialising past it.
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => Number(l.rentalRate))).toEqual([25]);
  });
});
```

- [ ] **Step 2: Warm the route, then run the test to verify it fails**

`next dev` compiles lazily; a first-request compile can blow a timeout that reads exactly like an assertion failure. Warm it first:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/teacher-rooms
npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "raced duplicate"
```

Expected: FAIL. `body.error.code` is `undefined`, not `'DUPLICATE'`; the message is `'Resource already exists'`.

- [ ] **Step 3: Add the catch**

In `src/app/api/teacher-rooms/route.ts`, add to the imports:

```ts
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
```

Replace lines 69-79 (the `create` and its `respondOk`) with:

```ts
  // The pre-check above is a plain read, so a concurrent attach to the same
  // (teacher, room) passes it and one of the two loses here. Answering with
  // the pre-check's own code keeps the two paths indistinguishable to a
  // client, which is the whole point: without it a race reaches
  // `withErrorHandler` and returns 409 with no `code` at all (#161).
  //
  // Matched on the column set rather than on `P2002` alone. `TeacherRoom`
  // also declares `@@unique([id, isArchived])`, which this create cannot
  // collide on — `id` is a fresh uuid — but a bare code check would swallow
  // that key and any key added later under reasoning established only for
  // this one.
  try {
    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId: session.teacherId,
        roomId,
        capacityOverride,
        rentalRate,
        equipmentNotes: equipmentNotes ?? undefined,
      },
    });
    return respondOk(teacherRoom, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'roomId'])) {
      return respondError('Teacher-room link already exists', 409, 'DUPLICATE');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with the
    // code-less 409 this catch exists to remove, so rethrowing would deliver
    // the same defect through the other door. Same reasoning, same shape as
    // `auth/student-signup`'s catch.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher-room create hit a unique constraint that is not the link key',
      );
      throw new Error('teacher-room create: unrecognised unique constraint');
    }
    throw err;
  }
```

Add the `Prisma` import at the top of the file:

```ts
import { Prisma } from '@prisma/client';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts
```

Expected: PASS, whole file green (not just the new case).

- [ ] **Step 5: Prove the guard bites — mutate, record, restore**

The realistic regression is not a deleted catch, it is a matcher that drifts off its constraint. Change the column set to a wrong-but-plausible one:

```ts
    if (isUniqueConflictOn(err, ['teacherId', 'roomId', 'isArchived'])) {
```

Re-run Step 4's command. Record the **exact** failure text in the task's report — it must show `code` arriving as `undefined`, which is the defect. Then restore the correct column set and re-run to confirm green again. A catch that cannot be made to fail this way is certifying nothing.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/teacher-rooms/route.ts tests/integration/teacher-rooms-api.test.ts
git commit -m "fix(teacher-rooms): a raced link answers DUPLICATE, not a code-less 409 (#161)"
```

---

### Task 2: `inviteContact` answers a raced invite with `ALREADY_INVITED`

**Files:**
- Modify: `src/services/invitations.ts:209-215`
- Test: `tests/integration/students-api.test.ts` (append a new `describe` at end of file)

**Interfaces:**
- Consumes: `isUniqueConflictOn` from `@/lib/unique-conflict`; the existing `InviteRefusal` union (`'ALREADY_INVITED' | 'ALREADY_LINKED' | 'DECLINED' | 'CONTACT_CHANGED'`) and `REFUSAL_MESSAGES` in the same module.
- Produces: no signature change. `inviteContact` already returns `{ ok: false; reason: InviteRefusal }`, and `POST /api/students:145-147` already maps that to `respondError(REFUSAL_MESSAGES[reason], 409, reason)`. The route needs no edit.

Background — why `ALREADY_INVITED` is exact rather than approximate: `:210` is the **only** `Invitation` INSERT in the module. Every other write to that table (`:274`, `:600`, `:640`, `:802`) is an `updateMany` against a row that already exists. So the row that won this race was inserted by another `inviteContact`, and `Invitation.status` is `@default(pending)` — exactly what `ALREADY_INVITED` names. `PUT /api/invitations/[id]:170` already answers this same code for this same constraint.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/students-api.test.ts`. **No import changes needed** — the file already imports `PrismaClient`, `BASE_URL`, `cookie`, `afterAll` and `uniqueSuffix`, and already binds `prisma`, `suffix`, `teacherId` and `teacherToken` at module scope, which is exactly what the snippet uses.

```ts
/**
 * `inviteContact`'s pre-check is a plain `findUnique` on
 * `Invitation @@unique([teacherId, email])`, so a concurrent invite of the
 * same address passes it and one of the two loses on the create at
 * `services/invitations.ts:210`. Unhandled, that `P2002` reaches
 * `withErrorHandler` and answers 409 with NO `code` — so the CRM cannot tell
 * "already invited" from any other conflict (#161).
 *
 * `ALREADY_INVITED` is the exact answer, not an approximation: `:210` is the
 * only `Invitation` INSERT in that module (every other write is an
 * `updateMany` on a row that already exists), so the row that won was
 * inserted by another `inviteContact` and carries the schema default
 * `pending`. See the spec for that census.
 */
describe('POST /api/students answers a raced invite with ALREADY_INVITED (#161)', () => {
  const raceEmail = `race-invite-${suffix}@test.local`;

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { email: raceEmail } });
  });

  it('returns 409 ALREADY_INVITED when the create loses to a concurrent invite', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.invitation.create({
          data: { teacherId, email: raceEmail, firstName: 'Holder', lastName: 'Invite' },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Race', lastName: 'Invite', email: raceEmail }),
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('ALREADY_INVITED');
    expect(body.error.message).toBe(
      'You have already invited this person — remove the contact to invite them again.',
    );

    // One invitation, and it is the holder's.
    const rows = await prisma.invitation.findMany({ where: { email: raceEmail } });
    expect(rows.map((r) => r.firstName)).toEqual(['Holder']);
  });
});
```

- [ ] **Step 2: Warm the route, then run the test to verify it fails**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/students
npx vitest run --project integration tests/integration/students-api.test.ts -t "raced invite"
```

Expected: FAIL. `body.error.code` is `undefined`; the message is `'Resource already exists'`.

- [ ] **Step 3: Add the catch in the service**

In `src/services/invitations.ts`, add to the imports:

```ts
import { isUniqueConflictOn } from '@/lib/unique-conflict';
```

(`Prisma` and `log` — check whether the module already imports them; add only what is missing.)

Replace lines 209-215 (the `else` branch holding the `create`) with:

```ts
  } else {
    // The `findUnique` at the top of this function is a plain read, so a
    // concurrent invite of the same address passes it and one of the two
    // loses here. `ALREADY_INVITED` is exact rather than a best guess: this
    // is the only `Invitation` INSERT in this module — every other write to
    // that table is an `updateMany` against a row that already exists — so
    // the row that won was inserted by another `inviteContact` and carries
    // the schema default `pending`, which is what this refusal names. Were
    // any other writer able to INSERT, the winner could be a `declined`
    // tombstone and this answer would be wrong.
    //
    // `PUT /api/invitations/[id]` already answers this same code for this
    // same constraint.
    try {
      const created = await db.invitation.create({
        data: { teacherId, email, firstName, lastName },
        select: { id: true },
      });
      invitationId = created.id;
    } catch (err) {
      if (isUniqueConflictOn(err, ['teacherId', 'email'])) {
        return { ok: false, reason: 'ALREADY_INVITED' };
      }
      // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
      // code-less 409, which is the defect this catch exists to remove.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        log.error(
          { err, rawTarget: err.meta?.target },
          'invitation create hit a unique constraint that is not the (teacher, email) key',
        );
        throw new Error('invitation create: unrecognised unique constraint');
      }
      throw err;
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project integration tests/integration/students-api.test.ts
```

Expected: PASS, whole file green.

- [ ] **Step 5: Prove the guard bites — mutate, record, restore**

Change the column set to the neighbouring table's key, which is the plausible drift (`TeacherBlock` declares the identical `@@unique([teacherId, email])`, so a copy-paste between them would not look wrong):

```ts
      if (isUniqueConflictOn(err, ['teacherId'])) {
```

Re-run Step 4's command, record the exact failure text, restore, re-run green.

- [ ] **Step 6: Commit**

```bash
git add src/services/invitations.ts tests/integration/students-api.test.ts
git commit -m "fix(invitations): a raced invite answers ALREADY_INVITED, not a code-less 409 (#161)"
```

---

### Task 3: `POST /api/teachers` keeps `EMAIL_TAKEN` and `SLUG_TAKEN` apart under a race

**Files:**
- Modify: `src/app/api/teachers/route.ts:41-54`
- Test: `tests/integration/teachers-api.test.ts` (append a new `describe` at end of file)

**Interfaces:**
- Consumes: `isUniqueConflictOn` from `@/lib/unique-conflict`; `freshIp()` from `tests/helpers.ts`.
- Produces: nothing later tasks depend on.

Background — **three** reachable unique keys, where #161 names two. `teacher.create` writes `Teacher` with a nested `account: { create: { email } }`:

| Key | `meta.target` |
|---|---|
| `Account.email @unique` | `['email']` |
| `Teacher.email @unique` | `['email']` |
| `Teacher.pageSlug @unique` | `['pageSlug']` |

The first two are indistinguishable by column set and that is correct — they mean the same thing to the caller, and the schema's own header comment records that they cannot disagree (*"Profile email columns are denormalized copies set at link time … there is deliberately no email-change flow"*). `Teacher.accountId @unique` cannot collide; the nested create mints a fresh account.

This is the window where the missing code has a cost beyond copy: the settings form renders an inline error against the offending field, so a code-less 409 tells the teacher something is taken without saying which.

- [ ] **Step 1: Write the two failing tests**

Append to `tests/integration/teachers-api.test.ts`. It already imports `PrismaClient`, `BASE_URL`, `uniqueSuffix` and `seedSession`, and binds `prisma`, `suffix` and `teacherId` at module scope. **One import must be added** — `freshIp` is not currently imported here:

```ts
import { BASE_URL, cookie, uniqueSuffix, seedSession, freshIp } from '../helpers';
```

```ts
/**
 * Both pre-checks at `:31` and `:36` are plain reads, so a concurrent signup
 * passes them and loses on the create. Unhandled, either collision answers
 * 409 with NO `code`, collapsing `EMAIL_TAKEN` and `SLUG_TAKEN` into one
 * indistinguishable response — and the settings form points at a field it
 * can no longer identify (#161).
 *
 * Three unique keys are reachable here, not two: `Account.email` and
 * `Teacher.email` both report `meta.target` `['email']`, and one predicate
 * covers both because they mean the same thing to the caller. See the spec.
 *
 * A fresh IP per request — this route is rate-limited to 3/hour per IP.
 */
describe('POST /api/teachers keeps its conflict codes apart under a race (#161)', () => {
  const raceEmail = `race-teacher-${suffix}@test.local`;
  const raceSlug = `race-slug-${suffix}`;
  const holderSlugEmail = `race-holder-${suffix}@test.local`;

  afterAll(async () => {
    await prisma.teacher.deleteMany({
      where: { email: { in: [raceEmail, holderSlugEmail] } },
    });
    await prisma.account.deleteMany({
      where: { email: { in: [raceEmail, holderSlugEmail] } },
    });
  });

  const signup = (body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/api/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify(body),
    });

  it('returns 409 EMAIL_TAKEN when the create loses on the email key', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.account.create({ data: { email: raceEmail } });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = signup({
      firstName: 'Race',
      lastName: 'Email',
      email: raceEmail,
      pageSlug: `race-email-slug-${suffix}`,
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('EMAIL_TAKEN');
    expect(body.error.message).toBe('Email already in use');
  });

  it('returns 409 SLUG_TAKEN when the create loses on the page slug key', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    // A whole Teacher, not a bare row: `Teacher.accountId` is non-null, so the
    // holder must mint its own account. Its email differs from the request's,
    // so `pageSlug` is the only key the request can lose on.
    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.teacher.create({
          data: {
            firstName: 'Holder',
            lastName: 'Slug',
            email: holderSlugEmail,
            pageSlug: raceSlug,
            defaultCurrency: 'EUR',
            defaultTimezone: 'Europe/Amsterdam',
            account: { create: { email: holderSlugEmail } },
          },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = signup({
      firstName: 'Race',
      lastName: 'Slug',
      email: `race-slug-req-${suffix}@test.local`,
      pageSlug: raceSlug,
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('SLUG_TAKEN');
    expect(body.error.message).toBe('Page slug already in use');
  });
});
```

Extend the `afterAll` cleanup to also remove `race-slug-req-${suffix}@test.local` from both tables.

- [ ] **Step 2: Warm the route, then run the tests to verify they fail**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/teachers
npx vitest run --project integration tests/integration/teachers-api.test.ts -t "under a race"
```

Expected: both FAIL with `code` `undefined` and message `'Resource already exists'`.

- [ ] **Step 3: Add the catch**

In `src/app/api/teachers/route.ts`, add to the imports:

```ts
import { Prisma } from '@prisma/client';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
```

Replace lines 41-54 with:

```ts
  // Both pre-checks above are plain reads, so a concurrent signup passes them
  // and loses here. Answering with the pre-check's own code is what keeps the
  // two paths indistinguishable — and it matters more here than elsewhere:
  // the settings form renders an inline error against the offending field, so
  // a code-less 409 says something is taken without saying which (#161).
  //
  // Three keys are reachable. `Account.email` and `Teacher.email` both report
  // `['email']` and are deliberately not told apart: they mean the same thing
  // to the caller, and the `Account` model's header comment records that they
  // cannot disagree — the profile email is a denormalized copy set at link
  // time and there is no email-change flow. `Teacher.accountId` cannot
  // collide; the nested create mints a fresh account.
  try {
    const teacher = await prisma.teacher.create({
      data: {
        firstName,
        lastName,
        email,
        bio,
        pageSlug,
        defaultCurrency: 'EUR',
        defaultTimezone: 'Europe/Amsterdam',
        account: { create: { email } },
      },
    });
    return respondOk(teacher, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['email'])) {
      return respondError('Email already in use', 409, 'EMAIL_TAKEN');
    }
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // code-less 409, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher signup hit a unique constraint that is neither the email nor the slug key',
      );
      throw new Error('teacher signup: unrecognised unique constraint');
    }
    throw err;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project integration tests/integration/teachers-api.test.ts
```

Expected: PASS, whole file green.

- [ ] **Step 5: Prove both guards bite — mutate, record, restore, one at a time**

Two guards, two mutations, recorded separately. Swap the two column sets so each predicate matches the other's key:

```ts
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      return respondError('Email already in use', 409, 'EMAIL_TAKEN');
    }
    if (isUniqueConflictOn(err, ['email'])) {
      return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
    }
```

This is the realistic regression — two adjacent branches with transposed keys — and it must redden **both** tests, each reporting the other's code. Record both failure texts. Restore and re-run green.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/teachers/route.ts tests/integration/teachers-api.test.ts
git commit -m "fix(teachers): a raced signup still says which field collided (#161)"
```

---

### Task 4: `POST /api/account/student-profile` answers a raced join with `ALREADY_STUDENT`

**Files:**
- Modify: `src/app/api/account/student-profile/route.ts:47-65`
- Test: `tests/integration/account-api.test.ts` (append a new `describe` at end of file)

**Interfaces:**
- Consumes: `isUniqueConflictOn` from `@/lib/unique-conflict`.
- Produces: nothing later tasks depend on.

Background — **catch both `['accountId']` and `['email']`.** A double-tap writes the same `accountId` *and* the same `email`, so both unique keys collide and Postgres reports whichever index it reaches first. Catching one would be a guard that passes its test and fails in production. Which target actually arrives is to be **measured in Step 5**, not assumed.

This is **not** an account-existence oracle. The route sits behind `requireSession`, reads `email` off the caller's own account row, and writes for the caller's own `accountId`. There are exactly two `student.create` sites in `src/` (this one and `auth/student-signup:44`), and signup's `if (!existingAccount && !existingStudent)` guard cannot fire for an address whose account exists. `Account.email @unique` means no *other* account holds this address, so no *foreign* `Student` row can be the one that collided. The disclosed fact is always about the caller's own account. `auth/student-signup` differs **because it is unauthenticated** — that is why its answer is a 200 and this one's is a coded 409.

- [ ] **Step 1: Write the failing test**

This needs an account with a **teacher** profile and **no** student profile, and no unclaimed CRM row for its address — the existing `account-api.test.ts` fixture claims its student row, so build a separate one. Append:

```ts
/**
 * `session.studentId` is the pre-check, so two concurrent "join as a student"
 * requests both read a session with no student profile, both find no
 * unclaimed row to claim, and both reach the create; the loser collides.
 * Unhandled, that `P2002` answers 409 with NO `code`, so the client cannot
 * tell it apart from any other conflict (#161).
 *
 * BOTH keys are caught, and this test is what says why. The holder writes the
 * caller's own `accountId` AND the caller's own `email`, so
 * `Student_accountId_key` and `Student_email_key` both have a pending entry
 * and Postgres reports whichever it reaches first. Which one that is, is
 * recorded in the PR body from an observed run — not assumed here.
 *
 * Not an enumeration oracle: this route is authenticated and writes for the
 * caller's own account, and `Account.email @unique` means no other account
 * can hold this address. See the spec.
 */
describe('POST /api/account/student-profile answers a raced join with ALREADY_STUDENT (#161)', () => {
  const raceEmail = `race-join-${suffix}@test.local`;
  let raceAccountId: string;
  let raceToken: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Race',
        lastName: 'Join',
        email: raceEmail,
        pageSlug: `race-join-${suffix}`,
        defaultCurrency: 'EUR',
        defaultTimezone: 'Europe/Amsterdam',
        account: { create: { email: raceEmail } },
      },
      select: { id: true, accountId: true },
    });
    raceAccountId = teacher.accountId;
    raceToken = await seedSession(prisma, raceAccountId);
  });

  afterAll(async () => {
    await prisma.student.deleteMany({ where: { email: raceEmail } });
    await prisma.teacher.deleteMany({ where: { email: raceEmail } });
    await prisma.account.deleteMany({ where: { email: raceEmail } });
  });

  it('returns 409 ALREADY_STUDENT when the create loses to a concurrent join', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        // The caller's own accountId and email — exactly what a second tap of
        // the same button writes, so both unique keys are contended.
        await tx.student.create({
          data: {
            firstName: 'Holder',
            lastName: 'Join',
            email: raceEmail,
            claimedAt: new Date(),
            accountId: raceAccountId,
          },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: cookie(raceToken),
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('ALREADY_STUDENT');
    expect(body.error.message).toBe('Account already has a student profile');

    // One student row, and it is the holder's.
    const rows = await prisma.student.findMany({ where: { email: raceEmail } });
    expect(rows.map((r) => r.firstName)).toEqual(['Holder']);
  });
});
```

**No import changes needed** — `account-api.test.ts` already imports `PrismaClient`, `BASE_URL`, `cookie`, `uniqueSuffix` and `seedSession`, and binds `prisma` and `suffix` at module scope. Note this block deliberately builds its **own** account rather than reusing the file's `accountId`/`rawToken`: that fixture's student row gets claimed by an earlier test, so it could never reach the `create` branch.

- [ ] **Step 2: Warm the route, then run the test to verify it fails**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/account/student-profile
npx vitest run --project integration tests/integration/account-api.test.ts -t "raced join"
```

Expected: FAIL. `body.error.code` is `undefined`; the message is `'Resource already exists'`.

- [ ] **Step 3: Add the catch**

In `src/app/api/account/student-profile/route.ts`, add to the imports:

```ts
import { Prisma } from '@prisma/client';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
```

Wrap the `create` branch. Replace lines 47-65 (the `unclaimed ? update : create` expression and the `respondOk`) with:

```ts
  // Scalar accountId, not a relation connect: Prisma splits nested
  // connects into two statements, and the claim/link CHECK constraint
  // requires both fields to change in one.
  if (unclaimed) {
    const student = await prisma.student.update({
      where: { id: unclaimed.id },
      data: { claimedAt: new Date(), accountId: session.accountId },
      select: { id: true },
    });
    return respondOk({ studentId: student.id }, 201);
  }

  // `session.studentId` above is the pre-check, and it is a plain read, so a
  // second tap of this button passes it and one of the two loses here.
  // Answering with the pre-check's own code keeps the two paths
  // indistinguishable to the client (#161).
  //
  // BOTH keys, because a double-tap writes the same `accountId` AND the same
  // `email`, so both indexes have a pending entry and Postgres reports
  // whichever it reaches first. Catching one would pass its test and fail
  // roughly half the time in production.
  //
  // Naming the collision is not an enumeration oracle, and the reason is that
  // this route is authenticated: it writes for the caller's own account, and
  // `Account.email @unique` means no other account holds this address, so no
  // foreign row can be the one that collided. `auth/student-signup` answers a
  // uniform 200 for the opposite reason — it is unauthenticated, so its 409
  // would tell a stranger an address was free.
  try {
    const student = await prisma.student.create({
      data: {
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        email: account.email,
        incomeTier: DEFAULT_INCOME_TIER,
        claimedAt: new Date(),
        accountId: session.accountId,
      },
      select: { id: true },
    });
    return respondOk({ studentId: student.id }, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['accountId']) || isUniqueConflictOn(err, ['email'])) {
      return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // code-less 409, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'student profile create hit a unique constraint that is neither the account nor the email key',
      );
      throw new Error('student profile create: unrecognised unique constraint');
    }
    throw err;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project integration tests/integration/account-api.test.ts
```

Expected: PASS, whole file green.

- [ ] **Step 5: MEASURE which key actually fires, then prove the guard bites**

This step produces a fact for the PR body, not just a pass. Temporarily replace the whole `catch` body's first branch with a logging probe that records the observed target and still answers correctly:

```ts
    if (isUniqueConflictOn(err, ['accountId']) || isUniqueConflictOn(err, ['email'])) {
      log.warn({ observedTarget: (err as Prisma.PrismaClientKnownRequestError).meta?.target },
        'MEASUREMENT: student-profile race target');
      return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
    }
```

Re-run Step 4's command and read the dev server's output for the `MEASUREMENT` line. **Record the observed `meta.target` verbatim in the task report** — it goes in the PR body.

Then mutate: narrow the predicate to the **other** key than the one just observed (if `['accountId']` was observed, keep only `['email']`, and vice versa). Re-run — the test must redden with `code` `undefined`. Record that failure text. Finally remove the probe, restore both branches, and re-run green.

Keeping both branches is deliberate even though only one fires today: which index Postgres reaches first is not a guarantee it publishes, and the comment says so.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/account/student-profile/route.ts tests/integration/account-api.test.ts
git commit -m "fix(account): a raced student-profile join answers ALREADY_STUDENT (#161)"
```

---

### Task 5: Replace the stale cross-file count on the `P2002` fallback branch

**Run this task last** — its replacement wording is only honest once Tasks 1–4 have closed the windows the current comment counts.

**Files:**
- Modify: `src/lib/api-errors.ts:498-503`

**Interfaces:** none — comment-only. No behaviour changes; `classifyApiError`'s `P2002` branch keeps its status, message, level and detail exactly.

The comment currently reads:

> Reaching this branch means a route's own check-then-create lost its race —
> **at least four routes have that window today** — or a route never
> pre-checked at all. Both are worth knowing about; neither is an outage,
> which is why this is `warn` and not `error`. `meta.target` names the
> constraint — without it the log says something already existed but not
> what, which is the same gap one level in.

That is a prose count, in a comment, about routes in other files. CLAUDE.md's *Comment Discipline* forbids it: a claim reaching past its own file has no owner, because the person who invalidates it never sees it. This branch is where that count is read and where nothing can keep it honest — and Tasks 1–4 falsify it.

- [ ] **Step 1: Replace the comment**

Replace it — do not annotate it. What it used to say belongs in the PR body, not beside the code.

```ts
  // Reaching this branch means a `create` raised a P2002 that its own caller
  // did not recognise: a route that never pre-checked, or a catch whose
  // column set has fallen behind its constraint. Both are worth knowing
  // about; neither is an outage, which is why this is `warn` and not `error`.
  // `meta.target` names the constraint — without it the log says something
  // already existed but not what, which is the same gap one level in.
  //
  // No count of such routes here: a number about other files has no owner,
  // and the edit that falsifies it happens where nobody is reading this.
```

- [ ] **Step 2: Verify nothing else asserts the old count**

```bash
grep -rn "at least four routes\|four routes have that window" src tests docs .github
```

Expected: no hits after the edit. Give any hit a verdict — a stale twin in a test docblock or a doc is the failure mode this project keeps hitting.

- [ ] **Step 3: Confirm the branch's behaviour is untouched**

```bash
npx vitest run src/lib/api-errors.test.ts src/lib/api-utils.test.ts
```

Expected: PASS. A comment-only edit must not move a single assertion; if anything reddens, the edit went further than intended.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api-errors.ts
git commit -m "docs(api-errors): state the invariant instead of counting routes in other files (#161)"
```

---

## Whole-branch gate (after Task 5)

- [ ] **Full verify**

```bash
npm run verify
```

`verify` runs typecheck, lint, and every vitest project, and needs the app live on `:3000`. Green `verify` is the whole integration suite — record the project-by-project arithmetic for the PR body.

- [ ] **Confirm the acceptance signal**

#161's stated completion signal is that `withErrorHandler`'s `warn` for an escaped `P2002` no longer fires from any of these routes. The four race tests each assert a coded 409, which can only come from the route's own catch — the fallback has no `code` to give. Note in the PR body that this is the mechanism by which the signal is observed.

- [ ] **Correct issue #161 itself**

A falsified claim gets corrected in *every* artifact, and the GitHub issue is one — anyone starting from it designs on a table where two of five rows point at deleted or already-fixed code. Two parts:

1. **Comment on #161** with the measured verdicts (the spec's first table), preserving the audit trail of what was checked and when.
2. **Edit the issue body** so the stale table cannot mislead the next reader: mark row 3 gone (#166 retired the unclaimed student), row 5 already fixed (commit `0fb73461`), row 2 as a different constraint in a different module, and add the sixth window the "floor" missed.

Post both from a `--body-file`, never `--body "…"` — backticks in a double-quoted shell string reach zsh as command substitution even escaped, and fail *silently*.

- [ ] **Whole-branch review, one fix wave, one scoped re-review** — the plan has five tasks, so this pass is required. Its purpose is cross-task blindness: a task reviewer sees only its own diff and cannot see the four catches drifting apart in shape, wording, or log-message convention.
