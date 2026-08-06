import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { LOCK_TIMEOUT_SQL, lockClassRow, setLockTimeout } from './db-locks';
import { claimTemplateForGeneration } from '@/services/class-generator';
import { claimStudioTemplateForGeneration } from '@/services/studio-class-generator';
import { withdrawWaitingEntriesForTeacher } from '@/services/waitlist';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The compile-time half of this file, and the reason it exists at all.
 *
 * `lockClassRow`'s `{ $transaction?: never }` brand is what stops a caller
 * passing the bare `PrismaClient`, which would compile cleanly and fail
 * silently: on a bare client each statement is its own autocommit
 * transaction, so `SET LOCAL` and `FOR UPDATE` would each apply to a
 * transaction that no longer exists by the time the next statement runs.
 * `Prisma.TransactionClient` alone does not stop it — it is
 * `Omit<PrismaClient, ITXClientDenyList>`, and `Omit` drops members from the
 * TYPE only, so a bare client stays structurally assignable.
 *
 * That was originally verified with a throwaway call site, which was then
 * deleted — throwing the verification away with it. This function is that
 * call site, kept: never called, so it costs nothing at runtime, and
 * `tsconfig.json` includes every `.ts` file in the repo, so weakening the
 * brand makes `tsc --noEmit` fail on the unused `@ts-expect-error` below
 * rather than leaving a green suite.
 *
 * One directive per branded function, not one for the type. Loosening
 * `TransactionClientOnly` itself fails all of them at once, but re-typing a
 * single parameter back to `Prisma.TransactionClient` fails only that
 * function's own line — which is the regression each of these is here to
 * catch. They live together because the brand does, not because one of them
 * covers the rest.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _theBrandRejectsABareClient(client: PrismaClient): Promise<void> {
  // @ts-expect-error A bare PrismaClient must never satisfy the brand: on it,
  // `SET LOCAL` and `FOR UPDATE` have no transaction to live in.
  await lockClassRow(client, 'never-called');
  // @ts-expect-error Same brand, same reason, on the split-out helper.
  await setLockTimeout(client);
  // @ts-expect-error `LOCK_TIMEOUT_SQL` then `FOR UPDATE`, both transaction-scoped.
  await claimTemplateForGeneration(client, 'never-called');
  // @ts-expect-error The studio mirror of the site above.
  await claimStudioTemplateForGeneration(client, 'never-called');
  // @ts-expect-error `FOR UPDATE OF c`, with the writes it protects after it.
  await withdrawWaitingEntriesForTeacher(client, { teacherId: 'x', studentId: 'y' });
}

describe('the shared lock timeout', () => {
  /**
   * `SHOW` reads the setting as the session actually holds it, so this
   * observes the effect rather than re-asserting the string that was sent.
   * The distinction matters: `SET LOCAL lock_timeout = '2 sekunden'` would
   * also be "a string that was sent".
   */
  it('is in force for the rest of the transaction after setLockTimeout', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  /**
   * `lockClassRow` must set it too, not merely assume a caller did. The class
   * id is deliberately one that does not exist: `SELECT ... WHERE id = $1 FOR
   * UPDATE` over zero rows takes no lock and errors on nothing, so this
   * needs no fixture and cannot contend with anything.
   */
  it('is in force after lockClassRow, which sets it itself', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await lockClassRow(tx, '00000000-0000-4000-8000-000000000000');
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  /**
   * Called twice in one transaction — `deleteStudentAccount` (`gdpr.ts`) does
   * exactly this, once up front and again inside `lockClassRow` per class it
   * locks. The docblock claims the second call overwrites the first rather
   * than erroring or stacking; this is that claim, checked.
   */
  it('survives being set twice in one transaction', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      await lockClassRow(tx, '00000000-0000-4000-8000-000000000000');
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  /**
   * Outside a transaction the setting is not in force — which is the whole
   * reason the brand above exists. A bare-client caller would get this: no
   * error, no bound, nothing to notice.
   */
  it('is not in force outside a transaction', async () => {
    const rows = await prisma.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;

    expect(rows[0]?.lock_timeout).not.toBe('2s');
  });

  it('is the literal both template-claim sites share', () => {
    expect(LOCK_TIMEOUT_SQL).toBe("SET LOCAL lock_timeout = '2s'");
  });
});
