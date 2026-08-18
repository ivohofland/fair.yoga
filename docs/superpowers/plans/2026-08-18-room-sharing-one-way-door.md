# Room sharing: a deliberate act, not a default (#73) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms are born private; sharing one becomes a deliberate, explained, duplicate-checked action behind its own route, and can never again happen as a side effect of a field update.

**Architecture:** Three defaults flip to private (create form, Zod schema, Postgres column). `isPublic` is removed from `updateRoomSchema` entirely, so `PUT /api/rooms/[id]` rejects it with a 400 and can no longer reach the public identity index. A new `POST /api/rooms/[id]/publish` becomes the sole door, guarded creator-first, with the two-shape collision catch narrowed to the one shape it can now hit. The UI gains a shared explanation block, a shared duplicate search, and a two-step confirm; `add-room-flow.tsx` is then split into three step components as a behaviour-neutral final commit.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma + PostgreSQL, Zod, Vitest (projects: `unit`, `components`, `integration`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-18-room-sharing-one-way-door-design.md`

## Global Constraints

- **TypeScript `strict: true`. No `any`, no implicit types.** Non-negotiable.
- **Test-first.** Write the failing test, see it fail with the stated message, then implement. Every task below is ordered that way; do not reorder.
- **Prove each guard bites.** Where a step says *Mutation*, apply it, record the **exact** failure text in the commit or task report, restore, and re-run. A guard that cannot fail certifies nothing.
- **Teacher-facing prose says "shared", never "public".** `isPublic`, `Room_public_identity_unique` and the `/publish` route path keep the wire vocabulary. This seam is deliberate — see spec §3.
- **`src/lib/room-identity.ts` must stay import-free.** It is value-imported by `'use client'` components; anything reaching `@/lib/log` (pino, server-only) breaks `npm run build` while still passing `npm run verify`.
- **Never edit an applied migration.** New migrations only, via `npx prisma migrate dev --name <description>`.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote any path containing parentheses: `"src/app/(teacher)/..."`.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project needs it live. Without it you get a wall of `ECONNREFUSED`.
- **Commit per task.** The PR is rebase-merged, so the history is the record.

## Measured baseline

Recorded before any change so the after-figures are checkable. **Re-measure rather than inheriting these** — a branch's own review can add tests this prediction cannot know about.

| Fact | Value | How derived |
|---|---|---|
| `prisma.room.create` sites in `tests/` | **38** = 7 explicit `isPublic` + 31 relying on the column default | classified per-site, see Task 1 |
| `prisma.room.create` sites in `prisma/seed.ts` | **4**, all explicit (`:331`, `:346`, `:361`, `:414`) | grep |
| `add-room-flow.tsx` | **441 lines**, **22** `useState` (23 lines mention it; one is the import) | `wc -l`, `grep -c` |
| Tests exercising `GET /api/rooms` search params | **0** | `grep -rn "postcode=\|street=" tests/` returns nothing |

Run `npm test` once before Task 1 and record files and tests per project. You will need the before-figure for the PR body.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | `Room.isPublic` default flips to `false` | 1 |
| `prisma/migrations/<ts>_room_is_public_defaults_private/` | the `ALTER COLUMN … SET DEFAULT false` | 1 |
| `src/lib/room-identity.ts` | **new** — the identity predicate mirroring `Room_public_identity_unique` | 2 |
| `src/lib/room-identity.test.ts` | **new** — byte-exactness, incl. case and whitespace variants | 2 |
| `tests/integration/room-identity-index.test.ts` | **new** — predicate and index agree, round-tripped through Postgres | 2 |
| `src/app/api/rooms/[id]/publish/route.ts` | **new** — the sole door into `isPublic: true` | 3 |
| `tests/integration/rooms-publish-api.test.ts` | **new** — four refusals, the ordering pin, the happy path | 3 |
| `src/lib/schemas.ts` | `updateRoomSchema` loses `isPublic`; `createRoomSchema` gains `.default(false)` | 4, 5 |
| `src/lib/schemas.test.ts` | the `updateRoomSchema` KNOWN GAP entry is deleted | 4 |
| `src/app/api/rooms/[id]/route.ts` | PUT catch narrows to one shape; comment rewritten; prose reworded | 4, 5 |
| `src/app/api/rooms/route.ts` | `?? true` deleted; prose reworded | 5 |
| `tests/integration/rooms-api.test.ts` | collision test re-pointed out; 400 test added; stale comments corrected | 4, 5 |
| `src/components/settings/public-room-notice.tsx` | **new** — the one copy block | 6 |
| `src/lib/room-search.ts` | **new** — `searchPublicRooms` + the `RoomResult` type | 6 |
| `src/components/settings/room-match-list.tsx` | **new** — rows; clickable iff `onSelect` | 6 |
| `src/components/settings/share-room-button.tsx` | **new** — two-step confirm with the duplicate branch | 7 |
| `src/app/(teacher)/settings/rooms/[id]/page.tsx` | mounts the share action when `canEditRoom` | 7 |
| `src/components/settings/add-room-flow.tsx` | unticked checkbox + notice; then split to a step router | 6, 8, 9 |
| `src/components/settings/room-{search,create,settings}-step.tsx` | **new** — the three steps | 9 |

---

## Task 1: Rooms default to private in the database

Ordered first deliberately: **this is the only task whose blast radius is unmeasured.** 31 of 38 test fixtures create rooms without `isPublic` and today get public ones. Spot-checks (`tests/integration/full-flow.test.ts:125`, `tests/e2e/booking.spec.ts:35`) show the safe pattern — `createdById: teacherId`, then a `prisma.teacherRoom.create` for the *same* teacher, via raw Prisma, so no route guard ever runs. But 2 of 31 were checked, not 31. Discovering a fixture wave here is cheap; discovering it at Task 8 is not.

Flipping public → private **loosens** PUT and DELETE (their guards 403 on *public*) and **tightens** only two things: cross-teacher attach via `POST /api/teacher-rooms`, and the `isPublic: true` filter in the `GET /api/rooms` search — which no test exercises.

**Files:**
- Modify: `prisma/schema.prisma` (`Room.isPublic`)
- Create: `prisma/migrations/<timestamp>_room_is_public_defaults_private/migration.sql` (generated)
- Create: `tests/integration/room-default-privacy.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Room.isPublic` defaults to `false` at the database level. Later tasks assume a room created without the field is private.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/room-default-privacy.test.ts`:

```ts
/**
 * The column default, pinned on its own.
 *
 * This is deliberately NOT tested through the API. `createRoomSchema` also
 * defaults `isPublic` to false (Task 5), so an end-to-end assertion would
 * pass with either layer removed and certify neither. The two layers are
 * belt and braces; each gets its own test at its own level.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

describe('Room.isPublic column default', () => {
  afterAll(async () => {
    await prisma.room.deleteMany({ where: { address: `${suffix} Default St` } });
    await prisma.teacher.deleteMany({ where: { bio: `${suffix} default-privacy` } });
    await prisma.$disconnect();
  });

  it('creates a private room when isPublic is omitted', async () => {
    const account = await prisma.account.create({
      data: { email: `${suffix}-default@example.com` },
    });
    const teacher = await prisma.teacher.create({
      data: { accountId: account.id, name: 'Default Privacy', bio: `${suffix} default-privacy` },
    });

    const room = await prisma.room.create({
      data: {
        venueName: 'Default Studio',
        address: `${suffix} Default St`,
        city: 'Amsterdam',
        postcode: '1234DP',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 10,
        createdById: teacher.id,
        // isPublic deliberately omitted — the column default is what is under test
      },
    });

    expect(room.isPublic).toBe(false);
  });
});
```

> **Verify before writing:** the `Teacher` and `Account` field names above are copied from existing fixtures. Open `prisma/schema.prisma` and confirm `Teacher` has `accountId`, `name` and `bio`, and that `Account` requires only `email`. If a required field is missing, add it and **report the drift** — do not silently work around it.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project integration tests/integration/room-default-privacy.test.ts
```

Expected: FAIL — `expected true to be false`.

- [ ] **Step 3: Flip the column default**

In `prisma/schema.prisma`, model `Room`:

```prisma
  isPublic    Boolean  @default(false)
```

- [ ] **Step 4: Generate the migration**

```bash
npx prisma migrate dev --name room_is_public_defaults_private
```

Expected: one new migration directory containing an `ALTER TABLE "Room" ALTER COLUMN "isPublic" SET DEFAULT false;`. Read the generated SQL and confirm it contains **no** `UPDATE` — existing rows must keep their current value. If Prisma proposes a data change, stop and report it.

- [ ] **Step 5: Run the test and watch it pass**

```bash
npx vitest run --project integration tests/integration/room-default-privacy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the FULL suite — this is the point of the task**

```bash
npm test
```

Expected: green. **If anything fails, it is a fixture that was silently depending on rooms being public.** Fix it by adding an explicit `isPublic: true` to that fixture — never by reverting the default — and record in the task report which files needed it and why. This list is a genuine finding for the PR body.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/integration/room-default-privacy.test.ts
git commit -m "feat: a room created without a choice is private (#73)"
```

---

## Task 2: The identity predicate, and proof it agrees with the index

**Files:**
- Create: `src/lib/room-identity.ts`
- Create: `src/lib/room-identity.test.ts`
- Create: `tests/integration/room-identity-index.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface RoomIdentity { address: string; floor: string; roomName: string }`
  - `sameRoomIdentity(a: RoomIdentity, b: RoomIdentity): boolean`
  - `findIdentityMatch<T extends RoomIdentity>(candidates: readonly T[], room: RoomIdentity): T | undefined`

  Task 7 consumes `findIdentityMatch`. No server code consumes this module — see the docblock.

- [ ] **Step 1: Write the failing unit test**

Create `src/lib/room-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sameRoomIdentity, findIdentityMatch } from './room-identity';

