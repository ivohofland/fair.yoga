# Room Archive Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `TeacherRoom.isArchived` downstream meaning — a room may not be archived while in use, and an archived room accepts no new commitments.

**Architecture:** One new framework-agnostic service (`src/services/room-archive.ts`) owns the "is this room in use?" question and the archive write; the existing PATCH route becomes a thin wrapper over it. Three further doors (publish a draft, resume a paused template, create a template) each gain a room-archived refusal inside the service or route that already reads the relevant row. Two pickers filter archived rooms client-side as feedback, not enforcement.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-18-room-archive-lifecycle-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. Non-negotiable.
- **Services are framework-agnostic.** `src/services/room-archive.ts` takes typed inputs, returns typed outputs. No HTTP concerns, no `next/*` imports.
- **No migration.** `TeacherRoom.isArchived` already exists (`prisma/schema.prisma:298`). Nothing about the schema changes in this branch.
- **`@/lib/log` is pino and server-only.** Do not import it into anything a `'use client'` component value-imports. Tasks 6 touch client components — keep them import-free of services.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it over HTTP.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `'src/app/(teacher)/...'`.
- **Commit per task.** The PR is rebase-merged; the commit-per-task history is the record.
- **Every task must leave the build green.** A type-union change and its exhaustive consumers land in the *same* commit.
- **Blocking predicate for classes:** status `open` or `in_progress`. **For templates:** `ACTIVE_TEMPLATE_WHERE` from `src/lib/template-selection.ts`, imported by both `room-archive.ts` and `class-generator.ts` so the two cannot diverge.
- **Test commands:** single file `npx vitest run --project <unit|integration|components> <path>`. Full gate `npm run verify` (typecheck + lint + all three projects). `verify` needs the app live on :3000.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/template-selection.ts` | **Create.** Import-free. Owns `ACTIVE_TEMPLATE_WHERE`, shared by the generator and the archive guard. | 1 |
| `src/services/class-generator.ts` | **Modify.** `:355` spreads the shared constant instead of inlining the literal. | 1 |
| `tests/room-fixtures.ts` | **Create.** Shared unit-test fixtures for both room test files. | 1 |
| `src/services/room-archive.ts` | **Create.** Owns the in-use predicate and the archive write. | 1 |
| `src/services/room-archive.test.ts` | **Create.** `unit` project. Door 1's full matrix + mutation records. | 1 |
| `src/app/api/teacher-rooms/[id]/route.ts` | **Modify.** PATCH becomes a thin wrapper (`:66-103`). | 2 |
| `tests/integration/teacher-rooms-api.test.ts` | **Modify.** HTTP shape of the 409 and the counted message. | 2 |
| `src/services/class-lifecycle.ts` | **Modify.** Door 2 at `:303`; `ROOM_ARCHIVED` added to the union at `:134`. | 3 |
| `src/app/api/classes/[id]/transition/route.ts` | **Modify.** `TRANSITION_FAILURE_RESPONSE` gains `ROOM_ARCHIVED`. | 3 |
| `src/services/class-template-lifecycle.ts` | **Modify.** Door 3 at `:727`; `room_archived` added to `PauseTemplateResult` at `:534`. | 4 |
| `src/app/api/class-templates/[id]/route.ts` | **Modify.** Reason chain gains `room_archived` (before the `never` guard, ~`:248`). | 4 |
| `src/app/api/class-templates/route.ts` | **Modify.** Door 4 at `:39-41`, on a row already read. | 5 |
| `src/app/(teacher)/class/new/page.tsx` | **Modify.** Filter archived from the picker (`:169`). | 6 |
| `src/components/settings/template-form.tsx` | **Modify.** Filter archived, retaining current selection (`:152`). | 6 |
| `src/components/settings/unlink-room-button.tsx` | **Modify.** Correct the false cascade copy (`:50`). | 7 |
| `src/app/api/rooms/[id]/route.ts` | **Modify.** Align the `hasClasses` refusal to the sibling (`:37-39`). | 7 |
| `tests/integration/rooms-api.test.ts` | **Modify.** Eight locations. See Task 7. | 7 |
| `src/app/(teacher)/settings/rooms/[id]/page.tsx` | **Modify.** `known-open` comment on the stale `classCount` gate (`:31`). | 7 |

---

### Task 1: The `room-archive` service and door 1

**Files:**
- Create: `src/lib/template-selection.ts` (import-free, shared constant)
- Create: `tests/room-fixtures.ts` (shared unit-test fixtures)
- Create: `src/services/room-archive.ts`
- Modify: `src/services/class-generator.ts:355` (consume the shared constant)
- Test: `src/services/room-archive.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type ArchiveRoomResult` — the discriminated union below.
  - `export type RoomBlockers = { classes: number; templates: number }`
  - `export async function setTeacherRoomArchived(db: PrismaClient, teacherRoomId: string, teacherId: string, target: 'archived' | 'unarchived'): Promise<ArchiveRoomResult>`
  - `export function describeRoomBlockers(blockers: RoomBlockers): string`
  - `export const BLOCKING_CLASS_STATUSES: readonly ClassStatus[]`
  - **`ACTIVE_TEMPLATE_WHERE` is NOT defined here.** It lives in the new import-free `src/lib/template-selection.ts` and is imported by BOTH `room-archive.ts` and `class-generator.ts`, so the two predicates cannot diverge — agreement is structural, not asserted.

Task 2 calls `setTeacherRoomArchived` and `describeRoomBlockers`. Task 3's test file imports the fixtures from `tests/room-fixtures.ts`. Task 8 pins `ACTIVE_TEMPLATE_WHERE`'s value.

- [ ] **Step 0: Create the two shared modules first**

Both exist so that agreement between the archive guard and the generator is
**structural rather than asserted**, and so the two room test files share one
fixture definition.

Create `src/lib/template-selection.ts` — **no imports of any kind**, matching
`src/lib/tiers.ts` and `src/lib/class-fields.ts`:

```ts
/**
 * Which recurring templates are live — i.e. which ones will actually put
 * classes on the calendar.
 *
 * Shared by `class-generator.ts` (which selects templates to run) and
 * `services/room-archive.ts` (which blocks archiving a room a template would
 * still generate into). Those two ask the SAME question, so they must not be
 * able to answer it differently: this constant is what makes divergence
 * impossible rather than merely detectable.
 *
 * IMPORT-FREE ON PURPOSE, like `lib/tiers.ts` and `lib/class-fields.ts`.
 * `class-generator.ts` value-imports `@/lib/log` (pino, server-only), so a
 * constant living there and imported by other modules would drag pino into
 * their graphs. Nothing here imports anything, so either side can take it.
 */
