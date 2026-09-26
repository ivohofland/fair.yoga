# Switch to the Shared Room: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher whose private room turns out to be already shared can switch to the shared one in a single atomic action. Their templates and upcoming classes move onto the shared room's link, and the private link is archived.

**Architecture:** A framework-agnostic service, `switchToSharedRoom` (`src/services/room-switch.ts`), runs one transaction in the lock order the spec fixes: templates, then the private link, then the shared link, then classes. A thin route, `POST /api/teacher-rooms/[id]/switch`, maps its result to the house response helpers. `ShareRoomButton`'s exact-match branch gains the action.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (`unit`, `integration`, `components` projects), Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md`. Read it before any task. Every "why" in this plan lives there.

## Global Constraints

- TypeScript `strict`: no `any`. No cast in production code.
- Services import no framework code: no `next/*`, no HTTP.
- Every 409 carries a code registered in `src/lib/api-error-codes.ts`. Tests assert codes with `expectRefusal`, never message text.
- The only new error code is `NOT_SAME_ROOM: 409`. The in-progress refusal reuses `ROOM_IN_USE`, and the shared-room-now refusal reuses `NOW_SHARED`.
- No migration. Every constraint this needs already exists.
- No economic field is written on any `Class` or `ClassTemplate`: `roomCost`, `minRate`, `targetRate`, `minStudents`, `maxStudents`.
- Classes that move: `status IN ('draft','open')` and `entryLive = true`. `in_progress` (with `entryLive`) refuses the whole switch. Completed and cancelled classes stay.
- Templates that move: every `ClassTemplate` on the private link, whatever its rule's state.
- A new link carries the private link's `rentalRate` and `equipmentNotes`, with `capacityOverride = min(private.capacityOverride, shared.maxCapacity)`. A reused link keeps its values and is un-archived if needed.
- Copy (verbatim):
  - Exact-match body: "{name} at {address} is already shared with all teachers. You can switch to it: your recurring classes and upcoming classes move there, and this room is archived. Past classes stay with this room."
  - Button: "Switch to shared room"; while pending: "Switching..."
  - `NOT_SAME_ROOM`: "This room's address no longer matches the shared room. Check its details and try again."
  - `ROOM_IN_USE` (switch): "A class is running in this room right now. You can switch once it has finished."
- Success (applied or unchanged) navigates to `/settings/rooms`.
- Comments state what is true now. Never write a count or roster in a comment (CLAUDE.md, *Comment Discipline*).
- Stage exact paths. Never `git add -A` or `git add .`. Quote paths containing `(teacher)`.
- Run integration tests against this worktree's own app. Run `pnpm run worktree:up` once before the first integration run, then use `pnpm exec vitest run --project integration <file>`.

## Review Focus

1. **A class cancelled while the switch waits on its row.** It must stay on the private link, not be moved as uncancelled. This is why the predicate reads `entryLive` on the locked row. Pinned in Task 1 (the predicate mutation) and in Task 2 (a cancel racing the switch).
2. **A teacher who already linked the shared room by hand, and archived it since.** The switch must reuse and un-archive that link, not fail on `@@unique([teacherId, roomId])`. Pinned in Task 1 (reuse cases).
3. **A double-submitted switch.** The second request must answer unchanged (200), not error. Pinned in Task 3 (sequential repeat) and Task 1 (unchanged case).
4. **Case and whitespace differences between the two rooms' identity.** "Studio A " and "studio a" must count as the same room, matching the Postgres index. Pinned in Task 1 (identity-normalisation case).
5. **A switch whose shared room has less capacity than the private link.** The new link is clamped and the result reports it. No existing class's `maxStudents` changes. Pinned in Task 1 (capacity and economics cases).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/room-switch.ts` (new) | `switchToSharedRoom`, its result type, and the transaction |
| `src/services/room-switch.test.ts` (new, `unit` project, real DB) | Behaviour of the service |
| `src/services/room-switch-lock-order.test.ts` (new, `unit` project) | Lock order and race behaviour |
| `tests/room-fixtures.ts` (modify) | Optional `daysAhead` on `addClass` and `dayOfWeek` on `addTemplate`, so one fixture can hold several live rows |
| `src/lib/api-error-codes.ts` (modify) | `NOT_SAME_ROOM: 409` |
| `src/lib/schemas.ts` (modify) | `switchRoomSchema` |
| `src/app/api/teacher-rooms/[id]/switch/route.ts` (new) | The thin route |
| `tests/integration/teacher-rooms-switch-api.test.ts` (new) | HTTP behaviour and guard order |
| `src/components/settings/share-room-button.tsx` (modify) | The exact-match action |
| `src/components/settings/share-room-button.test.tsx` (modify) | Its behaviour |
| `src/app/(teacher)/settings/rooms/[id]/page.tsx` (modify) | Passes `teacherRoomId` |
| `docs/lock-order.md` (modify) | New section for the switch, plus the stale `archiveRoom` name |
| `prisma/schema.prisma`, `src/services/room-archive.ts`, `src/services/class-lifecycle.ts`, `src/components/settings/room-match-list.tsx`, `src/lib/room-search.ts` (modify, comments only) | The claims §7 of the spec lists |

**Task order is load-bearing.** Task 2 and Task 3 consume Task 1's service. Task 4 consumes Task 3's route and error code.

---

### Task 1: The `switchToSharedRoom` service

**Files:**
- Create: `src/services/room-switch.ts`
- Create: `src/services/room-switch.test.ts`
- Modify: `tests/room-fixtures.ts` (`addClass`, `addTemplate`)
- Modify, comments only: `prisma/schema.prisma` (the `Class` mirror docblock, "no path moves a class between rooms"); `src/services/room-archive.ts:35-37` ("a class never changes rooms"); `src/services/class-lifecycle.ts:1098` (the `teacherRoomId` note)

**Interfaces:**
- Consumes: `setLockTimeout`, `lockClassRowsOrdered`, `statusInList`, `TransactionClientOnly` (`@/lib/db-locks`); `sameRoomIdentity` (`@/lib/room-identity`); `log` (`@/lib/log`).
- Produces:

```ts
export type SwitchRoomInput = {
  teacherId: string;
  teacherRoomId: string; // the PRIVATE link
  sharedRoomId: string;  // the SHARED Room
};

export type SwitchRoomResult =
  | {
      ok: true;
      action: 'switched';
      teacherRoomId: string; // the shared room's link
      moved: { templates: number; classes: number };
      reusedLink: boolean;
      capacityClamped: { from: number; to: number } | null;
    }
  | { ok: true; action: 'unchanged'; teacherRoomId: string }
  | { ok: false; reason: 'not_found' }             // private link missing
  | { ok: false; reason: 'forbidden' }             // private link is another teacher's
  | { ok: false; reason: 'now_shared' }            // private link's room is shared
  | { ok: false; reason: 'shared_room_not_found' } // missing, or not shared
  | { ok: false; reason: 'not_same_room' }
  | { ok: false; reason: 'class_in_progress' };

export async function switchToSharedRoom(
  db: PrismaClient,
  input: SwitchRoomInput,
): Promise<SwitchRoomResult>;
```

- [ ] **Step 1: Widen the room fixtures (no behaviour change for existing callers)**

In `tests/room-fixtures.ts`, give `addClass` an optional fourth parameter and `addTemplate` an optional `dayOfWeek`. That lets one fixture hold several uncancelled classes and several unarchived templates without tripping the teacher-slot exclusions its docblock describes:

```ts
  /** Always future-dated: a past date trips the STARTS_IN_PAST guard first.
   *  `daysAhead` (default 14) moves the date; give each uncancelled class on one
   *  fixture its own, or `CalendarEntry_teacher_slot_excl` refuses the second. */
  async function addClass(
    db: PrismaClient,
    f: RoomFixture,
    status: ClassFixtureStatus,
    opts: { daysAhead?: number } = {},
  ) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + (opts.daysAhead ?? 14));
```

