import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: { class: { findUnique } } }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));

import { generateMetadata } from './page';

const params = (slug: string) => ({ params: Promise.resolve({ slug, classId: 'c1' }) });

function row(overrides: { isPrivate?: boolean; status?: string; cancelledAt?: Date | null; deletedAt?: Date | null } = {}) {
  return {
    isPrivate: overrides.isPrivate ?? false,
    status: overrides.status ?? 'open',
    calendarEntry: {
      classType: 'Slow flow',
      date: new Date('2026-11-03T00:00:00Z'),
      startTime: new Date('1970-01-01T09:30:00Z'),
      durationMinutes: 75,
      cancelledAt: overrides.cancelledAt ?? null,
      teacher: { firstName: 'Anna', lastName: 'Smith', pageSlug: 'anna', deletedAt: overrides.deletedAt ?? null },
    },
  };
}

describe('booking page metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the class, its teacher and when it is, at its own canonical', async () => {
    findUnique.mockResolvedValue(row());

    const metadata = await generateMetadata(params('anna'));

    expect(metadata.title).toBe('Slow flow with Anna Smith');
    expect(metadata.description).toBe('Tuesday, 3 Nov at 09:30 · 75 min.');
    expect(metadata.alternates?.canonical).toBe('/anna/book/c1');
    expect(metadata.robots).toBeUndefined();
    // A page's own openGraph would replace the root's, preview image included.
    expect(metadata.openGraph).toBeUndefined();
  });

  it('keeps a private class out of search indexes', async () => {
    findUnique.mockResolvedValue(row({ isPrivate: true }));

    const metadata = await generateMetadata(params('anna'));

    expect(metadata.robots).toEqual({ index: false });
    expect(metadata.title).toBe('Slow flow with Anna Smith');
  });

  // The page answers 404 for these; its head must not name what its body hides.
  it.each([
    ['under another teacher’s slug', params('someone-else'), row()],
    ['a draft', params('anna'), row({ status: 'draft' })],
    ['a class in progress', params('anna'), row({ status: 'in_progress' })],
    ['a completed class', params('anna'), row({ status: 'completed' })],
    ['a cancelled class', params('anna'), row({ cancelledAt: new Date() })],
    ['an erased teacher’s class', params('anna'), row({ deletedAt: new Date() })],
  ])('names nothing for %s', async (_case, args, cls) => {
    findUnique.mockResolvedValue(cls);

    expect(await generateMetadata(args)).toEqual({});
  });

  it('still says noindex for a private class the page will 404, naming nothing', async () => {
    findUnique.mockResolvedValue(row({ isPrivate: true }));

    expect(await generateMetadata(params('someone-else'))).toEqual({ robots: { index: false } });
  });

  it('names nothing for a class that does not exist', async () => {
    findUnique.mockResolvedValue(null);

    expect(await generateMetadata(params('anna'))).toEqual({});
  });
});
