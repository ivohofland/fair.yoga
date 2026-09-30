# Announcements: custom-selection audience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can announce to a hand-picked subset of their students, and any resend of the same message within two minutes notifies only students not yet told.

**Architecture:** `Announcement` gains `audienceStudentIds String[]` (the ids actually notified). `sendAnnouncement` subtracts the ids of recent same-`(teacherId, message)` rows from its recipients under the existing advisory lock, for every audience. The route gains a `studentIds` branch (selected ∩ the all-students audience) and a `GET /api/announcements/audience` picker feed; the composer on `/students` gains an audience step.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Zod, Vitest (unit / components / integration), React client components.

**Spec:** `docs/superpowers/specs/2026-09-30-announcement-custom-audience-design.md` (issue #48). Read it first; §2 holds the decisions, §3 the design.

## Global Constraints

- TypeScript `strict: true`; no `any`, no implicit types.
- Test-first: every task writes the failing test, sees it fail, then implements.
- Services are framework-agnostic: `src/services/` takes typed inputs, returns typed outputs, imports no HTTP/Next.
- Migrations: hand-author and apply with `pnpm exec prisma migrate deploy` (an agent shell cannot answer `migrate dev`'s prompts); never edit an applied migration, comments included.
- Dedupe window stays `ANNOUNCEMENT_DEDUPE_WINDOW_MS` = 2 minutes; the SHA-256 stays confined to `lockAnnouncementSlot` (mutual exclusion only; the compare reads real ids).
- Comment Discipline (CLAUDE.md): a comment annotates the code it sits on; no counts or rosters in prose; comments state what is true now.
- Design: no motion, no badges, no gamification; cursor pointer is global CSS.
- Stage exact paths; never `git add -A`/`.`; quote paths containing `(teacher)`.
- Post `gh` prose from `--body-file`. Never write the auto-close keywords before `#48` in a commit or PR body; write "**#48** is ..." instead.
- Muted students (`receiveComms=false`) are listed in the picker and dropped at send, never hidden (spec §3).
- An id outside the audience is dropped silently and indistinguishably (no oracle), never a 4xx.

## Review Focus

1. **Foreign-teacher id in `studentIds`** — expected: no `Notification` row for that student, ever; the request behaves as if the id were absent (Task 3).
2. **Superset resend** (`{A,B}` then `{A,B,C,D}` inside the window) — expected: only C and D are notified, response says 2 already had it (Task 2, 3).
3. **Class send, then all-students send, same message** — expected: class registrants not told twice (Task 2).
4. **Stale picker row** (student archived or fully cancelled between load and send) — expected: dropped, send still succeeds for the rest, count tells the truth (Task 3).
5. **Duplicate ids inside `studentIds`, or the same student listed twice in `recipients`** — expected: one notification (Task 1, 2).

---

### Task 1: Column, migration, and request schema

**Files:**
- Modify: `prisma/schema.prisma` (model `Announcement`, ~line 1101)
- Create: `prisma/migrations/20260930120000_announcement_audience_student_ids/migration.sql`
- Modify: `src/lib/schemas.ts:610-613`
- Modify: `src/lib/schemas.test.ts` (new describe block; existing sweeps must stay green)
- Modify: `docs/data-model.md` (Announcement table, ~line 792)

**Interfaces:**
- Consumes: nothing.
- Produces: `Announcement.audienceStudentIds: string[]` (Prisma type); `MAX_CUSTOM_AUDIENCE = 500` exported from `src/lib/schemas.ts`; `createAnnouncementSchema` body type `{ classId?: string; studentIds?: string[]; message: string }`, where `classId` and `studentIds` together fail validation.

- [ ] **Step 1: Write the failing schema tests** — append to `src/lib/schemas.test.ts`:

```ts
describe('createAnnouncementSchema audience (#48)', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('accepts a class audience, a custom audience, and neither', () => {
    expect(createAnnouncementSchema.safeParse({ message: 'hi' }).success).toBe(true);
    expect(createAnnouncementSchema.safeParse({ message: 'hi', classId: id(1) }).success).toBe(true);
    expect(createAnnouncementSchema.safeParse({ message: 'hi', studentIds: [id(2)] }).success).toBe(true);
  });

  it('refuses a body naming two audiences', () => {
    const r = createAnnouncementSchema.safeParse({ message: 'hi', classId: id(1), studentIds: [id(2)] });
    expect(r.success).toBe(false);
  });

  it('refuses an empty list and a list past MAX_CUSTOM_AUDIENCE', () => {
    expect(createAnnouncementSchema.safeParse({ message: 'hi', studentIds: [] }).success).toBe(false);
    const over = Array.from({ length: MAX_CUSTOM_AUDIENCE + 1 }, (_, i) => id(i));
    expect(createAnnouncementSchema.safeParse({ message: 'hi', studentIds: over }).success).toBe(false);
    const atCap = over.slice(0, MAX_CUSTOM_AUDIENCE);
    expect(createAnnouncementSchema.safeParse({ message: 'hi', studentIds: atCap }).success).toBe(true);
  });

  it('refuses a non-uuid entry', () => {
    expect(createAnnouncementSchema.safeParse({ message: 'hi', studentIds: ['nope'] }).success).toBe(false);
  });
});
```
Add `MAX_CUSTOM_AUDIENCE` to that file's existing `@/lib/schemas` import.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts -t "audience"`
Expected: FAIL (`MAX_CUSTOM_AUDIENCE` is not exported / `studentIds` accepted as unknown key).

- [ ] **Step 3: Implement schema** — in `src/lib/schemas.ts` replace `createAnnouncementSchema`:

```ts
/** One request's fan-out ceiling for a hand-picked audience. */
export const MAX_CUSTOM_AUDIENCE = 500;

export const createAnnouncementSchema = z
  .object({
    classId: z.string().uuid().optional(),
    studentIds: z.array(z.string().uuid()).min(1).max(MAX_CUSTOM_AUDIENCE).optional(),
    message: z.string().trim().min(1),
  })
  .refine((body) => !(body.classId !== undefined && body.studentIds !== undefined), {
    message: 'Name one audience: a class or a list of students, not both.',
    path: ['studentIds'],
  });
```
One `.refine` and no `.transform`: `schemas.test.ts`'s sweep reads a single effects layer's `shape`; a second layer would push this schema into its "bare" list. Normalising (sort, unique) happens in the route.

- [ ] **Step 4: Add the column and migration.** In `prisma/schema.prisma`, `Announcement`:

```prisma
  audienceStudentIds String[] @default([])
```
Create `prisma/migrations/20260930120000_announcement_audience_student_ids/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "audienceStudentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
```
Run `pnpm exec prisma migrate deploy && pnpm exec prisma generate`, then `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code`.
Expected: deploy applies one migration; diff exits 0 (no drift). If diff prints SQL, fix the migration *before* committing (it is unapplied in any shared environment).

- [ ] **Step 5: Run tests** — `pnpm exec vitest run --project unit src/lib/schemas.test.ts`. Expected: PASS, including the existing unbounded-string sweep and the `createAnnouncementSchema.message` reach pin.

- [ ] **Step 6: Mutation proof.** Delete the `.refine(...)` call; expect "refuses a body naming two audiences" to FAIL; restore. Change `.max(MAX_CUSTOM_AUDIENCE)` to `.max(MAX_CUSTOM_AUDIENCE + 1)`; expect the cap test to FAIL; restore. Record both failure messages for the PR. Commit *before* mutating (a `git checkout` restore eats uncommitted sibling edits); end with `git status` clean.

- [ ] **Step 7: Doc.** `docs/data-model.md` Announcement table: add row `audience_student_ids | text[], default {} | Students actually notified by this send (sorted). What per-recipient dedupe reads; removed on student erasure`. Replace the "class_id" note ("Null = broadcast to all teacher's students") so it does not claim to name the audience alone, and add one sentence under the table: a custom audience is a selection from the all-students audience, never wider.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260930120000_announcement_audience_student_ids/migration.sql src/lib/schemas.ts src/lib/schemas.test.ts docs/data-model.md
git commit -m "feat: Announcement.audienceStudentIds and the studentIds request field (#48)"
```

---

### Task 2: Per-recipient dedupe in `sendAnnouncement`

**Files:**
- Modify: `src/services/announcements.ts`
- Test: `src/services/announcements.test.ts`

**Interfaces:**
- Consumes: `Announcement.audienceStudentIds` (Task 1).
- Produces:
  - `SendAnnouncementResult = { announcement: Announcement; deduped: boolean; alreadyNotified: number }` — `alreadyNotified` is how many of the requested recipients were already told; `deduped` is true only when that is all of them.
  - `listAnnouncementAudience(db: PrismaClient, teacherId: string): Promise<string[]>` — student ids of the all-students audience, **before** the opt-out subtraction. Used by Task 3.
  - `SendAnnouncementInput` is unchanged; the stored audience is derived from `recipients`.
  - `lockAnnouncementSlot` slot shape becomes `{ teacherId: string; message: string }`.

- [ ] **Step 1: Rewrite the tests that encode the old key.** In `src/services/announcements.test.ts` these assert `classId` is part of the dedupe identity and now assert the opposite by design (spec §2.2): `'does not deduplicate when classId differs'`, `'does not let an all-students announcement (classId null) dedupe against a class-scoped one'`, and the lock-key test `'does not make a send wait on a slot differing in any one field (lock-key composition)'` (drop `classId` from the fields it varies; it keeps `teacherId` and `message`). Replace the first two with the failing tests below; keep the existing helper for building `CreateNotificationInput[]` (extract a local `to(ids, message, classId)` helper if none exists).

```ts
it('a superset resend notifies only the students not yet told', async () => {
  const message = `Superset ${suffix}`;
  const first = await sendAnnouncement(prisma, {
    teacherId, classId: null, message, recipients: to([student1Id], message, null),
  });
  expect(first.deduped).toBe(false);

  const second = await sendAnnouncement(prisma, {
    teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null),
  });
  expect(second.deduped).toBe(false);
  expect(second.alreadyNotified).toBe(1);
  expect(second.announcement.recipientCount).toBe(1);
  expect(second.announcement.audienceStudentIds).toEqual([student2Id]);

  const rows = await prisma.notification.findMany({ where: { type: 'announcement', body: message } });
  expect(rows.map((r) => r.recipientId).sort()).toEqual([student1Id, student2Id].sort());
});

it('an identical resend tells nobody new and reports deduped', async () => {
  const message = `Identical ${suffix}`;
  await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null) });
  const again = await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id], message, null) });
  expect(again.deduped).toBe(true);
  expect(again.alreadyNotified).toBe(1);
  const rows = await prisma.notification.findMany({ where: { type: 'announcement', body: message } });
  expect(rows).toHaveLength(2);
});

