import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Prisma, createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { classifyApiError, isRestrictViolationOn } from './api-errors';
import { isCheckViolationOn } from './check-violation';
import { isExclusionConflictOn } from './exclusion-conflict';
import { serializeErr, type SerializedErr } from './log-serializers';
import { ADAPTER_KINDS, PG_POOL_TIMEOUT_MESSAGE, adapterKindOf, isPgPoolTimeout, pgErrorOf } from './pg-error';
import { driverAdapterError, knownWithAdapterCause, pgCause, pgPoolTimeout } from '../../tests/adapter-errors';
import { fixtureRun, type RoomFixture } from '../../tests/room-fixtures';
import type { ClassWithEntry } from '../../tests/class-fixtures';

describe('pgErrorOf (fabricated branches)', () => {
  it('reads a typed DriverAdapterError from its own cause', () => {
    const err = driverAdapterError(pgCause('23514', 'Class abc is completed, which is terminal; cannot change status to open'));
    expect(pgErrorOf(err)).toEqual({ sqlState: '23514', message: 'Class abc is completed, which is terminal; cannot change status to open' });
  });

  it('reads a Known error from meta.driverAdapterError.cause', () => {
    const err = knownWithAdapterCause('P2010', pgCause('55P03', 'canceling statement due to lock timeout'));
    expect(pgErrorOf(err)).toEqual({ sqlState: '55P03', message: 'canceling statement due to lock timeout' });
  });

  it('takes the SQLSTATE from originalCode even where code is absent (40001)', () => {
    const err = knownWithAdapterCause('P2034', pgCause('40001', 'could not serialize access due to concurrent update'));
    expect(pgErrorOf(err)?.sqlState).toBe('40001');
  });

  it.each([
    ['23505', 'duplicate key value violates unique constraint "Teacher_pageSlug_key"', 'Teacher_pageSlug_key'],
    ['23514', 'new row for relation "Class" violates check constraint "Class_live_needs_open_room"', 'Class_live_needs_open_room'],
    ['23P01', 'conflicting key value violates exclusion constraint "CalendarEntry_teacher_slot_excl"', 'CalendarEntry_teacher_slot_excl'],
  ])('names the constraint for %s from the anchored clause', (sqlState, message, name) => {
    expect(pgErrorOf(driverAdapterError(pgCause(sqlState, message)))?.constraint).toBe(name);
  });

  it('names a 23503 constraint from cause.constraint.index only', () => {
    const withIndex = knownWithAdapterCause('P2003', pgCause('23503', 'update or delete on table "TeacherRoom" violates foreign key constraint "Class_teacherRoomId_roomArchived_fkey" on table "Class"', { constraint: { index: 'Class_teacherRoomId_roomArchived_fkey' } }));
    expect(pgErrorOf(withIndex)?.constraint).toBe('Class_teacherRoomId_roomArchived_fkey');
    const fieldsOnly = knownWithAdapterCause('P2003', pgCause('23503', 'insert or update on table "TeacherRoom" violates foreign key constraint "TeacherRoom_roomId_fkey"', { constraint: { fields: ['roomId'] } }));
    expect(pgErrorOf(fieldsOnly)?.constraint).toBeUndefined();
  });

  // Review Focus 2: free text quoting a clause never names a constraint.
  it.each([
    ['23514', 'Class abc is completed, which is terminal; note: violates check constraint "Class_live_needs_open_room" in text'],
    ['23514', 'trigger said: new row violates check constraint "X" and more'],
    ['23505', 'note: duplicate key value violates unique constraint "Teacher_pageSlug_key"'],
    ['23P01', 'conflicting key value violates exclusion constraint "A" "B"'],
  ])('does not name a constraint from an impostor %s message', (sqlState, message) => {
    expect(pgErrorOf(driverAdapterError(pgCause(sqlState, message)))?.constraint).toBeUndefined();
  });

  it.each([
    ['no cause', Object.assign(new Error('x'), { name: 'DriverAdapterError' })],
    ['a non-Error impostor', { name: 'DriverAdapterError', cause: pgCause('23514', 'm') }],
    ['an Unknown request error', new Prisma.PrismaClientUnknownRequestError('code: "23514"', { clientVersion: '6.19.3' })],
    ['a Known error without driverAdapterError', new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '6.19.3', meta: { target: ['email'] } })],
    ['a lowercase SQLSTATE', driverAdapterError(pgCause('2351x', 'm'))],
    ['a missing originalMessage', driverAdapterError({ kind: 'postgres', originalCode: '23514' })],
    ['a kind with no Postgres error', knownWithAdapterCause('P2010', { kind: 'DatabaseNotReachable', host: 'h', port: 1 })],
  ])('answers null for %s', (_label, err) => {
    expect(pgErrorOf(err)).toBeNull();
  });

  it('is shallow: it never follows Error.cause', () => {
    const inner = driverAdapterError(pgCause('55P03', 'lock timeout'));
    expect(pgErrorOf(new Error('outer', { cause: inner }))).toBeNull();
  });
});

