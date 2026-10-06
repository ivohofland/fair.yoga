import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
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

/** Every element in `node`'s tree, reached through any prop, not only `children`. */
function* elements(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  const props: unknown = node.props;
  if (typeof props !== 'object' || props === null) return;
  for (const value of Object.values(props)) {
    if (Array.isArray(value) || isValidElement(value)) yield* elements(value);
  }
}

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

    const buttons = [...elements(tree)].filter((el) => el.type === CompleteClassButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props).toMatchObject({ classId: 'c-9', ownerId: 'acct-1' });
  });
});
