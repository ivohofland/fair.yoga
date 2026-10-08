import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma, type PayoutChangeEvent } from '@prisma/client';
import { savePaymentLink, removePaymentLink } from './payment-link';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];

async function makeTeacher(paymentLink: string | null = null): Promise<string> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Link', lastName: 'Teacher', email: `pay-link-${s}@test.local`, paymentLink,
      account: { create: { email: `pay-link-${s}@test.local` } }, bio: '', pageSlug: `pay-link-${s}`,
    },
  });
  teacherIds.push(t.id);
  return t.id;
}

afterAll(async () => {
  if (teacherIds.length > 0) {
    const accounts = await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { accountId: true } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    const accountIds = accounts.map((a) => a.accountId);
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

async function storedLink(teacherId: string): Promise<string | null> {
  const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { paymentLink: true } });
  return t.paymentLink;
}

async function erase(teacherId: string): Promise<void> {
  await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

/**
 * Polls until some backend waits on a lock `holderPid` holds, and answers the
 * statement it waits in. No deadline of its own: a call that never parks ends
 * the test at vitest's timeout.
 */
async function waitForWaiter(holderPid: number, settled: () => boolean): Promise<string | null> {
  while (!settled()) {
    const [row] = await prisma.$queryRaw<Array<{ query: string }>>`
      SELECT query FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.query;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Runs `call` while a second connection holds `hold`'s locks and writes
 * uncommitted, and commits them once `call` is parked behind them.
 */
async function raceBehind<T>(
  hold: (tx: Prisma.TransactionClient) => Promise<void>,
  call: () => Promise<T>,
): Promise<{ result: T; parked: boolean; waitedIn: string | null }> {
  const holder = new PrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx: Prisma.TransactionClient) => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    if (row === undefined) throw new Error('pg_backend_pid returned no row');
    holderPid = row.pid;
    await hold(tx);
    held.open();
    await release.promise;
  }, { timeout: 60_000 });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const pending = call().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const waitedIn = await waitForWaiter(holderPid, () => settled);
    release.open();
    await holding;
    return { result: await pending, parked: waitedIn !== null, waitedIn };
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}

/** Runs `call` behind an uncommitted erasure of the teacher's row. */
function raceBehindErasure<T>(teacherId: string, call: () => Promise<T>): Promise<{ result: T; parked: boolean; waitedIn: string | null }> {
  return raceBehind(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${teacherId} FOR NO KEY UPDATE`;
    await tx.$executeRaw`UPDATE "Teacher" SET "deletedAt" = now() WHERE id = ${teacherId}`;
  }, call);
}

/**
 * Runs `call` while a second connection holds the teacher's row `FOR SHARE`,
 * which conflicts with `FOR NO KEY UPDATE` and with no weaker first lock.
 */
function raceBehindShareHold<T>(teacherId: string, call: () => Promise<T>): Promise<{ result: T; parked: boolean; waitedIn: string | null }> {
  return raceBehind(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${teacherId} FOR SHARE`;
  }, call);
}

type EventRow = Pick<PayoutChangeEvent, 'id' | 'kind' | 'accountCurrency' | 'before' | 'after'>;

async function events(teacherId: string): Promise<EventRow[]> {
  return prisma.payoutChangeEvent.findMany({
    where: { teacherId },
    select: { id: true, kind: true, accountCurrency: true, before: true, after: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Each event's `identifierChanged`, oldest first. */
async function identifierChangedOf(teacherId: string): Promise<(boolean | null)[]> {
  const rows = await prisma.payoutChangeEvent.findMany({
    where: { teacherId }, select: { identifierChanged: true }, orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.identifierChanged);
}

/** Fails when any event column holds `secret` whole. */
async function expectNoEventHolds(teacherId: string, secret: string): Promise<void> {
  const rows = await prisma.payoutChangeEvent.findMany({ where: { teacherId } });
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(secret);
}

describe('savePaymentLink', () => {
  it('saves the parsed link', async () => {
    const teacherId = await makeTeacher();
    expect(await savePaymentLink(prisma, teacherId, '  https://revolut.me/anna\n')).toEqual({
      kind: 'saved', paymentLink: 'https://revolut.me/anna', eventId: expect.any(String),
    });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
  });

  it('replaces a different stored link', async () => {
    const teacherId = await makeTeacher('https://revolut.me/old');
    expect(await savePaymentLink(prisma, teacherId, 'https://revolut.me/anna')).toEqual({
      kind: 'saved', paymentLink: 'https://revolut.me/anna', eventId: expect.any(String),
    });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
  });

  it('answers unchanged when the parsed link is already stored', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    expect(await savePaymentLink(prisma, teacherId, 'HTTPS://revolut.me/anna')).toEqual({
      kind: 'unchanged', paymentLink: 'https://revolut.me/anna',
    });
    expect(await events(teacherId)).toEqual([]);
  });

  it('refuses a link that does not parse, and stores nothing', async () => {
    const teacherId = await makeTeacher();
    expect(await savePaymentLink(prisma, teacherId, 'http://revolut.me/anna')).toEqual({ kind: 'invalid', error: 'not_https' });
    expect(await storedLink(teacherId)).toBeNull();
  });

  it('answers teacher_gone for an erased teacher and leaves the column alone', async () => {
    const teacherId = await makeTeacher('https://revolut.me/old');
    await erase(teacherId);
    expect(await savePaymentLink(prisma, teacherId, 'https://revolut.me/anna')).toEqual({ kind: 'teacher_gone' });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/old');
    expect(await events(teacherId)).toEqual([]);
  });

  it('answers teacher_gone when it waited behind an erasure, and writes nothing', async () => {
    const teacherId = await makeTeacher();
    const { result, parked } = await raceBehindErasure(teacherId, () => savePaymentLink(prisma, teacherId, 'https://revolut.me/anna'));
    expect({ parked, result }).toEqual({ parked: true, result: { kind: 'teacher_gone' } });
    expect(await storedLink(teacherId)).toBeNull();
    expect(await events(teacherId)).toEqual([]);
  }, 20_000);

  // The link writers take the teacher row `FOR NO KEY UPDATE` as their first
  // statement (`docs/lock-order.md`, "The `Teacher` row is the first lock"),
  // so a `FOR SHARE` holder parks them there, before they read. Their later
  // `UPDATE` would park too, which is why the test names the statement.
  it('waits in its first lock behind a FOR SHARE hold on the teacher row, then saves (#786)', async () => {
    const teacherId = await makeTeacher();
    const { result, waitedIn } = await raceBehindShareHold(teacherId, () => savePaymentLink(prisma, teacherId, 'https://revolut.me/annayoga'));
    expect({ waitedInFirstLock: waitedIn?.includes('FOR NO KEY UPDATE') ?? false, kind: result.kind }).toEqual({ waitedInFirstLock: true, kind: 'saved' });
  }, 20_000);

  it('reads the link it replaces under its lock, so a save it waited behind is the before (#786)', async () => {
    const teacherId = await makeTeacher('https://revolut.me/original');
    const { result, parked } = await raceBehind(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${teacherId} FOR NO KEY UPDATE`;
      await tx.$executeRaw`UPDATE "Teacher" SET "paymentLink" = 'https://monzo.me/racerlink' WHERE id = ${teacherId}`;
    }, () => savePaymentLink(prisma, teacherId, 'https://paypal.me/annayoga'));
    expect({ parked, kind: result.kind }).toEqual({ parked: true, kind: 'saved' });
    expect(await events(teacherId)).toMatchObject([
      { kind: 'payment_link_changed', before: 'monzo.me/…link', after: 'paypal.me/…yoga' },
    ]);
  }, 20_000);
});

