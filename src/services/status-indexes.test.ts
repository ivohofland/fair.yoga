/**
 * `WaitlistEntry_status_idx` and `Class_status_idx` (#224): plain btree indexes
 * on each table's `status`, serving the every-minute sweeps that filter on it.
 *
 * The definitions are pinned exactly rather than by existence, because the
 * likeliest regression is a well-meant narrowing to a partial index
 * (`WHERE status = 'waiting'`), which Prisma's queries can never use — why is in
 * `docs/data-model.md` (Design Notes, status indexes). Neither regression
 * reaches the drift check: a dropped `@@index` ships its own dropping
 * migration, and `prisma migrate diff` does not see a partial predicate, so a
 * hand-written narrowing passes it too. This test refuses both.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

async function indexDefinition(indexName: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${indexName}`;
  return rows[0]?.indexdef;
}

describe('status indexes (#224)', () => {
  it('WaitlistEntry.status carries a plain btree index', async () => {
    expect(await indexDefinition('WaitlistEntry_status_idx')).toBe(
      'CREATE INDEX "WaitlistEntry_status_idx" ON public."WaitlistEntry" USING btree (status)',
    );
  });

  it('Class.status carries a plain btree index', async () => {
    expect(await indexDefinition('Class_status_idx')).toBe(
      'CREATE INDEX "Class_status_idx" ON public."Class" USING btree (status)',
    );
  });
});
