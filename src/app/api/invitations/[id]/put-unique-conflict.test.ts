import { describe, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { pgCause, typedCallError } from '../../../../../tests/adapter-errors';

/**
 * Which unique violation the edit's catch answers as `CONTACT_EMAIL_TAKEN`:
 * only `Invitation_teacherId_email_key`. The race itself is proven at the
 * integration tier (`tests/integration/invitations-api.test.ts`); this file
 * pins the name match, with the database mocked as in `cas-scope.test.ts`.
 */

const findFirst = vi.fn();
const updateMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    invitation: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
  },
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }),
  };
});

const { PUT } = await import('./route');

const PENDING_ROW = { id: 'inv-1', status: 'pending', isArchived: false, email: 'contact@test.local' };

function put(): NextRequest {
  return new NextRequest('http://localhost:3000/api/invitations/inv-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Updated' }),
  });
}

const params = () => Promise.resolve({ id: 'inv-1' });

function uniqueViolationOn(index: string) {
  return typedCallError(
    pgCause('23505', `duplicate key value violates unique constraint "${index}"`, { constraint: { index } }),
    'Invitation',
  );
}

beforeEach(() => {
  findFirst.mockReset();
  updateMany.mockReset();
});

describe('PUT /api/invitations/[id] on a unique violation', () => {
  it('answers CONTACT_EMAIL_TAKEN for the (teacher, email) key', async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW);
    updateMany.mockRejectedValueOnce(uniqueViolationOn('Invitation_teacherId_email_key'));

    await expectRefusal(await PUT(put(), { params: params() }), 'CONTACT_EMAIL_TAKEN');
  });

  it('leaves a violation on any other index to the generic fallback, not CONTACT_EMAIL_TAKEN', async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW);
    updateMany.mockRejectedValueOnce(uniqueViolationOn('Invitation_other_key'));

    await expectRefusal(await PUT(put(), { params: params() }), 'UNIQUE_CONFLICT');
  });
});
