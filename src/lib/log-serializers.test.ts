import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { serializeErr } from './log-serializers';

const PII = ['Alicepii', 'Surnamepii', 'pii.test@example.com'];
const V = { clientVersion: '6.19.3' };

function expectNoPii(value: unknown): void {
  const json = JSON.stringify(value);
  for (const token of PII) expect(json).not.toContain(token);
}

// Messages as Prisma 6.19.3 rendered them under NODE_ENV=production (spec, "measured").
const VALIDATION_MSG =
  '\nInvalid `prisma.student.create()` invocation:\n\n{\n  data: {\n    firstName: "Alicepii",\n    lastName: "Surnamepii",\n    email: "pii.test@example.com",\n    bogus: 1,\n    ~~~~~\n  }\n}\n\nUnknown argument `bogus`. Available options are marked with ?.';
const CHECK_MSG =
  '\nInvalid `prisma.student.update()` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"Student\\" violates check constraint \\"Student_income_tier_check\\"", severity: "ERROR", detail: Some("Failing row contains (4ad7b519, Alicepii, Surnamepii, pii.test@example.com, 9)."), column: None, hint: None }), transient: false })';
const rawCast = (value: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.$queryRawUnsafe()\` invocation:\n\n\nRaw query failed. Code: \`22P02\`. Message: \`ERROR: invalid input syntax for type integer: "${value}"\``,
    {
      ...V,
      code: 'P2010',
      meta: { type: 'Object', message: `ERROR: invalid input syntax for type integer: "${value}"`, stack: '', code: '22P02' },
    },
  );

