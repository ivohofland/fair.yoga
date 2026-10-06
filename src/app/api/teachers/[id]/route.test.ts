import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * `PUT /api/teachers/[id]` with Prisma mocked: the bank fields the schema
 * refuses, and the live-row scoping of the write. The integration suite
 * covers the rest.
 */
const TEACHER_ID = '5b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const findUniqueTeacher = vi.fn();
const updateTeacher = vi.fn();

vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: TEACHER_ID, accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => {
  const teacher = {
    findUnique: (...args: unknown[]) => findUniqueTeacher(...args),
    findUniqueOrThrow: (...args: unknown[]) => findUniqueTeacher(...args),
    updateMany: (...args: unknown[]) => updateTeacher(...args),
  };
  return {
    prisma: {
      teacher,
      // The currency branch's transaction runs its callback on the same mocks.
      $transaction: async (fn: (tx: { teacher: typeof teacher }) => unknown) => fn({ teacher }),
    },
  };
});
// The switch itself is `src/services/currency-switch.test.ts`'s; here it relabels nothing.
vi.mock('@/services/currency-switch', () => ({
  switchTeacherCurrency: async () => ({ relabelled: { classes: 0, studioClasses: 0 }, kept: [] }),
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

// `updateTeacherSchema` names no bank field, and `.strict()` refuses one.
describe('PUT /api/teachers/[id] — bank fields', () => {
  beforeEach(() => {
    findUniqueTeacher.mockReset();
    updateTeacher.mockReset();
  });

  it.each([{ bankIban: IBAN }, { bankAccountName: 'H. Teacher' }, { bio: 'x', bankIban: IBAN }])(
    'refuses a body naming a bank field with the schema’s 400, writing nothing: %j',
    async (body) => {
      const res = await put(body);

      expect(res.status).toBe(400);
      expect(updateTeacher).not.toHaveBeenCalled();
    },
  );
});

describe('PUT /api/teachers/[id] — writes only a live row (#758)', () => {
  beforeEach(() => {
    findUniqueTeacher.mockReset();
    updateTeacher.mockReset();
  });

  // The write is scoped to a live row; an erased one matches nothing.
  it('answers 404 when the write matches no live row', async () => {
    updateTeacher.mockResolvedValueOnce({ count: 0 });

    const res = await put({ bio: 'new bio' });

    expect(res.status).toBe(404);
    expect(updateTeacher).toHaveBeenCalledWith({
      where: { id: TEACHER_ID, deletedAt: null },
      data: { bio: 'new bio' },
    });
    expect(findUniqueTeacher).not.toHaveBeenCalled();
  });

  it('answers with the row as written', async () => {
    updateTeacher.mockResolvedValueOnce({ count: 1 });
    findUniqueTeacher.mockResolvedValueOnce({ id: TEACHER_ID, bio: 'new bio' });

    const res = await put({ bio: 'new bio' });

    expect(res.status).toBe(200);
    expect(findUniqueTeacher).toHaveBeenCalledWith({ where: { id: TEACHER_ID } });
  });
});