Leave the rest of `addClass` as it is. In `addTemplate`, widen `opts` to `{ isActive: boolean; isArchived: boolean; dayOfWeek?: number }` and write `dayOfWeek: opts.dayOfWeek ?? 2`. Add one sentence to the file docblock: distinct `daysAhead` / `dayOfWeek` values are how a single fixture holds more than one live row.

Add a fourth helper inside `fixtureRun`, and return it alongside the others (`return { suffix, makeFixture, addClass, addTemplate, addSharedTwin, cleanup };`):

```ts
  /**
   * A SHARED room with `f`'s identity (issue 259). `f`'s private room is first
   * given a run-unique `roomName`, because two runs' twins would otherwise
   * collide on `Room_public_identity_unique`. The twin's creator is `f`'s
   * teacher, so `cleanup` sweeps it with the rest. `twinCase` varies case and
   * whitespace on the twin's side only; `roomName` gives it a different
   * identity outright.
   */
  async function addSharedTwin(
    db: PrismaClient,
    f: RoomFixture,
    opts: { maxCapacity?: number; twinCase?: boolean; roomName?: string } = {},
  ) {
    const tag = `${suffix}-${crypto.randomBytes(3).toString('hex')}`;
    const priv = await db.room.update({
      where: { id: f.roomId },
      data: { roomName: `Studio ${tag}` },
    });
    return db.room.create({
      data: {
        venueName: `Shared ${tag}`,
        address: opts.twinCase ? `  ${priv.address.toUpperCase()} ` : priv.address,
        floor: priv.floor,
        roomName: opts.roomName ?? (opts.twinCase ? ` STUDIO ${tag.toUpperCase()}` : priv.roomName),
        city: priv.city,
        postcode: priv.postcode,
        maxCapacity: opts.maxCapacity ?? 24,
        isPublic: true,
        createdById: f.teacherId,
      },
    });
  }
```

Run: `pnpm run typecheck`
Expected: exit 0. Every existing caller still passes three arguments or omits `dayOfWeek`.

- [ ] **Step 2: Write the failing behaviour tests**

Create `src/services/room-switch.test.ts`:

```ts
/**
 * `switchToSharedRoom` (issue 259). Spec:
 * `docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md`.
 *
 * Real database, fresh fixture per case (`tests/room-fixtures.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { switchToSharedRoom } from './room-switch';

const prisma = new PrismaClient();
const fx = fixtureRun('rsw');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus, daysAhead: number) =>
  fx.addClass(prisma, f, status, { daysAhead });
const addTemplate = (
  f: RoomFixture,
  opts: { isActive: boolean; isArchived: boolean; dayOfWeek?: number },
) => fx.addTemplate(prisma, f, opts);
const addSharedTwin = (
  f: RoomFixture,
  opts?: { maxCapacity?: number; twinCase?: boolean; roomName?: string },
) => fx.addSharedTwin(prisma, f, opts);

const run = (f: RoomFixture, sharedRoomId: string) =>
  switchToSharedRoom(prisma, { teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId });

const linkOn = (teacherId: string, roomId: string) =>
  prisma.teacherRoom.findUnique({ where: { teacherId_roomId: { teacherId, roomId } } });

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  // The fixture cleanup sweeps rooms by creator, which includes the twins.
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('switchToSharedRoom — what moves and what stays', () => {
  // Fails under option A (moves all four) and option C (moves none).
  it('moves draft and open classes, and leaves completed and cancelled ones', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const draft = await addClass(f, 'draft', 14);
    const open = await addClass(f, 'open', 15);
    const completed = await addClass(f, 'completed', 16);
    const cancelled = await addClass(f, 'cancelled', 17);

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', moved: { classes: 2 } });
    if (!result.ok || result.action !== 'switched') throw new Error('unreachable');
    const after = await prisma.class.findMany({
      where: { id: { in: [draft.id, open.id, completed.id, cancelled.id] } },
      select: { id: true, teacherRoomId: true, roomArchived: true },
    });
    const byId = new Map(after.map((c) => [c.id, c]));
    expect(byId.get(draft.id)).toMatchObject({ teacherRoomId: result.teacherRoomId, roomArchived: false });
    expect(byId.get(open.id)).toMatchObject({ teacherRoomId: result.teacherRoomId, roomArchived: false });
    expect(byId.get(completed.id)).toMatchObject({ teacherRoomId: f.linkId, roomArchived: true });
    expect(byId.get(cancelled.id)).toMatchObject({ teacherRoomId: f.linkId, roomArchived: true });

    const priv = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(priv.isArchived).toBe(true);
  });

  it('moves every template, whatever its rule state', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const active = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    const paused = await addTemplate(f, { isActive: false, isArchived: false, dayOfWeek: 2 });
    const archived = await addTemplate(f, { isActive: false, isArchived: true, dayOfWeek: 3 });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', moved: { templates: 3 } });
    if (!result.ok) throw new Error('unreachable');
    const onShared = await prisma.classTemplate.findMany({
      where: { id: { in: [active.id, paused.id, archived.id] } },
      select: { teacherRoomId: true, roomArchived: true },
    });
    expect(onShared).toHaveLength(3);
    for (const t of onShared) expect(t).toEqual({ teacherRoomId: result.teacherRoomId, roomArchived: false });
  });

  it('refuses while a class is in progress, and changes nothing', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const open = await addClass(f, 'open', 14);
    const running = await addClass(f, 'in_progress', 15);
    const tpl = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });

    const result = await run(f, shared.id);

    expect(result).toEqual({ ok: false, reason: 'class_in_progress' });
    const classes = await prisma.class.findMany({
      where: { id: { in: [open.id, running.id] } },
      select: { teacherRoomId: true },
    });
    for (const c of classes) expect(c.teacherRoomId).toBe(f.linkId);
    const t = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    expect(t.teacherRoomId).toBe(f.linkId);
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
    expect(await linkOn(f.teacherId, shared.id)).toBeNull();
  });

  it('writes no economic field on a moved class or template', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { maxCapacity: 5 });
    const open = await addClass(f, 'open', 14);
    const tpl = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    const pick = { roomCost: true, minRate: true, targetRate: true, minStudents: true, maxStudents: true } as const;
    const clsBefore = await prisma.class.findUniqueOrThrow({ where: { id: open.id }, select: pick });
    const tplBefore = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id }, select: pick });

    await run(f, shared.id);

    expect(await prisma.class.findUniqueOrThrow({ where: { id: open.id }, select: pick })).toEqual(clsBefore);
    expect(await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id }, select: pick })).toEqual(tplBefore);
  });
});