it('a class send then an all-students send does not tell the registrants twice', async () => {
  const message = `Class then all ${suffix}`;
  await sendAnnouncement(prisma, { teacherId, classId: class1Id, message, recipients: to([student1Id], message, class1Id) });
  const all = await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null) });
  expect(all.alreadyNotified).toBe(1);
  const rows = await prisma.notification.findMany({ where: { type: 'announcement', body: message, recipientId: student1Id } });
  expect(rows).toHaveLength(1);
});

it('lists one student once when recipients repeats them', async () => {
  const message = `Repeated ${suffix}`;
  const r = await sendAnnouncement(prisma, {
    teacherId, classId: null, message, recipients: to([student1Id, student1Id], message, null),
  });
  expect(r.announcement.recipientCount).toBe(1);
  expect(r.announcement.audienceStudentIds).toEqual([student1Id]);
});
```
The existing `'sends a genuinely later identical announcement once window has elapsed'` test must stay green unchanged (it backdates `sentAt`; an out-of-window row must not count as "told").

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project unit src/services/announcements.test.ts`
Expected: the four new tests FAIL (`alreadyNotified` undefined / second send re-notifies); the rewritten lock-key test fails or passes vacuously — check it fails before step 3.

- [ ] **Step 3: Implement.** In `src/services/announcements.ts`:

