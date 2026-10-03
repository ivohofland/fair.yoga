import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { createLogger } from './log';

const VALIDATION_MSG =
  '\nInvalid `prisma.student.create()` invocation:\n\n{\n  data: {\n    firstName: "Alicepii",\n    email: "pii.test@example.com"\n  }\n}\n\nUnknown argument `bogus`.';
const PII = ['Alicepii', 'pii.test@example.com'];

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  return { logger, lines };
}

function expectNoPii(line: string | undefined): void {
  expect(line).toBeDefined();
  for (const token of PII) expect(line).not.toContain(token);
}

const prismaErr = () => new Prisma.PrismaClientValidationError(VALIDATION_MSG, { clientVersion: '6.19.3' });

describe('the logger redacts errors on every channel', () => {
  it('msg fallback: { err } with no message string', () => {
    const { logger, lines } = capture();
    logger.error({ err: prismaErr() });
    expectNoPii(lines[0]);
    expect(JSON.parse(lines[0] ?? '{}').msg).toBe('Invalid `prisma.student.create()` invocation (detail withheld from the log)');
  });

  it('an Error as the first argument', () => {
    const { logger, lines } = capture();
    logger.error(prismaErr());
    expectNoPii(lines[0]);
    expect(JSON.parse(lines[0] ?? '{}').err.type).toBe('PrismaClientValidationError');
  });

  it('an Error under a key other than err', () => {
    const { logger, lines } = capture();
    logger.warn({ err: new Error('first'), probeErr: prismaErr() }, 'probe failed');
    expectNoPii(lines[0]);
    expect(JSON.parse(lines[0] ?? '{}').probeErr.type).toBe('PrismaClientValidationError');
  });

  it('an error-like object under err that is not an Error', () => {
    const { logger, lines } = capture();
    logger.error({ err: { name: 'application_error', message: 'm', to: 'pii.test@example.com' } }, 'send failed');
    expectNoPii(lines[0]);
  });

  it('no mutation: the caller keeps its own object', () => {
    const { logger } = capture();
    const e = prismaErr();
    const obj = { err: e, classId: 'c1' };
    logger.error(obj, 'failed');
    expect(obj.err).toBe(e);
  });
});
