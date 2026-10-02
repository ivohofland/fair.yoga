import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const sendHtmlEmail = vi.fn();
vi.mock('@/lib/email', () => ({ sendHtmlEmail: (...a: unknown[]) => sendHtmlEmail(...a) }));

const { notifyOperatorOfDegradations, DegradationDigestError } = await import('./degradation-digest');

const prisma = new PrismaClient();
const PREFIX = 'test-digest-';
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const A = `${PREFIX}${run}-A`;
const B = `${PREFIX}${run}-B`;
const OPERATOR = 'operator@example.com';

const T1 = new Date('2026-10-01T10:00:00.000Z');
const T2 = new Date('2026-10-02T10:00:00.000Z');

type Hook = (delegate: PrismaClient['degradationEvent']) => Promise<void>;

/**
 * A client that sees only this file's rows. `afterRead` runs after the sweep's
 * read and `afterClaim` after each of its claims, which is where a concurrent
 * event would land.
 */
function scoped(hooks: { afterRead?: Hook; afterClaim?: Hook } = {}): PrismaClient {
  const real = prisma.degradationEvent;
  return {
    degradationEvent: {
      findMany: async (args: object) => {
        const rows = await real.findMany({
          ...args,
          where: { code: { startsWith: `${PREFIX}${run}` } },
        });
        await hooks.afterRead?.(real);
        return rows;
      },
      updateMany: async (args: Parameters<typeof real.updateMany>[0]) => {
        const result = await real.updateMany(args);
        if (result.count === 1 && (args as { data: { lastNotifiedAt?: unknown } }).data.lastNotifiedAt) {
          await hooks.afterClaim?.(real);
        }
        return result;
      },
    },
  } as unknown as PrismaClient;
}

async function seed(code: string, lastSeenAt: Date, lastNotifiedAt: Date | null = null) {
  await prisma.degradationEvent.create({
    data: { code, occurrences: 4, firstSeenAt: T1, lastSeenAt, lastNotifiedAt, sample: { tier: 9 } },
  });
}

beforeEach(async () => {
  sendHtmlEmail.mockReset();
  sendHtmlEmail.mockResolvedValue({ ok: true });
  await prisma.degradationEvent.deleteMany({ where: { code: { startsWith: `${PREFIX}${run}` } } });
});

afterAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code: { startsWith: `${PREFIX}${run}` } } });
  await prisma.$disconnect();
});

describe('notifyOperatorOfDegradations', () => {
  it('emails a new event once, to the operator, and marks it told', async () => {
    await seed(A, T2);

    const summary = await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(summary.emailed).toBe(1);
    expect(sendHtmlEmail).toHaveBeenCalledTimes(1);
    expect(sendHtmlEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: OPERATOR, subject: expect.stringContaining(A) }),
    );
    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toEqual(T2);
  });

  it('does not repeat an event that has not fired since it was told', async () => {
    await seed(A, T2, T2);

    const summary = await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(summary.emailed).toBe(0);
    expect(sendHtmlEmail).not.toHaveBeenCalled();
  });

  it('emails again once the event fires after it was told, and only that one', async () => {
    await seed(A, T2, T1);
    await seed(B, T2, T2);

    const summary = await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(summary.emailed).toBe(1);
    expect(JSON.stringify(sendHtmlEmail.mock.calls)).toContain(A);
    expect(JSON.stringify(sendHtmlEmail.mock.calls)).not.toContain(B);
  });

  it('sends nothing, and needs no operator address, when nothing is due', async () => {
    await expect(notifyOperatorOfDegradations(scoped(), undefined)).resolves.toEqual({ emailed: 0 });
    expect(sendHtmlEmail).not.toHaveBeenCalled();
  });

  it('throws, and marks nothing told, when something is due and there is no operator address', async () => {
    await seed(A, T2);

    await expect(notifyOperatorOfDegradations(scoped(), undefined)).rejects.toBeInstanceOf(
      DegradationDigestError,
    );

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toBeNull();
    expect(sendHtmlEmail).not.toHaveBeenCalled();
  });

  it('releases its claim and throws when the provider refuses', async () => {
    await seed(A, T2, T1);
    sendHtmlEmail.mockResolvedValue({ ok: false, reason: 'RESEND_API_KEY is not configured' });

    await expect(notifyOperatorOfDegradations(scoped(), OPERATOR)).rejects.toThrow(
      /RESEND_API_KEY is not configured/,
    );

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toEqual(T1);
  });

  it('releases its claim and throws when the send itself throws', async () => {
    await seed(A, T2);
    sendHtmlEmail.mockRejectedValue(new Error('network'));

    await expect(notifyOperatorOfDegradations(scoped(), OPERATOR)).rejects.toThrow(/network/);

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toBeNull();
  });

  it('does not claim an event that fires between the read and the claim, and tells it next run', async () => {
    await seed(A, T2);
    const T3 = new Date('2026-10-02T11:00:00.000Z');

    const first = await notifyOperatorOfDegradations(
      scoped({
        afterRead: async (real) => {
          await real.update({ where: { code: A }, data: { lastSeenAt: T3 } });
        },
      }),
      OPERATOR,
    );
    expect(first.emailed).toBe(0);
    expect(sendHtmlEmail).not.toHaveBeenCalled();

    const second = await notifyOperatorOfDegradations(scoped(), OPERATOR);
    expect(second.emailed).toBe(1);
    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toEqual(T3);
  });

  it('keeps an event that fires after the claim but before the send due for the next run', async () => {
    await seed(A, T2);
    const T3 = new Date('2026-10-02T11:00:00.000Z');

    const first = await notifyOperatorOfDegradations(
      scoped({
        afterClaim: async (real) => {
          await real.update({ where: { code: A }, data: { lastSeenAt: T3 } });
        },
      }),
      OPERATOR,
    );
    expect(first.emailed).toBe(1);
    const claimed = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(claimed.lastNotifiedAt).toEqual(T2);

    const second = await notifyOperatorOfDegradations(scoped(), OPERATOR);
    expect(second.emailed).toBe(1);
  });

  it('sends exactly one email when two runs read the same due rows', async () => {
    await seed(A, T2);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const barrier = {
      afterRead: async () => {
        arrived += 1;
        if (arrived === 2) open();
        await gate;
      },
    };

    const [one, two] = await Promise.all([
      notifyOperatorOfDegradations(scoped(barrier), OPERATOR),
      notifyOperatorOfDegradations(scoped(barrier), OPERATOR),
    ]);

    expect(sendHtmlEmail).toHaveBeenCalledTimes(1);
    expect([one.emailed, two.emailed].sort()).toEqual([0, 1]);
  });

  it('describes a code the registry no longer knows without failing', async () => {
    await seed(A, T2);

    await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(JSON.stringify(sendHtmlEmail.mock.calls)).toContain('no longer registered');
  });
});