describe('switchToSharedRoom — the shared link', () => {
  it('creates a link carrying the private rate, clamped to the shared maximum', async () => {
    const f = await makeFixture(); // private link: capacity 15, rate 30
    const shared = await addSharedTwin(f, { maxCapacity: 10 });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({
      ok: true, action: 'switched', reusedLink: false, capacityClamped: { from: 15, to: 10 },
    });
    const link = await linkOn(f.teacherId, shared.id);
    expect(link?.capacityOverride).toBe(10);
    expect(link?.rentalRate.equals(new Prisma.Decimal(30))).toBe(true);
    expect(link?.isArchived).toBe(false);
  });

  it('does not clamp when the private capacity fits', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { maxCapacity: 24 });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', capacityClamped: null });
    expect((await linkOn(f.teacherId, shared.id))?.capacityOverride).toBe(15);
  });

  it('reuses an existing link and keeps its values', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const existing = await prisma.teacherRoom.create({
      data: {
        teacherId: f.teacherId, roomId: shared.id,
        capacityOverride: 12, rentalRate: new Prisma.Decimal(55),
      },
    });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({
      ok: true, action: 'switched', teacherRoomId: existing.id, reusedLink: true, capacityClamped: null,
    });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.capacityOverride).toBe(12);
    expect(after.rentalRate.equals(new Prisma.Decimal(55))).toBe(true);
  });

  it('un-archives an archived existing link before moving live rows onto it', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const existing = await prisma.teacherRoom.create({
      data: {
        teacherId: f.teacherId, roomId: shared.id,
        capacityOverride: 12, rentalRate: new Prisma.Decimal(55), isArchived: true,
      },
    });
    const open = await addClass(f, 'open', 14);

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', teacherRoomId: existing.id, reusedLink: true });
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: existing.id } })).isArchived).toBe(false);
    expect(await prisma.class.findUniqueOrThrow({ where: { id: open.id } }))
      .toMatchObject({ teacherRoomId: existing.id, roomArchived: false });
  });
});

describe('switchToSharedRoom — refusals and the unchanged answer', () => {
  it('answers not_found for a missing link and forbidden for another teacher\'s', async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const shared = await addSharedTwin(f);

    expect(await switchToSharedRoom(prisma, {
      teacherId: f.teacherId, teacherRoomId: crypto.randomUUID(), sharedRoomId: shared.id,
    })).toEqual({ ok: false, reason: 'not_found' });
    expect(await switchToSharedRoom(prisma, {
      teacherId: other.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
    })).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('answers now_shared when the private link\'s room has been shared', async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    await prisma.room.update({ where: { id: f.roomId }, data: { isPublic: true } });
    const shared = await addSharedTwin(other);

    expect(await run(f, shared.id)).toEqual({ ok: false, reason: 'now_shared' });
  });

  it('answers shared_room_not_found for a private or missing target', async () => {
    const f = await makeFixture();
    const other = await makeFixture(); // a PRIVATE room

    expect(await run(f, other.roomId)).toEqual({ ok: false, reason: 'shared_room_not_found' });
    expect(await run(f, crypto.randomUUID())).toEqual({ ok: false, reason: 'shared_room_not_found' });
  });

  it('refuses a shared room that is not the same room', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { roomName: `Other ${fx.suffix}` });

    expect(await run(f, shared.id)).toEqual({ ok: false, reason: 'not_same_room' });
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
  });

  // Mirrors `Room_public_identity_unique`'s lower(trim(...)).
  it('treats case and whitespace differences as the same room', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { twinCase: true });

    expect(await run(f, shared.id)).toMatchObject({ ok: true, action: 'switched' });
  });

  it('answers unchanged on a repeat, with the shared link and no write', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    await addClass(f, 'open', 14);
    const first = await run(f, shared.id);
    if (!first.ok) throw new Error('first switch failed');
    const linkBefore = await linkOn(f.teacherId, shared.id);

    const second = await run(f, shared.id);

    expect(second).toEqual({ ok: true, action: 'unchanged', teacherRoomId: first.teacherRoomId });
    expect((await linkOn(f.teacherId, shared.id))?.updatedAt).toEqual(linkBefore?.updatedAt);
  });
});

