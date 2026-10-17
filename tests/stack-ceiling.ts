import crypto from 'crypto';
import { Prisma, type PrismaClient } from '@/lib/prisma-client';
import { createPrismaClient } from '@/lib/prisma-client';
import { pgErrorOf } from '@/lib/pg-error';
import { expect } from 'vitest';

/**
 * Fixtures for the ceiling tests (#674, #885): a client whose session parses
 * under a lowered `max_stack_depth`, so app-authored row-value SQL can be
 * shown to overflow the parser's stack; a count of the parameters each
 * statement on that client binds, so a sweep can be shown to page its
 * relation loads; and bulk seeders that put more than a page of parents in
 * front of a sweep. Why sweeps page, and the numbers behind each constant:
 * `docs/technical-architecture.md`, "Relation loads over platform-wide sets".
 */

/** The session stack a ceiling client runs under. */
export const CEILING_STACK = '200kB';

/**
 * A parent set larger than a page: a read that loads it unpaged binds more
 * parameters in one statement than any paged read can, and its row-value
 * tuples overflow `CEILING_STACK`.
 */
export const CEILING_ROWS = 1000;

/** The largest composite relation load that binds: 3n + 1 parameters, against a wire-protocol maximum of 65,535. */
export const BIND_LIMIT_PARENTS = 21_844;

type QueryEvents = { $on(event: 'query', cb: (e: Prisma.QueryEvent) => void): void };

/**
 * The client `$on` lives on. Under vitest the undefined-filter guard hands a
 * test-built client back extended (`tests/setup/undefined-filter-guard.ts`),
 * and an extended client sets `$on` to undefined; Prisma's `_originalClient`
 * is the unextended client behind it, and a plain client's own.
 */
function queryEventsOf(client: PrismaClient): QueryEvents {
  const base: unknown = (client as unknown as { _originalClient?: unknown })._originalClient;
  if (typeof (base as Partial<QueryEvents> | undefined)?.$on !== 'function') {
    throw new Error('lowStackClient: no $on on the client or its _originalClient');
  }
  return base as QueryEvents;
}

const peaks = new WeakMap<PrismaClient, { peak: number }>();

/** Parameters bound by one statement, from Prisma's query event. */
function paramCount(event: Prisma.QueryEvent): number {
  const params: unknown = JSON.parse(event.params);
  return Array.isArray(params) ? params.length : 0;
}

/** The most parameters any one statement on `client` has bound since its last reset. */
export function peakBoundParams(client: PrismaClient): number {
  const entry = peaks.get(client);
  if (!entry) throw new Error('peakBoundParams: not a lowStackClient');
  return entry.peak;
}

/** Starts `client`'s peak over, before the read a test measures. */
export function resetBoundParams(client: PrismaClient): void {
  const entry = peaks.get(client);
  if (!entry) throw new Error('resetBoundParams: not a lowStackClient');
  entry.peak = 0;
}

/**
 * A client whose every connection parses under `CEILING_STACK`. The URL's
 * `options` startup parameter carries `max_stack_depth`, so Postgres applies
 * it to each connection the pool opens; the read-back refuses a client the
 * option did not reach. `max_stack_depth` needs the same superuser privilege
 * a session `SET` of it needs.
 */
export async function lowStackClient(): Promise<PrismaClient> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('lowStackClient: DATABASE_URL is not set');
  const url = new URL(base);
  url.searchParams.set('options', `-c max_stack_depth=${CEILING_STACK}`);
  const client = createPrismaClient({ url: url.toString(), log: [{ emit: 'event', level: 'query' }] });
  const entry = { peak: 0 };
  peaks.set(client, entry);
  queryEventsOf(client).$on('query', (e) => {
    entry.peak = Math.max(entry.peak, paramCount(e));
  });
  const [row] = await client.$queryRawUnsafe<{ max_stack_depth: string }[]>('SHOW max_stack_depth');
  if (row?.max_stack_depth !== CEILING_STACK) {
    await client.$disconnect();
    throw new Error(
      `lowStackClient: max_stack_depth reads ${String(row?.max_stack_depth)}, expected ${CEILING_STACK}`,
    );
  }
  return client;
}

/**
 * Refreshes the planner's statistics for the whole database. Call it once a
 * ceiling test's seed is written and before its read runs: a plan chosen from
 * statistics taken before a `CEILING_ROWS` seed can be quadratic in it, and
 * nothing guarantees autovacuum has analyzed the seed by then. Serial-tier
 * files only. Why, measured, and what enforces the tier, is
 * `docs/test-database.md` §7.
 */
export async function analyzeSeed(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('ANALYZE');
}

/**
 * Asserts that `db` itself runs under `CEILING_STACK`. Pass the exact client
 * the sweep was handed — a `scopeSweep` client's raw queries reach its base —
 * so a ceiling test cannot pass by running on a default-stack client.
 */