1. `lockAnnouncementSlot(tx, slot: { teacherId: string; message: string })`, key `` `${slot.teacherId}|${slot.message}` ``. Rewrite its docblock paragraph about the tuple so it says the key and the `findMany` predicate in `sendAnnouncement` describe the same two columns (it currently says "exactly these three columns" and names `classId`). Rewrite the paragraph listing which statements take `FOR KEY SHARE` only if it named the key's columns; the `Class` lock-order reasoning is unchanged because a class-scoped send still inserts rows carrying `classId`.
2. `SendAnnouncementResult` gains `alreadyNotified: number`.
3. Replace the body of the transaction:

```ts
const result = await db.$transaction(async (tx) => {
  await lockAnnouncementSlot(tx, { teacherId, message });

  const recent = await tx.announcement.findMany({
    where: {
      teacherId,
      message,
      sentAt: { gte: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS) },
    },
    orderBy: { sentAt: 'desc' },
  });
  const told = new Set(recent.flatMap((a) => a.audienceStudentIds));

  const wanted = [...new Map(recipients.map((r) => [r.recipientId, r])).values()];
  const fresh = wanted.filter((r) => !told.has(r.recipientId));
  const alreadyNotified = wanted.length - fresh.length;

  const latest = recent[0];
  if (fresh.length === 0 && latest) {
    return { announcement: latest, deduped: true, alreadyNotified };
  }

  const count = await createBulkNotifications(tx, fresh);
  const created = await tx.announcement.create({
    data: {
      teacherId,
      classId,
      message,
      recipientCount: count,
      audienceStudentIds: fresh.map((r) => r.recipientId).sort(),
    },
  });
  return { announcement: created, deduped: false, alreadyNotified };
});
```
(`fresh.length === 0` with no `latest` cannot happen — `told` is empty then, so `fresh` equals `wanted`, which the zero-recipient guard above guarantees is non-empty.) Update the function docblock and the file header docblock to say dedupe is per recipient and keyed on `(teacherId, message)`; delete the paragraph explaining the `classId: undefined` Prisma trap — it described a predicate that no longer exists.

