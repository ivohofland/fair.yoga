import { Prisma } from '@/lib/prisma-client';
import { PG_CONNECT_TIMEOUT_MESSAGE, PG_POOL_TIMEOUT_MESSAGE } from '@/lib/pg-error';

/** The plain object the pg driver adapter puts in its DriverAdapterError's `cause`. */
export interface AdapterCause {
  readonly kind: string;
  readonly [key: string]: unknown;
}

const CLIENT_VERSION = Prisma.prismaVersion.client;

/**
 * The Prisma code a typed call's error carries for each adapter `kind`
 * `pgCause` builds — the runtime's own kind-to-code mapping, for these kinds.
 * `pgCause` tags every `kind` it writes `satisfies PgCauseKind`, so a new
 * case cannot compile without an entry here.
 */
const TYPED_CODE = {
  UniqueConstraintViolation: 'P2002',
  NullConstraintViolation: 'P2011',
  ForeignKeyConstraintViolation: 'P2003',
  InvalidInputValue: 'P2007',
  TransactionWriteConflict: 'P2034',
  TooManyConnections: 'P2037',
  postgres: 'P2039',
} as const;

type PgCauseKind = keyof typeof TYPED_CODE;

/**
 * The cause the adapter builds for a pg `DatabaseError` with this SQLSTATE:
 * the kind and the fields it sets per code. `src/lib/pg-error.test.ts` and
 * `src/lib/db-transient-shapes.test.ts` hold each case to a produced one,
 * except `23502`, whose case is read from the adapter's `mapDriverError`.
 * The `postgres` default is right only for a SQLSTATE `mapDriverError` does
 * not map; re-derive the mapped ones with
 * `grep -n 'case "' node_modules/@prisma/adapter-pg/dist/index.js`.
 */
export function pgCause(sqlState: string, message: string, extra: Partial<AdapterCause> = {}): AdapterCause {
  const original = { originalCode: sqlState, originalMessage: message };
  switch (sqlState) {
    case '23505':
      return { ...original, kind: 'UniqueConstraintViolation' satisfies PgCauseKind, constraint: undefined, table: undefined, ...extra };
    case '23502':
      return { ...original, kind: 'NullConstraintViolation' satisfies PgCauseKind, constraint: undefined, ...extra };
    case '23503':
      return { ...original, kind: 'ForeignKeyConstraintViolation' satisfies PgCauseKind, constraint: undefined, ...extra };
    case '22P02':
      return { ...original, kind: 'InvalidInputValue' satisfies PgCauseKind, message, ...extra };
    case '40001':
    case '40P01':
      return { ...original, kind: 'TransactionWriteConflict' satisfies PgCauseKind, ...extra };
    case '53300':
      return { ...original, kind: 'TooManyConnections' satisfies PgCauseKind, cause: message, ...extra };
    default:
      return { ...original, kind: 'postgres' satisfies PgCauseKind, code: sqlState, severity: 'ERROR', message, detail: undefined, column: undefined, hint: undefined, ...extra };
  }
}

/**
 * The adapter's own error, not wrapped by the client runtime: a
 * DriverAdapterError whose `cause` is the adapter's object. A typed model
 * call does not throw this; `typedCallError` is that shape. `pgErrorOf`
 * still reads this one, which `src/lib/pg-error.test.ts` ("reads a bare
 * DriverAdapterError from its own cause") holds.
 */
export function driverAdapterError(cause: AdapterCause): Error {
  const message = typeof cause.message === 'string' ? cause.message : cause.kind;
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: 'DriverAdapterError', enumerable: true, writable: true, configurable: true });
  Object.defineProperty(err, 'cause', { value: cause, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(err, 'clientVersion', { value: CLIENT_VERSION, enumerable: true, writable: true, configurable: true });
  return err;
}

/** A typed model call's shape: a Known error whose code follows the cause's `kind`. */
export function typedCallError(cause: AdapterCause, modelName = 'Class'): Prisma.PrismaClientKnownRequestError {
  if (!Object.hasOwn(TYPED_CODE, cause.kind)) throw new Error(`no typed code for adapter kind ${cause.kind}`);
  return knownWithAdapterCause(TYPED_CODE[cause.kind as PgCauseKind], cause, { modelName });
}

/** A raw call's shape, or a typed one given its code: a Known error carrying the adapter's error in `meta`. */
export function knownWithAdapterCause(
  code: string,
  cause: AdapterCause,
  meta: Record<string, unknown> = {},
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`fabricated ${code}`, {
    code,
    clientVersion: CLIENT_VERSION,
    meta: { ...meta, driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

/** pg-pool's wait-timeout error as Prisma rethrows it: a plain Error, own key `clientVersion` only. */
export function pgPoolTimeout(): Error {
  return Object.assign(new Error(PG_POOL_TIMEOUT_MESSAGE), { clientVersion: CLIENT_VERSION });
}

/**
 * pg-pool's connect-timeout error as Prisma rethrows it: a plain Error whose
 * only enumerable own key is `clientVersion`, with pg's own termination error
 * as its non-enumerable `cause`.
 */
export function pgConnectTimeout(): Error {
  return Object.assign(new Error(PG_CONNECT_TIMEOUT_MESSAGE, { cause: new Error('Connection terminated unexpectedly') }), { clientVersion: CLIENT_VERSION });
}

/**
 * The cause the adapter's `mapSocketError` builds for a socket failure: no
 * `originalCode`, so `pgErrorOf` reads nothing from it and only its `kind` says
 * what happened.
 */
export function socketCause(kind: 'DatabaseNotReachable' | 'ConnectionClosed' | 'SocketTimeout'): AdapterCause {
  return kind === 'DatabaseNotReachable' ? { kind, host: '127.0.0.1', port: 1 } : { kind };
}