describe('switchToSharedRoom — atomicity', () => {
  // A failure after the classes have moved (spec §6 item 3). The injection is
  // a trigger scoped to this one link id, so parallel files cannot hit it, and
  // it is dropped in `finally`.
  it('leaves everything where it was when the final archive fails', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const open = await addClass(f, 'open', 14);
    const tpl = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    if (!/^[0-9a-f-]{36}$/.test(f.linkId)) throw new Error('link id is not a uuid');
    const fn = `rsw_fail_${f.linkId.replace(/-/g, '')}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${fn} BEFORE UPDATE ON "TeacherRoom" FOR EACH ROW
      WHEN (NEW.id = '${f.linkId}' AND NEW."isArchived") EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(run(f, shared.id)).rejects.toThrow(/injected failure/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "TeacherRoom"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }

    expect((await prisma.class.findUniqueOrThrow({ where: { id: open.id } })).teacherRoomId).toBe(f.linkId);
    expect((await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).teacherRoomId).toBe(f.linkId);
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
    expect(await linkOn(f.teacherId, shared.id)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `pnpm exec vitest run --project unit src/services/room-switch.test.ts`
Expected: FAIL, because the import `./room-switch` cannot be resolved.

- [ ] **Step 4: Implement the service**

Create `src/services/room-switch.ts`:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
import { lockClassRowsOrdered, setLockTimeout, statusInList } from '@/lib/db-locks';
import { sameRoomIdentity } from '@/lib/room-identity';
import { log } from '@/lib/log';

/**
 * Moving a teacher from their private room onto the already-shared room with
 * the same identity (issue 259). The rules — what moves, what stays, which
 * link values survive — and the reasoning behind the lock order are in
 * `docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md`; the
 * lock order itself is recorded in `docs/lock-order.md` ("Switching to a
 * shared room").
 *
 * Framework-agnostic: the route `POST /api/teacher-rooms/[id]/switch` maps
 * `SwitchRoomResult` to responses.
 */

export type SwitchRoomInput = {
  teacherId: string;
  /** The PRIVATE link being retired. */
  teacherRoomId: string;
  /** The SHARED `Room` being moved onto. */
  sharedRoomId: string;
};

export type SwitchRoomResult =
  | {
      ok: true;
      action: 'switched';
      /** The shared room's link — created, or the one the teacher already had. */
      teacherRoomId: string;
      moved: { templates: number; classes: number };
      reusedLink: boolean;
      capacityClamped: { from: number; to: number } | null;
    }
  | { ok: true; action: 'unchanged'; teacherRoomId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'now_shared' }
  | { ok: false; reason: 'shared_room_not_found' }
  | { ok: false; reason: 'not_same_room' }
  | { ok: false; reason: 'class_in_progress' };

type Refusal = Extract<SwitchRoomResult, { ok: false }>;

/** Thrown inside the transaction so a refusal found after a write rolls it back. */
class SwitchRefused extends Error {
  constructor(readonly result: Refusal) {
    super(`room switch refused: ${result.reason}`);
  }
}

/** The classes that move: upcoming, not cancelled. `entryLive` is the
 *  cancellation mirror on the `Class` row (#339). */
const MOVING_CLASS_WHERE = {
  status: { in: ['draft', 'open'] },
  entryLive: true,
} satisfies Prisma.ClassWhereInput;

export async function switchToSharedRoom(
  db: PrismaClient,
  input: SwitchRoomInput,
): Promise<SwitchRoomResult> {
  const { teacherId, teacherRoomId, sharedRoomId } = input;

  // Ownership before any lock: a request about another teacher's link must
  // not take row locks on that teacher's templates.
  const pre = await db.teacherRoom.findUnique({ where: { id: teacherRoomId } });
  if (!pre) return { ok: false, reason: 'not_found' };
  if (pre.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  try {
    return await db.$transaction(async (tx) => {
      await setLockTimeout(tx);

      // 1. Templates before links — the order archiving uses, and the one the
      //    generator's claim implies (`docs/lock-order.md`).
      await tx.$queryRaw`
        SELECT ct."id" FROM "ClassTemplate" ct
        WHERE ct."teacherRoomId" = ${teacherRoomId}
        ORDER BY ct."id"
        FOR UPDATE`;

      // 2. The private link, then every guard again against what is locked.
      await tx.$queryRaw`
        SELECT "id" FROM "TeacherRoom" WHERE "id" = ${teacherRoomId} FOR UPDATE`;
      const priv = await tx.teacherRoom.findUnique({
        where: { id: teacherRoomId },
        include: { room: true },
      });
      if (!priv) throw new SwitchRefused({ ok: false, reason: 'not_found' });
      if (priv.room.isPublic) throw new SwitchRefused({ ok: false, reason: 'now_shared' });
      const shared = await tx.room.findUnique({ where: { id: sharedRoomId } });
      if (!shared || !shared.isPublic) {
        throw new SwitchRefused({ ok: false, reason: 'shared_room_not_found' });
      }
      if (!sameRoomIdentity(priv.room, shared)) {
        throw new SwitchRefused({ ok: false, reason: 'not_same_room' });
      }

      // Already switched: nothing left on the private link, and a usable
      // link on the shared room. After every refusal that makes the goal
      // moot or invalid, before any write.
      const existing = await tx.teacherRoom.findUnique({
        where: { teacherId_roomId: { teacherId, roomId: sharedRoomId } },
      });
      if (priv.isArchived && existing && !existing.isArchived) {
        const templatesLeft = await tx.classTemplate.count({ where: { teacherRoomId } });
        const classesLeft = await tx.class.count({ where: { teacherRoomId, ...MOVING_CLASS_WHERE } });
        if (templatesLeft === 0 && classesLeft === 0) {
          return { ok: true, action: 'unchanged', teacherRoomId: existing.id };
        }
      }

      // 3. The shared link: insert if absent, then hold it. Held before any
      //    class moves, so the move's foreign-key check waits on nothing.
      const capacity = Math.min(priv.capacityOverride, shared.maxCapacity);
      const inserted = await tx.teacherRoom.createMany({
        data: [{
          teacherId,
          roomId: sharedRoomId,
          capacityOverride: capacity,
          rentalRate: priv.rentalRate,
          equipmentNotes: priv.equipmentNotes,
        }],
        skipDuplicates: true,
      });
      const [target] = await tx.$queryRaw<Array<{ id: string; isArchived: boolean }>>`
        SELECT "id", "isArchived" FROM "TeacherRoom"
        WHERE "teacherId" = ${teacherId} AND "roomId" = ${sharedRoomId}
        FOR UPDATE`;
      if (!target) throw new Error('room switch: shared link missing after insert-if-absent');
      if (target.isArchived) {
        await tx.teacherRoom.update({ where: { id: target.id }, data: { isArchived: false } });
      }

      // 4. The private link's classes.
      //
      // VERDICT (#327): this transaction writes `Class.teacherRoomId` and
      // `roomArchived` and no entry column, so it takes the `Class` rows and
      // stops there. Cancellation is read from `entryLive` on the locked row,
      // not from a join, so a cancel that lands while this waits is re-checked.
      const lockedIds = await lockClassRowsOrdered(tx, {
        where: Prisma.sql`c."teacherRoomId" = ${teacherRoomId}
          AND c.status IN (${statusInList(['draft', 'open', 'in_progress'])})
          AND c."entryLive"`,
      });
      const running = await tx.class.count({
        where: { id: { in: lockedIds }, status: 'in_progress' },
      });
      if (running > 0) throw new SwitchRefused({ ok: false, reason: 'class_in_progress' });

      // 5. Move them, keyed on the locked ids alone, so the write set is a
      //    structural subset of the lock set (`lockClassRowsOrdered`'s
      //    docblock). No `in_progress` id survives the refusal above, so the
      //    set is exactly the upcoming classes. The mirror is written in the
      //    same statement: the cascade fires on the parent, never on a child
      //    that repoints.
      const movedClasses = await tx.class.updateMany({
        where: { id: { in: lockedIds } },
        data: { teacherRoomId: target.id, roomArchived: false },
      });

      // 6. Every template, by predicate rather than by the step-1 id set: the
      //    private link's lock (step 2) is what stops a new arrival, and a
      //    template moved onto it between steps 1 and 2 must go too.
      const movedTemplates = await tx.classTemplate.updateMany({
        where: { teacherRoomId },
        data: { teacherRoomId: target.id, roomArchived: false },
      });

      // 7. Retire the private link. Only terminal rows point at it now.
      await tx.teacherRoom.update({ where: { id: teacherRoomId }, data: { isArchived: true } });

      const reusedLink = inserted.count === 0;
      return {
        ok: true,
        action: 'switched',
        teacherRoomId: target.id,
        moved: { templates: movedTemplates.count, classes: movedClasses.count },
        reusedLink,
        capacityClamped:
          !reusedLink && capacity < priv.capacityOverride
            ? { from: priv.capacityOverride, to: capacity }
            : null,
      };
    });
  } catch (e) {
    if (e instanceof SwitchRefused) {
      // Not decoration: `respondError` does not log, so this line is the only
      // record of a refusal (the reasoning `setTeacherRoomArchived` states).
      log.info({ teacherId, teacherRoomId, sharedRoomId, reason: e.result.reason }, 'room switch refused');
      return e.result;
    }
    throw e;
  }
}
```

If `statusInList`'s parameter type rejects the array literal, pass it as `['draft', 'open', 'in_progress'] as const satisfies readonly ClassStatus[]`, importing `ClassStatus` from `@prisma/client`. Do not use a cast.

- [ ] **Step 5: Run the tests and see them pass**

Run: `pnpm exec vitest run --project unit src/services/room-switch.test.ts`
Expected: PASS, every case.

Also run `pnpm exec vitest run --project unit src/lib/db-locks-verdict-census.test.ts`.
Expected: PASS. The new call carries its `VERDICT (#327)` comment directly above it.

- [ ] **Step 6: Mutation-test each guard**

Commit first (Step 8 below can come before this step, or use a WIP commit), so a restore cannot discard sibling edits. For each mutation: apply it, run `room-switch.test.ts`, record the failing case name and the exact assertion text in the task report, restore, and confirm `git status` is clean. Store each mutation as exact text.

| # | Mutation | Case expected to fail |
|---|---|---|
| M1 | Delete `AND c."entryLive"` from step 4 | "moves draft and open classes, and leaves completed and cancelled ones" (the cancelled class moves) |
| M1b | Re-add `...MOVING_CLASS_WHERE` to step 5's `where`, alongside M1 | None, and that is the point: record it as the reason step 5 keys on ids alone. A fresh re-filter at the write would mask a wrong lock set, and Task 2's L2 could not fail. |
| M2 | In step 4, replace `statusInList(['draft', 'open', 'in_progress'])` with `statusInList(['draft', 'open'])` | "refuses while a class is in progress" (the switch succeeds, or fails with 23514 instead of refusing) |
| M3 | Change step 6's `where` to `{ teacherRoomId, ruleLive: true }` | "moves every template, whatever its rule state" |
| M4 | Replace `Math.min(priv.capacityOverride, shared.maxCapacity)` with `priv.capacityOverride` | "creates a link carrying the private rate, clamped to the shared maximum" |
| M5 | Delete the `if (target.isArchived) { … }` block | "un-archives an archived existing link …" (23514 on the move) |
| M6 | Delete the `sameRoomIdentity` guard | "refuses a shared room that is not the same room" |
| M7 | Replace `sameRoomIdentity(priv.room, shared)` with a byte-exact comparison of `address`, `floor` and `roomName` | "treats case and whitespace differences as the same room" |
| M8 | Delete the unchanged block | "answers unchanged on a repeat …" |

If a mutation fails no case, stop and add the missing case rather than dropping the mutation. If the mutation is inert by design, say why in the report.

- [ ] **Step 7: Correct the comments this task invalidates**

Replace each claim; don't annotate it:
- `prisma/schema.prisma`, the `Class` mirror docblock: "Neither is written by an update: no path moves a class between rooms (`updateClassSchema` carries no `teacherRoomId`)". Rewrite so it says `updateClass` never moves a class (the schema carries no `teacherRoomId`). The one path that does, `switchToSharedRoom` (`src/services/room-switch.ts`), writes `roomArchived` from the target link in the same statement.
- `src/services/room-archive.ts:35-37`, "a class never changes rooms". Same correction, same citation.
- `src/services/class-lifecycle.ts:1098`, the `teacherRoomId` note. It stays true of `updateClass`. Make sure the wording claims nothing beyond that function.

After editing, run `grep -rn "moves a class between rooms\|never changes rooms\|no path moves" src prisma`. Give each hit a verdict in the report.

- [ ] **Step 8: Commit**

```bash
git add tests/room-fixtures.ts src/services/room-switch.ts src/services/room-switch.test.ts prisma/schema.prisma src/services/room-archive.ts src/services/class-lifecycle.ts
git commit -m "feat(rooms): switchToSharedRoom moves templates and upcoming classes onto the shared link (#259)"
```

A comment-only edit to `schema.prisma` needs no migration. Confirm with `pnpm exec prisma validate` and `pnpm run check-migrations`: both must be clean.

---

### Task 2: Lock order, proven, and recorded

**Files:**
- Create: `src/services/room-switch-lock-order.test.ts`
- Modify: `docs/lock-order.md` (new section; fix the stale `archiveRoom` name near line 2907)

**Interfaces:**
- Consumes: `switchToSharedRoom` from Task 1; `fixtureRun` (including `addSharedTwin` and `addClass`'s `daysAhead`) and `createClassFixture` from `tests/`.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the lock-order tests**

Create `src/services/room-switch-lock-order.test.ts`. The holder follows `withHeldChild` in `src/services/room-archive-lock-order.test.ts` (a separate client, an acquired/release signal pair, a hold ceiling) and adds two things: an `onHeld` callback that runs inside the holder's transaction after its lock lands, and a `release` mode. `'after-body'` releases once `body` settles (the probe case). `'after-start'` releases once `body` has *started*, so the waiting switch can finish, and returns `body`'s promise:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun } from '../../tests/room-fixtures';
import { createClassFixture } from '../../tests/class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { switchToSharedRoom } from './room-switch';

const prisma = new PrismaClient();
const fx = fixtureRun('rswl');
const HELD_CASE_TIMEOUT_MS = 20_000;
const HOLD_CEILING_MS = 4_000;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

/**
 * Holds the row `lockSql` selects `FOR UPDATE` on a connection of its own,
 * runs `onHeld` inside that transaction, then runs `body`. The hold ends when
 * `body` settles ('after-body') or as soon as `body` has been started and
 * `startDelayMs` has passed ('after-start'). The ceiling turns a missing
 * bound into a failed assertion rather than a vitest timeout.
 */
async function withHeld<T>(
  lockSql: Prisma.Sql,
  body: () => Promise<T>,
  opts: {
    onHeld?: (tx: Prisma.TransactionClient) => Promise<void>;
    release: 'after-body' | 'after-start';
    startDelayMs?: number;
  },
): Promise<T> {
  const holder = new PrismaClient();
  await holder.$connect();
  let acquired!: () => void;
  let release!: () => void;
  const acquiredSignal = new Promise<void>((r) => { acquired = r; });
  const releaseSignal = new Promise<void>((r) => { release = r; });
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  try {
    const held = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw(lockSql);
        if (opts.onHeld) await opts.onHeld(tx);
        acquired();
        await Promise.race([
          releaseSignal,
          new Promise<void>((r) => { ceiling = setTimeout(r, HOLD_CEILING_MS); }),
        ]);
        return 'released';
      },
      { timeout: HOLD_CEILING_MS + 10_000 },
    );
    held.catch(() => {});
    await acquiredSignal;

    let result: T;
    if (opts.release === 'after-start') {
      const pending = body();
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, opts.startDelayMs ?? 300));
      release();
      expect(await held).toBe('released');
      result = await pending;
    } else {
      try {
        result = await body();
      } finally {
        release();
      }
      expect(await held).toBe('released');
    }
    return result;
  } finally {
    if (ceiling) clearTimeout(ceiling);
    await holder.$disconnect();
  }
}

