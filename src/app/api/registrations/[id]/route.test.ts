import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';
import { CHECKIN_OPENS_MINUTES } from '@/lib/finish-window';

/**
 * What PUT and DELETE answer when their scoped write matches nothing, decided
 * from the re-read that follows it.
 *
 * Mocked, as `promote-after-cancel.test.ts` beside it is: each case needs the
 * row to change between the write and the re-read, which nothing outside the
 * handler can schedule. The session is a teacher's, so DELETE takes the
 * full-cancel branch; the handler, its ownership check and its answers are
 * real.
 */
const findUnique = vi.fn();
const updateMany = vi.fn();
const handleSpotFreed = vi.fn();
const notificationCreate = vi.fn();

vi.mock('@/services/waitlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/waitlist')>();
  return { ...actual, handleSpotFreed: (...args: unknown[]) => handleSpotFreed(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireSession: async () => ({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    }),
  };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    registration: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    notification: { create: (...args: unknown[]) => notificationCreate(...args) },
  },
}));

const { PUT, DELETE } = await import('./route');

const params = () => ({ params: Promise.resolve({ id: 'reg-1' }) });

function bookingRow() {
  return {
    id: 'reg-1',
    classId: 'class-1',
    studentId: 'student-1',
    status: 'registered',
    class: {
      id: 'class-1',
      status: 'open',
      maxStudents: 10,
      cancelDeadline: 'HOURS_24',
      calendarEntry: {
        teacherId: 'teacher-1',
        classType: 'Vinyasa',
        date: new Date('2099-06-01T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        cancelledAt: null,
        teacher: { defaultTimezone: 'Europe/Amsterdam' },
      },
    },
  };
}

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset().mockResolvedValue({ count: 0 });
  handleSpotFreed.mockReset();
  notificationCreate.mockReset();
});

describe('DELETE /api/registrations/[id] — a teacher cancel whose write missed', () => {
  function cancel(): Promise<Response> {
    return DELETE(
      new NextRequest('http://localhost:3000/api/registrations/reg-1', { method: 'DELETE' }),
      params(),
    );
  }

  /** The pre-read sees a live booking; the re-read after the missed write sees `row`. */
  function afterTheWrite(row: { status: string } | null): void {
    findUnique.mockResolvedValueOnce(bookingRow()).mockResolvedValueOnce(row);
  }

  it('answers unchanged when the row is now cancelled', async () => {
    afterTheWrite({ status: 'cancelled' });

    expect(await expectUnchanged(await cancel())).toEqual({ id: 'reg-1', status: 'cancelled' });
    expect(handleSpotFreed).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('refuses when the student cancelled late in between: they stay charged', async () => {
    afterTheWrite({ status: 'late_cancel' });

    await expectRefusal(await cancel(), 'ALREADY_LATE_CANCELLED');
    expect(handleSpotFreed).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('answers not found when the row is gone', async () => {
    afterTheWrite(null);

    await expectRefusal(await cancel(), 'NOT_FOUND');
    expect(handleSpotFreed).not.toHaveBeenCalled();
  });

  it('says the booking changed when the row is active again', async () => {
    afterTheWrite({ status: 'registered' });

    await expectRefusal(await cancel(), 'CONCURRENT_MODIFICATION');
    expect(handleSpotFreed).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

/**
 * The pre-`parseBody` read of an attendance write: ownership plus what the
 * clock gate needs. A class starting 10:00 UTC on 2099-06-01 for a UTC teacher.
 */
const CLASS_START = new Date('2099-06-01T10:00:00Z');
function attendanceRead() {
  return {
    ...bookingRow(),
    class: {
      calendarEntry: {
        teacherId: 'teacher-1',
        date: new Date('2099-06-01T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        teacher: { defaultTimezone: 'UTC' },
      },
    },
  };
}

describe('PUT /api/registrations/[id] — an attendance write that missed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function clockAt(instant: Date): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
  }

  const opens = new Date(CLASS_START.getTime() - CHECKIN_OPENS_MINUTES * 60_000);

  function mark(status: 'attended' | 'no_show' | 'late_cancel'): Promise<Response> {
    return PUT(
      new NextRequest('http://localhost:3000/api/registrations/reg-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
      params(),
    );
  }

  it('says the booking changed when the row now holds another active status', async () => {
    clockAt(opens);
    findUnique
      .mockResolvedValueOnce(attendanceRead())
      .mockResolvedValueOnce({
        status: 'attended',
        cancelledAt: null,
        class: { status: 'open', calendarEntry: { cancelledAt: null } },
      });

    await expectRefusal(await mark('no_show'), 'CONCURRENT_MODIFICATION');
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('answers not found when the row is gone by the time the write is scoped', async () => {
    clockAt(opens);
    findUnique.mockResolvedValueOnce(attendanceRead()).mockResolvedValueOnce(null);

    await expectRefusal(await mark('attended'), 'NOT_FOUND');
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  describe('the clock gate (#766)', () => {
    it.each(['attended', 'no_show', 'late_cancel'] as const)(
      'refuses %s one millisecond before check-in opens, writing nothing',
      async (status) => {
        clockAt(new Date(opens.getTime() - 1));
        findUnique.mockResolvedValueOnce(attendanceRead());

        await expectRefusal(await mark(status), 'CLASS_NOT_STARTED');
        expect(updateMany).not.toHaveBeenCalled();
      },
    );

    it.each(['attended', 'no_show'] as const)('lets %s through exactly when check-in opens', async (status) => {
      clockAt(opens);
      findUnique.mockResolvedValueOnce(attendanceRead());
      updateMany.mockResolvedValue({ count: 1 });

      const res = await mark(status);

      expect(res.status).toBe(200);
      expect(updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('late_cancel is a restoration (#766)', () => {
    it('adds the once-late-cancelled condition to the write for late_cancel only', async () => {
      clockAt(opens);
      findUnique.mockResolvedValue(attendanceRead());
      updateMany.mockResolvedValue({ count: 1 });

      await mark('late_cancel');
      await mark('attended');

      const [late, attended] = updateMany.mock.calls.map(
        ([arg]) => (arg as { where: Record<string, unknown> }).where,
      );
      expect(late).toMatchObject({ cancelledAt: { not: null } });
      expect(attended).not.toHaveProperty('cancelledAt');
    });

    it('refuses a live booking that never late-cancelled, whatever status it holds', async () => {
      clockAt(opens);
      findUnique.mockResolvedValueOnce(attendanceRead()).mockResolvedValueOnce({
        status: 'attended',
        cancelledAt: null,
        class: { status: 'open', calendarEntry: { cancelledAt: null } },
      });

      await expectRefusal(await mark('late_cancel'), 'ILLEGAL_TRANSITION');
    });

    it('still answers a cancelled class and an unchanged row before that refusal', async () => {
      clockAt(opens);
      findUnique.mockResolvedValueOnce(attendanceRead()).mockResolvedValueOnce({
        status: 'registered',
        cancelledAt: null,
        class: { status: 'open', calendarEntry: { cancelledAt: new Date() } },
      });
      await expectRefusal(await mark('late_cancel'), 'CLASS_CANCELLED');

      findUnique.mockResolvedValueOnce(attendanceRead()).mockResolvedValueOnce({
        status: 'late_cancel',
        cancelledAt: null,
        class: { status: 'open', calendarEntry: { cancelledAt: null } },
      });
      await expectUnchanged(await mark('late_cancel'));
    });
  });
});
