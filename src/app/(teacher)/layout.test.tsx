import { describe, it, expect, vi } from 'vitest';
import { isValidElement, Children, type ReactElement, type ReactNode } from 'react';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('@/lib/db', () => ({ prisma: { notification: { count: async () => 0 } } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import TeacherLayout from './layout';
import { OutboxSync } from '@/components/layout/outbox-sync';

/** The first element in the tree whose `type` is `target`. */
function findByType(node: ReactNode, target: unknown): ReactElement | null {
  if (!isValidElement(node)) return null;
  if (node.type === target) return node;
  const { children } = node.props as { children?: ReactNode };
  for (const child of Children.toArray(children)) {
    const found = findByType(child, target);
    if (found !== null) return found;
  }
  return null;
}

describe('TeacherLayout', () => {
  // Outbox keys are owned by the account, and OutboxSync deletes every other
  // owner's on mount: handed any other id, it would delete every queued mark.
  it("mounts OutboxSync for the session's account", async () => {
    getSession.mockResolvedValue({ sessionId: 's1', accountId: 'acc-1', teacherId: 'teacher-1', studentId: null });

    const tree = await TeacherLayout({ children: <div>content</div> });

    expect(findByType(tree, OutboxSync)?.props).toEqual({ owner: 'acc-1' });
  });
});