const addSharedTwin = (f: Parameters<typeof fx.addSharedTwin>[1]) => fx.addSharedTwin(prisma, f);

describe('switchToSharedRoom — lock order (issue 259)', () => {
  // THE ORDER. While the switch waits on a held template it must not yet hold
  // the private link: templates before links. Move the step-1 pre-lock below
  // step 2 and the probe times out instead.
  it('has not taken the private link while it waits on one of its templates', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const tpl = await fx.addTemplate(prisma, f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    const prober = new PrismaClient();
    await prober.$connect();
    try {
      await withHeld(Prisma.sql`SELECT id FROM "ClassTemplate" WHERE id = ${tpl.id} FOR UPDATE`, async () => {
        const switching = switchToSharedRoom(prisma, {
          teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
        });
        await new Promise((r) => setTimeout(r, 800));
        await expect(prober.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
          await tx.$queryRaw`SELECT id FROM "TeacherRoom" WHERE id = ${f.linkId} FOR UPDATE`;
          return 'link was free';
        })).resolves.toBe('link was free');
        await expect(switching).rejects.toThrow(/55P03|lock timeout/i);
      }, { release: 'after-body' });
    } finally {
      await prober.$disconnect();
    }
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
  }, HELD_CASE_TIMEOUT_MS);

  // The generator's interleaving: it holds a template on the private link and
  // inserts a class there, then commits. The switch waited on that template,
  // so the class is visible to step 4 and moves.
  it('moves a class the generator inserted while the switch waited on its template', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const tpl = await fx.addTemplate(prisma, f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    let generatedId = '';
    const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + 20);

    const result = await withHeld(
      Prisma.sql`SELECT id FROM "ClassTemplate" WHERE id = ${tpl.id} FOR UPDATE`,
      () => switchToSharedRoom(prisma, {
        teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
      }),
      {
        release: 'after-start',
        onHeld: async (tx) => {
          const cls = await createClassFixture(tx, {
            teacherId: f.teacherId, teacherRoomId: f.linkId, classType: 'Hatha', date,
            startTime: hhmmToTime('07:00'), durationMinutes: 60,
            roomCost: new Prisma.Decimal(20), minRate: new Prisma.Decimal(15),
            targetRate: new Prisma.Decimal(25), minStudents: 2, maxStudents: 10, status: 'open',
            cancelledAt: null,
          });
          generatedId = cls.id;
        },
      },
    );

    expect(result).toMatchObject({ ok: true, action: 'switched' });
    if (!result.ok) throw new Error('unreachable');
    expect((await prisma.class.findUniqueOrThrow({ where: { id: generatedId } })).teacherRoomId)
      .toBe(result.teacherRoomId);
  }, HELD_CASE_TIMEOUT_MS);

  // Review Focus 1: a cancel that commits while the switch waits on the class
  // row. `entryLive` is re-checked on the locked row, so the class stays.
  it('leaves a class cancelled while the switch waited on its row', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const open = await fx.addClass(prisma, f, 'open', { daysAhead: 21 });

    const result = await withHeld(
      Prisma.sql`SELECT id FROM "Class" WHERE id = ${open.id} FOR UPDATE`,
      () => switchToSharedRoom(prisma, {
        teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
      }),
      {
        release: 'after-start',
        onHeld: async (tx) => {
          await tx.calendarEntry.update({
            where: { id: open.calendarEntryId }, data: { cancelledAt: new Date() },
          });
        },
      },
    );

    expect(result).toMatchObject({ ok: true, action: 'switched', moved: { classes: 0 } });
    expect((await prisma.class.findUniqueOrThrow({ where: { id: open.id } })).teacherRoomId).toBe(f.linkId);
  }, HELD_CASE_TIMEOUT_MS);
});
```

Check that `fx.addClass`'s return value exposes `calendarEntryId` (it returns `createClassFixture`'s `ClassWithEntry`). In the third case, the holder's own entry update cascades into the `Class` row it already holds (`Class → CalendarEntry`, the documented order), so the holder cannot deadlock itself.

**Why the 300 ms is safe in both 'after-start' cases.** The switch is only *started* before the release. If it has not reached its wait by then, it runs after the holder commits. The second case then sees the generated class as already committed and moves it; the third sees the class already cancelled and leaves it. Both are the same outcome the race produces, so the assertions do not depend on the timing. What would show a real defect is a different outcome, not a slower one.

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run --project unit src/services/room-switch-lock-order.test.ts`
Expected: PASS (Task 1's order is already in place).

- [ ] **Step 3: Mutation-test the order**

Commit first. Then, one at a time, recording the failing case and assertion text:

| # | Mutation | Case expected to fail |
|---|---|---|
| L1 | Move step 1's template pre-lock to just after step 2's `SELECT … FOR UPDATE` on the private link | "has not taken the private link …" (probe times out) |
| L2 | In step 4, replace `AND c."entryLive"` with `join: CLASS_TO_ENTRY_JOIN` plus `AND e."cancelledAt" IS NULL`, the joined predicate `lockClassRowsOrdered`'s docblock warns against | "leaves a class cancelled while the switch waited on its row". The stale join keeps the cancelled class in the lock set, and step 5 moves it. |

If L2 fails no case, check the test's interleaving actually made the switch wait on the class row. The holder must still hold it when step 4 runs. Record the verdict rather than weakening the test. Restore and check `git status` is clean after each mutation.

- [ ] **Step 4: Record the order in `docs/lock-order.md`**

Add a section headed `## Switching to a shared room (#259)`, placed beside "The room mirror's foreign keys are wait edges (#272)". It states:
- The statement order: `ClassTemplate` (all on the private link, ascending id) → `TeacherRoom` private → `TeacherRoom` shared (insert-if-absent, then `FOR UPDATE`) → `Class` via `lockClassRowsOrdered` → writes.
- Why each edge matches an existing one: archiving's `ClassTemplate → TeacherRoom`; creation's `TeacherRoom → Class`.
- That this is the first `UPDATE` of `Class.teacherRoomId`. Its foreign-key `KEY SHARE` on the shared link is already held by this transaction, so it adds no wait edge. Update the `TeacherRoom → Class` counterparty paragraph (around lines 3020-3040) to name this writer rather than claim none exists.
- The accepted shape: un-archiving a reused link cascades onto its classes before the private link's classes are locked, the same shape `setTeacherRoomArchived(…, 'unarchived')` has.
- Fix the stale `archiveRoom` near line 2907 to `setTeacherRoomArchived`.

Use no counts. Where a list of call sites is needed, give the grep that re-derives it.

- [ ] **Step 5: Commit**

```bash
git add src/services/room-switch-lock-order.test.ts docs/lock-order.md
git commit -m "test(rooms): the switch's lock order, and the race it closes, recorded in lock-order.md (#259)"
```

---

### Task 3: The route, schema and error code

**Files:**
- Modify: `src/lib/api-error-codes.ts` (add `NOT_SAME_ROOM: 409` between `NOT_ROOM_CREATOR` and `NOT_YOUR_PROFILE`)
- Modify: `src/lib/schemas.ts` (add `switchRoomSchema` under *TEACHER ROOMS*)
- Create: `src/app/api/teacher-rooms/[id]/switch/route.ts`
- Create: `tests/integration/teacher-rooms-switch-api.test.ts`

**Interfaces:**
- Consumes: `switchToSharedRoom`, `SwitchRoomResult` (Task 1).
- Produces: `POST /api/teacher-rooms/[id]/switch`, body `{ roomId: string }`.
  - Applied: 200 `{ data: { teacherRoomId, moved, reusedLink, capacityClamped } }`.
  - Unchanged: 200 `{ data: { teacherRoomId }, outcome: 'unchanged' }`.
  - Refusals: 404 `NOT_FOUND` (link, or shared room); 403 (another teacher's link); 409 `NOW_SHARED`; 409 `NOT_SAME_ROOM`; 409 `ROOM_IN_USE`; 400 (bad body).
  - Exported message constants: `SWITCH_NOT_SAME_ROOM_MESSAGE`, `SWITCH_CLASS_RUNNING_MESSAGE`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/teacher-rooms-switch-api.test.ts`. Follow `tests/integration/teacher-rooms-api.test.ts`: teachers created inline with `seedSession`, requests with `cookie(token)` and `freshIp()`. **Clean up by suffix, never by an id assigned in `beforeAll`.** An early `beforeAll` failure would otherwise turn `deleteMany({ where: { teacherId: undefined } })` into a whole-table delete.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { BASE_URL, cookie, freshIp, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const SLUG = `trsw-${suffix}`;

async function makeTeacher(tag: string) {
  const email = `${SLUG}-${tag}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Switch', lastName: tag, email, account: { create: { email } },
      bio: 'Room switch API tests', pageSlug: `${SLUG}-${tag}`,
    },
  });
  return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
}