const base = { address: 'Prinsengracht 42', floor: '2', roomName: 'Studio A' };

describe('sameRoomIdentity', () => {
  it('matches when all three fields are identical', () => {
    expect(sameRoomIdentity(base, { ...base })).toBe(true);
  });

  it('differs on address, on floor, and on roomName independently', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'Keizersgracht 1' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, floor: '3' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, roomName: 'Studio B' })).toBe(false);
  });

  // The two cases below are the point of this file.
  //
  // `Room_public_identity_unique` is a plain btree over three `text` columns
  // with no `citext` and no `lower()`, so Postgres compares them byte for
  // byte. This predicate must do the same. The realistic regression here is
  // not a wrong boolean — it is someone adding `.toLowerCase()` or `.trim()`
  // to make matching "more helpful". Every test above passes against that
  // version; only these two fail.
  //
  // A predicate STRICTER than the index refuses a share Postgres would have
  // accepted, and does it invisibly: the teacher is told "already shared"
  // about a room that is neither theirs nor the same. A predicate LOOSER than
  // the index merely lets the write reach the 409 that already exists. Only
  // the second is recoverable, so this one copies the index exactly.
  //
  // Duplicates that differ only by case therefore remain possible. That is
  // pre-existing (#196 chose this key), it is tracked as #260, and the
  // mitigation is the neighbourhood search putting both in front of a human.
  it('treats case variants as different rooms, because the index does', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'prinsengracht 42' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, roomName: 'studio a' })).toBe(false);
  });

  it('treats whitespace variants as different rooms, because the index does', () => {
    expect(sameRoomIdentity(base, { ...base, address: 'Prinsengracht 42 ' })).toBe(false);
    expect(sameRoomIdentity(base, { ...base, floor: ' 2' })).toBe(false);
  });
});