export const ACTIVE_TEMPLATE_WHERE = {
  isActive: true,
  isArchived: false,
} as const;
```

Then rewire `src/services/class-generator.ts:355` to consume it. Add the import
beside the existing ones at the top of that file, then replace the literal:

```ts
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';
```

```ts
  // The `isArchived: false` half is defense in depth — the routes keep
  // archived templates inactive — and it now comes from the shared constant
  // so `services/room-archive.ts` cannot block on a different set than this
  // query selects. See `lib/template-selection.ts`.
  const templates = await db.classTemplate.findMany({
    where: { ...ACTIVE_TEMPLATE_WHERE, ...(teacherId ? { teacherId } : {}) },
```

Preserve the existing explanatory comment above that query (`:350-353`) — do
not delete it; extend it as shown.

Run `npx vitest run --project unit src/services/class-generator.test.ts` and
`npx vitest run --project unit src/services/template-sync.test.ts`.
Expected: PASS, unchanged. This step is a pure refactor — if anything goes
red, the spread is not equivalent to the literal and must be fixed before
continuing.

Create `tests/room-fixtures.ts`. `src/**/*.test.ts` importing from `tests/` is
an established pattern here — `src/services/class-terminal-date.test.ts:5`
imports `'../../tests/migration-sql'`.

```ts
/**
 * Shared fixtures for the room-archive unit tests (issue 76).
 *
 * A FRESH teacher, room and link per case. Two partial unique indexes make
 * shared-teacher fixtures collide: `ClassTemplate_teacher_slot_unique` on
 * (teacherId, dayOfWeek, startTime) WHERE isArchived = false, and
 * `Class_teacher_slot_unique` on (teacherId, date, startTime) WHERE
 * status <> 'cancelled'. A fresh teacher per case sidesteps both.
 *
 * Each test file passes its own `prefix` so its afterAll sweep cannot delete
 * another file's rows.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

export type RoomFixture = { teacherId: string; roomId: string; linkId: string };
export type ClassFixtureStatus = 'draft' | 'open' | 'in_progress' | 'completed' | 'cancelled';

export function fixtureRun(prefix: string) {
  const suffix = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let seq = 0;

  async function makeFixture(db: PrismaClient): Promise<RoomFixture> {
    const tag = `${suffix}-${seq++}`;
    const teacher = await db.teacher.create({
      data: {
        firstName: 'Room',
        lastName: 'Fixture',
        email: `${tag}@test.local`,
        account: { create: { email: `${tag}@test.local` } },
        bio: 'room archive fixtures',
        pageSlug: tag,
      },
    });
    const room = await db.room.create({
      data: {
        venueName: `Venue ${tag}`,
        address: `${seq} Fixture Street`,
        city: 'Amsterdam',
        postcode: '1011AB',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    const link = await db.teacherRoom.create({
      data: {
        teacherId: teacher.id,
        roomId: room.id,
        capacityOverride: 15,
        rentalRate: new Prisma.Decimal(30),
      },
    });
    return { teacherId: teacher.id, roomId: room.id, linkId: link.id };
  }

  /** Always future-dated: a past date trips the STARTS_IN_PAST guard first. */
  async function addClass(db: PrismaClient, f: RoomFixture, status: ClassFixtureStatus) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + 14);
    return db.class.create({
      data: {
        teacherId: f.teacherId,
        teacherRoomId: f.linkId,
        classType: 'Vinyasa',
        date,
        startTime: `0${seq % 8}:30`,
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        status,
      },
    });
  }

  async function addTemplate(
    db: PrismaClient,
    f: RoomFixture,
    opts: { isActive: boolean; isArchived: boolean },
  ) {
    return db.classTemplate.create({
      data: {
        teacherId: f.teacherId,
        teacherRoomId: f.linkId,
        classType: 'Hatha',
        dayOfWeek: 2,
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        isActive: opts.isActive,
        isArchived: opts.isArchived,
      },
    });
  }

  /** Sweeps only rows created by THIS run's prefix. */
  async function cleanup(db: PrismaClient) {
    const mine = { teacher: { pageSlug: { startsWith: suffix } } };
    await db.class.deleteMany({ where: mine });
    await db.classTemplate.deleteMany({ where: mine });
    await db.teacherRoom.deleteMany({ where: mine });
    await db.room.deleteMany({ where: { createdBy: { pageSlug: { startsWith: suffix } } } });
    await db.teacher.deleteMany({ where: { pageSlug: { startsWith: suffix } } });
  }

  return { suffix, makeFixture, addClass, addTemplate, cleanup };
}
```

- [ ] **Step 1: Write the failing test file**

Create `src/services/room-archive.test.ts`. A **fresh teacher, room and link per case** — both `ClassTemplate_teacher_slot_unique` (teacherId, dayOfWeek, startTime WHERE `isArchived = false`) and `Class_teacher_slot_unique` (teacherId, date, startTime WHERE status <> 'cancelled') are partial unique indexes that will collide if fixtures share a teacher.

```ts
/**
 * Door 1 of the room archive lifecycle (issue 76).
 *
 * The guard is an OR of two independent predicates — a blocking class OR an
 * active template. A fixture that trips both at once certifies NEITHER: the
 * class clause short-circuits, so the template clause could be deleted
 * outright with this file green. Every case below therefore isolates one
 * clause and leaves the other empty. See the mutation record at the foot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { setTeacherRoomArchived, describeRoomBlockers } from './room-archive';

const prisma = new PrismaClient();
// `ra-` distinguishes this file's rows from `room-archive-doors.test.ts`'s,
// so each file's cleanup sweeps only its own.
const fx = fixtureRun('ra');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus) => fx.addClass(prisma, f, status);
const addTemplate = (f: RoomFixture, opts: { isActive: boolean; isArchived: boolean }) =>
  fx.addTemplate(prisma, f, opts);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('setTeacherRoomArchived — door 1, class clause (no template on any fixture)', () => {
  it.each(['open', 'in_progress'] as const)('refuses to archive a room with a %s class', async (status) => {
    const f = await makeFixture();
    await addClass(f, status);

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('in_use');
    if (result.reason !== 'in_use') throw new Error('unreachable');
    expect(result.blockers).toEqual({ classes: 1, templates: 0 });

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
  });

  it('archives a room whose only class is a draft', async () => {
    const f = await makeFixture();
    await addClass(f, 'draft');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived', isArchived: true });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(true);
  });

  // The issue's actual ask: history must stop blocking.
  it('archives a room whose classes are all completed or cancelled', async () => {
    const f = await makeFixture();
    await addClass(f, 'completed');
    await addClass(f, 'cancelled');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived', isArchived: true });
  });
});

describe('setTeacherRoomArchived — door 1, template clause (no blocking class on any fixture)', () => {
  it('refuses to archive a room with an active template', async () => {
    const f = await makeFixture();
    await addTemplate(f, { isActive: true, isArchived: false });

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('in_use');
    if (result.reason !== 'in_use') throw new Error('unreachable');
    expect(result.blockers).toEqual({ classes: 0, templates: 1 });

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
  });

  // Stops the clause being written as "any template exists", which would
  // re-block the room permanently and reintroduce issue 76 one layer up.
  it('archives a room whose only template is paused', async () => {
    const f = await makeFixture();
    await addTemplate(f, { isActive: false, isArchived: false });

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived' });
  });

  // `isActive: true` here, deliberately, not `false` like the paused case
  // above. Every real write pairs `isArchived: true` with `isActive: false`
  // (`class-template-lifecycle.ts:1053-1054`, `gdpr.ts:1139-1140`), so an
  // `isActive: false` fixture would already be excluded by the `isActive`
  // half of `ACTIVE_TEMPLATE_WHERE` and could never isolate the `isArchived`
  // half — dropping it from the constant would leave this case green. This
  // combination is the defense-in-depth state that clause exists to catch if
  // the pairing invariant ever slips (`class-generator.ts:351`).
  it('archives a room whose only template is archived', async () => {
    const f = await makeFixture();
    await addTemplate(f, { isActive: true, isArchived: true });

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived' });
  });
});

describe('setTeacherRoomArchived — ownership, idempotency, release valve', () => {
  it('reports not_found for an unknown link', async () => {
    const f = await makeFixture();
    const result = await setTeacherRoomArchived(
      prisma, '00000000-0000-0000-0000-000000000000', f.teacherId, 'archived',
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports forbidden for another teacher’s link', async () => {
    const mine = await makeFixture();
    const theirs = await makeFixture();
    const result = await setTeacherRoomArchived(prisma, theirs.linkId, mine.teacherId, 'archived');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  // Issue 98's rule: a retry after a lost response must not undo the first attempt.
  it('reports unchanged without writing when already in the target state', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
    const before = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });

    const again = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(again).toMatchObject({ ok: true, action: 'unchanged', isArchived: true });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  // Pins the ORDER of the two checks, which is not visible from either alone.
  // The already-in-state check sits BEFORE the in-use check, so an archived
  // room that has since acquired an open class — reachable through the
  // accepted race in spec section 8 — reports `unchanged` rather than
  // refusing on a state it is already in. Move the in-use check above it and
  // this case turns into an `in_use` refusal that no other test would catch.
  it('reports unchanged for an already-archived room that is now in use', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
    await addClass(f, 'open');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'unchanged', isArchived: true });
  });

  // The release valve. Every refusal above is recoverable only because of this.
  it('un-archives unconditionally, even while the room is in use', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
    await addClass(f, 'open');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'unarchived');

    expect(result).toMatchObject({ ok: true, action: 'unarchived', isArchived: false });
  });
});

describe('describeRoomBlockers', () => {
  it.each([
    [{ classes: 1, templates: 0 }, '1 upcoming class still uses this room.'],
    [{ classes: 2, templates: 0 }, '2 upcoming classes still use this room.'],
    [{ classes: 0, templates: 1 }, '1 recurring class still uses this room.'],
    [{ classes: 0, templates: 3 }, '3 recurring classes still use this room.'],
    [{ classes: 2, templates: 1 }, '2 upcoming classes and 1 recurring class still use this room.'],
  ])('renders %j', (blockers, expected) => {
    expect(describeRoomBlockers(blockers)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --project unit src/services/room-archive.test.ts`
Expected: FAIL — `Failed to resolve import "./room-archive"`.

- [ ] **Step 3: Write the service**

Create `src/services/room-archive.ts`:

```ts
import type { PrismaClient, ClassStatus } from '@prisma/client';
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';

/**
 * Whether a teacher's room link may be archived (issue 76).
 *
 * `TeacherRoom.isArchived` shipped in `e57b8bd` as a display flag: it decided
 * which of two list pages a row appeared on and nothing else read it. This
 * module is what gives it meaning — a room may not be archived while in use,
 * and (via the three doors in `class-lifecycle`, `class-template-lifecycle`
 * and `POST /api/class-templates`) an archived room accepts no new
 * commitments.
 *
 * Framework-agnostic per CLAUDE.md: no HTTP, no `next/*`. The route is a thin
 * wrapper.
 */