export async function expectLowered(db: PrismaClient): Promise<void> {
  const [row] = await db.$queryRawUnsafe<{ max_stack_depth: string }[]>('SHOW max_stack_depth');
  expect(row?.max_stack_depth).toBe(CEILING_STACK);
}

/**
 * True only for Postgres SQLSTATE 54001 (stack depth limit exceeded). Its
 * producer is app-authored row-value SQL through `$queryRaw`; a Prisma
 * relation load sends scalar `IN` lists and never reaches it.
 */
export function isStackDepthError(err: unknown): boolean {
  return pgErrorOf(err)?.sqlState === '54001';
}

export interface SeededTeachers {
  teacherIds: string[];
  teacherRoomIds: string[];
  cleanup(): Promise<void>;
}

/**
 * `count` teachers, each with an account, a room of its own and the teacher
 * room linking them. `teacherRoomIds[i]` belongs to `teacherIds[i]`.
 */
export async function seedTeachers(
  db: PrismaClient,
  count: number,
  tag: string,
): Promise<SeededTeachers> {
  const run = `${tag}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacherIds: string[] = [];
  const teacherRoomIds: string[] = [];
  const roomIds: string[] = [];
  const accountIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const handle = `${run}-${i}`;
    const teacher = await db.teacher.create({
      data: {
        firstName: 'Ceiling',
        lastName: 'Teacher',
        email: `${handle}@test.local`,
        account: { create: { email: `${handle}@test.local` } },
        bio: 'ceiling harness',
        pageSlug: handle,
        defaultTimezone: 'UTC',
      },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const room = await db.room.create({
      data: {
        venueName: `Ceiling ${handle}`,
        address: `${handle} Ceiling St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomIds.push(room.id);
    const link = await db.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 20, rentalRate: 0 },
    });
    teacherRoomIds.push(link.id);
  }

  // Entries first: deleting a room cascades to its teacher room, which a
  // class restricts. Rooms before teachers: a room's creator restricts too.
  async function cleanup(): Promise<void> {
    if (teacherIds.length === 0) return;
    await db.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await db.room.deleteMany({ where: { id: { in: roomIds } } });
    await db.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  return { teacherIds, teacherRoomIds, cleanup };
}

const SLOT_MINUTES = 15;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

/**
 * `opts.rows` regular classes, each an entry plus its class, written in two
 * `createMany` statements. Rows go round-robin across the teachers; each
 * teacher's rows take consecutive 15-minute slots from 00:00 on `opts.dates`
 * in turn, so no two of a teacher's entries overlap.
 */
export async function seedClasses(
  db: PrismaClient,
  teachers: SeededTeachers,
  opts: {
    rows: number;
    dates: Date[];
    status: 'open' | 'in_progress';
    minStudents: number;
    maxStudents: number;
  },
): Promise<{ classIds: string[] }> {
  const teacherCount = teachers.teacherIds.length;
  const capacity = teacherCount * SLOTS_PER_DAY * opts.dates.length;
  if (opts.rows > capacity) {
    throw new Error(`seedClasses: ${opts.rows} rows exceed ${capacity} non-overlapping slots`);
  }

  const entries: Prisma.CalendarEntryCreateManyInput[] = [];
  const classes: Prisma.ClassCreateManyInput[] = [];
  const classIds: string[] = [];
  for (let i = 0; i < opts.rows; i++) {
    const t = i % teacherCount;
    const slot = Math.floor(i / teacherCount);
    const date = opts.dates[Math.floor(slot / SLOTS_PER_DAY)];
    const teacherId = teachers.teacherIds[t];
    const teacherRoomId = teachers.teacherRoomIds[t];
    if (!date || !teacherId || !teacherRoomId) throw new Error('seedClasses: slot out of range');
    const calendarEntryId = crypto.randomUUID();
    const classId = crypto.randomUUID();
    classIds.push(classId);
    entries.push({
      id: calendarEntryId,
      teacherId,
      kind: 'regular',
      classType: 'Ceiling',
      date,
      startTime: new Date(Date.UTC(1970, 0, 1, 0, (slot % SLOTS_PER_DAY) * SLOT_MINUTES)),
      durationMinutes: SLOT_MINUTES,
      cancelledAt: null,
    });
    classes.push({
      id: classId,
      calendarEntryId,
      kind: 'regular',
      entryLive: true,
      teacherRoomId,
      roomArchived: false,
      currency: 'EUR',
      roomCost: 0,
      minRate: 0,
      targetRate: 0,
      minStudents: opts.minStudents,
      maxStudents: opts.maxStudents,
      status: opts.status,
    });
  }

  await db.calendarEntry.createMany({ data: entries });
  await db.class.createMany({ data: classes });
  return { classIds };
}
