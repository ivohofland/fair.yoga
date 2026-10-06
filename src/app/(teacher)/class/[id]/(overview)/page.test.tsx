import { describe, it, expect, vi } from 'vitest';
import { elementsOf } from '../../../../../../tests/react-tree';
import { CompleteClassButton } from '@/components/class/complete-class-button';

const { requireTeacherSession, findUnique, waitlistCount } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  findUnique: vi.fn(),
  waitlistCount: vi.fn(async () => 0),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique }, waitlistEntry: { count: waitlistCount } },
}));

import ClassDetailPage from './page';

describe('ClassDetailPage', () => {
  it('gives Finish class the session\'s account, so it sends that account\'s queued attendance', async () => {
    requireTeacherSession.mockResolvedValue({
      sessionId: 's1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      studentId: null,
      defaultTimezone: 'UTC',
    });
    // In progress since long ago, so Finish class is offered.
    findUnique.mockResolvedValue({
      id: 'c-9',
      status: 'in_progress',
      calendarEntry: {
        teacherId: 'teacher-1',
        cancelledAt: null,
        classType: 'Hatha',
        date: new Date('2026-01-05T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        durationMinutes: 60,
        teacher: { defaultTimezone: 'UTC', pageSlug: 'teacher' },
      },
      registrations: [],
      _count: { waitlistEntries: 0 },
    });

    const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-9' }) });

    const buttons = [...elementsOf(tree)].filter((el) => el.type === CompleteClassButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props).toMatchObject({ classId: 'c-9', ownerId: 'acct-1' });
  });
});
