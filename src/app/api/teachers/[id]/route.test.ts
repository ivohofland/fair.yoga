import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { BANK_HOLDER_NAME_REQUIRED_MESSAGE } from '@/lib/schemas';

/**
 * `PUT /api/teachers/[id]`'s bank-field branches that a request against the
 * running app cannot reach on demand: the teacher row gone between the session
 * check and the bank read, and the database refusing a pair the pre-check let
 * through. Prisma is mocked; the integration suite covers the rest.
 */
const TEACHER_ID = '5b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const findUniqueTeacher = vi.fn();
const updateTeacher = vi.fn();

vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: TEACHER_ID, accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    teacher: {
      findUnique: (...args: unknown[]) => findUniqueTeacher(...args),
      update: (...args: unknown[]) => updateTeacher(...args),
    },
  },
}));

const { PUT } = await import('./route');

const IBAN = 'NL91ABNA0417164300';

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new NextRequest(`http://localhost:3000/api/teachers/${TEACHER_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TEACHER_ID }) },
  );
}

/** The shape a typed Prisma call rejects with when Postgres raises 23514. */
function checkViolation(constraint: string): Error {
  return new Error(
    `Invalid \`prisma.teacher.update()\` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"Teacher\\" violates check constraint \\"${constraint}\\"", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  );
}

describe('PUT /api/teachers/[id] — bank fields', () => {
  beforeEach(() => {
    findUniqueTeacher.mockReset();
    updateTeacher.mockReset();
  });

  it('answers 404 when the teacher row is gone before the bank fields are read', async () => {
    findUniqueTeacher.mockResolvedValueOnce(null);

    const res = await put({ bankIban: IBAN, bankAccountName: 'H. Teacher' });

    expect(res.status).toBe(404);
    expect(updateTeacher).not.toHaveBeenCalled();
  });

  // The pre-check read a stored holder name; a concurrent save cleared it
  // before this update landed, so the database is what refuses the pair.
  it('answers the holder-name refusal when the database constraint refuses the pair', async () => {
    findUniqueTeacher.mockResolvedValueOnce({ bankIban: null, bankAccountName: 'H. Teacher' });
    updateTeacher.mockRejectedValueOnce(checkViolation('Teacher_bank_holder_name_check'));

    const res = await put({ bankIban: IBAN });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe(BANK_HOLDER_NAME_REQUIRED_MESSAGE);
  });

  it('does not relabel a different check violation as the holder-name refusal', async () => {
    findUniqueTeacher.mockResolvedValueOnce({ bankIban: null, bankAccountName: 'H. Teacher' });
    updateTeacher.mockRejectedValueOnce(checkViolation('Some_other_check'));

    const res = await put({ bankIban: IBAN });

    expect(res.status).toBe(500);
  });
});