/** A private room + link for `teacherId`, and its shared twin, identity unique to this case. */
async function makePair(teacherId: string, tag: string) {
  const identity = { address: `${tag} ${suffix} Street`, floor: '1', roomName: 'Studio' };
  const priv = await prisma.room.create({
    data: { ...identity, venueName: 'Mine', city: 'Amsterdam', postcode: '1011AB', maxCapacity: 20, createdById: teacherId },
  });
  const link = await prisma.teacherRoom.create({
    data: { teacherId, roomId: priv.id, capacityOverride: 15, rentalRate: new Prisma.Decimal(30) },
  });
  const shared = await prisma.room.create({
    data: { ...identity, venueName: 'Shared', city: 'Amsterdam', postcode: '1011AB', maxCapacity: 24, isPublic: true, createdById: teacherId },
  });
  return { priv, link, shared };
}

const post = (token: string, linkId: string, body: unknown) =>
  fetch(`${BASE_URL}/api/teacher-rooms/${linkId}/switch`, {
    method: 'POST',
    headers: { ...cookie(token), ...freshIp(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let owner: { id: string; token: string };
let other: { id: string; token: string };

beforeAll(async () => {
  owner = await makeTeacher('owner');
  other = await makeTeacher('other');
});

afterAll(async () => {
  const mine = { teacher: { pageSlug: { startsWith: SLUG } } };
  await prisma.calendarEntry.deleteMany({ where: mine });
  await prisma.scheduleRule.deleteMany({ where: mine });
  await prisma.teacherRoom.deleteMany({ where: mine });
  await prisma.room.deleteMany({ where: { createdBy: { pageSlug: { startsWith: SLUG } } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: { startsWith: SLUG } } });
  await prisma.account.deleteMany({ where: { email: { startsWith: SLUG } } });
  await prisma.$disconnect();
});

describe('POST /api/teacher-rooms/[id]/switch', () => {
  it('switches, then answers unchanged on a repeat', async () => {
    const { link, shared } = await makePair(owner.id, 'happy');
    const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + 14);
    const cls = await createClassFixture(prisma, {
      teacherId: owner.id, teacherRoomId: link.id, classType: 'Hatha', date,
      startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15), targetRate: new Prisma.Decimal(25),
      minStudents: 2, maxStudents: 10, status: 'open', cancelledAt: null,
    });

    const first = await post(owner.token, link.id, { roomId: shared.id });
    const body = (await expectApplied(first, 200)) as { teacherRoomId: string; moved: { classes: number } };
    expect(body.moved.classes).toBe(1);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).teacherRoomId).toBe(body.teacherRoomId);

    await expectUnchanged(await post(owner.token, link.id, { roomId: shared.id }));
  });

  it('refuses another teacher\'s link with 403', async () => {
    const { link, shared } = await makePair(owner.id, 'forbid');
    const res = await post(other.token, link.id, { roomId: shared.id });
    expect(res.status).toBe(403);
  });

  it('answers 404 NOT_FOUND for a missing link and for a private target', async () => {
    const { link, shared } = await makePair(owner.id, 'nf');
    await expectRefusal(await post(owner.token, crypto.randomUUID(), { roomId: shared.id }), 'NOT_FOUND');
    const { priv: othersPrivate } = await makePair(other.id, 'nf-other');
    await expectRefusal(await post(owner.token, link.id, { roomId: othersPrivate.id }), 'NOT_FOUND');
  });

  // Guard 4 (the link's own room is shared) comes before guard 5 (the target),
  // so any shared target reaches it. The twin itself must be removed first:
  // sharing `priv` would otherwise collide with it on the public identity index.
  it('answers NOW_SHARED when the private room has been shared', async () => {
    const { priv, link, shared } = await makePair(owner.id, 'nowshared');
    const { shared: target } = await makePair(other.id, 'nowshared-other');
    await prisma.room.delete({ where: { id: shared.id } });
    await prisma.room.update({ where: { id: priv.id }, data: { isPublic: true } });
    await expectRefusal(await post(owner.token, link.id, { roomId: target.id }), 'NOW_SHARED');
  });

  it('answers NOT_SAME_ROOM for a shared room with another identity', async () => {
    const { link } = await makePair(owner.id, 'notsame');
    const { shared: unrelated } = await makePair(other.id, 'notsame-other');
    await expectRefusal(await post(owner.token, link.id, { roomId: unrelated.id }), 'NOT_SAME_ROOM');
  });

  it('answers ROOM_IN_USE while a class is in progress', async () => {
    const { link, shared } = await makePair(owner.id, 'running');
    const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + 15);
    await createClassFixture(prisma, {
      teacherId: owner.id, teacherRoomId: link.id, classType: 'Hatha', date,
      startTime: hhmmToTime('10:00'), durationMinutes: 60, roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15), targetRate: new Prisma.Decimal(25),
      minStudents: 2, maxStudents: 10, status: 'in_progress', cancelledAt: null,
    });
    await expectRefusal(await post(owner.token, link.id, { roomId: shared.id }), 'ROOM_IN_USE');
  });

  it('answers 400 for a body without a uuid roomId', async () => {
    const { link } = await makePair(owner.id, 'badbody');
    expect((await post(owner.token, link.id, { roomId: 'nope' })).status).toBe(400);
  });
});
```

Add `import crypto from 'crypto';` to the imports.

- [ ] **Step 2: Run it and see it fail**

Run (once per session: `pnpm run worktree:up`): `pnpm exec vitest run --project integration tests/integration/teacher-rooms-switch-api.test.ts`
Expected: FAIL with 404 (the route does not exist yet).

- [ ] **Step 3: Implement the code, schema and route**

`src/lib/api-error-codes.ts`: add `NOT_SAME_ROOM: 409,` in alphabetical position.

`src/lib/schemas.ts`, under *TEACHER ROOMS*:

```ts
export const switchRoomSchema = z.object({
  roomId: z.string().uuid(),
}).strict();
```

`src/app/api/teacher-rooms/[id]/switch/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondUnchanged,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { switchRoomSchema } from '@/lib/schemas';
import { switchToSharedRoom } from '@/services/room-switch';
import { ROOM_IN_USE_CODE } from '@/services/room-deletion';

