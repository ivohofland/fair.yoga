import { describe, it, expect } from 'vitest';
import { Prisma } from '@/lib/prisma-client';
import { isUniqueConflictOn } from './unique-conflict';
import { driverAdapterError, knownWithAdapterCause, pgCause } from '../../tests/adapter-errors';

function uniqueViolation(name: string, code = 'P2002', extra: Record<string, unknown> = {}) {
  return knownWithAdapterCause(code, pgCause('23505', `duplicate key value violates unique constraint "${name}"`, extra));
}

/**
 * Unit coverage for `isUniqueConflictOn`'s own branches, on fabricated
 * adapter shapes. `pg-error.test.ts` holds the fabrication to produced errors
 * and every registry member to `pg_indexes`.
 */
describe('isUniqueConflictOn', () => {
  it('matches a P2002 naming one of the given constraints', () => {
    expect(isUniqueConflictOn(uniqueViolation('Teacher_pageSlug_key'), ['Teacher_pageSlug_key'])).toBe(true);
    expect(isUniqueConflictOn(uniqueViolation('Teacher_email_key'), ['Teacher_pageSlug_key', 'Teacher_email_key'])).toBe(true);
  });

  it('does not match a sibling constraint over the same columns', () => {
    // `Student.email` and `Account.email` are both `@unique`: only the name
    // tells the two collisions apart.
    expect(isUniqueConflictOn(uniqueViolation('Account_email_key'), ['Student_email_key'])).toBe(false);
  });

  it('matches an expression key whose reported fields are truncated', () => {
    // The adapter's `constraint.fields` for this index is what Postgres's
    // detail line held, cut off mid-expression; the name is whole.
    const err = uniqueViolation('Room_private_identity_unique', 'P2002', {
      constraint: { fields: ['"createdById"', 'lower(TRIM(BOTH FROM address'] },
    });
    expect(isUniqueConflictOn(err, ['Room_private_identity_unique'])).toBe(true);
    expect(isUniqueConflictOn(err, ['Room_public_identity_unique'])).toBe(false);
  });

  it('matches a raw P2010 carrying a 23505 on a listed name', () => {
    expect(isUniqueConflictOn(uniqueViolation('Teacher_pageSlug_key', 'P2010'), ['Teacher_pageSlug_key'])).toBe(true);
  });

  it('matches a typed DriverAdapterError carrying a 23505 on a listed name', () => {
    const err = driverAdapterError(pgCause('23505', 'duplicate key value violates unique constraint "Teacher_pageSlug_key"'));
    expect(isUniqueConflictOn(err, ['Teacher_pageSlug_key'])).toBe(true);
  });

  it('does not match a 23505 whose message names no constraint', () => {
    const err = knownWithAdapterCause('P2002', pgCause('23505', 'note: duplicate key value violates unique constraint "Teacher_pageSlug_key"'));
    expect(isUniqueConflictOn(err, ['Teacher_pageSlug_key'])).toBe(false);
  });

  it.each([
    ['a P2025', new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: Prisma.prismaVersion.client })],
    ['a non-23505 Known error', knownWithAdapterCause('P2010', pgCause('23514', 'new row for relation "Teacher" violates check constraint "Teacher_pageSlug_key"'))],
    ['a P2002 without the adapter error', new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: Prisma.prismaVersion.client, meta: { target: ['pageSlug'] } })],
    ['null', null],
    ['undefined', undefined],
    ['a plain Error', new Error('duplicate key value violates unique constraint "Teacher_pageSlug_key"')],
  ])('does not match %s', (_label, err) => {
    expect(isUniqueConflictOn(err, ['Teacher_pageSlug_key'])).toBe(false);
  });

  it('accepts only registered names (checked by `pnpm run typecheck`, not by vitest)', () => {
    // @ts-expect-error unknown name
    void isUniqueConflictOn(uniqueViolation('Teacher_bogus_key'), ['Teacher_bogus_key']);
  });
});