4. Add, above `sendAnnouncement`:

```ts
/**
 * Student ids of the all-students audience: everyone with a live registration
 * in one of this teacher's classes, minus students this teacher has archived.
 * Before the opt-out subtraction, which belongs to the caller that knows
 * whether it is listing for a picker (muted students stay visible there).
 */
export async function listAnnouncementAudience(
  db: PrismaClient,
  teacherId: string,
): Promise<string[]> {
  const registrations = await db.registration.findMany({
    where: {
      class: { calendarEntry: { teacherId } },
      status: { not: 'cancelled' },
      student: { teacherStudents: { none: { teacherId, isArchived: true } } },
    },
    select: { studentId: true },
    distinct: ['studentId'],
  });
  return registrations.map((r) => r.studentId);
}
```

- [ ] **Step 4: Run tests** — `pnpm exec vitest run --project unit src/services/announcements.test.ts`. Expected: all PASS (incl. the concurrency test `'serialises concurrent sends with the same slot…'`, which must still resolve to exactly one create and one dedupe).

- [ ] **Step 5: Mutation proofs** (commit first; record failure text; end `git status` clean):
  - Change `!told.has(r.recipientId)` to `true` → superset test FAILS (second send re-notifies student 1).
  - Re-add `classId` to the `findMany` `where` → "class send then all-students" FAILS.
  - Remove `message` from the lock key only (not the predicate) → the rewritten lock-key test FAILS. This proves key/predicate coupling is pinned.

- [ ] **Step 6: Sweep for what this invalidated.** `grep -rnE "classId, message|class, message|three columns|same three|\(teacher, class" src docs tests` — every hit gets a verdict; `docs/lock-order.md` (~lines 557-568, 1786-1809) and `db-locks.ts:64` describe the key and must be made true now.

- [ ] **Step 7: Commit**

```bash
git add src/services/announcements.ts src/services/announcements.test.ts docs/lock-order.md src/lib/db-locks.ts
git commit -m "feat: announcement dedupe is per recipient, keyed on teacher and message (#48)"
```
(Stage only files that actually changed.)

---

### Task 3: Route — custom branch, `alreadyNotified`, audience endpoint

**Files:**
- Modify: `src/app/api/announcements/route.ts`
- Create: `src/app/api/announcements/audience/route.ts`
- Modify: `src/services/announcements.ts` (add `listAnnouncementAudienceStudents`)
- Test: `tests/integration/announcements-api.test.ts`

**Interfaces:**
- Consumes: `listAnnouncementAudience`, `sendAnnouncement` (Task 2), `createAnnouncementSchema` / `MAX_CUSTOM_AUDIENCE` (Task 1).
- Produces:
  - `listAnnouncementAudienceStudents(db: PrismaClient, teacherId: string): Promise<{ id: string; displayName: string }[]>` — audience members (muted included) with the teacher-visible name, sorted by `displayName`.
  - `POST /api/announcements` body accepts `studentIds`; response data gains `alreadyNotified: number`.
  - `GET /api/announcements/audience` → `{ data: { students: { id: string; displayName: string }[] } }`, `requireTeacher`.

- [ ] **Step 1: Write the failing integration tests** in `tests/integration/announcements-api.test.ts`. Reuse its fixtures (`s1Id` booked unmuted, `s2Id` muted, `s3Id` cancelled-only, `otherTeacherId`, `sendAnnouncement(body)` helper). Add to the `beforeAll` a fourth student `s4Id` booked in `class2Id` (unmuted) and a `foreignStudentId` booked only with `otherTeacherId`'s class; add both to the `afterAll` cleanups and to `announcementNotifications`' recipient list. Then:

