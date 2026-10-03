import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { Prisma } from '@prisma/client';
import { createLogger, log } from './log';
import { serializeErr } from './log-serializers';

const VALIDATION_MSG =
  '\nInvalid `prisma.student.create()` invocation:\n\n{\n  data: {\n    firstName: "Alicepii",\n    email: "pii.test@example.com"\n  }\n}\n\nUnknown argument `bogus`.';
const PII = ['Alicepii', 'pii.test@example.com'];
const WITHHELD_MSG = 'Invalid `prisma.student.create()` invocation (detail withheld from the log)';
const PLACEHOLDER = { type: 'Unserializable', message: '(error could not be serialized for the log)' };

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  return { logger, lines };
}

/**
 * A written line is checked for the tokens. A serializer output is also
 * checked to be a plain object, so a raw Error returned unchanged cannot pass.
 */
function expectNoPii(value: unknown): void {
  expect(value).toBeDefined();
  if (typeof value !== 'string') {
    expect(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype).toBe(true);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const token of PII) expect(text).not.toContain(token);
}

function parsed(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? '{}') as Record<string, unknown>;
}

const prismaErr = () => new Prisma.PrismaClientValidationError(VALIDATION_MSG, { clientVersion: '6.19.3' });

/**
 * pino keeps a logger's stream, serializers and hooks under symbols it
 * exports but does not type as members of `Logger`.
 */
type PinoInternals = Record<symbol, unknown>;
const internals = (logger: pino.Logger): PinoInternals => logger as unknown as PinoInternals;

describe('the logger redacts errors on every channel', () => {
  it('msg fallback: { err } with no message string', () => {
    const { logger, lines } = capture();
    logger.error({ err: prismaErr() });
    expectNoPii(lines[0]);
    expect(parsed(lines[0]).msg).toBe(WITHHELD_MSG);
  });

  it('msg fallback: an error-like err that is not an Error instance', () => {
    const { logger, lines } = capture();
    logger.error({ err: { name: 'PrismaClientValidationError', message: VALIDATION_MSG } });
    expectNoPii(lines[0]);
    expect(parsed(lines[0]).msg).toBe(WITHHELD_MSG);
  });

  it('msg fallback: an ordinary error-like err keeps its message', () => {
    const { logger, lines } = capture();
    logger.error({ err: { name: 'Foo', message: 'class 42 failed' } });
    expect(parsed(lines[0]).msg).toBe('class 42 failed');
  });

  it('a payload with a message field under another key is not rewritten', () => {
    const { logger, lines } = capture();
    logger.info({ payload: { message: 'hello', extra: 1 } }, 'sent');
    expect(parsed(lines[0]).payload).toEqual({ message: 'hello', extra: 1 });
  });

  it('an Error as the first argument', () => {
    const { logger, lines } = capture();
    logger.error(prismaErr());
    expectNoPii(lines[0]);
    expect((parsed(lines[0]).err as { type: string }).type).toBe('PrismaClientValidationError');
  });

  it('an Error under a key other than err', () => {
    const { logger, lines } = capture();
    logger.warn({ err: new Error('first'), probeErr: prismaErr() }, 'probe failed');
    expectNoPii(lines[0]);
    expect((parsed(lines[0]).probeErr as { type: string }).type).toBe('PrismaClientValidationError');
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

describe('a log call never throws: a value that cannot be serialized is replaced', () => {
  const throwingGetter = (key: 'cause' | 'stack') => {
    const e = new Error('m');
    Object.defineProperty(e, key, {
      get() {
        throw new Error('Alicepii');
      },
    });
    return e;
  };
  const revoked = () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };

  it.each([
    ['an Error whose cause getter throws', () => throwingGetter('cause')],
    ['an Error whose stack getter throws', () => throwingGetter('stack')],
    ['a revoked Proxy', revoked],
  ])('%s', (_label, make) => {
    const { logger, lines } = capture();
    expect(() => logger.error({ err: make(), other: 'kept' }, 'm')).not.toThrow();
    expect(lines).toHaveLength(1);
    expectNoPii(lines[0]);
    const line = parsed(lines[0]);
    expect(line.err).toEqual(PLACEHOLDER);
    expect(line.other).toBe('kept');
    expect(line.msg).toBe('m');
  });

  it('a revoked Proxy under a key other than err', () => {
    const { logger, lines } = capture();
    expect(() => logger.error({ probe: revoked(), other: 'kept' }, 'm')).not.toThrow();
    expect(parsed(lines[0])).toMatchObject({ probe: PLACEHOLDER, other: 'kept' });
  });

  it('a revoked Proxy as the first argument', () => {
    const { logger, lines } = capture();
    expect(() => logger.error(revoked(), 'm')).not.toThrow();
    expect(parsed(lines[0])).toMatchObject({ err: PLACEHOLDER, msg: 'm' });
  });
});

describe('the configuration the app runs', () => {
  it('the exported log redacts', () => {
    const stream = internals(log)[pino.symbols.streamSym] as { write: (s: string) => unknown };
    const lines: string[] = [];
    const spy = vi.spyOn(stream, 'write').mockImplementation((s: string) => {
      lines.push(s);
      return true;
    });
    try {
      log.error({ err: prismaErr() });
    } finally {
      spy.mockRestore();
    }
    expectNoPii(lines[0]);
    expect(parsed(lines[0]).msg).toBe(WITHHELD_MSG);
  });

  it('the development logger carries the same serializer and hook', () => {
    vi.stubEnv('NODE_ENV', 'development');
    let logger: pino.Logger | undefined;
    try {
      logger = createLogger();
      const own = internals(logger);
      expect((own[pino.symbols.serializersSym] as { err?: unknown }).err).toBe(serializeErr);
      expect(typeof (own[pino.symbols.hooksSym] as { logMethod?: unknown }).logMethod).toBe('function');
    } finally {
      vi.unstubAllEnvs();
      // The transport runs pino-pretty in a worker thread; end it so it does
      // not outlive the test.
      (logger ? (internals(logger)[pino.symbols.streamSym] as { end?: () => void }) : undefined)?.end?.();
    }
  });
});
