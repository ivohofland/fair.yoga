import { Prisma } from '@/lib/prisma-client';

/**
 * A Postgres error as the pg driver adapter reports it: only fields Postgres
 * wrote. Where each field comes from, and why the 23505/23514/23P01 names
 * are read from the primary message: `docs/technical-architecture.md`,
 * "Database errors".
 */
export interface PgError {
  /** The SQLSTATE: the adapter's `originalCode`, which is pg's `DatabaseError.code`. */
  readonly sqlState: string;
  /** Postgres's primary message: the adapter's `originalMessage`. It can quote row values. */
  readonly message: string;
  /** The violated constraint's name, for the SQLSTATEs in `CONSTRAINT_SOURCE` only. */
  readonly constraint?: string;
}

/** The adapter kinds this repo can meet; the test beside this file tethers it to the runtime's type. */
export const ADAPTER_KINDS = [
  'GenericJs', 'UnsupportedNativeDataType', 'InvalidIsolationLevel', 'LengthMismatch',
  'UniqueConstraintViolation', 'NullConstraintViolation', 'ForeignKeyConstraintViolation',
  'DatabaseNotReachable', 'DatabaseDoesNotExist', 'DatabaseAlreadyExists', 'DatabaseAccessDenied',
  'ConnectionClosed', 'TlsConnectionError', 'AuthenticationFailed', 'TransactionWriteConflict',
  'TableDoesNotExist', 'ColumnNotFound', 'TooManyConnections', 'ValueOutOfRange',
  'MissingFullTextSearchIndex', 'SocketTimeout', 'InconsistentColumnData',
  'TransactionAlreadyClosed', 'postgres',
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
const ADAPTER_KIND_SET: ReadonlySet<string> = new Set(ADAPTER_KINDS);

/** pg-pool's own text for a pool wait that outlived `connectionTimeoutMillis` (driver text, matched only here). */
export const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

const SQLSTATE = /^[0-9A-Z]{5}$/;

type ConstraintReader = (cause: object, message: string) => string | undefined;

function fromMessage(clause: RegExp): ConstraintReader {
  return (_cause, message) => clause.exec(message)?.[1];
}

function field(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Where each constraint SQLSTATE's name comes from; a SQLSTATE added here must say. */
const CONSTRAINT_SOURCE = {
  '23503': (cause) => {
    const constraint = field(cause, 'constraint');
    const index = isObject(constraint) ? field(constraint, 'index') : undefined;
    return typeof index === 'string' ? index : undefined;
  },
  '23505': fromMessage(/^duplicate key value violates unique constraint "([^"]+)"$/),
  '23514': fromMessage(/ violates check constraint "([^"]+)"$/),
  '23P01': fromMessage(/^conflicting key value violates exclusion constraint "([^"]+)"$/),
} as const satisfies Record<'23503' | '23505' | '23514' | '23P01', ConstraintReader>;

function hasConstraintSource(sqlState: string): sqlState is keyof typeof CONSTRAINT_SOURCE {
  return Object.prototype.hasOwnProperty.call(CONSTRAINT_SOURCE, sqlState);
}

/** The adapter's cause object, from exactly one of the two places it is put; never walks `Error.cause`. */
function adapterCauseOf(err: unknown): object | null {
  if (err instanceof Error && err.name === 'DriverAdapterError') {
    const cause: unknown = err.cause;
    return isObject(cause) ? cause : null;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const wrapped = isObject(err.meta) ? field(err.meta, 'driverAdapterError') : undefined;
    if (!isObject(wrapped) || field(wrapped, 'name') !== 'DriverAdapterError') return null;
    const cause = field(wrapped, 'cause');
    return isObject(cause) ? cause : null;
  }
  return null;
}

/**
 * The Postgres error the adapter put on `err` itself, or `null`. Shallow: it
 * never follows `Error.cause`. Requires a SQLSTATE-shaped `originalCode` and a
 * string `originalMessage`. Where it looks: `docs/technical-architecture.md`, "Database errors".
 */
export function pgErrorOf(err: unknown): PgError | null {
  const cause = adapterCauseOf(err);
  if (cause === null) return null;
  const sqlState = field(cause, 'originalCode');
  const message = field(cause, 'originalMessage');
  if (typeof sqlState !== 'string' || !SQLSTATE.test(sqlState) || typeof message !== 'string') return null;
  const constraint = hasConstraintSource(sqlState) ? CONSTRAINT_SOURCE[sqlState](cause, message) : undefined;
  return constraint === undefined ? { sqlState, message } : { sqlState, message, constraint };
}

/**
 * True for pg-pool's plain wait-timeout `Error`: exact message, no own `code`,
 * and no Postgres error on it. Driver text, matched here only: `docs/technical-architecture.md`, "Database errors".
 */
export function isPgPoolTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === PG_POOL_TIMEOUT_MESSAGE &&
    !Object.prototype.hasOwnProperty.call(err, 'code') &&
    pgErrorOf(err) === null
  );
}

/**
 * The adapter's `cause.kind`, read from the same places as `pgErrorOf`, when it
 * is in `ADAPTER_KINDS`; `undefined` otherwise. For the log facet only: `docs/technical-architecture.md`, "Database errors".
 */
export function adapterKindOf(err: unknown): AdapterKind | undefined {
  const cause = adapterCauseOf(err);
  const kind = cause === null ? undefined : field(cause, 'kind');
  return typeof kind === 'string' && ADAPTER_KIND_SET.has(kind) ? (kind as AdapterKind) : undefined;
}