```ts
describe('custom audience (#48)', () => {
  it('notifies exactly the selected, eligible, unmuted students', async () => {
    const res = await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom A' });
    expect(res.status).toBe(201);
    expect((await res.json()).data.recipientCount).toBe(2);
    const rows = await announcementNotifications({ body: 'Custom A' });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([s1Id, s4Id].sort());
    expect(rows[0]!.relatedClassId).toBeNull();
  });

  it("never notifies another teacher's student, and answers as if the id were absent", async () => {
    const res = await sendAnnouncement({ studentIds: [s1Id, foreignStudentId], message: 'Custom B' });
    expect(res.status).toBe(201);
    expect((await res.json()).data.recipientCount).toBe(1);
    const foreign = await prisma.notification.findMany({ where: { recipientId: foreignStudentId, body: 'Custom B' } });
    expect(foreign).toHaveLength(0);
  });

  it('answers a foreign id and an unknown id identically', async () => {
    const unknown = '00000000-0000-4000-8000-00000000dead';
    const a = await sendAnnouncement({ studentIds: [foreignStudentId], message: 'Custom C' });
    const b = await sendAnnouncement({ studentIds: [unknown], message: 'Custom C' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(await a.json()).toEqual(await b.json());
  });

  it('drops muted and cancelled-only students, 400 when nothing remains', async () => {
    const res = await sendAnnouncement({ studentIds: [s2Id, s3Id], message: 'Custom D' });
    expect(res.status).toBe(400);
    expect(await prisma.announcement.count({ where: { teacherId, message: 'Custom D' } })).toBe(0);
  });

  it('drops an archived student', async () => {
    await prisma.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId, studentId: s4Id } },
      create: { teacherId, studentId: s4Id, isArchived: true },
      update: { isArchived: true },
    });
    try {
      const res = await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom E' });
      expect((await res.json()).data.recipientCount).toBe(1);
    } finally {
      await prisma.teacherStudent.deleteMany({ where: { teacherId, studentId: s4Id } });
    }
  });

  it('refuses a class and a list together', async () => {
    const res = await sendAnnouncement({ classId: class1Id, studentIds: [s1Id], message: 'Custom F' });
    expect(res.status).toBe(400);
  });

  it('tells only the additions when the list grows inside the window', async () => {
    await sendAnnouncement({ studentIds: [s1Id], message: 'Custom G' });
    const res = await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom G' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1);
    expect(data.alreadyNotified).toBe(1);
    const rows = await announcementNotifications({ body: 'Custom G' });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([s1Id, s4Id].sort());
  });

  it('collapses duplicate ids in the list to one notification', async () => {
    await sendAnnouncement({ studentIds: [s1Id, s1Id], message: 'Custom H' });
    expect(await announcementNotifications({ body: 'Custom H' })).toHaveLength(1);
  });
});

describe('GET /api/announcements/audience (#48)', () => {
  async function getAudience(token = teacherToken) {
    return fetch(`${BASE_URL}/api/announcements/audience`, { headers: cookie(token) });
  }

  it('lists the audience including muted students, excluding cancelled-only and foreign ones', async () => {
    const res = await getAudience();
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.students.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([s1Id, s2Id, s4Id]));
    expect(ids).not.toContain(s3Id);
    expect(ids).not.toContain(foreignStudentId);
  });

  it('shows first name plus initial unless the student shares their full name', async () => {
    const res = await getAudience();
    const s1 = (await res.json()).data.students.find((s: { id: string }) => s.id === s1Id);
    expect(s1.displayName).not.toContain('Student'); // surname withheld by default
  });

  it('401 without a session', async () => {
    const res = await fetch(`${BASE_URL}/api/announcements/audience`);
    expect(res.status).toBe(401);
  });
});
```
Fixture names: adjust the last-name assertion to whatever `makeStudent` sets (`lastName: 'Student'`); the point is the withheld surname.

Also rewrite `'does not let an all-students announcement match a class-scoped one'` (~line 346): under per-recipient dedupe the class send's registrants are not re-notified by a same-message all-students send. Assert that instead.

- [ ] **Step 2: Warm the routes, run, verify failure**

Run (with the worktree app up, `pnpm run worktree:up`): `curl -s -o /dev/null http://localhost:3000/api/announcements/audience`, then `pnpm exec vitest run --project integration tests/integration/announcements-api.test.ts`
Expected: the new tests FAIL (Zod strips `studentIds` today, so the send goes to everyone; the audience route 404s).

- [ ] **Step 3: Implement.** In `src/services/announcements.ts` add:

```ts
export async function listAnnouncementAudienceStudents(
  db: PrismaClient,
  teacherId: string,
): Promise<{ id: string; displayName: string }[]> {
  const ids = await listAnnouncementAudience(db, teacherId);
  const students = await db.student.findMany({
    where: { id: { in: ids } },
    select: studentNameSelect(teacherId),
  });
  return students
    .map((s) => ({ id: s.id, displayName: teacherVisibleName(s, teacherId) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
```
importing `studentNameSelect` and `teacherVisibleName` from `@/lib/student-visibility`.

