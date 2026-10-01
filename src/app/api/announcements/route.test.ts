import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { log } from '@/lib/log';

/**
 * `POST /api/announcements`'s custom branch with the audience read and the
 * send mocked: what it logs when it drops ids, and that the log carries
 * counts only. The end-to-end behaviour is `tests/integration/announcements-api.test.ts`'s.
 */
const listAnnouncementAudience = vi.fn();
const sendAnnouncement = vi.fn();
const findOptOuts = vi.fn();

vi.mock('@/services/announcements', () => ({
  listAnnouncementAudience: (...args: unknown[]) => listAnnouncementAudience(...args),
  sendAnnouncement: (...args: unknown[]) => sendAnnouncement(...args),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { studentPrivacy: { findMany: (...args: unknown[]) => findOptOuts(...args) } },
}));

const { POST } = await import('./route');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OUTSIDE = '33333333-3333-4333-8333-333333333333';

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const DROP_LINE = 'announcement: custom audience ids outside the audience dropped';

describe('POST /api/announcements — custom audience drops', () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listAnnouncementAudience.mockReset();
    sendAnnouncement.mockReset();
    findOptOuts.mockReset();
    findOptOuts.mockResolvedValue([]);
    listAnnouncementAudience.mockResolvedValue([A, B]);
    sendAnnouncement.mockImplementation(async (_db: unknown, input: { recipients: unknown[] }) => ({
      announcement: {
        id: 'ann-1',
        teacherId: 'teacher-1',
        classId: null,
        message: 'Hello.',
        recipientCount: input.recipients.length,
        sentAt: new Date('2026-10-01T09:00:00.000Z'),
        audienceStudentIds: [A, B],
      },
      deduped: false,
      alreadyNotified: 0,
    }));
    info = vi.spyOn(log, 'info').mockImplementation(() => log);
  });

  afterEach(() => {
    info.mockRestore();
  });

  it('logs how many requested ids it dropped, as counts only', async () => {
    const res = await post({ studentIds: [A, OUTSIDE, B], message: 'Hello.' });
    expect(res.status).toBe(201);
    expect(info).toHaveBeenCalledWith({ teacherId: 'teacher-1', requested: 3, accepted: 2 }, DROP_LINE);
  });

  it('counts a repeated id once', async () => {
    await post({ studentIds: [A, A, B], message: 'Hello.' });
    expect(info).not.toHaveBeenCalledWith(expect.anything(), DROP_LINE);
  });

  it('logs nothing about drops when every id is in the audience', async () => {
    await post({ studentIds: [A, B], message: 'Hello.' });
    expect(info).not.toHaveBeenCalledWith(expect.anything(), DROP_LINE);
  });

  it('never logs a drop for an all-students send', async () => {
    await post({ message: 'Hello.' });
    expect(info).not.toHaveBeenCalledWith(expect.anything(), DROP_LINE);
  });

  it("does not hand back the stored row's recipient ids", async () => {
    const res = await post({ studentIds: [A, B], message: 'Hello.' });
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.id).toBe('ann-1');
    expect(data).not.toHaveProperty('audienceStudentIds');
  });
});
