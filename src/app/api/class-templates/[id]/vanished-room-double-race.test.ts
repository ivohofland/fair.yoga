import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';

/**
 * Tests for PUT /api/class-templates/[id]'s room constraint error handling.
 * The service module is mocked (not DB-probed): updateClassTemplate is replaced,
 * CLASS_TEMPLATE_ROOM_FK comes from the real module so it stays single-sourced.
 *
 * 1. Double-race room deletion: when a room vanishes after updateRule's
 *    internal re-read, the route re-reads, finds null, logs warn, and returns
 *    400 ('Invalid teacher room') rather than 409 (#231).
 * 2. Diagnostic probe safety: if the re-read itself fails (DB drop, pool
 *    exhaustion), the route rethrows the original error rather than masking it.
 *    The rethrow is pinned by identity (`.toBe`), not a structural assertion.
 * 3. Pre-check room-not-found: targetRoom null at the ownership pre-probe
 *    short-circuits to 400 before the service is called.
 * 4. Archived room at re-read: the service rethrows P2003 when the room still
 *    exists but isArchived; the route answers 409 ROOM_ARCHIVED.
 * 5. Open room at re-read: the room was un-archived after the write; the route
 *    answers 503 TEMPLATE_BUSY so the teacher can retry.
 */

const updateClassTemplate = vi.fn();
const findUniqueClassTemplate = vi.fn();
const findUniqueTeacherRoom = vi.fn();

vi.mock('@/services/class-template-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-template-lifecycle')>();
  return { ...actual, updateClassTemplate: (...args: unknown[]) => updateClassTemplate(...args) };
});
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

/**
 * First log call's merge object. `objectContaining` cannot distinguish two Error
 * instances with the same message: the real value of `err` is its stack.
 */
function firstLoggedMerge(fn: typeof log.error): Record<string, unknown> {
  const call = vi.mocked(fn).mock.calls[0];
  return (call?.[0] ?? {}) as unknown as Record<string, unknown>;
}

describe('PUT /api/class-templates/[id] — room deletion double-race & probe guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);
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
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          err: fkError,
          method: 'PUT',
          path: `/api/class-templates/${TEMPLATE_ID}`,
        }),
        'unhandled API error',
      );
      expect(firstLoggedMerge(errorLog)['err']).toBe(fkError);
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('returns 400 when the move target room does not exist at the pre-check', async () => {
    findUniqueClassTemplate.mockResolvedValue({
      ruleLive: true,
      teacherRoomId: 'old-room',
      scheduleRule: { teacherId: 'teacher-1' },
    });
    findUniqueTeacherRoom.mockResolvedValueOnce(null);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const res = await PUT(putWithRoom(VALID_ROOM_ID), { params: Promise.resolve({ id: TEMPLATE_ID }) });
      expect(res.status).toBe(400);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: TEMPLATE_ID, teacherRoomId: VALID_ROOM_ID }),
        'template move target room not found',
      );
      expect(updateClassTemplate).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns 409 when the room is archived at the time of the constraint-violation re-read', async () => {
    findUniqueClassTemplate.mockResolvedValue({
      ruleLive: true,
      teacherRoomId: 'old-room',
      scheduleRule: { teacherId: 'teacher-1' },
    });
    findUniqueTeacherRoom
      .mockResolvedValueOnce({ isArchived: false, teacherId: 'teacher-1' })
      .mockResolvedValueOnce({ isArchived: true });

    const fkError = new Prisma.PrismaClientKnownRequestError('FK error', {
      code: 'P2003',
      clientVersion: '6.19.3',
      meta: { constraint: 'ClassTemplate_teacherRoomId_roomArchived_fkey' },
    });
    updateClassTemplate.mockRejectedValue(fkError);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const res = await PUT(putWithRoom(VALID_ROOM_ID), { params: Promise.resolve({ id: TEMPLATE_ID }) });
      expect(res.status).toBe(409);
      const payload = (await res.json()) as { error: { message: string; code: string } };
      expect(payload.error.code).toBe('ROOM_ARCHIVED');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: TEMPLATE_ID, teacherId: 'teacher-1' }),
        'template move lost the room-archive race',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('returns 503 when the room was archived at updateRule but is open again at the re-read', async () => {
    findUniqueClassTemplate.mockResolvedValue({
      ruleLive: true,
      teacherRoomId: 'old-room',
      scheduleRule: { teacherId: 'teacher-1' },
    });
    findUniqueTeacherRoom
      .mockResolvedValueOnce({ isArchived: false, teacherId: 'teacher-1' })
      .mockResolvedValueOnce({ isArchived: false });

    const fkError = new Prisma.PrismaClientKnownRequestError('FK error', {
      code: 'P2003',
      clientVersion: '6.19.3',
      meta: { constraint: 'ClassTemplate_teacherRoomId_roomArchived_fkey' },
    });
    updateClassTemplate.mockRejectedValue(fkError);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const res = await PUT(putWithRoom(VALID_ROOM_ID), { params: Promise.resolve({ id: TEMPLATE_ID }) });
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error: { message: string; code: string } };
      expect(payload.error.code).toBe('TEMPLATE_BUSY');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: TEMPLATE_ID, teacherId: 'teacher-1' }),
        'template move lost a room-state race the other way; the room is open again',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