/**
 * Classes that block archiving. NOT the complement of
 * `TERMINAL_CLASS_STATUSES` — `draft` is non-terminal and deliberately does
 * not block. A draft is a parked intention with no registrations; it is
 * stopped at the publish door instead (`transitionClass`, reason
 * `ROOM_ARCHIVED`), which is where the room's availability actually matters.
 */
export const BLOCKING_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  ['open', 'in_progress'] as ClassStatus[],
);

// Templates that block archiving come from `ACTIVE_TEMPLATE_WHERE`
// (`lib/template-selection.ts`), imported above and shared with
// `class-generator.ts`. "Would this template put classes into this room?" is
// precisely the question the generator asks when selecting what to run, so
// the two must not be able to answer differently — sharing the constant makes
// divergence impossible rather than merely detectable.

export type RoomBlockers = { classes: number; templates: number };

export type ArchiveRoomResult =
  | { ok: true; action: 'archived' | 'unarchived' | 'unchanged'; isArchived: boolean }
  | { ok: false; reason: 'not_found' | 'forbidden' }
  | { ok: false; reason: 'in_use'; blockers: RoomBlockers };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The refusal names what blocks it rather than saying "in use", so the teacher
 * knows what to clear — the house style `DUPLICATE_ROOM` and `NOW_SHARED`
 * already follow in `src/app/api/rooms/[id]/route.ts`.
 */
export function describeRoomBlockers(blockers: RoomBlockers): string {
  const parts: string[] = [];
  if (blockers.classes > 0) parts.push(plural(blockers.classes, 'upcoming class', 'upcoming classes'));
  if (blockers.templates > 0) parts.push(plural(blockers.templates, 'recurring class', 'recurring classes'));
  const subject = parts.join(' and ');
  // "uses" only when a single thing is named; two clauses are always plural.
  const verb = parts.length === 1 && blockers.classes + blockers.templates === 1 ? 'uses' : 'use';
  return `${subject} still ${verb} this room.`;
}