describe('savePaymentLink records a payout-change event (#786)', () => {
  it('records an add with no before and the masked link after, and returns its id', async () => {
    const teacherId = await makeTeacher();
    const out = await savePaymentLink(prisma, teacherId, 'https://revolut.me/annayoga');
    if (out.kind !== 'saved') throw new Error(`expected saved, got ${out.kind}`);
    expect(await events(teacherId)).toEqual([
      { id: out.eventId, kind: 'payment_link_added', accountCurrency: null, before: null, after: 'revolut.me/…yoga' },
    ]);
    expect(await identifierChangedOf(teacherId)).toEqual([null]);
    await expectNoEventHolds(teacherId, 'annayoga');
  });

  it('records a change with both links masked', async () => {
    const teacherId = await makeTeacher('https://revolut.me/oldteacher');
    const out = await savePaymentLink(prisma, teacherId, 'https://paypal.me/annayoga');
    if (out.kind !== 'saved') throw new Error(`expected saved, got ${out.kind}`);
    expect(await events(teacherId)).toEqual([
      { id: out.eventId, kind: 'payment_link_changed', accountCurrency: null, before: 'revolut.me/…cher', after: 'paypal.me/…yoga' },
    ]);
    await expectNoEventHolds(teacherId, 'oldteacher');
    await expectNoEventHolds(teacherId, 'annayoga');
  });

  it('records a changed link that masks like the old one as a changed identifier', async () => {
    const teacherId = await makeTeacher('https://revolut.me/annacher');
    await savePaymentLink(prisma, teacherId, 'https://revolut.me/evilcher');
    expect(await events(teacherId)).toMatchObject([
      { kind: 'payment_link_changed', before: 'revolut.me/…cher', after: 'revolut.me/…cher' },
    ]);
    expect(await identifierChangedOf(teacherId)).toEqual([true]);
  });

  // The column's CHECK admits any https value; the parser also refuses userinfo.
  it('masks a stored link that no longer parses as an unreadable link', async () => {
    const teacherId = await makeTeacher('https://revolut.me@evil.example/oldteacher');
    const out = await savePaymentLink(prisma, teacherId, 'https://paypal.me/annayoga');
    if (out.kind !== 'saved') throw new Error(`expected saved, got ${out.kind}`);
    expect(await events(teacherId)).toMatchObject([
      { kind: 'payment_link_changed', before: 'an unreadable link', after: 'paypal.me/…yoga' },
    ]);
    await expectNoEventHolds(teacherId, 'oldteacher');
  });
});

