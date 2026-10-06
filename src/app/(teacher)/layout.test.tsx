import { describe, it, expect, vi } from 'vitest';
import { elementsOf } from '../../../tests/react-tree';
import { AttendanceSyncProvider } from '@/components/layout/attendance-sync-status';

const { getSession, count } = vi.hoisted(() => ({
  getSession: vi.fn(),
  count: vi.fn(async () => 0),
}));

vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('@/lib/db', () => ({ prisma: { notification: { count } } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import TeacherLayout from './layout';

describe('TeacherLayout', () => {
  it('syncs queued attendance as the session\'s account, not its teacher profile', async () => {
    getSession.mockResolvedValue({
      sessionId: 's1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      studentId: null,
      defaultTimezone: 'UTC',
    });

    const tree = await TeacherLayout({ children: null });

    const providers = [...elementsOf(tree)].filter((el) => el.type === AttendanceSyncProvider);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.props).toMatchObject({ ownerId: 'acct-1' });
  });
});
