import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { serializeErr, type SerializedErr, type SerializedPrismaMeta } from './log-serializers';
import { TERMINAL_TRIGGER_TAILS } from './api-errors';

const PII = ['Alicepii', 'Surnamepii', 'pii.test@example.com'];
const V = { clientVersion: '6.19.3' };
/** Strips `readonly` so a test can probe that a nested container is frozen at runtime. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Every value passed here is a serializer output, so it must be a plain
// object: a raw Error returned unchanged would fail this before the tokens.
function expectNoPii(value: unknown): void {
  expect(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype).toBe(true);
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

  it('a raw-query value spelling a frame stays inside the withheld message', () => {
    const out = serializeErr(rawCast('Alicepii\n    at evil3 (x)'));
    expectNoPii(out);
    expect(out.stack).not.toContain('evil3');
  });

  it('frame shape: a remainder that does not start on a new line is not frames', () => {
    const e = new Prisma.PrismaClientValidationError('\nInvalid `prisma.student.create()` invocation: firstName "Alicepii"', V);
    void e.stack; // force V8 to format and cache the stack before the message changes
    e.message = '\nInvalid `prisma.student.create()` invocation:';
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out.stack).not.toContain('Alicepii');
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

  it('meta.target shaped like a raw SQL expression is not an identifier', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.student.create()` invocation:\n\n\nUnique constraint failed', {
        ...V,
        code: 'P2002',
        meta: { target: 'lower(TRIM(BOTH FROM Alicepii))' },
      }),
    );
    expectNoPii(out);
    expect(out.meta).toBeUndefined();
  });

  it('meta.code shaped like a name, not a SQLSTATE, lifts no sqlState', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.$queryRawUnsafe()` invocation:', {
        ...V,
        code: 'P2010',
        meta: { code: 'Alicepii' },
      }),
    );
    expectNoPii(out);
    expect(out.sqlState).toBeUndefined();
  });

  it('a Prisma error class whose own name was left as "Error" is still withheld, by constructor name', () => {
    class PrismaClientUnknownRequestError extends Error {}
    const out = serializeErr(new PrismaClientUnknownRequestError(CHECK_MSG));
    expectNoPii(out);
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

  it('a code that is not shaped like a Prisma error code is withheld', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.student.create()` invocation:\n\n\nUnique constraint failed', {
        ...V,
        code: 'Alicepii',
        meta: {},
      }),
    );
    expectNoPii(out);
    expect(out.code).toBeUndefined();
  });

  it('withholds stack entirely when the original error had none', () => {
    const e = new Prisma.PrismaClientValidationError(VALIDATION_MSG, V);
    Object.defineProperty(e, 'stack', { value: undefined });
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out.stack).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, 'stack')).toBe(false);
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

  it('terminates on a cause cycle, and flags where it cut', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    const out = serializeErr(a);
    expect(out.cause?.message).toBe('b');
    expect(out.cause?.cause).toBeUndefined();
    expect(out.cause?.causeCycle).toBe(true);
    expect(out.causeCycle).toBeUndefined();
  });

  it('flags an aggregate member omitted as a cycle', () => {
    const agg = new AggregateError([], 'self');
    agg.errors.push(agg);
    const out = serializeErr(agg);
    expect(out.aggregateErrors).toBeUndefined();
    expect(out.causeCycle).toBe(true);
  });

  it('stops at a depth bound on a long chain', () => {
    // The exact hop count, not an inequality a loosened or tightened bound
    // could still satisfy.
    let e = new Error('0');
    for (let i = 1; i < 50; i++) e = new Error(String(i), { cause: e });
    let depth = 0;
    let node: SerializedErr = serializeErr(e);
    while (node.cause) {
      depth++;
      node = node.cause;
    }
    expect(depth).toBe(8);
    expect(node.causeTruncated).toBe(true);
  });

  it('does not flag truncation when the chain ends inside the budget', () => {
    let e = new Error('0');
    for (let i = 1; i <= 8; i++) e = new Error(String(i), { cause: e });
    let node: SerializedErr = serializeErr(e);
    while (node.cause) node = node.cause;
    expect(node.message).toBe('0');
    expect(node.causeTruncated).toBeUndefined();
  });

  it('stops at the same depth bound through nested aggregates', () => {
    let e: Error = new Error('0');
    for (let i = 1; i < 50; i++) e = new AggregateError([e], String(i));
    let hops = 0;
    let node: SerializedErr = serializeErr(e);
    while (node.aggregateErrors?.[0]) {
      hops++;
      node = node.aggregateErrors[0];
    }
    expect(hops).toBe(8);
    expect(node.causeTruncated).toBe(true);
  });

  it('serializes an AggregateError through the same allowlist', () => {
    const agg = new AggregateError([new Prisma.PrismaClientValidationError(VALIDATION_MSG, V)], 'two failed');
    const out = serializeErr(agg);
    expectNoPii(out);
    expect(out.aggregateErrors?.[0]?.type).toBe('PrismaClientValidationError');
  });

  it('a repeated non-cyclic error is serialized at each position it occurs', () => {
    const x = new Error('x');
    const agg = new AggregateError([x, x], 'two failed', { cause: x });
    const out = serializeErr(agg);
    expect(out.cause?.message).toBe('x');
    expect(out.aggregateErrors).toHaveLength(2);
    expect(out.aggregateErrors?.[0]?.message).toBe('x');
    expect(out.aggregateErrors?.[1]?.message).toBe('x');
    // Serialized once: every position holds the same frozen object.
    expect(out.aggregateErrors?.[0]).toBe(out.cause);
    expect(out.aggregateErrors?.[1]).toBe(out.cause);
  });

  it('omits aggregateErrors when no element survives', () => {
    const out = serializeErr(new AggregateError([], 'empty'));
    expect(out.aggregateErrors).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, 'aggregateErrors')).toBe(false);
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

const known = (message: string, code: string, meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { ...V, code, meta });
const QUERY_HEADER = '\nInvalid `prisma.class.update()` invocation:\n\n\n';
const pgError = (code: string, message: string) =>
  `${QUERY_HEADER}Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`;
const pgErrorWithDetail = (code: string, message: string, detail: string) =>
  `${QUERY_HEADER}Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: Some("${detail}"), column: None, hint: None }), transient: false })`;

/** Every position in `out`, a repeated node counted wherever it appears. */
function entries(out: SerializedErr): number {
  return 1 + (out.cause ? entries(out.cause) : 0) + (out.aggregateErrors ?? []).reduce((n, e) => n + entries(e), 0);
}

