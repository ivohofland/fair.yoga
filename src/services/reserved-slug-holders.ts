import type { PrismaClient } from '@prisma/client';

/** A teacher whose page slug is a reserved name. */
export interface ReservedSlugHolder {
  teacherId: string;
  pageSlug: string;
}

/**
 * Every teacher holding one of `reserved` as their page slug, ordered by slug.
 * Runs in the migrate image, which has no tsconfig paths: relative imports
 * only. CI's "Reserved-slug check loads in the migration image" step catches
 * a non-relative import.
 */
export async function findReservedSlugHolders(
  db: PrismaClient,
  reserved: Iterable<string>,
): Promise<ReservedSlugHolder[]> {
  const rows = await db.teacher.findMany({
    where: { pageSlug: { in: [...reserved] } },
    select: { id: true, pageSlug: true },
    orderBy: { pageSlug: 'asc' },
  });
  return rows.map((r) => ({ teacherId: r.id, pageSlug: r.pageSlug }));
}
