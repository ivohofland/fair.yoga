import { Prisma } from '@/lib/prisma-client';

/**
 * A Postgres error as the pg driver adapter reports it: only fields Postgres
 * wrote. Where each field comes from, and which constraint names are read
 * from the primary message: `docs/technical-architecture.md`,
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
  'MissingFullTextSearchIndex', 'SocketTimeout', 'InconsistentColumnData', 'RestrictViolation', 'InvalidInputValue',
  'TransactionAlreadyClosed', 'postgres',
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
const ADAPTER_KIND_SET: ReadonlySet<string> = new Set(ADAPTER_KINDS);

/** pg-pool's own text for a pool wait that outlived `connectionTimeoutMillis` (driver text, matched only here). */
export const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/** pg-pool's own text for a connect that outlived `connectionTimeoutMillis` while a new client's `connect` was still running, before any client was handed out (driver text, matched only here). */
export const PG_CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

/** pg's own text for a socket that ended cleanly while the client was not ending it, with no `ErrorResponse` before it; a reset arrives as `ECONNRESET` instead (driver text, matched only here). */
export const PG_CONNECTION_TERMINATED_MESSAGE = 'Connection terminated unexpectedly';

const SQLSTATE = /^[0-9A-Z]{5}$/;

type ConstraintReader = (cause: object, message: string) => string | undefined;

function field(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** The adapter's `cause.constraint.index`, when it is a string. */
const fromIndex: ConstraintReader = (cause) => {
  const constraint = field(cause, 'constraint');
  const index = isObject(constraint) ? field(constraint, 'index') : undefined;
  return typeof index === 'string' ? index : undefined;
};

/** The readers `fromMessage` built, whose name can depend on Postgres's message wording; `namesConstraintInMessage` keys on it. */
const MESSAGE_READERS = new WeakSet<ConstraintReader>();

/** `structured` first when given, then the anchored `clause` on the primary message. */
function fromMessage(clause: RegExp, structured?: ConstraintReader): ConstraintReader {
  const reader: ConstraintReader = (cause, message) => structured?.(cause, message) ?? clause.exec(message)?.[1];
  MESSAGE_READERS.add(reader);
  return reader;
}

/** Where each constraint SQLSTATE's name comes from; a SQLSTATE added here must say. */
const CONSTRAINT_SOURCE = {
  '23503': fromIndex,
  '23505': fromMessage(/^duplicate key value violates unique constraint "([^"]+)"$/, fromIndex),
  '23514': fromMessage(/ violates check constraint "([^"]+)"$/),
  '23P01': fromMessage(/^conflicting key value violates exclusion constraint "([^"]+)"$/),
} as const satisfies Record<'23503' | '23505' | '23514' | '23P01', ConstraintReader>;

function hasConstraintSource(sqlState: string): sqlState is keyof typeof CONSTRAINT_SOURCE {
  return Object.prototype.hasOwnProperty.call(CONSTRAINT_SOURCE, sqlState);
}

/**
 * True when `sqlState`'s constraint name can be read from Postgres's primary
 * message, alone or as the fallback for an absent structured field, so a
 * missing name can mean a localised or reworded message:
 * `docs/technical-architecture.md`, "Database errors".
 */
export function namesConstraintInMessage(sqlState: string): boolean {
  return hasConstraintSource(sqlState) && MESSAGE_READERS.has(CONSTRAINT_SOURCE[sqlState]);
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
  return cause === null ? null : pgErrorOfCause(cause);
}

/**
 * The Postgres error in the adapter's cause object itself, for a caller that
 * holds the bare cause (the log serializer). The matchers use `pgErrorOf`,
 * which takes no bare cause.
 */
export function pgErrorOfCause(cause: object): PgError | null {
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
 * True for pg-pool's plain connect-timeout `Error`: the same rules as
 * `isPgPoolTimeout`, for `PG_CONNECT_TIMEOUT_MESSAGE`.
 */
export function isPgConnectTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === PG_CONNECT_TIMEOUT_MESSAGE &&
    !Object.prototype.hasOwnProperty.call(err, 'code') &&
    pgErrorOf(err) === null
  );
}

/**
 * True for pg's plain termination `Error`: the same rules as
 * `isPgPoolTimeout`, for `PG_CONNECTION_TERMINATED_MESSAGE`.
 */
export function isPgConnectionTerminated(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === PG_CONNECTION_TERMINATED_MESSAGE &&
    !Object.prototype.hasOwnProperty.call(err, 'code') &&
    pgErrorOf(err) === null
  );
}

/**
 * The adapter's `cause.kind`, read from the same places as `pgErrorOf`, when it
 * is in `ADAPTER_KINDS`; `undefined` otherwise. Shallow: it never follows `Error.cause`. Where it looks: `docs/technical-architecture.md`, "Database errors".
 */
export function adapterKindOf(err: unknown): AdapterKind | undefined {
  const cause = adapterCauseOf(err);
  return cause === null ? undefined : adapterKindOfCause(cause);
}

/** `adapterKindOf` for the bare cause object, as `pgErrorOfCause` is to `pgErrorOf`. */
export function adapterKindOfCause(cause: object): AdapterKind | undefined {
  const kind = field(cause, 'kind');
  return typeof kind === 'string' && ADAPTER_KIND_SET.has(kind) ? (kind as AdapterKind) : undefined;
}
