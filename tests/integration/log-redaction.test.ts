import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLogger } from '@/lib/log';
import { createPrismaClient } from '@/lib/prisma-client';
import { fixtureRun } from '../room-fixtures';

const suffix = `logredact-${Date.now()}`;
const email = `pii-${suffix}@test.local`;
const PII = ['Alicepii', 'Surnamepii', email];
const studentIds: string[] = [];
const run = fixtureRun('logredact');
let completedClassId = '';

// `minimal` is what production gets: Prisma picks it when NODE_ENV is
// `production` and no format is passed.
const clients = {
  colorless: createPrismaClient({ errorFormat: 'colorless' }),
  minimal: createPrismaClient({ errorFormat: 'minimal' }),
} as const;

beforeAll(async () => {
  const s = await clients.colorless.student.create({ data: { firstName: 'Alicepii', lastName: 'Surnamepii', email } });
  studentIds.push(s.id);
  const room = await run.makeFixture(clients.colorless);
  completedClassId = (await run.addClass(clients.colorless, room, 'completed')).id;
});

afterAll(async () => {
  // `in` over an array that may be empty deletes nothing; never a scalar id
  // that an early beforeAll failure would leave undefined.
  await clients.colorless.student.deleteMany({ where: { id: { in: studentIds } } });
  await run.cleanup(clients.colorless);
  await Promise.all(Object.values(clients).map((c) => c.$disconnect()));
});

/**
 * Throws `run`'s error, checks its raw message carries `expected` — so the
 * redaction checks below cannot pass for want of anything to redact — then
 * logs it and checks the line carries none of the fake student's data.
 */
async function logged(work: () => Promise<unknown>, expected: string): Promise<{ thrown: Error; err: LoggedErr }> {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  let thrown: unknown = null;
  try {
    await work();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(expected);
  logger.error({ err: thrown });
  const line = lines[0] ?? '';
  for (const token of PII) expect(line).not.toContain(token);
  return { thrown: thrown as Error, err: (JSON.parse(line) as { err: LoggedErr }).err };
}

interface LoggedErr {
  readonly [key: string]: unknown;
  readonly message: string;
}

describe.each(['colorless', 'minimal'] as const)('real Prisma errors reach the log without row values (%s)', (format) => {
  const prisma = clients[format];

  it('a validation error', async () => {
    const out = await logged(
      () => prisma.student.update({ where: { email }, data: { incomeTier: 'Alicepii' as never } }),
      'Alicepii',
    );
    expect(out.err.message).toMatch(/^Invalid `prisma\.student\.update\(\)` invocation \(detail withheld/);
  });

  it('a CHECK violation names its constraint', async () => {
    const primary = 'violates check constraint';
    const out = await logged(() => prisma.student.update({ where: { email }, data: { incomeTier: 9 } }), primary);
    // The failing row is on the thrown value, so its absence below is redaction.
    expect(JSON.stringify((out.thrown as { cause?: unknown }).cause)).toContain('Alicepii');
    expect(out.err).toMatchObject({ name: 'DriverAdapterError', sqlState: '23514', constraint: 'Student_income_tier_check' });
    const line = JSON.stringify(out.err);
    expect(line).not.toContain(primary);
    expect(line).not.toContain('Failing row contains');
  });

  it('a typed trigger raise names its trigger and row, and leaks neither its message nor the row id', async () => {
    const out = await logged(() => prisma.class.update({ where: { id: completedClassId }, data: { status: 'open' } }), completedClassId);
    // The row id appears at most once, as the rowIds facet: never in the message or stack.
    expect(JSON.stringify(out.err).split(completedClassId).length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(out.err)).not.toContain('which is terminal');
    expect(out.err.message).toBe('Driver adapter error (detail withheld from the log)');
    expect(out.err).toMatchObject({ name: 'DriverAdapterError', sqlState: '23514', trigger: 'status', rowIds: [completedClassId] });
  });

  it("a produced DriverAdapterError keeps its own class, its frames, and has no code", async () => {
    const out = await logged(() => prisma.class.update({ where: { id: completedClassId }, data: { status: 'open' } }), completedClassId);
    expect(out.thrown.constructor.name).toBe('DriverAdapterError');
    expect(Object.prototype.hasOwnProperty.call(out.thrown, 'code')).toBe(false);
    expect(out.thrown.stack).toMatch(/^DriverAdapterError: Class [0-9a-f-]+ is completed/);
    expect(out.err.type).toBe('DriverAdapterError');
    expect(out.err).not.toHaveProperty('code');
    expect(out.err).not.toHaveProperty('cause');
    expect(out.err).not.toHaveProperty('causeTruncated');
    expect(out.err.stack).toMatch(/^DriverAdapterError: Driver adapter error \(detail withheld from the log\)\n {4}at /);
  });

  it('a raw-query error', async () => {
    const out = await logged(() => prisma.$queryRawUnsafe('SELECT $1::int', `Alicepii ${email}`), email);
    expect(out.err).toMatchObject({ code: 'P2010', sqlState: '22P02' });
  });
});
