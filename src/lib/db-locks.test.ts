import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  ANNOUNCEMENT_DEDUPE_WINDOW_MS,
  LOCK_TIMEOUT_SQL,
  lockAnnouncementSlot,
  lockClassRow,
  setLockTimeout,
} from './db-locks';
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
  // @ts-expect-error `pg_advisory_xact_lock` — taken and released by its own
  // autocommit transaction on a bare client, protecting nothing.
  await lockAnnouncementSlot(client, { teacherId: 'x', classId: null, message: 'never-called' });
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

describe('the announcement advisory lock', () => {
  /**
   * The shape of the lock, not merely that the call returned. Postgres names
   * the form it took in `pg_locks`: `objsubid = 2` is the two-int
   * `pg_advisory_xact_lock(int4, int4)` and `objsubid = 1` the single-bigint
   * one, and `classid` is the first of those two ints — the namespace. Both
   * are the reason a future unrelated advisory lock cannot collide with this
   * one by accident, and neither is observable from the call site.
   */
  it('takes one advisory lock, in the two-int form, under this project namespace', async () => {
    const held = await prisma.$transaction(async (tx) => {
      await lockAnnouncementSlot(tx, {
        teacherId: 'teacher',
        classId: 'class',
        message: 'Bring a blanket.',
      });
      return tx.$queryRaw<Array<{ classid: number; objsubid: number }>>`
        SELECT classid::int AS classid, objsubid::int AS objsubid
        FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
    });

    expect(held).toHaveLength(1);
    expect(held[0]!.objsubid).toBe(2);
    expect(held[0]!.classid).toBe(196);
  });

  /**
   * The property the announcements route buys with it, and the property that
   * separates `pg_advisory_xact_lock` from `pg_advisory_lock`: a second holder
   * of the same key waits, and it stops waiting when the first transaction
   * ENDS rather than when its connection is handed back to the pool. A
   * session-scoped lock would pass the first half of this and hang the second.
   *
   * A second `PrismaClient`, deliberately: advisory locks are held per session,
   * so two transactions that happened to share a pooled connection would not
   * contend at all and this would prove nothing.
   */
  it('makes a second transaction wait for the same key, and lets go on commit', async () => {
    const other = new PrismaClient();
    const slot = { teacherId: 'contended', classId: null, message: 'Same message.' };
    const order: string[] = [];
    let taken!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((r) => {
      taken = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });

    const holding = prisma.$transaction(
      async (tx) => {
        await lockAnnouncementSlot(tx, slot);
        taken();
        await released;
      },
      { timeout: 20_000 },
    );
    await acquired;

    const waiting = other.$transaction(
      async (tx) => {
        await lockAnnouncementSlot(tx, slot);
        order.push('second acquired');
      },
      { timeout: 20_000 },
    );

    await new Promise((r) => setTimeout(r, 300));
    // Still parked: the assertion that fails if the lock is not taken at all.
    expect(order).toEqual([]);

    order.push('first committed');
    release();
    await holding;
    await waiting;
    await other.$disconnect();

    expect(order).toEqual(['first committed', 'second acquired']);
  });

  /**
   * The other half: it serialises one `(teacher, class, message)`, not every
   * announcement in the database. A lock keyed on a constant would pass the
   * test above and make every teacher's send queue behind every other's.
   *
   * All THREE fields, one at a time, because the helper now composes the key
   * from the tuple itself: a composition that dropped `classId` would still
   * pass a two-teacher version of this test while making a teacher's
   * class-scoped send queue behind their identical all-students one.
   */
  it('does not make two slots differing in any one field wait for each other', async () => {
    const other = new PrismaClient();
    const held = { teacherId: 'teacher-one', classId: 'class-one', message: 'Bring a blanket.' };
    const neighbours = [
      { ...held, teacherId: 'teacher-two' },
      { ...held, classId: 'class-two' },
      { ...held, message: 'Bring two blankets.' },
    ];
    let taken!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((r) => {
      taken = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });

    const holding = prisma.$transaction(
      async (tx) => {
        await lockAnnouncementSlot(tx, held);
        taken();
        await released;
      },
      { timeout: 20_000 },
    );
    await acquired;

    // Each resolves while the first transaction is still open, which is the point.
    for (const neighbour of neighbours) {
      await other.$transaction(async (tx) => {
        await lockAnnouncementSlot(tx, neighbour);
      });
    }

    release();
    await holding;
    await other.$disconnect();
  });

  it('is a two-minute window, the same quantity the manual reminder cooldown uses', () => {
    expect(ANNOUNCEMENT_DEDUPE_WINDOW_MS).toBe(2 * 60 * 1000);
  });
});
