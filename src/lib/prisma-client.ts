import { availableParallelism } from 'node:os';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import { PG_POOL_TIMEOUT_MESSAGE } from './pg-messages';

/**
 * Re-exports the generated client, except that `PrismaClient` is a type only here,
 * so `createPrismaClient` below is the one value that constructs a client. Why,
 * and where it is enforced: `docs/technical-architecture.md`, "Where Prisma
 * comes from".
 */
export * from '../generated/prisma/client';
export type { PrismaClient } from '../generated/prisma/client';

/** pg's `max` when `poolMax` is omitted. Why this formula, and its production value: docs/technical-architecture.md, "Where Prisma comes from". */
export const DEFAULT_POOL_MAX = availableParallelism() * 2 + 1;
/** pg's `connectionTimeoutMillis` when `connectionTimeoutMs` is omitted. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
/** How long an idle connection stays open. Why 300 s: docs/technical-architecture.md, "Where Prisma comes from". */
const IDLE_TIMEOUT_MS = 300_000;

export interface PrismaClientFactoryOptions {
  /** Connection string. Omitted, `DATABASE_URL` is read when the client is built. */
  url?: string;
  /** pg's `max`. Omitted, `DEFAULT_POOL_MAX`. */
  poolMax?: number;
  /** pg's `connectionTimeoutMillis`: bounds both a pool wait and a new connection. A positive integer; pg reads 0 as "wait forever", which `maxWait` cannot mirror. */
  connectionTimeoutMs?: number;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
  /** Passed through to `PrismaClient`. */
  log?: Prisma.PrismaClientOptions['log'];
  /** Heard when an idle pooled connection errors (server restart, reset socket). Omitted, the adapter drops it. */
  onPoolError?: (err: Error) => void;
  /** Heard when a connection held by a transaction errors. Omitted, the adapter drops it. */
  onConnectionError?: (err: Error) => void;
  /**
   * Heard when a caller's wait for a pooled connection times out, with the
   * pool's counters as the timeout is delivered; the caller still gets the
   * error. A throw from it becomes a process warning, never the caller's error.
   * It does not survive `$disconnect` and a later reconnect: the adapter then
   * rebuilds a plain pool from the config.
   */
  onPoolExhausted?: (counters: PoolCounters) => void;
}

/** The pool as a wait timed out: pg-pool's `waitingCount`, `totalCount` and `idleCount`, and the pool's `max`. */
export interface PoolCounters {
  readonly waiting: number;
  readonly total: number;
  readonly idle: number;
  readonly max: number;
}

/** The `pg.Pool` config `PrismaPg` is built from. */
export interface PgPoolConfig {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly allowExitOnIdle: boolean;
}

/**
 * The pool `createPrismaClient` builds for `options`. An empty url counts as
 * missing: pg would read it as "libpq defaults" rather than refuse.
 * `allowExitOnIdle` unrefs idle clients so a finished process exits; it closes nothing.
 */
export function poolConfigFor(options: PrismaClientFactoryOptions = {}): PgPoolConfig {
  const connectionString = options.url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('createPrismaClient: no url given and DATABASE_URL is not set');
  const max = options.poolMax ?? DEFAULT_POOL_MAX;
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`createPrismaClient: poolMax must be a positive integer, got ${String(max)}`);
  }
  const connectionTimeoutMillis = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 1) {
    throw new RangeError(
      `createPrismaClient: connectionTimeoutMs must be a positive integer, got ${String(connectionTimeoutMillis)}`,
    );
  }
  return {
    connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  };
}

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void;

/** A `pg.Pool` that tells `onPoolExhausted` when a caller's wait for a connection times out, in both `connect` forms. */
class ExhaustionReportingPool extends pg.Pool {
  readonly #max: number;
  readonly #onPoolExhausted: ((counters: PoolCounters) => void) | undefined;

  constructor(config: PgPoolConfig, onPoolExhausted: ((counters: PoolCounters) => void) | undefined) {
    super(config);
    this.#max = config.max;
    this.#onPoolExhausted = onPoolExhausted;
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | undefined {
    if (callback === undefined) {
      return super.connect().catch((err: unknown) => {
        this.#report(err);
        throw err;
      });
    }
    super.connect((err, client, done) => {
      this.#report(err);
      callback(err, client, done);
    });
    return undefined;
  }

  #report(err: unknown): void {
    // A deliberate subset of `isPgPoolTimeout` (pg-error.ts): the message and no own
    // `code` suffice, because this is pg-pool's own error, before anything wraps it.
    if (!(err instanceof Error) || err.message !== PG_POOL_TIMEOUT_MESSAGE || Object.prototype.hasOwnProperty.call(err, 'code')) return;
    try {
      this.#onPoolExhausted?.({ waiting: this.waitingCount, total: this.totalCount, idle: this.idleCount, max: this.#max });
    } catch (hookErr: unknown) {
      // The caller's error stays untouched; the hook's own failure is only made visible.
      const detail = hookErr instanceof Error ? hookErr.message : String(hookErr);
      process.emitWarning(`onPoolExhausted threw: ${detail}`);
    }
  }
}

/** How far past the pool bound `maxWait` sits, so pg-pool's timeout fires first. */
export const MAX_WAIT_MARGIN_MS = 1_000;

/**
 * The client's default interactive-transaction options for `pool`: `maxWait`
 * sits a margin past the pool's wait bound, so pg-pool's timeout, not `maxWait`,
 * is the bound a waiting transaction meets. Why: `docs/technical-architecture.md`,
 * "Database errors".
 */
export function transactionOptionsFor(pool: PgPoolConfig): { readonly maxWait: number } {
  return { maxWait: pool.connectionTimeoutMillis + MAX_WAIT_MARGIN_MS };
}

/**
 * Every TypeScript module builds its `PrismaClient` here. This never caches;
 * each call returns a new client with its own pool. The client runs on
 * Prisma's client engine through `PrismaPg`, which owns the connections: the
 * factory, not Prisma, reads `DATABASE_URL`, through `poolConfigFor`. Pool
 * policy: `docs/technical-architecture.md`, "Where Prisma comes from".
 *
 * Under vitest the guard installer skips this module's stack frame, so the
 * caller decides whether the client carries the undefined-filter guard:
 * `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".
 */
export function createPrismaClient(options: PrismaClientFactoryOptions = {}): PrismaClient {
  const pool = poolConfigFor(options);
  return new PrismaClient({
    adapter: new PrismaPg(new ExhaustionReportingPool(pool, options.onPoolExhausted), {
      ...(options.onPoolError === undefined ? {} : { onPoolError: options.onPoolError }),
      ...(options.onConnectionError === undefined ? {} : { onConnectionError: options.onConnectionError }),
      disposeExternalPool: true,
    }),
    transactionOptions: transactionOptionsFor(pool),
    ...(options.errorFormat === undefined ? {} : { errorFormat: options.errorFormat }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}