Create `src/app/api/announcements/audience/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { listAnnouncementAudienceStudents } from '@/services/announcements';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  const students = await listAnnouncementAudienceStudents(prisma, session.teacherId);
  return respondOk({ students });
});
```

In `src/app/api/announcements/route.ts`: replace the inline all-students query with `studentIds = await listAnnouncementAudience(prisma, session.teacherId)`; add the custom branch between the class branch and the else:

```ts
} else if (body.studentIds) {
  // Gate 4: the client names students, so each must be proven to be in this
  // teacher's audience. An id outside it — another teacher's student, an
  // archived one, a stale picker row, a made-up uuid — is dropped without
  // saying which, so the answer is no oracle on who exists or is linked elsewhere.
  const audience = new Set(await listAnnouncementAudience(prisma, session.teacherId));
  studentIds = [...new Set(body.studentIds)].filter((id) => audience.has(id));
}
```
Ordering becomes `if (body.classId) … else if (body.studentIds) … else …`. The opt-out subtraction and the `400 No students to notify` stay after all three. Return `alreadyNotified` from the result: `respondOk({ ...announcement, duplicateSuppressed: deduped, alreadyNotified }, deduped ? 200 : 201)` (destructure it from `sendAnnouncement`). Update the trailing comment block so it mentions `alreadyNotified` only as the count the client can report.

- [ ] **Step 4: Run tests** — `pnpm exec vitest run --project integration tests/integration/announcements-api.test.ts`. Expected: all PASS, including the untouched concurrency tests (~line 230).

- [ ] **Step 5: Mutation proofs** (commit first; clean at the end):
  - Replace `filter((id) => audience.has(id))` with `filter(() => true)` → "never notifies another teacher's student" FAILS (foreign student gets a row). This is the gate-4 guard.
  - In `listAnnouncementAudience`, drop the `status: { not: 'cancelled' }` line → the audience-endpoint test excluding `s3Id` FAILS.
  - In the audience service, return `id`/`firstName lastName` raw instead of `teacherVisibleName` → the surname test FAILS.
  - Warm the route with `curl` after each mutation before judging RED/GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/announcements/route.ts src/app/api/announcements/audience/route.ts src/services/announcements.ts tests/integration/announcements-api.test.ts