export async function setTeacherRoomArchived(
  db: PrismaClient,
  teacherRoomId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveRoomResult> {
  const link = await db.teacherRoom.findUnique({ where: { id: teacherRoomId } });
  if (!link) return { ok: false, reason: 'not_found' };
  if (link.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = target === 'archived';

  // Before the in-use check, deliberately, and before any write. Issue 98: a
  // retry after a lost response must not undo what the first attempt did.
  // Placing it first also means an already-archived room in use (reachable via
  // the accepted race below) reports `unchanged` rather than a refusal about a
  // state it is already in.
  if (link.isArchived === archiving) {
    return { ok: true, action: 'unchanged', isArchived: link.isArchived };
  }

  // Un-archiving is unconditional. It is the release valve that makes every
  // refusal in this lifecycle recoverable in one action, so it must never
  // acquire a guard of its own.
  if (archiving) {
    const [classes, templates] = await Promise.all([
      db.class.count({
        where: { teacherRoomId, status: { in: [...BLOCKING_CLASS_STATUSES] } },
      }),
      db.classTemplate.count({ where: { teacherRoomId, ...ACTIVE_TEMPLATE_WHERE } }),
    ]);
    if (classes > 0 || templates > 0) {
      return { ok: false, reason: 'in_use', blockers: { classes, templates } };
    }
  }

  // KNOWN-OPEN, and deliberate (spec section 8). The counts above are read
  // before this write, so a class published in another tab in between leaves
  // an archived room holding an `open` class. Accepted rather than locked: the
  // publish guard two doors away already records the reasoning for this exact
  // class of check ("a policy about intent, not an invariant", see
  // class-lifecycle.ts:298-302), losing the race needs two tabs, and the state
  // is recoverable by un-archiving and self-heals when the class completes.
  // A transaction here would NOT help — under read-committed the counts lock
  // nothing — and the alternative is a new FOR UPDATE node in the ordering
  // that `template-lock-order.test.ts` exists to defend.
  await db.teacherRoom.update({
    where: { id: teacherRoomId },
    data: { isArchived: archiving },
  });

  return { ok: true, action: archiving ? 'archived' : 'unarchived', isArchived: archiving };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --project unit src/services/room-archive.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Prove the two clauses are independently load-bearing**

These are the mutations that matter. **Apply one at a time, record the exact failure output, then restore and re-run to confirm green again.**

| # | Mutation in `room-archive.ts` | Must go RED | Must stay GREEN |
|---|---|---|---|
| 1 | Delete the `db.classTemplate.count(...)` term; hard-code `templates = 0` | "refuses to archive a room with an active template" | every class-clause case |
| 2 | Delete the `db.class.count(...)` term; hard-code `classes = 0` | both `open`/`in_progress` cases | every template-clause case |
| 3 | Change `ACTIVE_TEMPLATE_WHERE` to `{ isActive: true }` only | "archives a room whose only template is archived" | the rest |
| 4 | Add `'draft'` to `BLOCKING_CLASS_STATUSES` | "archives a room whose only class is a draft" | the rest |
| 8 | Move the in-use check ABOVE the already-in-state check | "reports unchanged for an already-archived room that is now in use" | the rest |

Mutation 8 pins an ordering, not a predicate — it is the only one whose subject is *where* a check sits rather than what it tests. It is numbered 8 rather than 5 because mutations 5, 6 and 7 belong to Tasks 3, 4 and 5; the numbering is global across the plan so a fix-round dispatch can name one unambiguously.

If mutation 1 or 2 leaves the suite green, the fixtures are not isolating and the test file is wrong — fix the fixtures, not the service.

Record each mutation's exact error text in the commit message body.

- [ ] **Step 6: Commit**

```bash
git add src/lib/template-selection.ts tests/room-fixtures.ts src/services/room-archive.ts src/services/class-generator.ts src/services/room-archive.test.ts
git commit -m "feat: archiving a room refuses while the room is in use (issue 76)"
```

---

### Task 2: The PATCH route becomes a thin wrapper

**Files:**
- Modify: `src/app/api/teacher-rooms/[id]/route.ts:66-103` (the whole `PATCH` handler)
- Test: `tests/integration/teacher-rooms-api.test.ts`

**Interfaces:**
- Consumes: `setTeacherRoomArchived`, `describeRoomBlockers` from Task 1.
- Produces: `PATCH …?state=archived` answers **409** with code `ROOM_IN_USE` when in use. All existing responses are unchanged.

- [ ] **Step 1: Write the failing integration tests**

Append to the existing `describe('PATCH /api/teacher-rooms/[id]', …)` block in `tests/integration/teacher-rooms-api.test.ts`. The file already has `send`, `ownerToken`, `linkWithClassId` and `blockingClassId` in scope; `linkWithClassId`'s class is created in `beforeAll`.

First check what status `blockingClassId` carries — if it is not `open`, add a dedicated link. Then:

```ts
  // Issue 76. The room-archive lifecycle: a room in use cannot be shelved.
  it('refuses to archive a link that still carries an open class, and names what blocks it', async () => {
    const res = await send('PATCH', ownerToken, `${linkWithClassId}?state=archived`);
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('ROOM_IN_USE');
    expect(body.error.message).toBe('1 upcoming class still uses this room.');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkWithClassId } });
    expect(after.isArchived).toBe(false);
  });

  // The release valve, over HTTP. Un-archiving must never acquire a guard.
  it('un-archives a link that is in use', async () => {
    await prisma.teacherRoom.update({ where: { id: linkWithClassId }, data: { isArchived: true } });

    const res = await send('PATCH', ownerToken, `${linkWithClassId}?state=unarchived`);
    expect(res.status).toBe(200);

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkWithClassId } });
    expect(after.isArchived).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts`
Expected: FAIL — the archive returns 200 and `isArchived` becomes `true`.

If you see a wall of `ECONNREFUSED`, the app is not running on :3000. **Ask the user to start it. Do not start it yourself.**

- [ ] **Step 3: Rewrite the PATCH handler**

Replace the body of `PATCH` (currently `route.ts:66-103`) with:

```ts
export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = archiveStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of archived or unarchived is required', 400);
  }

  const result = await setTeacherRoomArchived(
    prisma, id, session.teacherId, parsed.data.state,
  );

  if (result.ok) {
    return respondOk({ isArchived: result.isArchived, action: result.action });
  }

  if (result.reason === 'not_found') return respondError('Teacher-room not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'in_use') {
    // 409, matching the sibling DELETE below: a conflict with current state,
    // not a malformed request.
    return respondError(describeRoomBlockers(result.blockers), 409, 'ROOM_IN_USE');
  }

  // Exhaustiveness: a new ArchiveRoomResult reason becomes a compile error
  // here rather than being silently answered with the wrong status. Same
  // discipline as `class-templates/[id]/route.ts`.
  const unhandled: never = result;
  return unhandled;
});
```

Add to the imports at the top of the file:

```ts
import { setTeacherRoomArchived, describeRoomBlockers } from '@/services/room-archive';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts`
Expected: PASS, including the four pre-existing PATCH cases at `:331-378` (missing state, unrecognised state, set-and-repeat, un-archive-and-repeat). **If any of those four go red, the wrapper changed observable behaviour it should not have.**

- [ ] **Step 5: Prove the exhaustiveness guard bites**

Delete the `if (result.reason === 'in_use')` branch. Run `npm run typecheck`. Expected: a type error on `const unhandled: never = result`. Restore.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/teacher-rooms/[id]/route.ts' tests/integration/teacher-rooms-api.test.ts
git commit -m "refactor: the archive route becomes a wrapper over room-archive (issue 76)"
```

---

### Task 3: Door 2 — publishing a draft into an archived room

**Files:**
- Modify: `src/services/class-lifecycle.ts:134-139` (the union) and `:303` (the publish block)
- Modify: `src/app/api/classes/[id]/transition/route.ts:44-56` (`TRANSITION_FAILURE_RESPONSE`)
- Test: `src/services/room-archive-doors.test.ts` (**create**)

**Interfaces:**
- Consumes: nothing from Task 1 (this door reads `isArchived` directly — it asks a different question, "is the room archived", not "is the room in use").
- Produces: `TransitionFailureReason` gains `'ROOM_ARCHIVED'`; the route answers 409 with code `ROOM_ARCHIVED`.

**Why the union changes first:** `TRANSITION_FAILURE_RESPONSE` is typed `Record<TransitionFailureReason, …>`, so adding the member makes the build fail at the table until it is mapped. Let the compiler enumerate the call sites rather than searching for them. Both edits land in this one commit so the tree is never red between commits.

- [ ] **Step 1: Write the failing test**

Create `src/services/room-archive-doors.test.ts`. Reuse the fixture helpers from Task 1 by copying them into this file (they are small, and cross-importing test files is not a pattern this repo uses).

```ts
/**
 * Doors 2 and 3 of the room archive lifecycle (issue 76): an archived room
 * accepts no new commitments. Door 1 lives in `room-archive.test.ts`; door 4
 * is an HTTP-level guard and is pinned in `tests/integration/`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { transitionClass } from './class-lifecycle';
import { pauseOrResumeTemplate } from './class-template-lifecycle';

const prisma = new PrismaClient();
// `rad-` distinguishes this file's rows from `room-archive.test.ts`'s,
// so each file's cleanup sweeps only its own.
const fx = fixtureRun('rad');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus) => fx.addClass(prisma, f, status);
const addTemplate = (f: RoomFixture, opts: { isActive: boolean; isArchived: boolean }) =>
  fx.addTemplate(prisma, f, opts);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('transitionClass — door 2: publishing into an archived room', () => {
  it('refuses to publish a draft whose room is archived', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'draft');
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ROOM_ARCHIVED');
    expect(result.error).toBe('This room is archived. Unarchive it to publish classes here.');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('draft');
  });

  it('publishes a draft whose room is not archived', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'draft');

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(true);
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('open');
  });
});
```

`addClass` must produce a **future** date, or the pre-existing `STARTS_IN_PAST` guard fires first and the second case fails for the wrong reason. The Task 1 helper already dates 14 days ahead — keep that.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/room-archive-doors.test.ts`
Expected: FAIL — the archived-room publish succeeds, `result.ok` is `true`.

- [ ] **Step 3: Add the reason to the union**

In `src/services/class-lifecycle.ts:134`:

```ts
export type TransitionFailureReason =
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_ENDED_YET'
  | 'CONCURRENT_MODIFICATION'
  | 'STARTS_IN_PAST'
  | 'ROOM_ARCHIVED';
```

- [ ] **Step 4: Run typecheck to let the compiler find the consumers**

Run: `npm run typecheck`
Expected: FAIL at `src/app/api/classes/[id]/transition/route.ts` — `Property 'ROOM_ARCHIVED' is missing in type …` on `TRANSITION_FAILURE_RESPONSE`.

This is the compile-time proof the door is wired. Note the exact error text for the commit message.

- [ ] **Step 5: Map the reason in the route table**

In `src/app/api/classes/[id]/transition/route.ts`, add to `TRANSITION_FAILURE_RESPONSE`:

```ts
  ROOM_ARCHIVED: { httpStatus: 409, code: 'ROOM_ARCHIVED' },
```

- [ ] **Step 6: Add the guard to the publish block**

Inside the existing `if (targetStatus === 'open')` block at `class-lifecycle.ts:303`, extend the `select` and add the check **before** the `startsInPast` check, so a draft that is both past-dated and in an archived room reports the room — the room is the condition the teacher can act on, and the past-start message is permanent.

```ts
    const cls = await db.class.findUnique({
      where: { id: classId },
      select: {
        status: true,
        date: true,
        startTime: true,
        teacherRoom: { select: { isArchived: true } },
        teacher: { select: { defaultTimezone: true } },
      },
    });

    // Door 2 of the room archive lifecycle (issue 76). An archived room
    // accepts no new commitments: a draft may SIT on an archived room —
    // it is a parked intention with no registrations, which is why door 1
    // lets a draft-only room be archived — but publishing it is the moment
    // the room's availability starts to matter.
    //
    // Before the past-start check deliberately. A draft that is both
    // past-dated and in an archived room gets told about the room, because
    // that is the condition the teacher can clear; `STARTS_IN_PAST` is
    // permanent and would end the conversation.
    if (
      cls &&
      sourceStatesFor(targetStatus).includes(cls.status) &&
      cls.teacherRoom.isArchived
    ) {
      return {
        ok: false,
        reason: 'ROOM_ARCHIVED',
        error: 'This room is archived. Unarchive it to publish classes here.',
      };
    }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project unit src/services/room-archive-doors.test.ts`
Expected: PASS.

Then: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: PASS — the pre-existing transition tests must be unaffected.

- [ ] **Step 8: Prove the guard bites (mutation 5)**

Change `cls.teacherRoom.isArchived` to `!cls.teacherRoom.isArchived`. Run the file. Expected: BOTH cases fail — the archived case now publishes, the un-archived case now refuses. Record the output, restore, re-run green.

- [ ] **Step 9: Commit**

```bash
git add src/services/class-lifecycle.ts 'src/app/api/classes/[id]/transition/route.ts' src/services/room-archive-doors.test.ts
git commit -m "feat: a draft cannot be published into an archived room (issue 76)"
```

---

### Task 4: Door 3 — resuming a paused template into an archived room

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:534` (`PauseTemplateResult`) and `:727` (the guard site)
- Modify: `src/app/api/class-templates/[id]/route.ts:~248` (the pause/resume reason chain, before the `never` guard)
- Test: `src/services/room-archive-doors.test.ts` (extend)

**Interfaces:**
- Consumes: the fixture helpers already in `room-archive-doors.test.ts` from Task 3.
- Produces: `PauseTemplateResult` gains `{ ok: false; reason: 'room_archived' }`; the route answers 409.

- [ ] **Step 1: Write the failing test**

Append to `src/services/room-archive-doors.test.ts`:

`pauseOrResumeTemplate` is already imported at the top of the file from Task 3;
do not add a second import.

```ts
describe('pauseOrResumeTemplate — door 3: resuming into an archived room', () => {
  it('refuses to resume a paused template whose room is archived', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'room_archived' });

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    expect(after.isActive).toBe(false);
    expect(await prisma.class.count({ where: { templateId: tpl.id } })).toBe(0);
  });

  // Pausing is the safe direction and must stay unguarded — otherwise a
  // teacher whose room is archived cannot even stop the template.
  it('still allows pausing a template whose room is archived', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: true, isArchived: false });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'paused');

    expect(result).toMatchObject({ ok: true, action: 'paused' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/room-archive-doors.test.ts`
Expected: FAIL — the resume succeeds and generates instances.

- [ ] **Step 3: Add the reason to `PauseTemplateResult`**

In `src/services/class-template-lifecycle.ts:534`, add to the union:

```ts
  | { ok: false; reason: 'room_archived' }
```

- [ ] **Step 4: Run typecheck to find the consumer**

Run: `npm run typecheck`
Expected: FAIL at `src/app/api/class-templates/[id]/route.ts` on `const unhandled: never = result` — `Type '{ ok: false; reason: "room_archived"; }' is not assignable to type 'never'`.

- [ ] **Step 5: Add the guard**

In `pauseOrResumeTemplate`, the read at `:704` must include the room. Extend its `include`:

```ts
  const template = await db.classTemplate.findUnique({
    where: { id: templateId },
    include: {
      teacher: { select: { defaultTimezone: true } },
      teacherRoom: { select: { isArchived: true } },
    },
  });
```

The function already drops the joined `teacher` before returning (`const { teacher: _t, ...bare } = template`) so `PauseTemplateResult` carries a plain `ClassTemplate`. **Drop `teacherRoom` the same way**, or the join leaks back to the caller:

```ts
  const { teacher: _t, teacherRoom: _tr, ...bare } = template;
  void _t;
  void _tr;
```

Then add the guard immediately after the existing `if (template.isArchived)` line at `:727`:

```ts
  if (template.isArchived) return { ok: false, reason: 'archived' };

  // Door 3 of the room archive lifecycle (issue 76). Symmetric with door 2:
  // a paused template may SIT on an archived room, but resuming it is the
  // moment new classes start being manufactured there. Without this, resume
  // succeeded silently and generated instances into the archived room inside
  // the transaction below.
  //
  // After the already-in-state check above, for the same reason that check
  // precedes the template-archived guard: `?state=paused` on a template that
  // is already paused is a no-op with nothing to refuse.
  if (template.teacherRoom.isArchived) return { ok: false, reason: 'room_archived' };
```

- [ ] **Step 6: Map the reason in the route**

In `src/app/api/class-templates/[id]/route.ts`, in the pause/resume reason chain, after the `archived` branch:

```ts
  if (result.reason === 'room_archived') {
    return respondError(
      'This room is archived. Unarchive it to resume this recurring class.',
      409,
      'ROOM_ARCHIVED',
    );
  }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project unit src/services/room-archive-doors.test.ts src/services/class-template-lifecycle.test.ts`
Expected: PASS both files.

- [ ] **Step 8: Prove the guard bites (mutation 6)**

Invert to `if (!template.teacherRoom.isArchived)`. Expected: the refuse case passes wrongly *and* many pre-existing `class-template-lifecycle.test.ts` resume cases go red. Record, restore, re-run green.

- [ ] **Step 9: Commit**

```bash
git add src/services/class-template-lifecycle.ts 'src/app/api/class-templates/[id]/route.ts' src/services/room-archive-doors.test.ts
git commit -m "feat: a paused template cannot be resumed into an archived room (issue 76)"
```

---

### Task 5: Door 4 — creating a template on an archived room

**Files:**
- Modify: `src/app/api/class-templates/route.ts:38-41`
- Test: `tests/integration/class-templates-api.test.ts` (extend; create the describe block if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `POST /api/class-templates` answers 409 `ROOM_ARCHIVED` when `teacherRoomId` names an archived link.

**Why this door exists:** `ClassTemplate.isActive` defaults `true` (`prisma/schema.prisma:336`), so a template created on an archived room begins generating immediately. There is no matching door for creating a *class*, because a class is always born `draft` (`src/app/api/classes/route.ts:80`) and door 2 catches it at publish.

- [ ] **Step 1: Write the failing test**

```ts
  it('refuses to create a template on an archived room', async () => {
    await prisma.teacherRoom.update({ where: { id: linkId }, data: { isArchived: true } });

    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({
        teacherRoomId: linkId,
        classType: 'Yin',
        dayOfWeek: 4,
        startTime: '20:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('ROOM_ARCHIVED');

    // A template born active on an archived room would generate into it at
    // once — nothing must have been written.
    expect(await prisma.classTemplate.count({ where: { teacherRoomId: linkId } })).toBe(0);

    await prisma.teacherRoom.update({ where: { id: linkId }, data: { isArchived: false } });
  });
```

Adapt the fixture variable names to whatever that file already defines.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: FAIL — 201/200 and a template row exists.

- [ ] **Step 3: Add the guard**

`src/app/api/class-templates/route.ts` already reads the link for ownership at `:39`. Add immediately after the ownership check at `:40-42`:

```ts
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return respondError('Invalid teacher room', 400);
  }

  // Door 4 of the room archive lifecycle (issue 76). Unlike a class — always
  // born `draft` and caught at the publish door — a template is born
  // `isActive: true` (schema.prisma:336) and starts generating immediately,
  // so creation is itself the commitment and there is no later door to catch.
  if (teacherRoom.isArchived) {
    return respondError(
      'This room is archived. Unarchive it to add a recurring class here.',
      409,
      'ROOM_ARCHIVED',
    );
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the guard bites (mutation 7)**

Delete the whole `if (teacherRoom.isArchived)` block. Expected: the new test fails on `expect(res.status).toBe(409)` receiving the create status. Record, restore.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/class-templates/route.ts tests/integration/class-templates-api.test.ts
git commit -m "feat: a recurring class cannot be created on an archived room (issue 76)"
```

---

### Task 6: The pickers stop offering archived rooms

**Files:**
- Modify: `src/app/(teacher)/class/new/page.tsx:169-183`
- Modify: `src/components/settings/template-form.tsx:150-165`
- Test: `src/components/settings/template-form.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing. `GET /api/teacher-rooms` is deliberately **unchanged** — it returns the teacher's rooms; *which are selectable* is UI policy, and narrowing the response would silently truncate the list for any future caller.
- Produces: no exported surface.

**This is feedback, not enforcement.** Doors 2 and 4 are what actually prevent commitments into an archived room. Do not add a server guard for draft-class creation — a parked draft is deliberately permitted.

- [ ] **Step 1: Write the failing component test**

`TemplateForm` runs in both `create` and `edit` mode (`src/app/(teacher)/settings/recurring/[id]/page.tsx:34`), so in `edit` mode the **currently-selected** room must stay in the list even when archived — otherwise editing a paused template on an archived room silently loses its room.

Per `vitest.config.ts`, the `components` project does **not** mock `fetch`; stub it in the test.

```ts
  it('omits archived rooms from the picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teacher-rooms') {
        return new Response(JSON.stringify({ data: [
          { id: 'tr-live', isArchived: false, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Live Venue', roomName: 'Studio A' } },
          { id: 'tr-archived', isArchived: true, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Archived Venue', roomName: 'Studio B' } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    render(<TemplateForm mode="create" />);

    expect(await screen.findByRole('option', { name: /Live Venue/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Archived Venue/ })).not.toBeInTheDocument();
  });

  // Editing a paused template on an archived room must not lose its room.
  it('keeps an archived room in the picker when it is the current selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teacher-rooms') {
        return new Response(JSON.stringify({ data: [
          { id: 'tr-live', isArchived: false, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Live Venue', roomName: 'Studio A' } },
          { id: 'tr-archived', isArchived: true, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Archived Venue', roomName: 'Studio B' } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    render(
      <TemplateForm
        mode="edit"
        templateId="tpl-1"
        initial={{ ...VALID_INITIAL, teacherRoomId: 'tr-archived' }}
      />,
    );

    expect(await screen.findByRole('option', { name: /Archived Venue/ })).toBeInTheDocument();
  });
```

Adapt `VALID_INITIAL` to the `TemplateFormValues` shape the file already builds elsewhere. Match the option label to however the existing markup renders room names.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`
Expected: FAIL on the first case — the archived option is present.

- [ ] **Step 3: Filter in `TemplateForm`**

At `template-form.tsx:152`, after `setTeacherRooms(json.data)`:

```ts
        const json: { data: TeacherRoomData[] } = await res.json();
        // Issue 76: an archived room accepts no new commitments, so it is not
        // offered here. FEEDBACK, NOT ENFORCEMENT — `POST /api/class-templates`
        // refuses an archived room regardless, and must keep doing so.
        //
        // The current selection survives the filter: in `edit` mode this form
        // may be editing a paused template that already sits on an archived
        // room, and dropping its option would silently blank the field.
        setTeacherRooms(
          json.data.filter((tr) => !tr.isArchived || tr.id === form.teacherRoomId),
        );
```

Add `isArchived: boolean` to the `TeacherRoomData` interface in that file.

If `form.teacherRoomId` is not in scope at the fetch site (the effect runs on mount), read it from `initial?.teacherRoomId` instead — that is the value `edit` mode seeds and it cannot have changed before the fetch resolves.

- [ ] **Step 4: Filter in the class-creation picker**

At `class/new/page.tsx:174`, the same filter without the selection carve-out — this page is create-only and has no pre-existing selection:

```ts
        const json: { data: TeacherRoomData[] } = await res.json();
        // Issue 76: archived rooms are not offered for new classes. Feedback
        // only — a class created here is born `draft`, and door 2
        // (`transitionClass`) is what actually refuses publishing into an
        // archived room.
        setTeacherRooms(json.data.filter((tr) => !tr.isArchived));
```

Add `isArchived: boolean` to that file's `TeacherRoomData` interface too.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`
Expected: PASS both cases, and the pre-existing cases in that file unaffected.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/(teacher)/class/new/page.tsx' src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "feat: archived rooms are no longer offered when scheduling (issue 76)"
```

---

### Task 7: The three residues

**Files:**
- Modify: `src/components/settings/unlink-room-button.tsx:50`
- Modify: `src/app/api/rooms/[id]/route.ts:37-39`
- Modify: `tests/integration/rooms-api.test.ts` — **eight locations, listed below**
- Modify: `src/app/(teacher)/settings/rooms/[id]/page.tsx:31`

**Interfaces:** none. This task changes copy, one status code, and one comment.

**THE HAZARD IN THIS TASK.** Changing the `hasClasses` refusal from `400 "Cannot delete a room that has classes"` to `409 "Cannot delete a room with class history. Archive it instead."` touches **eight** places in `tests/integration/rooms-api.test.ts`, only four of which are assertions. A `grep` for `toBe(400)` finds two and misses six. Enumerate and fix all eight:

| Line | Kind | What it says now |
|---|---|---|
| `:141` | comment | "Private, with a TeacherRoom that has a class: the hasClasses 400." |
| `:397` | comment | "it says \"Cannot delete a room that has classes\" with a 400 —" |
| `:446` | test name | "…still has classes -> 400, nothing removed" |
| `:448` | assertion | `expect(res.status).toBe(400)` |
| `:451` | assertion | `expect(json.error.message).toContain('Cannot delete a room that has classes')` |
| `:473` | comment | "this becomes 400 \"Cannot delete a room that has classes\" — telling a" |
| `:497` | assertion | `expect(res.status).toBe(400)` |
| `:499` | assertion | `expect(body.error.message).toBe('Cannot delete a room that has classes')` |

**Two decoys — do NOT change these.** `:346` and `:371` are a *different* 400, from the `PUT` handler's guard, and `:262` discusses that one too. They are unrelated to `hasClasses`.

- [ ] **Step 1: Correct the unlink copy**

`src/components/settings/unlink-room-button.tsx:50` currently promises a cascade the route refuses:

```tsx
      <p className="text-sm text-brown">Unlink {roomName}? Classes using this room will also be removed.</p>
```

The route it calls (`DELETE /api/teacher-rooms/[id]:120-124`) answers 409 when any class exists — it never removes classes. Replace:

```tsx
      <p className="text-sm text-brown">Unlink {roomName}? This removes it from your rooms. Only possible while no classes use it.</p>
```

- [ ] **Step 2: Align the delete refusal**

`src/app/api/rooms/[id]/route.ts:37-39`:

```ts
  const hasClasses = room.teacherRooms.some((tr) => tr._count.classes > 0);
  if (hasClasses) {
    // Matches the sibling refusal in `teacher-rooms/[id]:123` in both status
    // and wording. The 400 this replaces implied a clearable condition and
    // named no way out; a room with class history is permanently undeletable
    // BY DESIGN — archiving is the end state (issue 76), and hard deletion is
    // reserved for rooms that were never used. 409, because it is a conflict
    // with current state rather than a malformed request.
    return respondError('Cannot delete a room with class history. Archive it instead.', 409);
  }
```

- [ ] **Step 3: Fix all eight locations in the test file**

Work down the table above. Assertions become `toBe(409)` and the new message; comments and the test name must state 409 and the new wording. **A comment left saying "400" is a defect, not cosmetics** — it is exactly the failure this project has hit before, where a fix landed in the assertion and its twin three hundred lines away stood.

- [ ] **Step 4: Add the known-open comment on the stale gate**

`src/app/(teacher)/settings/rooms/[id]/page.tsx`, above `:31`:

```tsx
  // KNOWN-OPEN (issue 76): a server-render snapshot. The buttons below gate on
  // it, so a class created on this room after render leaves `Delete room`
  // offered; the click then meets the route's own refusal, which is the
  // authority. Recorded rather than locked, for the same reason as the archive
  // race in `services/room-archive.ts` — see spec section 8.
  const classCount = await prisma.class.count({ where: { teacherRoomId: teacherRoom.id } });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project integration tests/integration/rooms-api.test.ts`
Expected: PASS.

Then confirm no stale references survive anywhere:

```bash
grep -rn "Cannot delete a room that has classes" src tests docs
```
Expected: **no output.** Any hit is an unfixed twin.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/unlink-room-button.tsx 'src/app/api/rooms/[id]/route.ts' tests/integration/rooms-api.test.ts 'src/app/(teacher)/settings/rooms/[id]/page.tsx'
git commit -m "fix: two room messages stop describing behaviour that cannot happen (issue 76)"
```

---

### Task 8: Pin the shared constant, then the full gate

**Files:**
- Test: `src/lib/template-selection.test.ts` (**create**)

**Interfaces:**
- Consumes: `ACTIVE_TEMPLATE_WHERE` from `src/lib/template-selection.ts` (Task 1).
- Produces: nothing.

**What changed from the original plan, and why it matters here.** The first
draft asserted agreement between the archive guard and the generator by
reading `class-generator.ts` as text and checking for a literal. Task 1
instead made both sides *import the same constant*, so divergence is now
impossible rather than merely detectable — there is no agreement left to
assert. What remains worth pinning is the constant's own value, so that
changing it is a deliberate act with a visible blast radius rather than a
one-word edit.

- [ ] **Step 1: Write the test**

```ts
/**
 * `ACTIVE_TEMPLATE_WHERE` is imported by two modules that must agree:
 * `services/class-generator.ts` selects templates to run with it, and
 * `services/room-archive.ts` blocks archiving a room those templates would
 * generate into. Sharing the constant is what makes them agree; this test
 * pins its VALUE, so that widening or narrowing it is a deliberate change
 * with both call sites in view rather than a one-word edit in passing.
 */
import { describe, it, expect } from 'vitest';
import { ACTIVE_TEMPLATE_WHERE } from './template-selection';

describe('ACTIVE_TEMPLATE_WHERE', () => {
  it('selects live templates only — active and not archived', () => {
    expect(ACTIVE_TEMPLATE_WHERE).toEqual({ isActive: true, isArchived: false });
  });

  // `isArchived: false` is defense in depth: the routes already keep archived
  // templates inactive, so dropping it would change nothing observable today
  // and would silently remove the backstop `class-generator.ts` documents.
  it('keeps both keys, not just isActive', () => {
    expect(Object.keys(ACTIVE_TEMPLATE_WHERE).sort()).toEqual(['isActive', 'isArchived']);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --project unit src/lib/template-selection.test.ts`
Expected: PASS.

- [ ] **Step 3: Prove the sharing is real, not decorative**

This is the check that replaces the old text-matching test. In
`src/lib/template-selection.ts`, change `isActive: true` to `isActive: false`.

Run: `npx vitest run --project unit src/lib/template-selection.test.ts src/services/room-archive.test.ts src/services/class-generator.test.ts`

Expected: RED in **all three** — the constant test, the archive guard's
template cases, and the generator's own tests. That single edit reaching all
three files is the structural agreement demonstrating itself; if the generator
tests stay green, the rewire in Task 1 Step 0 did not take and must be fixed.

Restore and re-run green.

- [ ] **Step 4: Run the full gate**

Run: `npm run verify`

This is typecheck + lint + all three vitest projects, including every file in
`tests/integration/`. It needs the app live on :3000; a wall of `ECONNREFUSED`
means it is not running — **ask the user, do not start it**.

Expected: PASS. Record the per-project file and test counts from the output,
with totals that reconcile (e.g. `50 + 37 + 28 = 115` files,
`712 + 205 + 396 = 1313` tests). The PR body needs these, and a bare number is
not checkable.

Green `verify` is a strong signal but **not** a substitute for CI, which
additionally runs `prisma validate`, a migration-drift check, `npm run build`,
and Playwright.

- [ ] **Step 5: Commit**

```bash
git add src/lib/template-selection.test.ts
git commit -m "test: the shared template predicate is pinned, not assumed (issue 76)"
```

---

## What the PR body must record

- The corrected premise: archiving shipped `e57b8bd` on 2026-04-05, three and a half months before the issue was filed; three of the issue's claims do not hold (see spec section 1).
- Each mutation applied, with its exact error text, and confirmation that mutations 1 and 2 each went red **while the other clause's tests stayed green**.
- The arithmetic behind the test counts, per project, reconciling to a total.
- Which `tests/integration/` files this branch touched, by path: `teacher-rooms-api.test.ts`, `rooms-api.test.ts`, `class-templates-api.test.ts`. Note that a green `npm run verify` ran **all** of them, and give the count that proves it.
- What this PR does not do: no lock for the archive race (spec section 8), no server guard on draft-class creation, no change to `GET /api/teacher-rooms`.
- **Issues 52 and 259 are unaffected.** Write it exactly that way. Never write the word "close"/"fixes"/"resolves" immediately before `#<number>` for an issue you are not closing — GitHub's parser does not understand the negation and will close it.
