import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { expectRefusal } from '../../../../tests/api-assertions';

/**
 * `POST /api/class-templates`: the room ownership pre-check, and what the
 * handler answers when the insert's room foreign key refuses the row. The
 * service is mocked, so each re-read outcome is reached directly; the pattern
 * is `[id]/vanished-room-double-race.test.ts`'s for `PUT`.
 */
const createClassTemplate = vi.fn();
const findUniqueTeacherRoom = vi.fn();

vi.mock('@/services/class-template-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-template-lifecycle')>();
  return { ...actual, createClassTemplate: (...args: unknown[]) => createClassTemplate(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    teacherRoom: { findUnique: (...args: unknown[]) => findUniqueTeacherRoom(...args) },
  },
}));

const { POST } = await import('./route');

const ROOM_ID = 'e2b26090-4a81-4286-9057-df498d361596';
const OWNED_OPEN_ROOM = { id: ROOM_ID, teacherId: 'teacher-1', isArchived: false };

function create(): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/class-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teacherRoomId: ROOM_ID,
        classType: 'Race Flow',
        dayOfWeek: 2,
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      }),
    }),
  );
}

function roomForeignKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('FK error', {
    code: 'P2003',
    clientVersion: '6.19.3',
    meta: { constraint: 'ClassTemplate_teacherRoomId_roomArchived_fkey' },
  });
}

/**
 * `mockReset`, not `clearAllMocks`: the latter clears recorded calls and
 * leaves a queued `mockResolvedValueOnce` in place, so a case whose handler
 * takes one read fewer than it staged hands the leftover to the next case —
 * which then fails somewhere else entirely.
 */
function resetMocks(): void {
  createClassTemplate.mockReset();
  findUniqueTeacherRoom.mockReset();
}

describe('POST /api/class-templates — room pre-check', () => {
  beforeEach(resetMocks);

  it("answers another teacher's room with ROOM_NOT_ON_LIST, before the service", async () => {
    findUniqueTeacherRoom.mockResolvedValueOnce({ ...OWNED_OPEN_ROOM, teacherId: 'teacher-2' });

    await expectRefusal(await create(), 'ROOM_NOT_ON_LIST');
    expect(createClassTemplate).not.toHaveBeenCalled();
  });

  it('answers an unknown room with ROOM_NOT_ON_LIST, before the service', async () => {
    findUniqueTeacherRoom.mockResolvedValueOnce(null);

    await expectRefusal(await create(), 'ROOM_NOT_ON_LIST');
    expect(createClassTemplate).not.toHaveBeenCalled();
  });
});

describe('POST /api/class-templates — the insert lost a race on the room', () => {
  beforeEach(() => {
    resetMocks();
    createClassTemplate.mockRejectedValue(roomForeignKeyViolation());
  });

  it('answers ROOM_NOT_ON_LIST when the room is gone at the re-read', async () => {
    findUniqueTeacherRoom.mockResolvedValueOnce(OWNED_OPEN_ROOM).mockResolvedValueOnce(null);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      await expectRefusal(await create(), 'ROOM_NOT_ON_LIST');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create target room vanished',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('answers ROOM_ARCHIVED when the room is archived at the re-read', async () => {
    findUniqueTeacherRoom
      .mockResolvedValueOnce(OWNED_OPEN_ROOM)
      .mockResolvedValueOnce({ isArchived: true });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      await expectRefusal(await create(), 'ROOM_ARCHIVED');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create lost the room-archive race',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('answers TEMPLATE_BUSY when the room is open again at the re-read', async () => {
    findUniqueTeacherRoom
      .mockResolvedValueOnce(OWNED_OPEN_ROOM)
      .mockResolvedValueOnce({ isArchived: false });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      await expectRefusal(await create(), 'TEMPLATE_BUSY');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create lost a room-state race the other way; the room is open again',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rethrows the constraint error, not its own, when the re-read itself fails', async () => {
    const fkError = roomForeignKeyViolation();
    createClassTemplate.mockReset();
    createClassTemplate.mockRejectedValueOnce(fkError);
    findUniqueTeacherRoom
      .mockResolvedValueOnce(OWNED_OPEN_ROOM)
      .mockRejectedValueOnce(new Error('DB connection drop'));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const res = await create();

      expect(res.status).toBe(500);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create hit the room constraint, but the diagnostic re-read failed',
      );
      const logged = vi.mocked(errorLog).mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined;
      expect(logged?.['err']).toBe(fkError);
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });
});