describe('serializeErr: repeated and oversized graphs', () => {
  it('a node reachable many times is serialized once, and the line stays bounded', () => {
    let e: Error = new Error('leaf');
    for (let level = 0; level < 9; level++) {
      const below = e;
      e = new AggregateError(Array.from({ length: 8 }, () => below), `level ${level}`);
    }
    const started = performance.now();
    const out = serializeErr(e);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(() => JSON.stringify(out)).not.toThrow();
    // The exact budget is pinned by the wide-aggregate test below; here the
    // greedy packing of whole repeated subtrees can leave it part unspent.
    expect(entries(out)).toBeLessThanOrEqual(64);
    expect(out.causeTruncated).toBe(true);
  });

  it('a wide aggregate stops at the entry budget, and says so', () => {
    const out = serializeErr(new AggregateError(Array.from({ length: 100 }, (_, i) => new Error(String(i))), 'wide'));
    expect(out.aggregateErrors).toHaveLength(63);
    expect(out.causeTruncated).toBe(true);
  });
});

describe('serializeErr: fails closed on odd errors', () => {
  it('an Error whose message is not a string is still serialized, never returned raw', () => {
    const e = rawCast('Alicepii pii.test@example.com');
    Object.defineProperty(e, 'message', { value: undefined });
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out.type).toBe('PrismaClientKnownRequestError');
  });

  it('an Error whose cause getter throws becomes the placeholder, not a throw', () => {
    const e = new Error('m');
    Object.defineProperty(e, 'cause', {
      get() {
        throw new Error('Alicepii');
      },
    });
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out).toEqual({ type: 'Unserializable', message: '(error could not be serialized for the log)' });
  });

  it('a withheld error keeps its own name only when it is a Prisma class name', () => {
    class PrismaClientUnknownRequestError extends Error {}
    const e = new PrismaClientUnknownRequestError(CHECK_MSG);
    e.name = 'Alicepii';
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out.name).toBeUndefined();
  });

  it('outputs are frozen, so a mutated output cannot be replayed', () => {
    const o = serializeErr(new Prisma.PrismaClientValidationError(VALIDATION_MSG, V));
    expect(() => {
      (o as { message: string }).message = 'Alicepii';
    }).toThrow(TypeError);
    expectNoPii(serializeErr(o));
  });

  it('meta.target, aggregateErrors, and rowIds are frozen at every level, not just the top', () => {
    const id = '824c3362-c21f-466e-a741-7301d469730f';
    const err = new Prisma.PrismaClientUnknownRequestError(pgError('23514', `Row ${id} is terminal; ${TERMINAL_TRIGGER_TAILS.status} Alicepii`), V);
    (err as unknown as { meta?: unknown }).meta = { target: ['email', 'phone'] };
    (err as unknown as { errors?: unknown }).errors = [new Error('member')];

    const o = serializeErr(err);
    expectNoPii(o);
    expect(o.rowIds).toEqual([id]);
    expect(o.meta).toEqual({ target: ['email', 'phone'] });
    expect(o.aggregateErrors).toHaveLength(1);

    const meta = o.meta as Mutable<SerializedPrismaMeta>;
    expect(() => {
      meta.target = 'z';
    }).toThrow(TypeError);
    expect(() => {
      (meta.target as string[]).push('z');
    }).toThrow(TypeError);
    expect(() => {
      (o.aggregateErrors as SerializedErr[]).push(o);
    }).toThrow(TypeError);
    expect(() => {
      (o.rowIds as string[]).push('z');
    }).toThrow(TypeError);
    expectNoPii(serializeErr(o));
  });
});

