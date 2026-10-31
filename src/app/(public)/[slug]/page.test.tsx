import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: { teacher: { findUnique } } }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));

import { generateMetadata } from './page';

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe('teacher page metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the teacher and describes them from their bio', async () => {
    findUnique.mockResolvedValue({ firstName: 'Anna', lastName: 'Smith', bio: 'Hatha and yin\nin Utrecht.', deletedAt: null });

    const metadata = await generateMetadata(params('anna'));

    expect(metadata.title).toBe('Anna Smith');
    expect(metadata.description).toBe('Hatha and yin in Utrecht.');
    expect(metadata.alternates?.canonical).toBe('/anna');
  });

  // A page's own openGraph replaces the root's wholesale, preview image
  // included; left unset, the card inherits the image and takes its title and
  // description from the page's.
  it('leaves the preview card to the root, so it keeps the image', async () => {
    findUnique.mockResolvedValue({ firstName: 'Anna', lastName: 'Smith', bio: null, deletedAt: null });

    expect((await generateMetadata(params('anna'))).openGraph).toBeUndefined();
  });

  it('falls back to a plain line when the teacher wrote no bio', async () => {
    findUnique.mockResolvedValue({ firstName: 'Anna', lastName: 'Smith', bio: null, deletedAt: null });

    const metadata = await generateMetadata(params('anna'));

    expect(metadata.description).toBe('Book a class with Anna Smith.');
  });

  // Discoverable, never promoted: a page a teacher shares may be indexed.
  it('does not ask search engines to stay away', async () => {
    findUnique.mockResolvedValue({ firstName: 'Anna', lastName: 'Smith', bio: null, deletedAt: null });

    expect((await generateMetadata(params('anna'))).robots).toBeUndefined();
  });

  it.each([
    ['no teacher', null],
    ['an erased teacher', { firstName: 'Anna', lastName: 'Smith', bio: null, deletedAt: new Date() }],
  ])('names no one for %s, whose page is a 404', async (_case, row) => {
    findUnique.mockResolvedValue(row);

    expect(await generateMetadata(params('anna'))).toEqual({});
  });
});
