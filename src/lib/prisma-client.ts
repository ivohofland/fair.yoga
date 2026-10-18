import { availableParallelism } from 'node:os';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';

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
  /** pg's `connectionTimeoutMillis`: bounds both a pool wait and a new connection. */
  connectionTimeoutMs?: number;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
  /** Passed through to `PrismaClient`. */
  log?: Prisma.PrismaClientOptions['log'];
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
  return {
    connectionString,
    max,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  };
}

/**
 * The client's default interactive-transaction options for `pool`: `maxWait`
 * equals the pool's wait bound, so pg-pool's timeout is the bound a waiting
 * transaction meets. Why: `docs/technical-architecture.md`, "Database errors".
 */
export function transactionOptionsFor(pool: PgPoolConfig): { readonly maxWait: number } {
  return { maxWait: pool.connectionTimeoutMillis };
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
    adapter: new PrismaPg(pool),
    transactionOptions: transactionOptionsFor(pool),
    ...(options.errorFormat === undefined ? {} : { errorFormat: options.errorFormat }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}
