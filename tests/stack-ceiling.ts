import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Fixtures for the relation-load ceiling tests (#674): a client whose session
 * parses under a lowered `max_stack_depth`, and bulk seeders that put enough
 * rows in front of a sweep to overflow it. The design is
 * `docs/superpowers/specs/2026-09-24-relation-load-paging-design.md`.
 */

/** The session stack a ceiling client runs under. */
export const CEILING_STACK = '200kB';

/** A parent-set size that overflows `CEILING_STACK` when loaded unpaged. */
export const CEILING_ROWS = 1000;

/**
 * A client pinned to ONE connection with `max_stack_depth` lowered on it.
 * `connection_limit=1` is what makes a session `SET` reach every later query;
 * the read-back refuses a client whose SET landed somewhere else.
 */
export async function lowStackClient(): Promise<PrismaClient> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('lowStackClient: DATABASE_URL is not set');
  const datasourceUrl = `${base}${base.includes('?') ? '&' : '?'}connection_limit=1`;
  const client = new PrismaClient({ datasourceUrl });
  await client.$executeRawUnsafe(`SET max_stack_depth = '${CEILING_STACK}'`);
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
 * True only for Postgres SQLSTATE 54001 (stack depth limit exceeded), in the
 * two shapes Prisma surfaces it in.
 */
export function isStackDepthError(err: unknown): boolean {
  // `$queryRaw`: a known request error, SQLSTATE in `meta.code`.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    return err.code === 'P2010' && meta?.code === '54001';
  }
  // `findMany` relation load (measured 2026-09-24): an unknown request error
  // with no `code` or `meta`; the SQLSTATE is only in the engine's
  // `PostgresError { code: "54001", … }` text.
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return err.message.includes('PostgresError { code: "54001"');
  }
  return false;
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
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

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