describe('removePaymentLink', () => {
  it('removes a stored link', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    expect(await removePaymentLink(prisma, teacherId)).toEqual({ kind: 'removed', eventId: expect.any(String) });
    expect(await storedLink(teacherId)).toBeNull();
  });

  it('records the removal with the masked link before, and returns its id (#786)', async () => {
    const teacherId = await makeTeacher('https://revolut.me/annayoga');
    const out = await removePaymentLink(prisma, teacherId);
    if (out.kind !== 'removed') throw new Error(`expected removed, got ${out.kind}`);
    expect(await events(teacherId)).toEqual([
      { id: out.eventId, kind: 'payment_link_removed', accountCurrency: null, before: 'revolut.me/…yoga', after: null },
    ]);
    expect(await identifierChangedOf(teacherId)).toEqual([null]);
    await expectNoEventHolds(teacherId, 'annayoga');
  });

  it('answers absent when there is no link, and records nothing', async () => {
    const teacherId = await makeTeacher();
    expect(await removePaymentLink(prisma, teacherId)).toEqual({ kind: 'absent' });
    expect(await events(teacherId)).toEqual([]);
  });

  it('answers teacher_gone for an erased teacher and leaves the column alone', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    await erase(teacherId);
    expect(await removePaymentLink(prisma, teacherId)).toEqual({ kind: 'teacher_gone' });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
    expect(await events(teacherId)).toEqual([]);
  });

  it('answers teacher_gone when it waited behind an erasure, and removes nothing', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    const { result, parked } = await raceBehindErasure(teacherId, () => removePaymentLink(prisma, teacherId));
    expect({ parked, result }).toEqual({ parked: true, result: { kind: 'teacher_gone' } });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
    expect(await events(teacherId)).toEqual([]);
  }, 20_000);

  it('waits in its first lock behind a FOR SHARE hold on the teacher row, then removes (#786)', async () => {
    const teacherId = await makeTeacher('https://revolut.me/annayoga');
    const { result, waitedIn } = await raceBehindShareHold(teacherId, () => removePaymentLink(prisma, teacherId));
    expect({ waitedInFirstLock: waitedIn?.includes('FOR NO KEY UPDATE') ?? false, kind: result.kind }).toEqual({ waitedInFirstLock: true, kind: 'removed' });
  }, 20_000);
});
