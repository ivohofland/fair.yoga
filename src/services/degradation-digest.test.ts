import { describe, it, expect, vi, beforeEach, afterAll, onTestFinished } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { log } from '@/lib/log';

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
type UpdateManyArgs = Parameters<PrismaClient['degradationEvent']['updateMany']>[0];

interface ScopedHooks {
  afterRead?: Hook;
  afterClaim?: Hook;
  /** Runs before the sweep's nth claim, counting from 1; throw to fail it. */
  beforeClaim?: (n: number) => void;
  /** Runs before each release; throw to fail it. */
  beforeRelease?: () => void;
  /** Presents a stored code to the sweep under another name. */
  alias?: Readonly<Record<string, string>>;
}

/**
 * A client that sees only this file's rows. `afterRead` runs after the sweep's
 * read and `afterClaim` after each of its successful claims, which is where a
 * concurrent event would land. A claim is an `updateMany` keyed on
 * `lastSeenAt`; a release is one that is not.
 */
function scoped(hooks: ScopedHooks = {}): PrismaClient {
  const real = prisma.degradationEvent;
  const alias = hooks.alias ?? {};
  const stored = Object.fromEntries(Object.entries(alias).map(([from, to]) => [to, from]));
  let claims = 0;
  return {
    degradationEvent: {
      findMany: async (args: object) => {
        const rows = await real.findMany({
          ...args,
          where: { code: { startsWith: `${PREFIX}${run}` } },
        });
        await hooks.afterRead?.(real);
        return rows.map((r) => ({ ...r, code: alias[r.code] ?? r.code }));
      },
      updateMany: async (args: UpdateManyArgs) => {
        const where = args.where as { code: string; lastSeenAt?: Date };
        const isClaim = where.lastSeenAt !== undefined;
        if (isClaim) {
          claims += 1;
          hooks.beforeClaim?.(claims);
        } else {
          hooks.beforeRelease?.();
        }
        const result = await real.updateMany({
          ...args,
          where: { ...args.where, code: stored[where.code] ?? where.code },
        });
        if (isClaim && result.count === 1) await hooks.afterClaim?.(real);
        return result;
      },
    },
  } as unknown as PrismaClient;
}

async function seed(
  code: string,
  lastSeenAt: Date,
  lastNotifiedAt: Date | null = null,
  sample: Prisma.InputJsonValue = { tier: 9 },
) {
  await prisma.degradationEvent.create({
    data: { code, occurrences: 4, firstSeenAt: T1, lastSeenAt, lastNotifiedAt, sample },
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

  it('describes a code named like an Object prototype key as unregistered', async () => {
    await seed(A, T2);

    await notifyOperatorOfDegradations(scoped({ alias: { [A]: 'toString' } }), OPERATOR);

    expect(sendHtmlEmail).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendHtmlEmail.mock.calls)).toContain('no longer registered');
  });

  it.each([
    ['an array', ['first', 'second']],
    ['a string', 'tier nine'],
  ])('renders a sample that is %s as no sample', async (_label, sample) => {
    await seed(A, T2, null, sample);

    await notifyOperatorOfDegradations(scoped(), OPERATOR);

    const { html } = sendHtmlEmail.mock.calls[0]![0] as { html: string };
    expect(html).not.toContain('Latest:');
  });

  it.each([
    ['never told', null],
    ['told before', T1],
  ])('puts back the claims already made when a later claim throws (%s)', async (_label, previous) => {
    await seed(A, T2, previous);
    await seed(B, T2, previous);

    const result = notifyOperatorOfDegradations(
      scoped({
        beforeClaim: (n) => {
          if (n === 2) throw new Error('claim failed');
        },
      }),
      OPERATOR,
    );

    await expect(result).rejects.toBeInstanceOf(DegradationDigestError);
    await expect(result).rejects.toThrow(/claim failed/);
    expect(sendHtmlEmail).not.toHaveBeenCalled();
    const rows = await prisma.degradationEvent.findMany({ where: { code: { in: [A, B] } } });
    expect(rows.map((r) => r.lastNotifiedAt)).toEqual([previous, previous]);
  });

  it('says so, and logs the code, when a claim cannot be released', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    await seed(A, T2, T1);
    sendHtmlEmail.mockResolvedValue({ ok: false, reason: 'provider down' });

    const result = notifyOperatorOfDegradations(
      scoped({
        beforeRelease: () => {
          throw new Error('release failed');
        },
      }),
      OPERATOR,
    );

    await expect(result).rejects.toBeInstanceOf(DegradationDigestError);
    await expect(result).rejects.toThrow(/could not be released/);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: A, err: expect.any(Error) }),
      expect.stringContaining('could not release'),
    );
  });
});
