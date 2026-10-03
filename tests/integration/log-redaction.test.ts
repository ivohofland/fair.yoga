import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@/lib/log';

const suffix = `logredact-${Date.now()}`;
const email = `pii-${suffix}@test.local`;
const PII = ['Alicepii', 'Surnamepii', email];
const studentIds: string[] = [];

// `minimal` is what production gets: Prisma picks it when NODE_ENV is
// `production` and no format is passed.
const clients = {
  colorless: new PrismaClient({ errorFormat: 'colorless' }),
  minimal: new PrismaClient({ errorFormat: 'minimal' }),
} as const;

beforeAll(async () => {
  const s = await clients.colorless.student.create({ data: { firstName: 'Alicepii', lastName: 'Surnamepii', email } });
  studentIds.push(s.id);
});

afterAll(async () => {
  // `in` over an array that may be empty deletes nothing; never a scalar id
  // that an early beforeAll failure would leave undefined.
  await clients.colorless.student.deleteMany({ where: { id: { in: studentIds } } });
  await Promise.all(Object.values(clients).map((c) => c.$disconnect()));
});

/**
 * Throws `run`'s error, checks its raw message carries `expected` — so the
 * redaction checks below cannot pass for want of anything to redact — then
 * logs it and checks the line carries none of the fake student's data.
 */
async function logged(run: () => Promise<unknown>, expected: string): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  let thrown: unknown = null;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(expected);
  logger.error({ err: thrown });
  const line = lines[0] ?? '';
  for (const token of PII) expect(line).not.toContain(token);
  return JSON.parse(line) as Record<string, unknown>;
}

describe.each(['colorless', 'minimal'] as const)('real Prisma errors reach the log without row values (%s)', (format) => {
  const prisma = clients[format];

  it('a validation error', async () => {
    const out = await logged(
      () => prisma.student.update({ where: { email }, data: { incomeTier: 'Alicepii' as never } }),
      'Alicepii',
    );
    expect((out.err as { message: string }).message).toMatch(/^Invalid `prisma\.student\.update\(\)` invocation \(detail withheld/);
  });

  it('a CHECK violation names its constraint', async () => {
    const out = await logged(() => prisma.student.update({ where: { email }, data: { incomeTier: 9 } }), 'Alicepii');
    expect(out.err).toMatchObject({ sqlState: '23514', constraint: 'Student_income_tier_check' });
  });

  it('a raw-query error', async () => {
    const out = await logged(() => prisma.$queryRawUnsafe('SELECT $1::int', `Alicepii ${email}`), email);
    expect(out.err).toMatchObject({ code: 'P2010', sqlState: '22P02' });
  });
});
