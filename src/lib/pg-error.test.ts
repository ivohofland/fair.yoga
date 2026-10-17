import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Prisma } from '@/lib/prisma-client';
import { ADAPTER_KINDS, PG_POOL_TIMEOUT_MESSAGE, adapterKindOf, isPgPoolTimeout, pgErrorOf } from './pg-error';
import { driverAdapterError, knownWithAdapterCause, pgCause, pgPoolTimeout } from '../../tests/adapter-errors';

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
