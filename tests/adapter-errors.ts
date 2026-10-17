import { Prisma } from '@/lib/prisma-client';
import { PG_POOL_TIMEOUT_MESSAGE } from '@/lib/pg-error';

/** The plain object the pg driver adapter puts in a DriverAdapterError's `cause`. */
export interface AdapterCause {
  readonly kind: string;
  readonly [key: string]: unknown;
}

const CLIENT_VERSION = Prisma.prismaVersion.client;

/**
 * The cause the adapter builds for a pg `DatabaseError` with this SQLSTATE:
 * the kind and the fields it sets per code. The fidelity tests in
 * `src/lib/pg-error.test.ts` and `src/lib/db-transient-shapes.test.ts` hold
 * each shape to a produced one.
 */
export function pgCause(sqlState: string, message: string, extra: Partial<AdapterCause> = {}): AdapterCause {
  const original = { originalCode: sqlState, originalMessage: message };
  switch (sqlState) {
    case '23505':
      return { ...original, kind: 'UniqueConstraintViolation', ...extra };
    case '23503':
      return { ...original, kind: 'ForeignKeyConstraintViolation', ...extra };
    case '40001':
      return { ...original, kind: 'TransactionWriteConflict', ...extra };
    default:
      return { ...original, kind: 'postgres', code: sqlState, severity: 'ERROR', message, detail: undefined, column: undefined, hint: undefined, ...extra };
  }
}

/** A typed call's shape: a DriverAdapterError whose `cause` is the adapter's object. */
export function driverAdapterError(cause: AdapterCause): Error {
  const message = typeof cause.message === 'string' ? cause.message : cause.kind;
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: 'DriverAdapterError', enumerable: true, writable: true, configurable: true });
  Object.defineProperty(err, 'cause', { value: cause, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(err, 'clientVersion', { value: CLIENT_VERSION, enumerable: true, writable: true, configurable: true });
  return err;
}

/** A raw or mapped call's shape: a Known error carrying the adapter's error in `meta`. */
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
