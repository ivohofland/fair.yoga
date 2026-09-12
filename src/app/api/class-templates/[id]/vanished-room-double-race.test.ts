import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';

/**
 * Tests for PUT /api/class-templates/[id]'s room constraint error handling:
 * 1. Double-race room deletion: when a room vanishes after updateRule's probe
 *    or when updateClassTemplate throws P2003, the route re-reads, finds null,
 *    logs warn, and returns 400 ('Invalid teacher room') rather than 409 (#231).
 * 2. Diagnostic probe safety: if the diagnostic re-read itself fails (DB drop,
 *    pool exhaustion), the route rethrows the original error rather than masking it.
 */

const updateClassTemplate = vi.fn();
const findUniqueClassTemplate = vi.fn();
const findUniqueTeacherRoom = vi.fn();

vi.mock('@/services/class-template-lifecycle', () => ({
  updateClassTemplate: (...args: unknown[]) => updateClassTemplate(...args),
  CLASS_TEMPLATE_ROOM_FK: 'ClassTemplate_teacherRoomId_roomArchived_fkey',
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    classTemplate: {
      findUnique: (...args: unknown[]) => findUniqueClassTemplate(...args),
    },
    teacherRoom: {
      findUnique: (...args: unknown[]) => findUniqueTeacherRoom(...args),
    },
  },
}));

const { PUT } = await import('./route');

const VALID_ROOM_ID = 'e2b26090-4a81-4286-9057-df498d361596';
const TEMPLATE_ID = '123e4567-e89b-12d3-a456-426614174000';

function putWithRoom(roomId: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/class-templates/${TEMPLATE_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teacherRoomId: roomId }),
  });
}

describe('PUT /api/class-templates/[id] — room deletion double-race & probe guard', () => {
  it('maps double-race room deletion to 400 with invalid room message and logs warn', async () => {
    findUniqueClassTemplate.mockResolvedValue({
      ruleLive: true,
      teacherRoomId: 'old-room',
      scheduleRule: { teacherId: 'teacher-1' },
    });
    findUniqueTeacherRoom
      .mockResolvedValueOnce({ isArchived: false, teacherId: 'teacher-1' })
      .mockResolvedValueOnce(null);

    const fkError = new Prisma.PrismaClientKnownRequestError('FK error', {
      code: 'P2003',
      clientVersion: '6.19.3',
      meta: { constraint: 'ClassTemplate_teacherRoomId_roomArchived_fkey' },
    });
    updateClassTemplate.mockRejectedValue(fkError);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const res = await PUT(putWithRoom(VALID_ROOM_ID), { params: Promise.resolve({ id: TEMPLATE_ID }) });

      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { message: string } };
      expect(payload.error.message).toBe('Invalid teacher room');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: TEMPLATE_ID,
          teacherId: 'teacher-1',
          teacherRoomId: VALID_ROOM_ID,
        }),
        'template move target room vanished',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rethrows original P2003 error if the diagnostic probe itself throws', async () => {
    findUniqueClassTemplate.mockResolvedValue({
      ruleLive: true,
      teacherRoomId: 'old-room',
      scheduleRule: { teacherId: 'teacher-1' },
    });
    findUniqueTeacherRoom
      .mockResolvedValueOnce({ isArchived: false, teacherId: 'teacher-1' })
      .mockRejectedValueOnce(new Error('DB connection drop'));

    const fkError = new Prisma.PrismaClientKnownRequestError('FK error', {
      code: 'P2003',
      clientVersion: '6.19.3',
      meta: { constraint: 'ClassTemplate_teacherRoomId_roomArchived_fkey' },
    });
    updateClassTemplate.mockRejectedValue(fkError);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const res = await PUT(putWithRoom(VALID_ROOM_ID), { params: Promise.resolve({ id: TEMPLATE_ID }) });
      expect(res.status).toBe(500);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: TEMPLATE_ID,
          teacherId: 'teacher-1',
          teacherRoomId: VALID_ROOM_ID,
        }),
        'room constraint violated, but diagnostic probe failed',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
