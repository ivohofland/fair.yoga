import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@/lib/log';

const prisma = new PrismaClient();
const suffix = `logredact-${Date.now()}`;
const email = `pii-${suffix}@test.local`;
const PII = ['Alicepii', 'Surnamepii', email];
const studentIds: string[] = [];

beforeAll(async () => {
  const s = await prisma.student.create({ data: { firstName: 'Alicepii', lastName: 'Surnamepii', email } });
  studentIds.push(s.id);
});

afterAll(async () => {
  // `in` over an array that may be empty deletes nothing; never a scalar id
  // that an early beforeAll failure would leave undefined.
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.$disconnect();
});

async function logged(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  let thrown: unknown = null;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).not.toBeNull();
  logger.error({ err: thrown });
  const line = lines[0] ?? '';
  for (const token of PII) expect(line).not.toContain(token);
  return JSON.parse(line) as Record<string, unknown>;
}

describe('real Prisma errors reach the log without row values', () => {
  it('a validation error', async () => {
    const out = await logged(() =>
      prisma.student.update({ where: { email }, data: { incomeTier: 'Alicepii' as never } }),
    );
    expect((out.err as { message: string }).message).toMatch(/^Invalid `prisma\.student\.update\(\)` invocation \(detail withheld/);
  });

  it('a CHECK violation names its constraint', async () => {
    const out = await logged(() => prisma.student.update({ where: { email }, data: { incomeTier: 9 } }));
    expect(out.err).toMatchObject({ sqlState: '23514', constraint: 'Student_income_tier_check' });
  });

  it('a raw-query error', async () => {
    const out = await logged(() => prisma.$queryRawUnsafe('SELECT $1::int', `Alicepii ${email}`));
    expect(out.err).toMatchObject({ code: 'P2010', sqlState: '22P02' });
  });
});