describe('isPgPoolTimeout', () => {
  it('matches pg-pool\'s plain timeout error', () => {
    // pg-pool is pg's dependency, not ours, so it resolves from pg's directory.
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    const poolSource = readFileSync(req.resolve('pg-pool', { paths: [path.dirname(req.resolve('pg'))] }), 'utf8');
    expect(poolSource).toContain(`new Error('${PG_POOL_TIMEOUT_MESSAGE}')`);
    expect(isPgPoolTimeout(pgPoolTimeout())).toBe(true);
  });
  it.each([
    ['a different message', Object.assign(new Error('timeout exceeded when trying to connect.'), { clientVersion: '6.19.3' })],
    ['an own code', Object.assign(pgPoolTimeout(), { code: 'ETIMEDOUT' })],
    ['a non-Error', { message: 'timeout exceeded when trying to connect' }],
  ])('rejects %s', (_label, err) => {
    expect(isPgPoolTimeout(err)).toBe(false);
  });
});

describe('adapterKindOf', () => {
  it('reads cause.kind from either path, inside the closed set', () => {
    expect(adapterKindOf(knownWithAdapterCause('P2010', { kind: 'DatabaseNotReachable', host: 'h', port: 1 }))).toBe('DatabaseNotReachable');
    expect(adapterKindOf(driverAdapterError(pgCause('23514', 'm')))).toBe('postgres');
  });
  it('answers undefined for a kind outside the set', () => {
    expect(adapterKindOf(knownWithAdapterCause('P2010', { kind: 'mysql' }))).toBeUndefined();
    expect(adapterKindOf(knownWithAdapterCause('P2010', { kind: 'constructor' }))).toBeUndefined();
  });
  it('ADAPTER_KINDS is MappedError\'s kinds minus the other databases\'', () => {
    const dts = readFileSync(path.join(process.cwd(), 'node_modules/@prisma/client/runtime/client.d.ts'), 'utf8');
    const start = dts.indexOf('declare type MappedError = {');
    const end = dts.indexOf('\n};', start);
    expect(start).toBeGreaterThan(-1);
    const kinds = [...dts.slice(start, end).matchAll(/kind: '([A-Za-z]+)'/g)].map((m) => m[1]);
    const expected = kinds.filter((k) => k !== 'mysql' && k !== 'sqlite' && k !== 'mssql');
    expect([...ADAPTER_KINDS].sort()).toEqual([...expected].sort());
  });
});