describe('findIdentityMatch', () => {
  it('returns the matching candidate', () => {
    const other = { address: 'Prinsengracht 42', floor: '3', roomName: 'Studio A', id: 'b' };
    const hit = { ...base, id: 'a' };
    expect(findIdentityMatch([other, hit], base)).toBe(hit);
  });

  it('returns undefined when only same-street neighbours are present', () => {
    const neighbour = { address: 'Prinsengracht 42', floor: '9', roomName: 'Attic', id: 'c' };
    expect(findIdentityMatch([neighbour], base)).toBeUndefined();
  });

  it('returns undefined for an empty candidate list', () => {
    expect(findIdentityMatch([], base)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/lib/room-identity.test.ts
```

Expected: FAIL — `Failed to resolve import "./room-identity"`.

- [ ] **Step 3: Write the module**

Create `src/lib/room-identity.ts`:

```ts
/**
 * The identity a shared room occupies in the commons.
 *
 * This mirrors `Room_public_identity_unique`, declared in
 * `prisma/migrations/20260811202634_teacher_slot_unique_indexes/migration.sql:33`:
 *
 *     CREATE UNIQUE INDEX "Room_public_identity_unique"
 *       ON "Room" ("address", "floor", "roomName") WHERE "isPublic" = true;
 *
 * Three raw `text` columns — no `citext`, no `lower()` — so the comparison
 * below is byte-exact on purpose. Do not add `.toLowerCase()` or `.trim()`
 * here without changing the index in the same commit: a predicate stricter
 * than the index refuses shares the database would have accepted, and the
 * refusal is invisible to everyone including the teacher.
 *
 * Consequence, tracked as #260: two rooms differing only by case or trailing
 * whitespace are distinct to both this predicate and the index. The
 * neighbourhood search in the sharing flow surfaces both to a human, which is
 * the mitigation that flow relies on.
 *
 * Import-free by requirement. `share-room-button.tsx` is a client component
 * and value-imports this; a transitive edge to `@/lib/log` (pino, server-only)
 * would break `npm run build` while still passing `npm run verify`. Same
 * reason `src/lib/tiers.ts` and `src/lib/class-fields.ts` are import-free.
 *
 * The server does not use this. `POST /api/rooms/[id]/publish` lets the index
 * refuse, exactly as `POST /api/rooms` already does and for the reason stated
 * there. This module exists so the rule is named, unit-tested and greppable
 * rather than inlined in a component, where drift from the index would be
 * invisible.
 */
export interface RoomIdentity {
  address: string;
  floor: string;
  roomName: string;
}

export function sameRoomIdentity(a: RoomIdentity, b: RoomIdentity): boolean {
  return a.address === b.address && a.floor === b.floor && a.roomName === b.roomName;
}

export function findIdentityMatch<T extends RoomIdentity>(
  candidates: readonly T[],
  room: RoomIdentity,
): T | undefined {
  return candidates.find((candidate) => sameRoomIdentity(candidate, room));
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --project unit src/lib/room-identity.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation — prove the byte-exactness tests bite**

Change `sameRoomIdentity` to lowercase both sides:

```ts
return a.address.toLowerCase() === b.address.toLowerCase()
  && a.floor === b.floor && a.roomName === b.roomName;
```

Re-run. **Expected: the case-variant test fails and the whitespace test still passes** — record both facts. That asymmetry is the evidence: the four "obvious" tests above sail straight through this mutation. Restore, re-run, confirm green.

- [ ] **Step 6: Write the failing agreement test**

This is stronger than Step 1's unit tests: it detects drift in *either* direction, which no test of the function alone can do.

Create `tests/integration/room-identity-index.test.ts`:

```ts
/**
 * `sameRoomIdentity` and `Room_public_identity_unique` must agree.
 *
 * The unit tests in src/lib/room-identity.test.ts pin the predicate against
 * its own docblock. This pins it against Postgres: two rooms the predicate
 * calls DIFFERENT must both be insertable as shared, and two it calls the
 * SAME must not. If either the predicate or the index changes without the
 * other, exactly one of these fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';
import { sameRoomIdentity } from '@/lib/room-identity';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const address = `${suffix} Agreement St`;
const variantAddress = address.toLowerCase();

let teacherId: string;

function shared(addr: string, floor: string, roomName: string) {
  return prisma.room.create({
    data: {
      venueName: 'Agreement Studio',
      address: addr,
      city: 'Amsterdam',
      postcode: '1234AG',
      floor,
      roomName,
      maxCapacity: 10,
      createdById: teacherId,
      isPublic: true,
    },
  });
}

beforeAll(async () => {
  const account = await prisma.account.create({
    data: { email: `${suffix}-agreement@example.com` },
  });
  const teacher = await prisma.teacher.create({
    data: { accountId: account.id, name: 'Agreement', bio: `${suffix} agreement` },
  });
  teacherId = teacher.id;
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address: { in: [address, variantAddress] } } });
  await prisma.teacher.deleteMany({ where: { bio: `${suffix} agreement` } });
  await prisma.$disconnect();
});

describe('sameRoomIdentity agrees with Room_public_identity_unique', () => {
  it('accepts as shared two rooms the predicate calls different', async () => {
    // Guard the test's own premise: if the predicate ever starts calling
    // these the same, this assertion says so before Postgres is consulted.
    expect(
      sameRoomIdentity(
        { address, floor: '1', roomName: 'Hall' },
        { address: variantAddress, floor: '1', roomName: 'Hall' },
      ),
    ).toBe(false);

    await shared(address, '1', 'Hall');
    await expect(shared(variantAddress, '1', 'Hall')).resolves.toBeDefined();
  });

  it('refuses as shared a second room the predicate calls the same', async () => {
    expect(
      sameRoomIdentity(
        { address, floor: '2', roomName: 'Annex' },
        { address, floor: '2', roomName: 'Annex' },
      ),
    ).toBe(true);

    await shared(address, '2', 'Annex');
    await expect(shared(address, '2', 'Annex')).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run it**

```bash
npx vitest run --project integration tests/integration/room-identity-index.test.ts
```

Expected: PASS, 2 tests. (The module already exists from Step 3, so this one passes on first run — its failing state was proved in Step 5's mutation, which breaks the first assertion of the first test.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/room-identity.ts src/lib/room-identity.test.ts tests/integration/room-identity-index.test.ts
git commit -m "feat: the identity rule the index enforces, written down once (#73)"
```

---

## Task 3: `POST /api/rooms/[id]/publish` — the sole door

**Files:**
- Create: `src/app/api/rooms/[id]/publish/route.ts`
- Create: `tests/integration/rooms-publish-api.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `POST /api/rooms/:id/publish` → `200 { data: Room }`, or one of four refusals. Task 7's client consumes the `DUPLICATE_ROOM` code.

| Condition | Status | Code |
|---|---|---|
| No such room | 404 | `NOT_FOUND` |
| Not the creator | 403 | `NOT_ROOM_CREATOR` |
| Already shared | 409 | `ALREADY_SHARED` |
| Identity taken by a shared room | 409 | `DUPLICATE_ROOM` |

> Note: `rooms/[id]/route.ts` answers its 404 with no code (`respondError('Room not found', 404)`). This route codes all four, per the spec. The bare-404 neighbour is the deviation, not this — codes are what let the tests below assert without matching English, which is the lesson `TransitionFailureReason` exists to carry.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/rooms-publish-api.test.ts`:

```ts
/**
 * POST /api/rooms/[id]/publish — the only door into `isPublic: true`.
 *
 * GUARD ORDER IS THE INVERSE OF PUT's AND DELETE's, AND THAT IS DELIBERATE.
 * Those two ask `isPublic?` before `createdById?`, because a shared room is
 * community property no matter who asks. This route asks `createdById?`
 * first, because only the creator may donate. "Make it consistent with its
 * neighbours" is the plausible future edit that breaks it.
 *
 * Which case pins WHICH property matters, and they are not the same case:
 *   - non-creator on a PRIVATE room answers 403 under BOTH orderings. It
 *     pins the product decision and is blind to the order.
 *   - non-creator on an ALREADY-SHARED room is the only case that separates
 *     them: creator-first answers NOT_ROOM_CREATOR, isPublic-first answers
 *     ALREADY_SHARED.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const address = `${suffix} Publish St`;

let creatorId: string;
let creatorToken: string;
let otherToken: string;

function publish(token: string, id: string) {
  return fetch(`${BASE_URL}/api/rooms/${id}/publish`, {
    method: 'POST',
    headers: { cookie: cookie(token) },
  });
}

function makeRoom(roomName: string, isPublic: boolean, createdById = creatorId) {
  return prisma.room.create({
    data: {
      venueName: 'Publish Studio',
      address,
      city: 'Amsterdam',
      postcode: '1234PB',
      floor: '1',
      roomName,
      maxCapacity: 10,
      createdById,
      isPublic,
    },
  });
}

beforeAll(async () => {
  const creator = await seedSession(prisma, `${suffix}-creator`, { teacher: true });
  creatorId = creator.teacherId;
  creatorToken = creator.token;
  const other = await seedSession(prisma, `${suffix}-other`, { teacher: true });
  otherToken = other.token;
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address } });
  await prisma.$disconnect();
});

describe('POST /api/rooms/[id]/publish', () => {
  it('shares the creator\'s own private room', async () => {
    const room = await makeRoom('Happy', false);
    const res = await publish(creatorToken, room.id);
    expect(res.status).toBe(200);

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.isPublic).toBe(true);
  });

  it('answers 404 for a room that does not exist', async () => {
    const res = await publish(creatorToken, '00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  // PRODUCT DECISION — blind to guard order by construction.
  it('refuses a non-creator, and leaves the room private', async () => {
    const room = await makeRoom('NotYours', false);
    const res = await publish(otherToken, room.id);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NOT_ROOM_CREATOR');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.isPublic).toBe(false);
  });

  // GUARD ORDER — the only case that can detect a swap.
  it('answers a non-creator on an already-shared room with NOT_ROOM_CREATOR, not ALREADY_SHARED', async () => {
    const room = await makeRoom('SharedNotYours', true);
    const res = await publish(otherToken, room.id);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NOT_ROOM_CREATOR');
  });

  it('refuses the creator re-sharing an already-shared room', async () => {
    const room = await makeRoom('AlreadyShared', true);
    const res = await publish(creatorToken, room.id);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('ALREADY_SHARED');
  });

  it('refuses when a shared room already holds that identity, and leaves both rows alone', async () => {
    const holder = await makeRoom('Contested', true);
    const mine = await prisma.room.create({
      data: {
        venueName: 'Publish Studio',
        address,
        city: 'Amsterdam',
        postcode: '1234PB',
        floor: '1',
        roomName: 'Contested',
        maxCapacity: 10,
        createdById: creatorId,
        isPublic: false,
      },
    });

    const res = await publish(creatorToken, mine.id);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('DUPLICATE_ROOM');
    expect(json.error.message).toBe('A shared room at this address already exists');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: mine.id } });
    expect(after.isPublic).toBe(false);
    const stillShared = await prisma.room.findUniqueOrThrow({ where: { id: holder.id } });
    expect(stillShared.isPublic).toBe(true);
  });
});
```

> **Verify before writing:** open `tests/helpers.ts` and confirm the signature of `seedSession` and `cookie`. The call above assumes `seedSession(prisma, label, { teacher: true })` returning `{ teacherId, token }`. **Copy the real signature** from an existing caller — `tests/integration/rooms-api.test.ts` is the closest neighbour — and fix this test to match. Report the correction.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project integration tests/integration/rooms-publish-api.test.ts
```

Expected: every case fails with `404` (Next.js has no such route yet).

- [ ] **Step 3: Write the route**

Create `src/app/api/rooms/[id]/publish/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

/**
 * Sharing a room — the only write in the app that can set `isPublic: true`.
 *
 * `updateRoomSchema` deliberately does not accept the field, so a generic
 * field update cannot flip it as a side effect. That was #73: the flip was
 * reachable from `PUT /api/rooms/[id]`, and a shared room is read-only and
 * undeletable for everyone including its creator (#52/#60), so one careless
 * body permanently froze a teacher's own room.
 *
 * GUARD ORDER IS THE INVERSE OF PUT's AND DELETE's, ON PURPOSE. Those ask
 * `isPublic?` first: a shared room is community property regardless of who
 * asks, and the creator may have left the platform. This route asks
 * `createdById?` first: only the creator may donate a room to the commons.
 * Reordering these to "match" the neighbours would answer a non-creator's
 * request about an already-shared room with ALREADY_SHARED instead of
 * NOT_ROOM_CREATOR — pinned in tests/integration/rooms-publish-api.test.ts.
 *
 * No pre-check for the duplicate, for the reason `POST /api/rooms` states at
 * src/app/api/rooms/route.ts:60-68: a `findFirst` guard in front would only
 * make this catch reachable under a race, and untestable except by one.
 *
 * ONE index shape, not two. The row is private on the way in and shared on
 * the way out, so it can only ever collide on `Room_public_identity_unique`;
 * `Room_private_identity_unique` is the index it leaves.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404, 'NOT_FOUND');

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can share this room', 403, 'NOT_ROOM_CREATOR');
  }

  if (room.isPublic) {
    return respondError('This room is already shared', 409, 'ALREADY_SHARED');
  }

  try {
    const updated = await prisma.room.update({
      where: { id },
      data: { isPublic: true },
    });
    return respondOk(updated);
  } catch (err) {
    if (isUniqueConflictOn(err, ['address', 'floor', 'roomName'])) {
      return respondError(
        'A shared room at this address already exists',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }
});
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx vitest run --project integration tests/integration/rooms-publish-api.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation — prove the guard-order test bites**

Swap the two guards so `isPublic` is checked first:

```ts
  if (room.isPublic) {
    return respondError('This room is already shared', 409, 'ALREADY_SHARED');
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can share this room', 403, 'NOT_ROOM_CREATOR');
  }
```

Re-run. **Expected: exactly one test fails** — *"answers a non-creator on an already-shared room with NOT_ROOM_CREATOR"*, with `expected 409 to be 403`. Record that the *other* non-creator test still passes; that asymmetry is the evidence the two cases pin different properties. Restore, re-run, confirm 6 green.

- [ ] **Step 6: Mutation — prove the duplicate catch bites**

Narrow the catch to the private shape:

```ts
    if (isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])) {
```

Re-run. Expected: the DUPLICATE_ROOM test fails — the `P2002` falls through to `withErrorHandler`'s generic fallback and the response is a **500**. Record the exact text. Restore, re-run.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/rooms/[id]/publish/route.ts" tests/integration/rooms-publish-api.test.ts
git commit -m "feat: sharing a room gets its own door, guarded creator-first (#73)"
```

---

## Task 4: `PUT /api/rooms/[id]` can no longer flip the bit

**Files:**
- Modify: `src/lib/schemas.ts` (`updateRoomSchema`, currently `:288-299`)
- Modify: `src/lib/schemas.test.ts` (delete the `updateRoomSchema` entry, `:420-424`)
- Modify: `src/app/api/rooms/[id]/route.ts` (comment `:99-106`, catch `:113-116`, ternary `:119`)
- Modify: `tests/integration/rooms-api.test.ts` (move one test out, add one, correct two comments)

**Interfaces:**
- Consumes: `POST /api/rooms/:id/publish` from Task 3 — the relocated collision test targets it.
- Produces: `updateRoomSchema` no longer has an `isPublic` key.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/rooms-api.test.ts`, inside the existing PUT describe block:

```ts
  // #73. `updateRoomSchema` is `.strict()`, so dropping `isPublic` from it
  // does not make this request silently ignore the field — it makes the
  // request invalid. An old client is told, not quietly given different
  // behaviour. Sharing has its own route now; see
  // tests/integration/rooms-publish-api.test.ts.
  it('rejects isPublic in the body outright, and leaves the room private', async () => {
    const room = await makeRoom('Strict', false);
    const res = await put(creatorToken, room.id, { isPublic: true });
    expect(res.status).toBe(400);

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.isPublic).toBe(false);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project integration tests/integration/rooms-api.test.ts -t "rejects isPublic in the body"
```

Expected: FAIL — `expected 200 to be 400`, and the follow-up assertion would also fail because the room *did* flip. Both facts are the bug this task removes.

- [ ] **Step 3: Remove the field from the schema**

In `src/lib/schemas.ts`, delete the `isPublic: z.boolean().optional(),` line from `updateRoomSchema` **only**. Leave `createRoomSchema`'s alone — Task 5 changes that one, and the create form still legitimately sends it.

- [ ] **Step 4: Delete the KNOWN GAP entry it was blocking**

In `src/lib/schemas.test.ts`, delete these five lines (`:420-424`) entirely — comment and entry:

```ts
  // KNOWN GAP: no form sends it, and flipping it true is a one-way door — the
  // room can then no longer be edited or deleted, and any teacher may attach.
  // Blocked on #73's isPublic product decision.
  updateRoomSchema: ['isPublic'],
```

**Keep** the `createRoomSchema: ['isPublic'],` entry above it and its comment. The create form still sends the field.

That guard reads `Object.keys(shape)`, so it is now the regression test for the removal: re-adding `isPublic` to `updateRoomSchema` fails `schemas.test.ts` without anyone writing a new test.

- [ ] **Step 5: Narrow the PUT catch and rewrite its comment**

In `src/app/api/rooms/[id]/route.ts`, replace the comment at `:99-106` and the catch below it:

```ts
  // `room.isPublic` is `false` here unconditionally — the guard above refused
  // a currently-shared room — and `updateRoomSchema` no longer accepts
  // `isPublic` at all (#73), so this write cannot change it. The row is
  // private going in and private coming out, which leaves exactly one index
  // it can collide on: `Room_private_identity_unique`.
  //
  // `Room_public_identity_unique` was reachable here until #73, because the
  // same PUT that edited an address could flip the room shared. That flip now
  // lives in `POST /api/rooms/[id]/publish`, and the public-shape catch went
  // with it — the catch follows the capability.
  try {
    const updated = await prisma.room.update({
      where: { id },
      data: updateData,
    });
    return respondOk(updated);
  } catch (err) {
    if (isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])) {
      return respondError(
        // `floor`/`roomName` both default to `""` and are optional free-text,
        // so two genuinely different private rooms at one address, both left
        // blank, collide here too — names the way out, not just the collision.
        'You already have a room at this address. Add a floor or room name to tell them apart.',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }
```

The `parsed.data.isPublic === true` ternary is gone with it — `parsed.data` has no such property any more, so leaving it would fail typecheck.

- [ ] **Step 6: Move the relocated collision test**

`tests/integration/rooms-api.test.ts:628` — *"refuses flipping a private room public onto a slot a public room already holds"* — is **re-pointed, not deleted.** It exists to pin that the catch matches the public index shape; that property now belongs to the publish route, where Task 3's last test already covers it.

Delete that `it(...)` block from `rooms-api.test.ts`, and replace the describe-block docblock above it (`:563-570`) with:

```ts
/**
 * Task 6b (#196), narrowed by #73. The six indexes constrain every write, not
 * just creates. `PUT /api/rooms/[id]` never touches a currently-shared room —
 * the guard in the route refuses it — and since #73 it cannot make a room
 * shared either, so the only identity index it can collide on is
 * `Room_private_identity_unique`.
 *
 * The public-shape case that used to live here moved with the capability, to
 * tests/integration/rooms-publish-api.test.ts.
 */
```

- [ ] **Step 7: Correct the two stale comments in the same file**

`rooms-api.test.ts:115` currently reads:

```ts
  // Room.isPublic defaults to true (the `isPublic` field in prisma/schema.prisma)
  // — passed explicitly throughout, since these fixtures depend on the value.
```

Task 1 made that false. Replace with:

```ts
  // Room.isPublic defaults to FALSE since #73 (prisma/schema.prisma) — passed
  // explicitly throughout anyway, since these fixtures depend on the value
  // rather than on the default.
```

Then check `:236` and `:240`, which quote the message `"Public rooms cannot be edited"`. **Leave the wording alone in this task** — Task 5 reworders both the message and these pins together, so they change in one commit rather than two.

Leave `:244` alone: *"the isPublic flip (third case) is one-way"* is still true. That fixture flips via `prisma.room.update` at `:274`, a raw Prisma write this branch does not touch.

- [ ] **Step 8: Run the affected suites**

```bash
npx vitest run --project unit src/lib/schemas.test.ts
npx vitest run --project integration tests/integration/rooms-api.test.ts
npx vitest run --project integration tests/integration/rooms-publish-api.test.ts
```

Expected: all green. `rooms-api.test.ts` has one test fewer (moved) and one more (the 400) — net unchanged.

- [ ] **Step 9: Mutation — prove the schema removal is pinned twice**

Re-add `isPublic: z.boolean().optional(),` to `updateRoomSchema`. Re-run both suites above.

**Expected: two independent failures** — `schemas.test.ts` fails on the unregistered server-owned field, and `rooms-api.test.ts` fails the 400 test with `expected 200 to be 400`. Record both. Restore, re-run, confirm green.

- [ ] **Step 10: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts "src/app/api/rooms/[id]/route.ts" tests/integration/rooms-api.test.ts
git commit -m "fix: a field update can no longer donate a room to the commons (#73)"
```

---

## Task 5: The API default, and the word teachers read

**Files:**
- Modify: `src/lib/schemas.ts` (`createRoomSchema.isPublic`)
- Modify: `src/app/api/rooms/route.ts` (`:58`, and the two catch messages)
- Modify: `src/app/api/rooms/[id]/route.ts` (the two guard messages, `:30` and `:79`)
- Modify: `tests/integration/rooms-api.test.ts` (message assertions and the comments quoting them)
- Modify: `src/lib/schemas.test.ts` (add the create-default unit test)

**Interfaces:**
- Consumes: nothing
- Produces: `z.infer<typeof createRoomSchema>['isPublic']` is `boolean`, not `boolean | undefined`.

- [ ] **Step 1: Write the failing unit test**

Add to `src/lib/schemas.test.ts`:

```ts
// #73. The schema default and the column default (Task 1) are belt and
// braces, and they mask each other: with the column defaulting false,
// removing this default changes nothing observable through the API. So each
// is tested at its own level — this one here, the column in
// tests/integration/room-default-privacy.test.ts. A single end-to-end
// assertion would pass with either layer removed and certify neither.
describe('createRoomSchema isPublic default', () => {
  it('defaults a room to private when the field is omitted', () => {
    const parsed = createRoomSchema.parse({
      venueName: 'Somewhere',
      address: 'Street 1',
      city: 'Amsterdam',
      postcode: '1234AB',
      maxCapacity: 10,
    });
    expect(parsed.isPublic).toBe(false);
  });

  it('still honours an explicit true', () => {
    const parsed = createRoomSchema.parse({
      venueName: 'Somewhere',
      address: 'Street 1',
      city: 'Amsterdam',
      postcode: '1234AB',
      maxCapacity: 10,
      isPublic: true,
    });
    expect(parsed.isPublic).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/lib/schemas.test.ts -t "createRoomSchema isPublic default"
```

Expected: FAIL — `expected undefined to be false`.

- [ ] **Step 3: Add the default and delete the route's**

In `src/lib/schemas.ts`, `createRoomSchema`:

```ts
  isPublic: z.boolean().optional().default(false),
```

In `src/app/api/rooms/route.ts`, delete line 58 (`const isPublic = body.isPublic ?? true;`) and use `body.isPublic` at both sites that referenced the local — the `data:` object and the catch's message branch. **The route now carries no default of its own**, which is the point: the policy is stated once, at the schema boundary, instead of twice with a chance of disagreeing.

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --project unit src/lib/schemas.test.ts -t "createRoomSchema isPublic default"
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Reword every teacher-facing string**

Four messages. `isPublic`, the index names and the `/publish` path keep the wire vocabulary — see Global Constraints.

| File:line | Was | Becomes |
|---|---|---|
| `rooms/[id]/route.ts:30` | `Public rooms cannot be deleted` | `Shared rooms cannot be deleted` |
| `rooms/[id]/route.ts:79` | `Public rooms cannot be edited` | `Shared rooms cannot be edited` |
| `rooms/route.ts` catch | `A public room at this address already exists` | `A shared room at this address already exists` |
| `rooms/[id]/route.ts` catch | *(unchanged — private-room wording)* | — |

Then update every assertion and comment in `tests/integration/rooms-api.test.ts` that quotes them, including the docblock text at `:236` and `:240` left alone in Task 4.

```bash
grep -n "Public room" src/ tests/ -r
```

Expected after the edit: **no hits.**

- [ ] **Step 6: Run the affected suites**

```bash
npx vitest run --project unit src/lib/schemas.test.ts
npx vitest run --project integration tests/integration/rooms-api.test.ts
npx vitest run --project integration tests/integration/rooms-publish-api.test.ts
```

Expected: all green.

- [ ] **Step 7: Mutation — prove the schema default is pinned independently**

Drop `.default(false)`, leaving `.optional()`. Re-run **both** the unit file and `rooms-api.test.ts`.

**Expected: the unit test fails (`expected undefined to be false`) and the integration suite stays green** — because Task 1's column default still yields a private room. Record that asymmetry explicitly: it is the evidence that these two layers need two tests, and that an end-to-end test would have certified nothing. Restore, re-run.

- [ ] **Step 8: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts src/app/api/rooms/route.ts "src/app/api/rooms/[id]/route.ts" tests/integration/rooms-api.test.ts
git commit -m "feat: the API defaults a room to private, and says 'shared' to teachers (#73)"
```

---

## Task 6: The shared UI units

**Files:**
- Create: `src/components/settings/public-room-notice.tsx`
- Create: `src/lib/room-search.ts`
- Create: `src/components/settings/room-match-list.tsx`
- Create: `src/components/settings/room-match-list.test.tsx`
- Modify: `src/components/settings/add-room-flow.tsx` (use the extracted units)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PublicRoomNotice` — no props
  - `interface RoomResult { id, venueName, roomName, address, city, postcode, floor, maxCapacity }`
  - `searchPublicRooms(postcode: string, street: string): Promise<RoomResult[]>` — throws on network/HTTP failure; callers catch
  - `RoomMatchList` — `{ rooms: readonly RoomResult[]; onSelect?: (room: RoomResult) => void }`

  Task 7 consumes all four. Task 8 consumes `PublicRoomNotice`.

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/room-match-list.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoomMatchList } from './room-match-list';
import type { RoomResult } from '@/lib/room-search';

const rooms: RoomResult[] = [
  {
    id: 'r1', venueName: 'Yoga Loft', roomName: 'Studio A',
    address: 'Prinsengracht 42', city: 'Amsterdam', postcode: '1015DX',
    floor: '2', maxCapacity: 20,
  },
];

describe('RoomMatchList', () => {
  it('renders each room as a button when onSelect is given', async () => {
    const onSelect = vi.fn();
    render(<RoomMatchList rooms={rooms} onSelect={onSelect} />);

    const row = screen.getByRole('button', { name: /Studio A/ });
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(rooms[0]);
  });

  it('renders plain rows with no button when onSelect is omitted', () => {
    render(<RoomMatchList rooms={rooms} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Studio A/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project components src/components/settings/room-match-list.test.tsx
```

Expected: FAIL — `Failed to resolve import "./room-match-list"`.

- [ ] **Step 3: Write the three units**

Create `src/lib/room-search.ts`:

```ts
/**
 * The shared-room lookup both sharing paths run before contributing a room.
 *
 * Deliberately fuzzy: `GET /api/rooms` matches `postcode` and `address` with
 * `contains` + `mode: 'insensitive'`, and returns shared rooms only. That is
 * NOT the same question `Room_public_identity_unique` answers — see
 * `src/lib/room-identity.ts`. This one finds neighbours for a human to judge;
 * that one decides whether the database will accept the write.
 */
export interface RoomResult {
  id: string;
  venueName: string;
  roomName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  maxCapacity: number;
}

export async function searchPublicRooms(
  postcode: string,
  street: string,
): Promise<RoomResult[]> {
  const params = new URLSearchParams({ postcode: postcode.trim(), street: street.trim() });
  const res = await fetch(`/api/rooms?${params}`);
  if (!res.ok) throw new Error('Room search failed');
  const json: { data: RoomResult[] } = await res.json();
  return json.data;
}
```

Create `src/components/settings/public-room-notice.tsx`:

```tsx
/**
 * What sharing a room costs, in one place, for both callers — the create step
 * and the share confirm. One definition so the two cannot drift.
 *
 * Cost first, reassurance second. The reassurance is true and load-bearing:
 * once shared, the room detail page swaps EditRoomForm for
 * EditTeacherRoomForm, so `capacityOverride`, `rentalRate` and
 * `equipmentNotes` become independently editable rather than mirrored from
 * the room's own fields.
 */
export function PublicRoomNotice() {
  return (
    <div className="bg-sand-soft border border-border rounded-card p-4 flex flex-col gap-2">
      <p className="text-ink text-sm font-semibold">Sharing a room is permanent.</p>
      <p className="text-brown text-sm">
        Other teachers can find this room and use it for their own classes. Its venue,
        address, capacity and props can no longer be changed or deleted — by you or by
        anyone else.
      </p>
      <p className="text-brown text-sm">
        Your rate, your capacity and your notes stay private to you, and stay editable.
      </p>
    </div>
  );
}
```

Create `src/components/settings/room-match-list.tsx`:

```tsx
import { formatRoomLocation } from '@/lib/format';
import type { RoomResult } from '@/lib/room-search';

interface RoomMatchListProps {
  rooms: readonly RoomResult[];
  /** Given: rows are selectable buttons. Omitted: rows are read-only. */
  onSelect?: (room: RoomResult) => void;
}

/**
 * Rooms already shared at an address. Selectable when adding a room (pick one
 * instead of creating), read-only when sharing one (switching to an existing
 * room is #259, not built).
 */
export function RoomMatchList({ rooms, onSelect }: RoomMatchListProps) {
  return (
    <div className="mb-4">
      {rooms.map((room) => {
        const body = (
          <>
            <span className="text-base text-ink">
              {formatRoomLocation(room.roomName, room.venueName)}
            </span>
            <span className="type-caption">{room.address}, {room.city}</span>
          </>
        );
        const className = 'w-full text-left flex flex-col gap-1 py-3 border-b border-border';

        return onSelect ? (
          <button key={room.id} type="button" onClick={() => onSelect(room)} className={className}>
            {body}
          </button>
        ) : (
          <div key={room.id} className={className}>{body}</div>
        );
      })}
    </div>
  );
}
```

> **Verify before writing:** confirm `rounded-card` and `type-caption` exist in `src/app/globals.css`. The caption class is copied from `add-room-flow.tsx`'s existing rows; `rounded-card` is an assumption. If it is not a real token, use the radius class the neighbouring cards use and report the correction.

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --project components src/components/settings/room-match-list.test.tsx
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Rewire `add-room-flow.tsx` to the extracted units**

Delete the local `RoomResult` interface (`:12-21`) and import it from `@/lib/room-search`. Replace the body of `handleSearch` so the fetch and JSON parsing come from `searchPublicRooms`, keeping the existing `searching` / `searchError` / `results` state and the same two error strings (`'Search failed. Please try again.'` for a non-OK response, `'Network error. Please try again.'` for a throw). Replace the inline results `.map(...)` with `<RoomMatchList rooms={results} onSelect={handleSelectRoom} />`.

**No behaviour change.** `add-room-flow.test.tsx` must pass untouched — that is the proof.

- [ ] **Step 6: Run the add-room-flow tests**

```bash
npx vitest run --project components src/components/settings/add-room-flow.test.tsx
```

Expected: PASS, unchanged, with **no edits to the test file.** If a test needed changing, the extraction changed behaviour — stop and report rather than editing the test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/room-search.ts src/components/settings/public-room-notice.tsx src/components/settings/room-match-list.tsx src/components/settings/room-match-list.test.tsx src/components/settings/add-room-flow.tsx
git commit -m "refactor: the search, the rows and the notice, extracted for two callers (#73)"
```

---

## Task 7: The share action on the room detail page

**Files:**
- Create: `src/components/settings/share-room-button.tsx`
- Create: `src/components/settings/share-room-button.test.tsx`
- Modify: `src/app/(teacher)/settings/rooms/[id]/page.tsx`

**Interfaces:**
- Consumes: `findIdentityMatch` (Task 2), `POST /api/rooms/:id/publish` and its `DUPLICATE_ROOM` code (Task 3), `PublicRoomNotice` / `searchPublicRooms` / `RoomMatchList` / `RoomResult` (Task 6)
- Produces: `ShareRoomButton` — `{ roomId: string; identity: RoomIdentity; postcode: string }`

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/share-room-button.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareRoomButton } from './share-room-button';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const identity = { address: 'Prinsengracht 42', floor: '2', roomName: 'Studio A' };

function room(over: Partial<{ id: string; floor: string; roomName: string }> = {}) {
  return {
    id: 'other', venueName: 'Yoga Loft', roomName: 'Studio A',
    address: 'Prinsengracht 42', city: 'Amsterdam', postcode: '1015DX',
    floor: '2', maxCapacity: 20, ...over,
  };
}

function mockSearch(rooms: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ data: rooms }),
  }) as unknown as typeof fetch;
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('ShareRoomButton', () => {
  it('offers the confirm when nothing is shared at the address', async () => {
    mockSearch([]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    await userEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Sharing a room is permanent/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  // The fixture below carries BOTH a neighbour and an exact match on purpose.
  // A fixture with only the exact match would pass equally against code that
  // blocks on ANY search result, and could not tell the two behaviours apart.
  it('warns but still allows when only a same-street neighbour is shared', async () => {
    mockSearch([room({ id: 'neighbour', floor: '9', roomName: 'Attic' })]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    await userEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Rooms already shared at this address/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  it('removes the confirm entirely on an exact identity match', async () => {
    mockSearch([
      room({ id: 'neighbour', floor: '9', roomName: 'Attic' }),
      room({ id: 'exact' }),
    ]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    await userEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Already shared/)).toBeDefined();
    // Absent, not disabled — there is no state that would enable it.
    expect(screen.queryByRole('button', { name: /^Share room$/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project components src/components/settings/share-room-button.test.tsx
```

Expected: FAIL — `Failed to resolve import "./share-room-button"`.

- [ ] **Step 3: Write the component**

Create `src/components/settings/share-room-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { PublicRoomNotice } from './public-room-notice';
import { RoomMatchList } from './room-match-list';
import { searchPublicRooms, type RoomResult } from '@/lib/room-search';
import { findIdentityMatch, type RoomIdentity } from '@/lib/room-identity';

interface ShareRoomButtonProps {
  roomId: string;
  identity: RoomIdentity;
  postcode: string;
}

/**
 * Sharing a room, as a two-step inline confirm — the same shape as
 * DeleteRoomButton, and for the same reason: the action is irreversible.
 *
 * The duplicate search runs on OPEN, client-side, not as a server prop. A
 * server-rendered "nothing shared here" goes stale the moment another teacher
 * shares a colliding room, and this control must not be gated on a snapshot a
 * concurrent write can invalidate. The route's DUPLICATE_ROOM stays the
 * authority; this pre-check exists to replace an error with a branch.
 *
 * Switching to a room that already holds the identity is #259, not built —
 * which is why RoomMatchList is rendered without `onSelect` here.
 */
export function ShareRoomButton({ roomId, identity, postcode }: ShareRoomButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [matches, setMatches] = useState<RoomResult[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');

  async function handleOpen() {
    setConfirming(true);
    setError('');
    try {
      setMatches(await searchPublicRooms(postcode, identity.address));
    } catch {
      // A failed lookup must not block the action — the route refuses a real
      // collision regardless. Show nothing rather than a false all-clear.
      setMatches([]);
    }
  }

  async function handleShare() {
    setSharing(true);
    setError('');
    try {
      const res = await fetch(`/api/rooms/${roomId}/publish`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const json: { error?: { message?: string } } = await res.json();
      setError(json.error?.message ?? 'Failed to share this room.');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSharing(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" onClick={handleOpen} className="text-teal text-sm text-left">
        Share with other teachers
      </button>
    );
  }

  const exact = matches ? findIdentityMatch(matches, identity) : undefined;

  return (
    <div className="flex flex-col gap-3">
      {exact ? (
        <>
          <p className="text-ink text-sm font-semibold">Already shared</p>
          <p className="text-brown text-sm">
            {exact.roomName || exact.venueName} at {exact.address} is already shared with all
            teachers. You don&apos;t need to share yours — you can add it from
            Settings › Rooms › Add room.
          </p>
        </>
      ) : (
        <>
          {matches && matches.length > 0 && (
            <>
              <p className="text-ink text-sm font-semibold">Rooms already shared at this address</p>
              <RoomMatchList rooms={matches} />
              <p className="text-brown text-sm">
                If one of these is the same room, there&apos;s no need to share yours.
              </p>
            </>
          )}
          <PublicRoomNotice />
        </>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        {!exact && (
          <Button onClick={handleShare} disabled={sharing || matches === null}>
            {sharing ? 'Sharing...' : 'Share room'}
          </Button>
        )}
        <Button variant="secondary" onClick={() => { setConfirming(false); setMatches(null); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --project components src/components/settings/share-room-button.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation — prove the exact-match branch is not just "any match"**

Replace `findIdentityMatch(matches, identity)` with `matches[0]`. Re-run.

**Expected: the neighbour test fails** (`Already shared` renders and the confirm vanishes) while the other two still pass. That is precisely the failure a single-fixture test could not produce. Restore, re-run.

- [ ] **Step 6: Mount it on the room detail page**

In `src/app/(teacher)/settings/rooms/[id]/page.tsx`, import `ShareRoomButton` and render it inside the final `<section>` alongside archive/unlink/delete, gated on `canEditRoom` — private, and created by this teacher, which is exactly the set of rooms that can be shared:

```tsx
        {canEditRoom && (
          <ShareRoomButton
            roomId={room.id}
            identity={{ address: room.address, floor: room.floor, roomName: room.roomName }}
            postcode={room.postcode}
          />
        )}
```

- [ ] **Step 7: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/share-room-button.tsx src/components/settings/share-room-button.test.tsx "src/app/(teacher)/settings/rooms/[id]/page.tsx"
git commit -m "feat: sharing a room is a two-step confirm that checks for duplicates first (#73)"
```

---

## Task 8: The create checkbox is unticked and explains itself

**Files:**
- Modify: `src/components/settings/add-room-flow.tsx` (`:95`, and the checkbox block near `:373-380`)
- Modify: `src/components/settings/add-room-flow.test.tsx`

**Interfaces:**
- Consumes: `PublicRoomNotice` (Task 6)
- Produces: nothing downstream

- [ ] **Step 1: Write the failing test**

Add to `src/components/settings/add-room-flow.test.tsx`:

```tsx
  // #73. The assertion that matters is on the REQUEST BODY, not the checkbox.
  // An unchecked box that still posts `isPublic: true` is the regression shape
  // this exists to catch, and `not.toBeChecked()` alone sails straight past it.
  it('posts isPublic false when the share checkbox is left alone', async () => {
    // <- Reach the create step exactly as the existing tests in this file do,
    //    then fill the required fields and submit. Copy that setup verbatim
    //    from the neighbouring test rather than inventing a new one.

    const checkbox = screen.getByRole('checkbox', {
      name: /Share this room with other teachers/,
    });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /Create room/ }));

    const call = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .find(([url]) => url === '/api/rooms');
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as { body: string }).body) as { isPublic: boolean };
    expect(body.isPublic).toBe(false);
  });
```

> **Verify before writing:** `add-room-flow.test.tsx` is 125 lines and already drives this flow — open it, copy its existing navigation-to-create-step and fetch-mocking setup exactly, and replace the comment placeholder above with the real steps. Do not invent a second mocking style in the same file.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project components src/components/settings/add-room-flow.test.tsx -t "posts isPublic false"
```

Expected: FAIL twice over — the checkbox is checked, and the body carries `true`.

- [ ] **Step 3: Flip the default and reword**

`src/components/settings/add-room-flow.tsx:95`:

```tsx
  const [isPublic, setIsPublic] = useState(false);
```

Replace the checkbox block with the reworded label and the notice beneath it:

```tsx
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-3 min-h-[44px]">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="w-5 h-5 accent-teal"
              />
              <span className="text-brown text-sm">Share this room with other teachers</span>
            </label>
            <PublicRoomNotice />
          </div>
```

Import `PublicRoomNotice` from `./public-room-notice`.

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --project components src/components/settings/add-room-flow.test.tsx
```

Expected: PASS. If an existing test in this file asserted the old label text, update it — that string genuinely changed.

- [ ] **Step 5: Mutation — prove the body assertion bites where the checkbox one would not**

Set `useState(false)` back to `useState(true)`. Re-run. Expected: both assertions fail. Now instead leave `useState(false)` but hard-code `isPublic: true` in the request body object. Re-run.

**Expected: the checkbox assertion passes and the body assertion fails.** Record that — it is the evidence for why this test asserts the payload. Restore, re-run.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/add-room-flow.tsx src/components/settings/add-room-flow.test.tsx
git commit -m "feat: the share checkbox starts unticked and says what it costs (#73)"
```

---

## Task 9: Split `add-room-flow` into its three steps

Behaviour-neutral by construction, and last on purpose: `add-room-flow.test.tsx` must pass **unchanged** through this task, which is the proof the move changed nothing. If a test needs editing, the split is wrong.

**Files:**
- Create: `src/components/settings/room-search-step.tsx`
- Create: `src/components/settings/room-create-step.tsx`
- Create: `src/components/settings/room-settings-step.tsx`
- Modify: `src/components/settings/add-room-flow.tsx` (becomes a step router)

**Interfaces:**
- Consumes: everything from Tasks 6 and 8
- Produces: nothing downstream

**State split — this reconciles to the measured 22:**

| Home | State | Count |
|---|---|---|
| `add-room-flow` (router) | `postcode`, `street`, `selectedRoom`, `step` | 4 |
| `room-search-step` | `results`, `searching`, `searchError` | 3 |
| `room-create-step` | `venueName`, `roomName`, `floor`, `city`, `maxCapacity`, `equipmentChecks`, `notes`, `isPublic`, `createError`, `creating` | 10 |
| `room-settings-step` | `capacityOverride`, `rentalRate`, `equipmentNotes`, `settingsError`, `saving` | 5 |
| | | **22** |

The four in the router are lifted because they cross a step boundary: `postcode`/`street` are typed in search and seed the create form's address fields, `selectedRoom` is produced by search or create and consumed by settings, and `step` is the router's own.

- [ ] **Step 1: Record the green baseline**

```bash
npx vitest run --project components src/components/settings/add-room-flow.test.tsx
```

Record the test count. It must be identical at Step 5.

- [ ] **Step 2: Extract `room-settings-step.tsx` first**

Least entangled — it consumes only `selectedRoom` and owns 5 states.

Props: `{ selectedRoom: RoomResult; onSaved: () => void; onBack: () => void }`. Move `handleSaveSettings` and the step-3 JSX verbatim. The `router.push('/settings/rooms')` call becomes `onSaved()`, invoked by the parent.

Run the baseline test after this single extraction and confirm the count is unchanged before continuing.

- [ ] **Step 3: Extract `room-create-step.tsx`**

Props: `{ postcode: string; street: string; onCreated: (room: RoomResult) => void; onBack: () => void }`. Move `handleCreateRoom`, the 10 states, and the step-2 JSX including the checkbox and `PublicRoomNotice` from Task 8, verbatim.

Run the baseline test again. Unchanged count.

- [ ] **Step 4: Extract `room-search-step.tsx`**

Props: `{ postcode: string; street: string; onPostcodeChange: (v: string) => void; onStreetChange: (v: string) => void; onSelect: (room: RoomResult) => void; onCreateNew: () => void }`. Move `handleSearch`, the 3 states and the step-1 JSX including `RoomMatchList`.

`add-room-flow.tsx` is now a router over 4 states.

- [ ] **Step 5: Run the baseline test, unchanged**

```bash
npx vitest run --project components src/components/settings/add-room-flow.test.tsx
```

Expected: PASS, **same count as Step 1, with zero edits to the test file.** If the file needed editing, stop and report — behaviour moved when it should not have.

- [ ] **Step 6: Confirm the arithmetic**

```bash
wc -l src/components/settings/add-room-flow.tsx src/components/settings/room-*-step.tsx
grep -c "useState" src/components/settings/add-room-flow.tsx src/components/settings/room-*-step.tsx
```

Record both. The `useState` counts should be 4 / 3 / 10 / 5 plus one import line each. **If they do not sum to 22, say so rather than rounding** — a state that vanished or duplicated in the move is a real defect.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/add-room-flow.tsx src/components/settings/room-search-step.tsx src/components/settings/room-create-step.tsx src/components/settings/room-settings-step.tsx
git commit -m "refactor: add-room-flow becomes a router over three steps (#73)"
```

---

## Task 10: Whole-branch verification

Task reviewers see only their own diff. An entire class of defect — a lint that only exists in the union, a dark test file, a claim corrected in the source but not the spec — is invisible to them.

- [ ] **Step 1: Full verify**

```bash
npm run verify
```

Needs the dev server live on :3000 (the user runs it — do not start or restart it). Expected: typecheck clean, lint clean, all three vitest projects green.

- [ ] **Step 2: Build, which `verify` does not run**

```bash
npm run build
```

This is the only gate that catches a `'use client'` component pulling in `@/lib/log` transitively. `share-room-button.tsx` value-imports `room-identity.ts` and `room-search.ts`; both must stay import-free of server-only modules.

- [ ] **Step 3: Reconcile the §7 artifact list against the actual diff**

Do **not** grep for a keyword — derive the sweep from what changed:

```bash
git diff --stat main...HEAD
```

Open the spec's §7 table and give **each row its own verdict**, naming the file. A wave that corrects four of five things reports success either way; the list is what makes that detectable.

- [ ] **Step 4: Confirm no stale vocabulary or stale claims survive**

```bash
grep -rn "Public room" src/ tests/ docs/superpowers/specs/2026-08-18-room-sharing-one-way-door-design.md
grep -rn "isPublic" src/lib/schemas.ts
grep -rn "defaults to true" tests/integration/rooms-api.test.ts
```

Expected: first returns nothing; second shows `createRoomSchema` only, never `updateRoomSchema`; third returns nothing.

- [ ] **Step 5: Measure the after-figures**

```bash
npm test
```

Record files and tests per project. Reconcile against the baseline taken before Task 1, showing the arithmetic. **Measure — do not use a prediction**, including any in this plan.

- [ ] **Step 6: Push and open the PR**

The PR body must record: which of #73's claims were checked and which held (§1 of the spec — the "API-only" claim is the one that failed); the arithmetic behind every count, including the 38 = 7 + 31 `room.create` classification and any fixtures Task 1 had to make explicit; that `npm run verify` ran all three projects, with the per-project arithmetic; the integration files this branch touched, by path; and what the branch does **not** do — **#259 and #260 are unaffected**, and the read-only lock itself is untouched.

> Write "**#259 and #260 are unaffected**". Never "does not close #259" — GitHub's parser matches the keyword and ignores the negation in front of it, and that has already closed an issue on this repo twice.

---

## Self-review

**Spec coverage.** Every section maps to a task: §2's three defaults → Tasks 1, 5, 8; §2's sole door → Task 3; §3's vocabulary → Task 5; §3's copy and flow → Tasks 6, 7; §4's schema removal → Task 4; §5's modules → Tasks 2, 6, 7, 9; §6's eleven guards → the mutation steps in Tasks 1–8; §7's artifact list → Task 10 Step 3. **No gaps found.**

**Guard coverage against spec §6.** #1 → T4 S9. #2, #3 → T3 S5. #4, #5 → T3 S1/S6. #6 → T2 S5. #7 → T2 S6. #8 → T8 S5. #9 → T5 S7. #10 → T1 S1. #11 → T7 S5. **All eleven placed.**

**Type consistency.** `RoomIdentity` is defined once (T2) and consumed by `ShareRoomButton`'s props (T7). `RoomResult` is defined once in `room-search.ts` (T6), consumed by `RoomMatchList` (T6), `ShareRoomButton` (T7) and all three step components (T9) — and the local duplicate in `add-room-flow.tsx:12-21` is explicitly deleted in T6 S5. `searchPublicRooms` is called with `(postcode, street)` in T6 and `(postcode, identity.address)` in T7 — same positional order, both times.

**Known soft spots, flagged rather than hidden.** Three code blocks depend on details a fresh reader must confirm rather than trust, and each carries a *verify before writing* note at its site: `seedSession`/`cookie` signatures (T3 S1), the `rounded-card` token (T6 S3), and `add-room-flow.test.tsx`'s existing setup idiom (T8 S1). Task 1 Step 6 is the other genuine unknown — 2 of 31 defaulted fixtures were spot-checked, so a fixture wave there is possible and is meant to be discovered at Task 1 rather than Task 8.
