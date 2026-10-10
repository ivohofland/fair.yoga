import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { elementsOf } from '../../../tests/react-tree';
import { ContentColumn } from './content-column';

const { getSession, count } = vi.hoisted(() => ({
  getSession: vi.fn(),
  count: vi.fn(async () => 0),
}));

vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('@/lib/db', () => ({ prisma: { notification: { count } } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }));

const session = {
  sessionId: 's1',
  accountId: 'a1',
  teacherId: 't1',
  studentId: 'st1',
  defaultTimezone: 'UTC',
};

const columnsIn = (tree: ReactNode) => [...elementsOf(tree)].filter((el) => el.type === ContentColumn);

describe('the content column', () => {
  it('is not imposed by the root layout, so the landing page can be wider', async () => {
    const { default: RootLayout } = await import('@/app/layout');
    expect(columnsIn(await RootLayout({ children: null }))).toHaveLength(0);
  });

  it.each([
    ['public', () => import('@/app/(public)/layout')],
    ['teacher', () => import('@/app/(teacher)/layout')],
    ['student', () => import('@/app/(student)/layout')],
    ['admin', () => import('@/app/(admin)/layout')],
  ])('holds every %s page', async (_group, load) => {
    getSession.mockResolvedValue(session);
    const { default: Layout } = await load();
    expect(columnsIn(await Layout({ children: null }))).toHaveLength(1);
  });

  it.each([
    ['not-found', () => import('@/app/not-found')],
    ['error', () => import('@/app/error')],
  ])('holds the root %s page', async (_page, load) => {
    const { default: Page } = await load();
    expect(columnsIn(Page({ error: new Error('x'), reset: () => undefined }))).toHaveLength(1);
  });
});