describe('produced against the real database: conflict codes', () => {
  const db = createPrismaClient();
  const run = fixtureRun('pgerr');
  let checkRoom: RoomFixture;
  let frozen: ClassWithEntry;
  let slot: { teacherId: string; date: string; time: string; ruleTime: string };

  beforeAll(async () => {
    // One fixture per refusal family, so no case's blocker can be reported in
    // place of another's: a template on the CHECK fixture's link would race
    // the class for which foreign key the delete reports.
    checkRoom = await run.makeFixture(db);
    await run.addClass(db, checkRoom, 'open');
    const frozenRoom = await run.makeFixture(db);
    frozen = await run.addClass(db, frozenRoom, 'completed');
    const slotRoom = await run.makeFixture(db);
    const held = await run.addClass(db, slotRoom, 'open');
    const rule = await db.scheduleRule.create({
      data: { teacherId: slotRoom.teacherId, kind: 'studio', classType: 'pgerr', dayOfWeek: 3, startTime: hhmmToTime('07:00'), durationMinutes: 60 },
    });
    slot = {
      teacherId: slotRoom.teacherId,
      date: held.calendarEntry.date.toISOString().slice(0, 10),
      time: held.calendarEntry.startTime.toISOString().slice(11, 16),
      ruleTime: rule.startTime.toISOString().slice(11, 16),
    };
  });

  afterAll(async () => {
    await run.cleanup(db);
    await db.$disconnect();
  });

  async function rejectionOf(write: () => Promise<unknown>): Promise<unknown> {
    try {
      await write();
    } catch (err) {
      return err;
    }
    throw new Error('the write was expected to be refused');
  }

  function expectConflict(err: unknown, want: { sqlState: string; constraint?: string; status: 409 | 500; code?: string }): void {
    const pg = pgErrorOf(err);
    expect(pg?.sqlState).toBe(want.sqlState);
    expect(pg?.constraint).toBe(want.constraint);
    const failure = classifyApiError(err);
    expect(failure.status).toBe(want.status);
    if (want.code) expect(failure).toMatchObject({ code: want.code });
  }

  function expectLogFacets(err: unknown, want: { sqlState: string; constraint?: string; trigger?: string }): void {
    const pg = pgErrorOf(err);
    if (pg === null) throw new Error('no Postgres error on the produced value');
    const out = serializeErr(err) as SerializedErr;
    expect(out).toMatchObject({
      sqlState: want.sqlState,
      ...(want.constraint !== undefined ? { constraint: want.constraint } : {}),
      ...(want.trigger !== undefined ? { trigger: want.trigger } : {}),
    });
    expect(out.message).toContain('withheld');
    const json = JSON.stringify(out);
    expect(json).not.toContain(pg.message);
    expect(json).not.toContain(JSON.stringify(pg.message).slice(1, -1));
    expect(json).not.toContain('Failing row contains');
  }

  const SLOT_NAMES = ['CalendarEntry_teacher_slot_excl', 'ScheduleRule_teacher_slot_excl'] as const;

  interface ConflictCase {
    readonly label: string;
    readonly produce: () => Promise<unknown>;
    readonly want: { sqlState: string; constraint?: string; status: 409 | 500; code?: string; trigger?: string };
    readonly verdict: (err: unknown) => void;
  }

  const CHECK = 'Class_live_needs_open_room';
  const ROOM_FK = 'Class_teacherRoomId_roomArchived_fkey';

  const checkVerdict = (err: unknown): void => expect(isCheckViolationOn(err, CHECK)).toBe(true);
  const notCheckVerdict = (err: unknown): void => expect(isCheckViolationOn(err, CHECK)).toBe(false);
  const exclusionVerdict = (name: (typeof SLOT_NAMES)[number]) => (err: unknown): void => {
    expect(isExclusionConflictOn(err, name)).toBe(true);
    for (const other of SLOT_NAMES) if (other !== name) expect(isExclusionConflictOn(err, other)).toBe(false);
  };
  const restrictVerdict = (name: string) => (err: unknown): void =>
    expect(isRestrictViolationOn(err, [name])).toBe(true);

  const cases: readonly ConflictCase[] = [
    {
      label: 'CHECK Class_live_needs_open_room via the teacherRoom.update cascade (typed)',
      produce: () => rejectionOf(() => db.teacherRoom.update({ where: { id: checkRoom.linkId }, data: { isArchived: true } })),
      want: { sqlState: '23514', constraint: CHECK, status: 500 },
      verdict: checkVerdict,
    },
    {
      label: 'CHECK Class_live_needs_open_room via the same write (raw)',
      produce: () => rejectionOf(() => db.$executeRaw`UPDATE "TeacherRoom" SET "isArchived" = true WHERE id = ${checkRoom.linkId}`),
      want: { sqlState: '23514', constraint: CHECK, status: 500 },
      verdict: checkVerdict,
    },
    {
      label: 'trigger: class.update of status on a completed class (typed)',
      produce: () => rejectionOf(() => db.class.update({ where: { id: frozen.id }, data: { status: 'open' } })),
      want: { sqlState: '23514', status: 409, code: 'CLASS_FROZEN', trigger: 'status' },
      verdict: notCheckVerdict,
    },
    {
      label: 'trigger: calendarEntry.update of date on a frozen entry (typed)',
      produce: () => rejectionOf(() => db.calendarEntry.update({ where: { id: frozen.calendarEntryId }, data: { date: new Date(Date.UTC(2099, 11, 31)) } })),
      want: { sqlState: '23514', status: 409, code: 'CLASS_FROZEN', trigger: 'date' },
      verdict: notCheckVerdict,
    },
    {
      label: 'trigger: status on a completed class (raw)',
      produce: () => rejectionOf(() => db.$executeRaw`UPDATE "Class" SET status = 'open' WHERE id = ${frozen.id}`),
      want: { sqlState: '23514', status: 409, code: 'CLASS_FROZEN', trigger: 'status' },
      verdict: notCheckVerdict,
    },
    {
      label: 'CalendarEntry_teacher_slot_excl (typed)',
      produce: () => rejectionOf(() => db.calendarEntry.create({
        data: { teacherId: slot.teacherId, kind: 'studio', classType: 'pgerr dup', date: new Date(`${slot.date}T00:00:00Z`), startTime: hhmmToTime(slot.time), durationMinutes: 60 },
      })),
      want: { sqlState: '23P01', constraint: 'CalendarEntry_teacher_slot_excl', status: 409, code: 'ENTRY_SLOT_TAKEN' },
      verdict: exclusionVerdict('CalendarEntry_teacher_slot_excl'),
    },
    {
      label: 'CalendarEntry_teacher_slot_excl (raw)',
      produce: () => rejectionOf(() => db.$executeRaw`INSERT INTO "CalendarEntry" (id, "teacherId", kind, "classType", date, "startTime", "durationMinutes", "updatedAt")
        VALUES (gen_random_uuid()::text, ${slot.teacherId}, 'studio', 'pgerr raw', ${slot.date}::date, ${slot.time}::time, 60, now())`),
      want: { sqlState: '23P01', constraint: 'CalendarEntry_teacher_slot_excl', status: 409, code: 'ENTRY_SLOT_TAKEN' },
      verdict: exclusionVerdict('CalendarEntry_teacher_slot_excl'),
    },
    {
      label: 'ScheduleRule_teacher_slot_excl (typed)',
      produce: () => rejectionOf(() => db.scheduleRule.create({
        data: { teacherId: slot.teacherId, kind: 'studio', classType: 'pgerr rule dup', dayOfWeek: 3, startTime: hhmmToTime(slot.ruleTime), durationMinutes: 60 },
      })),
      want: { sqlState: '23P01', constraint: 'ScheduleRule_teacher_slot_excl', status: 409, code: 'RULE_SLOT_TAKEN' },
      verdict: exclusionVerdict('ScheduleRule_teacher_slot_excl'),
    },
    {
      label: 'ScheduleRule_teacher_slot_excl (raw)',
      produce: () => rejectionOf(() => db.$executeRaw`INSERT INTO "ScheduleRule" (id, "teacherId", kind, "classType", "dayOfWeek", "startTime", "durationMinutes", "updatedAt")
        VALUES (gen_random_uuid()::text, ${slot.teacherId}, 'studio', 'pgerr raw rule', 3, ${slot.ruleTime}::time, 60, now())`),
      want: { sqlState: '23P01', constraint: 'ScheduleRule_teacher_slot_excl', status: 409, code: 'RULE_SLOT_TAKEN' },
      verdict: exclusionVerdict('ScheduleRule_teacher_slot_excl'),
    },
    {
      label: 'restrict: teacherRoom.delete blocked by Class_teacherRoomId_roomArchived_fkey (typed)',
      produce: () => rejectionOf(() => db.teacherRoom.delete({ where: { id: checkRoom.linkId } })),
      want: { sqlState: '23503', constraint: ROOM_FK, status: 500 },
      verdict: restrictVerdict(ROOM_FK),
    },
    {
      label: 'restrict: the same delete (raw)',
      produce: () => rejectionOf(() => db.$executeRaw`DELETE FROM "TeacherRoom" WHERE id = ${checkRoom.linkId}`),
      want: { sqlState: '23503', constraint: ROOM_FK, status: 500 },
      verdict: restrictVerdict(ROOM_FK),
    },
    {
      label: 'dangling insert: teacherRoom.create with a random roomId (typed)',
      produce: () => rejectionOf(() => db.teacherRoom.create({
        data: { teacherId: checkRoom.teacherId, roomId: randomUUID(), rentalRate: 1, capacityOverride: 15 },
      })),
      want: { sqlState: '23503', constraint: 'TeacherRoom_roomId_fkey', status: 500 },
      verdict: restrictVerdict('TeacherRoom_roomId_fkey'),
    },
  ];

  for (const c of cases) {
    it(`${c.label}: classification`, async () => {
      const err = await c.produce();
      expectConflict(err, c.want);
      if (c.want.trigger !== undefined) {
        expect(classifyApiError(err)).toMatchObject({ detail: { trigger: c.want.trigger } });
      }
      c.verdict(err);
    });
    it(`${c.label}: log facets`, async () => {
      const err = await c.produce();
      expectLogFacets(err, c.want);
    });
  }

  function ownKeys(value: unknown): string[] {
    return Object.keys(value as object).sort();
  }
  function metaOf(err: unknown): { driverAdapterError: { cause: object } } {
    return (err as { meta: { driverAdapterError: { cause: object } } }).meta;
  }

  it('the helper fabricates a typed DriverAdapterError identical to a produced one', async () => {
    const real = await rejectionOf(() => db.class.update({ where: { id: frozen.id }, data: { status: 'open' } }));
    const pg = pgErrorOf(real);
    if (pg === null) throw new Error('no Postgres error on the produced value');
    const fake = driverAdapterError(pgCause('23514', pg.message));
    expect(pgErrorOf(fake)).toEqual(pg);
    expect(ownKeys(fake)).toEqual(ownKeys(real));
    expect(ownKeys((fake as { cause: object }).cause)).toEqual(ownKeys((real as { cause: object }).cause));
  });

  it('the helper fabricates a Known P2010 (raw 23514) identical to a produced one', async () => {
    const real = await rejectionOf(() => db.$executeRaw`UPDATE "Class" SET status = 'open' WHERE id = ${frozen.id}`);
    expect(real).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const pg = pgErrorOf(real);
    if (pg === null) throw new Error('no Postgres error on the produced value');
    const fake = knownWithAdapterCause('P2010', pgCause('23514', pg.message));
    expect(pgErrorOf(fake)).toEqual(pg);
    expect((fake as Prisma.PrismaClientKnownRequestError).code).toBe((real as Prisma.PrismaClientKnownRequestError).code);
    expect(ownKeys(metaOf(fake))).toEqual(ownKeys(metaOf(real)));
    expect(ownKeys(metaOf(fake).driverAdapterError)).toEqual(ownKeys(metaOf(real).driverAdapterError));
    expect(ownKeys(metaOf(fake).driverAdapterError.cause)).toEqual(ownKeys(metaOf(real).driverAdapterError.cause));
  });

  it('the helper fabricates a Known P2003 (the restrict delete) identical to a produced one', async () => {
    const real = await rejectionOf(() => db.teacherRoom.delete({ where: { id: checkRoom.linkId } }));
    expect(real).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const pg = pgErrorOf(real);
    if (pg === null) throw new Error('no Postgres error on the produced value');
    const fake = knownWithAdapterCause('P2003', pgCause('23503', pg.message, { constraint: { index: ROOM_FK } }), { modelName: 'TeacherRoom' });
    expect(pgErrorOf(fake)).toEqual(pg);
    expect((fake as Prisma.PrismaClientKnownRequestError).code).toBe((real as Prisma.PrismaClientKnownRequestError).code);
    expect(ownKeys(metaOf(fake))).toEqual(ownKeys(metaOf(real)));
    expect(ownKeys(metaOf(fake).driverAdapterError)).toEqual(ownKeys(metaOf(real).driverAdapterError));
    expect(ownKeys(metaOf(fake).driverAdapterError.cause)).toEqual(ownKeys(metaOf(real).driverAdapterError.cause));
  });
});