describe('serializeErr: Prisma query errors withhold their message', () => {
  it('a validation error keeps the operation header and drops the argument tree', () => {
    const out = serializeErr(new Prisma.PrismaClientValidationError(VALIDATION_MSG, V));
    expectNoPii(out);
    expect(out.type).toBe('PrismaClientValidationError');
    expect(out.message).toBe('Invalid `prisma.student.create()` invocation (detail withheld from the log)');
    expect(out.stack).toMatch(/^PrismaClientValidationError: Invalid `prisma\.student\.create\(\)` invocation \(detail withheld from the log\)\n\s+at /);
  });

  it('a CHECK violation lifts its SQLSTATE and constraint, never the failing row', () => {
    const out = serializeErr(new Prisma.PrismaClientUnknownRequestError(CHECK_MSG, V));
    expectNoPii(out);
    expect(out.sqlState).toBe('23514');
    expect(out.constraint).toBe('Student_income_tier_check');
  });

  it('a P2010 drops meta.message and lifts meta.code as its SQLSTATE', () => {
    const out = serializeErr(rawCast('Alicepii pii.test@example.com'));
    expectNoPii(out);
    expect(out.code).toBe('P2010');
    expect(out.sqlState).toBe('22P02');
    expect(out.message).toBe('Invalid `prisma.$queryRawUnsafe()` invocation (detail withheld from the log)');
  });

  it('forged frame: a newline in a raw-query value cannot pass as a stack frame', () => {
    const out = serializeErr(rawCast('Alicepii\n    at evil3 (x)'));
    expectNoPii(out);
    expect(out.stack).not.toContain('evil3');
  });

  it('class-23 gate: a non-integrity error quoting the constraint sentence lifts no constraint', () => {
    const out = serializeErr(rawCast('x violates check constraint "Alicepii"'));
    expectNoPii(out);
    expect(out.constraint).toBeUndefined();
  });

  it('a known request error keeps its code and identifier meta', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.student.create()` invocation:\n\n\nUnique constraint failed on the fields: (`email`)', {
        ...V,
        code: 'P2002',
        meta: { modelName: 'Student', target: ['email'], cause: 'Alicepii' },
      }),
    );
    expectNoPii(out);
    expect(out.code).toBe('P2002');
    expect(out.meta).toEqual({ modelName: 'Student', target: ['email'] });
  });

  it('a pool timeout keeps its numeric meta', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
        ...V,
        code: 'P2024',
        meta: { modelName: 'Class', connection_limit: 5, timeout: 10 },
      }),
    );
    expect(out.meta).toEqual({ modelName: 'Class', connection_limit: 5, timeout: 10 });
  });

  it('parses the non-production header form, any receiver, and $-identifiers', () => {
    const dev = serializeErr(
      new Prisma.PrismaClientValidationError(
        '\nInvalid `tx.student.create()` invocation in\n/app/src/services/x.ts:12:3\n\n   9 const a = 1\n→ 12 await tx.student.create({ data: { firstName: "Alicepii" } })',
        V,
      ),
    );
    expectNoPii(dev);
    expect(dev.message).toBe('Invalid `tx.student.create()` invocation (detail withheld from the log)');
  });

  it('withholds the whole message when no header parses', () => {
    const out = serializeErr(new Prisma.PrismaClientRustPanicError('panicked at Alicepii', '6.19.3'));
    expectNoPii(out);
    expect(out.message).toBe('Prisma error (detail withheld from the log)');
  });

  it('fails closed: an error named like a Prisma error is withheld without instanceof', () => {
    class Lookalike extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'PrismaClientValidationError';
      }
    }
    const out = serializeErr(new Lookalike(VALIDATION_MSG));
    expectNoPii(out);
  });

  it('an initialization error keeps its message: it is about the connection', () => {
    const msg = "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `db:5432`";
    const out = serializeErr(new Prisma.PrismaClientInitializationError(msg, '6.19.3', 'P1001'));
    expect(out.message).toBe(msg);
    expect(out.code).toBe('P1001');
  });
});

describe('serializeErr: the shape', () => {
  it('a plain error keeps message and stack, and drops other enumerable props', () => {
    const e = Object.assign(new Error('class 42 failed'), { code: 'E_X', extra: 'Alicepii' });
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out.message).toBe('class 42 failed');
    expect(out.stack).toBe(e.stack);
    expect(out.code).toBe('E_X');
  });

  it("a URL error loses the input it refused", () => {
    let caught: unknown;
    try {
      new URL('not a url Alicepii');
    } catch (err) {
      caught = err;
    }
    const out = serializeErr(caught);
    expectNoPii(out);
    expect(out).toMatchObject({ type: 'TypeError', code: 'ERR_INVALID_URL' });
  });

  it('keeps an explicitly set name', () => {
    const e = new Error('m');
    e.name = 'SpotFreedError';
    expect(serializeErr(e).name).toBe('SpotFreedError');
  });

  it('redacts a Prisma error at depth in a cause chain', () => {
    const inner = new Prisma.PrismaClientValidationError(VALIDATION_MSG, V);
    const outer = new Error('spot freed but promotion failed', { cause: new Error('wrapper', { cause: inner }) });
    const out = serializeErr(outer);
    expectNoPii(out);
    expect(out.cause?.cause?.type).toBe('PrismaClientValidationError');
  });

  it('terminates on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    const out = serializeErr(a);
    expect(out.cause?.message).toBe('b');
    expect(out.cause?.cause).toBeUndefined();
  });

  it('stops at a depth bound on a long chain', () => {
    let e = new Error('0');
    for (let i = 1; i < 50; i++) e = new Error(String(i), { cause: e });
    let depth = 0;
    let node: { cause?: unknown } | undefined = serializeErr(e);
    while (node?.cause) {
      depth++;
      node = node.cause as { cause?: unknown };
    }
    expect(depth).toBeLessThan(49);
  });

  it('serializes an AggregateError through the same allowlist', () => {
    const agg = new AggregateError([new Prisma.PrismaClientValidationError(VALIDATION_MSG, V)], 'two failed');
    const out = serializeErr(agg);
    expectNoPii(out);
    expect(out.aggregateErrors?.[0]?.type).toBe('PrismaClientValidationError');
  });

  it('is idempotent on its own output', () => {
    const e = new AggregateError([new Error('x')], 'agg', { cause: new Error('c') });
    const once = serializeErr(e);
    expect(serializeErr(once)).toBe(once);
    expect(serializeErr(once)).toEqual(serializeErr(e));
  });

  it('allowlists an error-like object that is not an Error instance', () => {
    const out = serializeErr({ name: 'application_error', message: 'm', statusCode: 500, to: 'pii.test@example.com' });
    expectNoPii(out);
  });

  it('returns a value that is not error-like unchanged', () => {
    const obj = { a: 1 };
    expect(serializeErr(obj)).toBe(obj);
    expect(serializeErr('text')).toBe('text');
    expect(serializeErr(undefined)).toBeUndefined();
  });
});
