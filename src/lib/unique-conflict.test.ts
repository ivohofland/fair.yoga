import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isUniqueConflictOn } from './unique-conflict';

/**
 * Matches the construction used in `src/lib/api-errors.test.ts` — Prisma 6
 * takes the code and clientVersion in an options object.
 */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('constraint failed', {
    code,
    clientVersion: 'test',
    meta,
  });
}

/**
 * Unit coverage for `isUniqueConflictOn`'s own branches. `slot-constraints
 * .test.ts` measures the real `meta.target` shape Postgres/Prisma actually
 * produce for all six #196 indexes against a live DB — that is the premise
 * this helper is built on. It never calls `isUniqueConflictOn` itself, so
 * every branch below (the set-compare, the length guard, the two "not a
 * P2002 at all" exits) was covered only transitively, through eleven call
 * sites that all happen to pass a matching column set. This file tests the
 * function directly instead.
 */
describe('isUniqueConflictOn', () => {
  it('is true when meta.target names exactly the given columns, same order', () => {
    const err = prismaError('P2002', { target: ['teacherId', 'date', 'startTime'] });
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(true);
  });

  it('is true when meta.target names the same columns in a different order', () => {
    // The docblock's whole reason to exist: two unique keys over the same
    // columns in a different order cannot meaningfully coexist, so the
    // compare is order-insensitive rather than positional.
    const err = prismaError('P2002', { target: ['startTime', 'teacherId', 'date'] });
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(true);
  });

  it('is false when meta.target has the same length but different columns', () => {
    const err = prismaError('P2002', { target: ['teacherId', 'dayOfWeek', 'startTime'] });
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(false);
  });

  it('is false when meta.target is a different length than the given columns', () => {
    const err = prismaError('P2002', { target: ['teacherId', 'date', 'startTime', 'roomId'] });
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(false);
  });

  it('is false for a P2002 whose meta.target is not an array', () => {
    // Measured shape aside, Prisma's own types leave `meta` as
    // `Record<string, unknown> | undefined` — nothing stops a future Prisma
    // version, or a differently-shaped constraint violation, from putting a
    // string there instead of an array.
    const err = prismaError('P2002', { target: 'teacherId_date_startTime_key' });
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(false);
  });

  it('is false for a P2002 with no meta at all', () => {
    const err = prismaError('P2002');
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(false);
  });

  it('is false for a PrismaClientKnownRequestError with a different code', () => {
    const err = prismaError('P2025', { target: ['teacherId', 'date', 'startTime'] });
    expect(isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])).toBe(false);
  });

  it('is false for a non-Prisma error', () => {
    expect(isUniqueConflictOn(new Error('boom'), ['teacherId', 'date', 'startTime'])).toBe(false);
  });

  it('is false for a thrown non-error value', () => {
    // `catch (err)` types `err` as `unknown`, and nothing stops a caller
    // from rethrowing something that isn't an Error at all.
    expect(isUniqueConflictOn('not an error', ['teacherId', 'date', 'startTime'])).toBe(false);
    expect(isUniqueConflictOn(undefined, ['teacherId', 'date', 'startTime'])).toBe(false);
  });
});