git commit -m "feat: announce to a selected subset of the audience (#48)"
```

---

### Task 4: Student erasure scrubs the audience array

**Files:**
- Modify: `src/services/gdpr.ts` (`deleteStudentAccount`, inside its transaction)
- Test: the erasure test file that covers `deleteStudentAccount` (find it: `grep -l deleteStudentAccount src/services/*.test.ts`)
- Modify: `docs/lock-order.md` (only if the census finds a new node)

**Interfaces:**
- Consumes: `Announcement.audienceStudentIds` (Task 1).
- Produces: after `deleteStudentAccount(db, studentId)` resolves, no `Announcement` row's `audienceStudentIds` contains `studentId`.

- [ ] **Step 1: Write the failing test** next to the existing erasure tests, following that file's fixture style:

```ts
it('removes the erased student from every announcement audience', async () => {
  const keep = await createStudent();            // the file's existing fixture helper
  const gone = await createStudent();
  const a = await prisma.announcement.create({
    data: { teacherId, message: `erase ${suffix}`, recipientCount: 2, audienceStudentIds: [gone.id, keep.id].sort() },
  });
  await deleteStudentAccount(prisma, gone.id);
  const after = await prisma.announcement.findUniqueOrThrow({ where: { id: a.id } });
  expect(after.audienceStudentIds).toEqual([keep.id]);
  expect(after.recipientCount).toBe(2); // a snapshot of what was sent, not a live count
});
```
Use whatever teacher/student fixture builders that file already has.

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run --project unit <that file> -t "announcement audience"`. Expected: FAIL (`audienceStudentIds` still contains the erased id).

- [ ] **Step 3: Lock census before writing.** Read `docs/lock-order.md`'s section on the `Student` row in erasure and the announcement advisory-lock section. Answer, in the PR body, for **every mode**: (a) does `sendAnnouncement` ever lock an existing `Announcement` row? (it reads without `FOR UPDATE` and only inserts), so the erasure's `UPDATE` row locks cannot form a cycle with it; (b) does the `UPDATE` wait on anything a send holds? (an insert of a *new* row; no); (c) the residual: a send committing *after* the erasure scrub can write the erased id into a new row's array — the send's audience query reads `Registration`, which the erasure deletes, so the window is a send that read before and commits after; state it as accepted (opaque uuid of a deleted person, expires from use within the dedupe window) in `docs/lock-order.md` if a new node is added, else in the PR body. Do not write the statement until this is answered.

- [ ] **Step 4: Implement** — inside the `db.$transaction` in `deleteStudentAccount`, after the student-scoped cleanup that precedes the final `student` delete and before any statement that depends on it:

```ts
await tx.$executeRaw`
  UPDATE "Announcement"
  SET "audienceStudentIds" = array_remove("audienceStudentIds", ${studentId})
  WHERE "audienceStudentIds" @> ARRAY[${studentId}]::text[]`;
```
Match the surrounding comment style; the comment says what the statement is for (the array holds another person's id), not its history. The `@>` filter keeps the statement from rewriting unrelated rows.

- [ ] **Step 5: Run tests** — the test above plus the existing erasure lock-order tests (`gdpr-lock-order.test.ts` and siblings): `pnpm exec vitest run --project unit src/services/gdpr`. Expected: PASS.

- [ ] **Step 6: Mutation proof** — delete the `WHERE` clause's `@>` condition and change it to `WHERE true`: the test still passes (the scrub is idempotent), so instead mutate the assignment to `= "audienceStudentIds"`; the test must FAIL. Record it. Restore; `git status` clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr.ts <the erasure test file> docs/lock-order.md
git commit -m "feat: erasing a student removes them from announcement audiences (#48)"
```

---

### Task 5: Composer audience step and picker

**Files:**
- Create: `src/components/class/audience-picker.tsx`
- Create: `src/components/class/audience-picker.test.tsx`
- Modify: `src/components/class/send-announcement.tsx`
- Modify: `src/components/class/send-announcement.test.tsx`
- Modify: `docs/teacher-screens.md` (§8.3 one line on eligibility)

**Interfaces:**
- Consumes: `GET /api/announcements/audience`, `POST /api/announcements` with `studentIds`, response field `alreadyNotified` (Task 3).
- Produces: `AudiencePicker({ selected: string[]; onChange: (ids: string[]) => void })`; `SendAnnouncement` renders an "Everyone / Choose students" choice only when `classId` is absent.

- [ ] **Step 1: Write the failing picker tests** (`audience-picker.test.tsx`). Stub `fetch` per test, as `send-announcement.test.tsx` does (the components project mocks nothing else):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AudiencePicker } from './audience-picker';

function stubAudience(students: { id: string; displayName: string }[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { students } }) }));
}
const STUDENTS = [
  { id: 'a', displayName: 'Anna K.' },
  { id: 'b', displayName: 'Ben L.' },
  { id: 'c', displayName: 'Cleo M.' },
];
afterEach(() => vi.unstubAllGlobals());

describe('AudiencePicker', () => {
  it('lists the audience and reports a ticked student', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={[]} onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Anna K.'));
    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('filters by name without changing the selection', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={['a']} onChange={onChange} />);
    await screen.findByLabelText('Anna K.');
    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'ben' } });
    expect(screen.queryByLabelText('Anna K.')).toBeNull();
    expect(screen.getByLabelText('Ben L.')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects all shown students and clears', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={[]} onChange={onChange} />);
    fireEvent.click(await screen.findByText('Select all'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('says so when the fetch fails instead of showing an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<AudiencePicker selected={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
```
Add composer tests to `send-announcement.test.tsx`: without `classId`, choosing "Choose students" and ticking one student POSTs `{ message, studentIds: [id] }` and no `classId`; Send is disabled with zero ticked; the confirmation reads `Sent to 1 student (2 already had it)` when the response has `alreadyNotified: 2` and `recipientCount: 1`; with `classId` set, no audience choice renders.

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run --project components src/components/class`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `audience-picker.tsx`** (client component). Behaviour contract: on mount `fetch('/api/announcements/audience')`; on non-ok or throw, render `<p role="alert">` with "Could not load your students. Try again." and call `logRequestFailure('audience-picker', {}, err)` for throws (same helper `student-directory.tsx` uses); a `type="search"` input labelled "Search students" filtering `displayName` case-insensitively on the client; each student is `<label><input type="checkbox" checked={…} onChange={…}/> {displayName}</label>` in a list with rows ≥ 56px tall; "Select all" (adds every *shown* student to `selected`) and "Clear" (empties it) as `type-label text-teal` buttons; a caption "N selected". No motion, no badges; reuse the `Input` component for search if its label prop matches, else a plain input with the same classes.

- [ ] **Step 4: Modify `send-announcement.tsx`.** State: `audience: 'all' | 'chosen'` (default `'all'`), `chosen: string[]`. Render the choice (two radio inputs, "Everyone" / "Choose students") only when `!classId`. When `'chosen'`, render `<AudiencePicker selected={chosen} onChange={setChosen} />`, disable Send while `chosen.length === 0`, and change the textarea label to `Announcement to ${chosen.length} selected`. Body: `{ message, ...(classId ? { classId } : {}), ...(audience === 'chosen' ? { studentIds: chosen } : {}) }`. Extend the parsed response with `alreadyNotified?: number` and the `SentState` with `alreadyNotified: number`; the confirmation becomes `Sent to N students` plus ` (M already had it)` when `M > 0`. Extend `recipientExplanation` for `'chosen'`: "Only the students you tick, and only those who have booked with you and haven't muted your messages. Anyone who already got this exact message in the last two minutes is skipped." Reset `audience`/`chosen` in the `Send another` handler only if the message resets; keep the ticked students so a teacher can add a few and resend (the scenario the dedupe exists for).

- [ ] **Step 5: Run tests** — `pnpm exec vitest run --project components src/components/class`. Expected: PASS.

- [ ] **Step 6: Mutation proofs** (commit first; clean at the end):
  - Make the POST body always include `classId` when `audience === 'chosen'` → "POSTs studentIds and no classId" FAILS.
  - Drop the `chosen.length === 0` disable → "Send is disabled" FAILS.
  - Filter search on the `id` instead of `displayName` → the search test FAILS.

- [ ] **Step 7: Drive it in the running app** (the `verify` skill has the recipe): sign in as a seeded teacher, open `/students`, choose students, tick two, send; check the inbox of one of them; resend with a third ticked and confirm only the third gains a notification. Judge spacing at 100% (measure the DOM if zoomed). Record what you saw; if the dev server is not yours to touch, use the worktree app.

- [ ] **Step 8: Doc + commit.** `docs/teacher-screens.md` §8.3, after the audience bullet: "Custom selection draws from the same students as 'all students' (a live booking, not archived); it never reaches further." Then:

```bash
git add src/components/class/audience-picker.tsx src/components/class/audience-picker.test.tsx src/components/class/send-announcement.tsx src/components/class/send-announcement.test.tsx docs/teacher-screens.md
git commit -m "feat: choose the students an announcement goes to (#48)"
```

---

### Task 6: Whole-branch verification and PR

**Files:** none new.

- [ ] **Step 1:** `pnpm run verify` (the app live; in a worktree run `pnpm run worktree:up` first). Expected: green. State the arithmetic in the PR body (`N = unit + components + integration`), and name by path the integration files this branch touched: `tests/integration/announcements-api.test.ts`.
- [ ] **Step 2:** `pnpm run build` (CI runs it; `verify` does not) and `pnpm exec prisma validate`.
- [ ] **Step 3:** Sweep what this invalidated, per the diff, not a keyword: list the names/phrases removed (`classId` in the dedupe key, "three columns", the `classId: undefined` trap paragraph) and grep each across `src docs tests .claude`; give every hit a verdict.
- [ ] **Step 4:** Whole-branch review on the most capable model (plan has 5 tasks), one fix wave, one scoped re-review; then push and open the PR with a `--body-file` that records: the premise corrections (picker cannot reuse `/api/students`; dedupe must learn the audience), the measured arithmetic, every mutation with its failure text, that **#48** is the issue this PR implements, and what is *not* done (saved groups, never-booked contacts, a longer window). Run `/pr-review-toolkit:review-pr <N>`; aggregate; rebase-merge (never squash); then `gh issue view 48 --json state`.

---

## Self-review

- **Spec coverage:** §2.1 eligibility (Task 3 intersection); §2.2 per-recipient dedupe, lock key, classId leaving the key (Task 2); §2.3 picker (Task 5); §3 schema/cap/refine (Task 1), audience resolution + gate 4 + endpoint (Task 3), service + `alreadyNotified` (Task 2), storage note (Task 1 doc), GDPR + lock census (Task 4), UI (Task 5); §4 tests distributed per task; §5 docs in Tasks 1, 2, 5.
- **Placeholder scan:** none; the two "find the file" steps give the command that finds it.
- **Type consistency:** `audienceStudentIds`, `alreadyNotified`, `listAnnouncementAudience`, `listAnnouncementAudienceStudents`, `MAX_CUSTOM_AUDIENCE`, `AudiencePicker` are spelled identically in every task that names them.
- **Task order is load-bearing:** 1 → 2 → 3 (3 needs 2's exports and 1's schema); 4 needs only 1; 5 needs 3's endpoints.