describe('serializeErr: what a withheld error still says', () => {
  it('keeps column and field-name identifiers', () => {
    const p2022 = serializeErr(known(QUERY_HEADER, 'P2022', { modelName: 'Class', column: 'Class.newCol' }));
    expect(p2022.meta).toEqual({ modelName: 'Class', column: 'Class.newCol' });
    const p2003 = serializeErr(known(QUERY_HEADER, 'P2003', { modelName: 'Class', field_name: 'Class_roomId_fkey' }));
    expect(p2003.meta).toEqual({ modelName: 'Class', field_name: 'Class_roomId_fkey' });
  });

  it('lifts a constraint only for the SQLSTATEs whose message is the constraint sentence', () => {
    const out = serializeErr(
      new Prisma.PrismaClientUnknownRequestError(
        pgError('23502', 'null value in column \\"x\\" violates not-null constraint; DETAIL violates check constraint \\"Alicepii\\"'),
        V,
      ),
    );
    expectNoPii(out);
    expect(out.sqlState).toBe('23502');
    expect(out.constraint).toBeUndefined();
  });

  it.each([
    ['23505', 'duplicate key value violates unique constraint "X_key"', 'X_key'],
    ['23503', 'insert or update on table "t" violates foreign key constraint "X_fkey"', 'X_fkey'],
    ['23P01', 'conflicting key value violates exclusion constraint "X_excl"', 'X_excl'],
  ] as const)('lifts the constraint name for %s', (sqlState, message, name) => {
    const out = serializeErr(new Prisma.PrismaClientUnknownRequestError(pgError(sqlState, message), V));
    expect(out.sqlState).toBe(sqlState);
    expect(out.constraint).toBe(name);
  });

  it('names a connector-level failure by its kind', () => {
    const out = serializeErr(
      new Prisma.PrismaClientUnknownRequestError(`${QUERY_HEADER}Error in PostgreSQL connection: Error { kind: Closed, cause: None }`, V),
    );
    expect(out.connectorKind).toBe('Closed');
    expect(out.sqlState).toBeUndefined();
  });

  it('a kind outside the closed set is not emitted', () => {
    const out = serializeErr(
      new Prisma.PrismaClientUnknownRequestError(`${QUERY_HEADER}Error in PostgreSQL connection: Error { kind: Alicepii, cause: None }`, V),
    );
    expectNoPii(out);
    expect(out.connectorKind).toBeUndefined();
  });

  it('a connector kind is read only from an Unknown request error', () => {
    const out = serializeErr(
      new Prisma.PrismaClientValidationError(`${QUERY_HEADER}Error { kind: Closed, cause: None }`, V),
    );
    expect(out.connectorKind).toBeUndefined();
  });

  it.each([
    [
      'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction. Alicepii',
      'expired',
    ],
    ['Transaction already closed: Alicepii, 5012 ms passed', 'expired'],
    ['Unable to start a transaction in the given time. Alicepii', 'start_timeout'],
    ["Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore. Alicepii", 'not_found'],
    ['Transaction already closed: A commit cannot be executed on a committed transaction. Alicepii', 'closed'],
    ['Something else entirely. Alicepii', 'other'],
  ])('maps a P2028 meta.error to its kind, never its text: %s', (error, kind) => {
    const out = serializeErr(known('Transaction API error: Alicepii', 'P2028', { error }));
    expectNoPii(out);
    expect(out.txError).toBe(kind);
  });

  it.each(Object.entries(TERMINAL_TRIGGER_TAILS))('a terminal trigger fire names its trigger and rows: %s', (trigger, tail) => {
    const id = '824c3362-c21f-466e-a741-7301d469730f';
    const other = '12345678-1234-1234-1234-123456789abc';
    const out = serializeErr(
      new Prisma.PrismaClientUnknownRequestError(pgError('23514', `Row ${id} of ${other}, ${id} is terminal; ${tail} Alicepii`), V),
    );
    expectNoPii(out);
    expect(out.trigger).toBe(trigger);
    expect(out.rowIds).toEqual([id, other]);
  });

  it('a terminal trigger fire keeps at most three row ids', () => {
    const ids = ['a', 'b', 'c', 'd'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`);
    const out = serializeErr(
      new Prisma.PrismaClientUnknownRequestError(pgError('23514', `${ids.join(' ')} ${TERMINAL_TRIGGER_TAILS.status} open`), V),
    );
    expect(out.rowIds).toEqual(ids.slice(0, 3));
  });

  it('a CHECK violation is not a trigger fire, and its failing row lends no ids', () => {
    // The second message gives the failing row a full UUID, so dropping the
    // trigger condition on `rowIds` has an id to find.
    for (const msg of [CHECK_MSG, CHECK_MSG.replace('4ad7b519', '4ad7b519-0000-4000-8000-000000000001')]) {
      const out = serializeErr(new Prisma.PrismaClientUnknownRequestError(msg, V));
      expectNoPii(out);
      expect(out.trigger).toBeUndefined();
      expect(out.rowIds).toBeUndefined();
    }
  });

  it('a CHECK violation whose DETAIL carries a real trigger tail and row ids lifts neither', () => {
    const id = '824c3362-c21f-466e-a741-7301d469730f';
    const other = '12345678-1234-1234-1234-123456789abc';
    const msg = pgErrorWithDetail(
      '23514',
      'new row for relation \\"Student\\" violates check constraint \\"Student_income_tier_check\\"',
      `Failing row ${id} of ${other}, ${id} is terminal; ${TERMINAL_TRIGGER_TAILS.status} Alicepii.`,
    );
    const out = serializeErr(new Prisma.PrismaClientUnknownRequestError(msg, V));
    expectNoPii(out);
    expect(out.constraint).toBe('Student_income_tier_check');
    expect(out.trigger).toBeUndefined();
    expect(out.rowIds).toBeUndefined();
  });

  it('a 23514 whose message field names no constraint and no trigger still lifts neither from DETAIL', () => {
    // Unlike the test above, this message field never matches the `violates
    // … constraint` sentence, so `constraint` stays undefined here too — the
    // only thing standing between DETAIL's trigger tail and row ids and the
    // output is the PostgresError `message` field restriction on its own.
    const id = '824c3362-c21f-466e-a741-7301d469730f';
    const other = '12345678-1234-1234-1234-123456789abc';
    const msg = pgErrorWithDetail(
      '23514',
      'row check failed',
      `Row ${id} of ${other}, ${id} is terminal; ${TERMINAL_TRIGGER_TAILS.status} Alicepii.`,
    );
    const out = serializeErr(new Prisma.PrismaClientUnknownRequestError(msg, V));
    expectNoPii(out);
    expect(out.constraint).toBeUndefined();
    expect(out.trigger).toBeUndefined();
    expect(out.rowIds).toBeUndefined();
  });
});

/**
 * A P2010 whose stack was formatted from `header + rest`, then whose message
 * was cut back to the header alone: the stack's remainder after the
 * `${name}: ${message}` prefix starts with `rest`.
 */
function rawCastHeaderOnly(rest: string): Prisma.PrismaClientKnownRequestError {
  const header = '\nInvalid `prisma.$queryRawUnsafe()` invocation:';
  const e = known(`${header}${rest}`, 'P2010', { code: '22P02' });
  void e.stack; // force V8 to format and cache the stack before the message changes
  e.message = header;
  return e;
}

describe('serializeErr: anchors and guards', () => {
  it('the header is anchored at the start of the message', () => {
    const out = serializeErr(new Prisma.PrismaClientRustPanicError('panicked: Invalid `Alicepii()` invocation', '6.19.3'));
    expect(out.message).toBe('Prisma error (detail withheld from the log)');
  });

  it('frame shape: a remainder with a non-frame line is not frames', () => {
    expectNoPii(serializeErr(rawCastHeaderOnly('\n\n\nRaw query failed. Message: `"Alicepii"`')));
  });

  it('frame shape: a line is a frame only when it starts with the frame indent', () => {
    expectNoPii(serializeErr(rawCastHeaderOnly('\nAlicepii    at evil (x)')));
  });

  it('every element of an identifier array must be an identifier', () => {
    const out = serializeErr(known(QUERY_HEADER, 'P2002', { target: ['email', 'lower(Alicepii)'] }));
    expectNoPii(out);
    expect(out.meta).toBeUndefined();
  });

  it('a non-Prisma code that is neither a string nor a number is dropped', () => {
    const out = serializeErr(Object.assign(new Error('m'), { code: { to: 'Alicepii' } }));
    expectNoPii(out);
    expect(out.code).toBeUndefined();
  });

  it('numeric meta must be a number', () => {
    const out = serializeErr(known(QUERY_HEADER, 'P2024', { timeout: 'Alicepii' }));
    expectNoPii(out);
    expect(out.meta?.timeout).toBeUndefined();
  });

  it('a SQLSTATE is the whole of meta.code, not a part of it', () => {
    const out = serializeErr(known(QUERY_HEADER, 'P2010', { code: 'ALICE pii' }));
    expect(out.sqlState).toBeUndefined();
  });

  it('a Prisma code is the whole of code, not a prefix', () => {
    const out = serializeErr(known(QUERY_HEADER, 'P2002 Alicepii', {}));
    expectNoPii(out);
    expect(out.code).toBeUndefined();
  });

  it('an initialization error reads its code from errorCode, not an own code', () => {
    const e = Object.assign(new Prisma.PrismaClientInitializationError("Can't reach database server", '6.19.3', 'P1001'), {
      code: 'Alicepii',
    });
    expect(serializeErr(e).code).toBe('P1001');
  });
});