export const SWITCH_NOT_SAME_ROOM_MESSAGE =
  "This room's address no longer matches the shared room. Check its details and try again.";
export const SWITCH_CLASS_RUNNING_MESSAGE =
  'A class is running in this room right now. You can switch once it has finished.';

/**
 * Switch a private room link onto the already-shared room with the same
 * identity (issue 259). The rules and guard order are the service's —
 * `switchToSharedRoom` (`src/services/room-switch.ts`).
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, switchRoomSchema);
  if ('error' in parsed) return parsed.error;

  const result = await switchToSharedRoom(prisma, {
    teacherId: session.teacherId,
    teacherRoomId: id,
    sharedRoomId: parsed.data.roomId,
  });

  if (result.ok) {
    switch (result.action) {
      case 'switched':
        return respondOk({
          teacherRoomId: result.teacherRoomId,
          moved: result.moved,
          reusedLink: result.reusedLink,
          capacityClamped: result.capacityClamped,
        });
      case 'unchanged':
        return respondUnchanged<{ teacherRoomId: string }>({ teacherRoomId: result.teacherRoomId });
      default: {
        const unhandledSuccess: never = result;
        return unhandledSuccess;
      }
    }
  }

  switch (result.reason) {
    case 'not_found':
      return respondError('This room is no longer in your rooms.', 404, 'NOT_FOUND');
    case 'forbidden':
      return respondError('Access denied', 403);
    case 'now_shared':
      return respondError('This room is shared now, so there is nothing to switch.', 409, 'NOW_SHARED');
    case 'shared_room_not_found':
      return respondError('That shared room no longer exists.', 404, 'NOT_FOUND');
    case 'not_same_room':
      return respondError(SWITCH_NOT_SAME_ROOM_MESSAGE, 409, 'NOT_SAME_ROOM');
    case 'class_in_progress':
      return respondError(SWITCH_CLASS_RUNNING_MESSAGE, 409, ROOM_IN_USE_CODE);
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
});
```

Check `ROOM_IN_USE_CODE`'s declared type is the literal `'ROOM_IN_USE'` (`src/services/room-deletion.ts`). If it is wider, pass the literal `'ROOM_IN_USE'` instead. `respondError`'s overload needs the literal to infer 409. Check `respondUnchanged`'s generic matches the `NoInfer<T>` signature (`api-utils.ts:42`).

- [ ] **Step 4: Run the tests and see them pass**

Run: `pnpm exec vitest run --project integration tests/integration/teacher-rooms-switch-api.test.ts`
Expected: PASS.
Run: `pnpm run typecheck && pnpm run lint`
Expected: exit 0.

- [ ] **Step 5: Mutation-test the route's mapping**

Commit first. Then:

| # | Mutation | Case expected to fail |
|---|---|---|
| R1 | Map `not_same_room` to `'NOW_SHARED'` | "answers NOT_SAME_ROOM …" |
| R2 | Map `class_in_progress` to 500 by deleting its `case` (the `never` default then fails to compile; record the `tsc` error text, as that *is* the guard) | `pnpm run typecheck` |
| R3 | Return `respondOk` for `unchanged` | "switches, then answers unchanged on a repeat" |

Restore after each and check `git status` is clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-error-codes.ts src/lib/schemas.ts "src/app/api/teacher-rooms/[id]/switch/route.ts" tests/integration/teacher-rooms-switch-api.test.ts
git commit -m "feat(api): POST /api/teacher-rooms/[id]/switch, and NOT_SAME_ROOM (#259)"
```

---

### Task 4: The share panel offers the switch

**Files:**
- Modify: `src/components/settings/share-room-button.tsx`
- Modify: `src/components/settings/share-room-button.test.tsx`
- Modify: `src/app/(teacher)/settings/rooms/[id]/page.tsx:132-136` (pass `teacherRoomId={teacherRoom.id}`)
- Modify, comments only: `src/components/settings/room-match-list.tsx:11-13`; `src/lib/room-search.ts:17-20`

**Interfaces:**
- Consumes: `POST /api/teacher-rooms/[id]/switch` (Task 3); the `NOT_SAME_ROOM`, `NOW_SHARED`, `NOT_FOUND` and `ROOM_IN_USE` codes.
- Produces: `ShareRoomButtonProps` gains `teacherRoomId: string`.

- [ ] **Step 1: Write the failing component tests**

In `share-room-button.test.tsx`:
- Extend the hoisted mock: `const { refreshMock, pushMock } = vi.hoisted(() => ({ refreshMock: vi.fn(), pushMock: vi.fn() }));`, and `useRouter: () => ({ refresh: refreshMock, push: pushMock })`.
- Add `teacherRoomId="link-1"` to every existing `render(...)` call.
- Add `const SWITCH_URL = '/api/teacher-rooms/link-1/switch';` and a helper `mockSearchThenSwitch(rooms, answer)` shaped like `mockSearchThenPublish`, matching `SWITCH_URL` with method `POST`.
- Replace the body of `'removes the confirm entirely on an exact identity match'` so that it still asserts the `Share room` button is absent, and also asserts `screen.getByRole('button', { name: 'Switch to shared room' })` is present and that the old sentence is gone: `expect(screen.queryByText(/Settings › Rooms › Add room/)).toBeNull()`.

New cases:

```ts
  it('posts the exact match to the switch route and goes to the rooms list', async () => {
    mockSearchThenSwitch([room({ id: 'exact' })], {
      ok: true, body: { data: { teacherRoomId: 'shared-link', moved: { templates: 0, classes: 1 } } },
    });
    render(<ShareRoomButton roomId="mine" teacherRoomId="link-1" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to shared room' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/settings/rooms'));
    const post = calls().find(([url]) => url === SWITCH_URL);
    expect(JSON.parse(String((post?.[1] as { body?: string }).body))).toEqual({ roomId: 'exact' });
  });

  it('treats an unchanged answer as a successful switch', async () => {
    mockSearchThenSwitch([room({ id: 'exact' })], {
      ok: true, body: { data: { teacherRoomId: 'shared-link' }, outcome: 'unchanged' },
    });
    render(<ShareRoomButton roomId="mine" teacherRoomId="link-1" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to shared room' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/settings/rooms'));
  });

  it.each([
    ['NOT_SAME_ROOM', true],
    ['NOW_SHARED', true],
    ['NOT_FOUND', true],
    ['ROOM_IN_USE', false],
  ] as const)('shows the %s refusal inline (refresh: %s)', async (code, refreshes) => {
    const message = `refusal for ${code}`;
    mockSearchThenSwitch([room({ id: 'exact' })], { ok: false, body: { error: { code, message } } });
    render(<ShareRoomButton roomId="mine" teacherRoomId="link-1" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to shared room' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', message);
    expect(pushMock).not.toHaveBeenCalled();
    if (refreshes) await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    else expect(refreshMock).not.toHaveBeenCalled();
  });
```

Add `beforeEach(() => { refreshMock.mockReset(); pushMock.mockReset(); })` if the file does not already reset both spies.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run --project components src/components/settings/share-room-button.test.tsx`
Expected: FAIL. There is no "Switch to shared room" button yet, and TypeScript flags the unknown `teacherRoomId` prop.

- [ ] **Step 3: Implement**

In `share-room-button.tsx`:
- Add `teacherRoomId: string;` to `ShareRoomButtonProps`, and destructure it.
- Replace the docblock paragraph "Switching to a room that already holds the identity is #259, not built — …" with: "On an exact identity match the share is replaced by a switch onto the shared room (`POST /api/teacher-rooms/[id]/switch`, issue 259). The match list stays read-only: the exact match is one room, so the action belongs to the panel, not to a row."
- Add a `switching` state and a handler:

```ts
  async function handleSwitch(sharedRoomId: string) {
    setSwitching(true);
    setError('');
    try {
      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: sharedRoomId }),
      });
      // Applied or unchanged: this room is archived now, so its page is not
      // where the teacher belongs — the landing ArchiveRoomButton uses.
      if (res.ok) {
        router.push('/settings/rooms');
        return;
      }
      const { code, message } = await readError(res, 'Failed to switch rooms.');
      setError(message);
      // These three mean the page describes a room that no longer looks the
      // way it was rendered. ROOM_IN_USE does not: the teacher waits for the
      // running class and tries again.
      if (code === 'NOT_SAME_ROOM' || code === 'NOW_SHARED' || code === 'NOT_FOUND') {
        router.refresh();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSwitching(false);
    }
  }
```

- Replace the exact-match paragraph with the verbatim copy from *Global Constraints*.
- In the button row, render the action before Cancel only when `exact` is set:

```tsx
        {exact && (
          <Button onClick={() => handleSwitch(exact.id)} disabled={switching}>
            {switching ? 'Switching...' : 'Switch to shared room'}
          </Button>
        )}
```

In `page.tsx`, pass `teacherRoomId={teacherRoom.id}`.

Comment corrections: in `room-match-list.tsx:11-13`, replace "(switching to an existing room is #259, not built)" with "(the share panel's switch acts on the exact match, not on a row)". In `room-search.ts:17-20`, replace the sentence saying #259 will rewrite the `findIdentityMatch` line with one stating what is true now: the share panel's exact match now offers the switch. Then run `grep -rn "#259\|not built" src` and give each hit a verdict in the report.

- [ ] **Step 4: Run the tests and see them pass**

Run: `pnpm exec vitest run --project components src/components/settings/share-room-button.test.tsx src/components/settings/room-match-list.test.tsx`
Expected: PASS.
Run: `pnpm run typecheck && pnpm run lint`
Expected: exit 0.

- [ ] **Step 5: Mutation-test the refresh split**

Commit first. Then:

| # | Mutation | Case expected to fail |
|---|---|---|
| U1 | Add `code === 'ROOM_IN_USE' ||` to the refresh condition | "shows the ROOM_IN_USE refusal inline (refresh: false)" |
| U2 | Replace `router.push('/settings/rooms')` with `router.refresh()` | "posts the exact match …" and "treats an unchanged answer …" |

Restore after each and check `git status` is clean.

- [ ] **Step 6: See it in the running app**

Use the `verify` skill's recipe against this worktree's app (`pnpm run worktree:up`, its port from `.env`):
1. Sign in as a seeded teacher.
2. Create a private room, then as another teacher share a room with the same address, floor and room name.
3. Open the first teacher's room page and choose "Share with other teachers". Confirm the panel shows the new copy and the switch button.
4. Switch. Confirm you land on `/settings/rooms`, the shared room is listed with its capacity and rate, and the private one appears under *Archived rooms*.

Judge the panel at 100% zoom. Record screenshots in the task report.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/share-room-button.tsx src/components/settings/share-room-button.test.tsx "src/app/(teacher)/settings/rooms/[id]/page.tsx" src/components/settings/room-match-list.tsx src/lib/room-search.ts
git commit -m "feat(settings): the share panel's exact match offers a switch to the shared room (#259)"
```

---

## Finish

- [ ] `pnpm run verify` (typecheck, lint, the whole suite, lockfile, migrations, visual-baseline freshness). Record the vitest project totals and their arithmetic for the PR body.
- [ ] `pnpm exec prisma validate` is clean, and `pnpm run check-migrations` shows no drift. No migration was added.
- [ ] Sweep for what this branch invalidated: `grep -rn "moves a class between rooms\|never changes rooms\|#259\|not built\|add it from Settings" src prisma docs --exclude-dir=superpowers`. Give each hit a verdict.
- [ ] `pnpm run worktree:down`.
