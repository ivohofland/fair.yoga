import 'server-only';
import type { PrismaClient } from '@prisma/client';

export interface DegradationWrite {
  readonly code: string;
  /** Occurrences this write accounts for; the database refuses anything below 1. */
  readonly count: number;
  /** When the latest of those occurrences happened. */
  readonly at: Date;
  readonly sample: Readonly<Record<string, string | number>>;
}

/**
 * Records `count` occurrences of one degradation code: creates its row, or
 * adds to the existing one. A single `upsert` keyed on the primary key, which
 * Prisma runs as one `INSERT … ON CONFLICT` statement, so two writers racing
 * on a code with no row yet both land.
 */
export async function writeDegradationEvent(
  db: Pick<PrismaClient, 'degradationEvent'>,
  write: DegradationWrite,
): Promise<void> {
  await db.degradationEvent.upsert({
    where: { code: write.code },
    create: {
      code: write.code,
      occurrences: write.count,
      firstSeenAt: write.at,
      lastSeenAt: write.at,
      sample: { ...write.sample },
    },
    update: {
      occurrences: { increment: write.count },
      lastSeenAt: write.at,
      sample: { ...write.sample },
    },
  });
}
