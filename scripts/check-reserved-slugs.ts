/**
 * Deploy gate (#855): refuses while a teacher holds a reserved page slug.
 * The migrate image runs it after `prisma migrate deploy`; a non-zero exit
 * fails the migrate step and so refuses the deploy (DEPLOYMENT.md §6).
 *   pnpm check:reserved-slugs
 */
import { PrismaClient } from '@prisma/client';
import { RESERVED_SLUGS } from '../src/lib/reserved-slugs';
import { findReservedSlugHolders } from '../src/services/reserved-slug-holders';

async function main(): Promise<number> {
  const db = new PrismaClient();
  try {
    // An explicit connect reports an unreachable database as P1001; a first
    // query reports the same failure with no code.
    await db.$connect();
    const holders = await findReservedSlugHolders(db, RESERVED_SLUGS);
    if (holders.length === 0) {
      console.log('reserved-slug check: no teacher holds a reserved page slug');
      return 0;
    }
    for (const h of holders) console.error(`reserved-slug check: "${h.pageSlug}" is held by teacher ${h.teacherId}`);
    console.error('reserved-slug check: refusing the deploy; see DEPLOYMENT.md §6, A reserved page slug a teacher holds');
    return 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('reserved-slug check: failed to run; refusing the deploy', err);
    process.exit(1);
  },
);
