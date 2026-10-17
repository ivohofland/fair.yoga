import { PrismaClient, type Prisma } from '../generated/prisma/client';

/**
 * Re-exports the generated client, except that `PrismaClient` is a type only here,
 * so `createPrismaClient` below is the one value that constructs a client. Why,
 * and where it is enforced: `docs/technical-architecture.md`, "Where Prisma
 * comes from".
 */
export * from '../generated/prisma/client';
export type { PrismaClient } from '../generated/prisma/client';

export interface PrismaClientFactoryOptions {
  /** Connection URL. Omitted, Prisma reads `DATABASE_URL`. */
  url?: string;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
}

/**
 * Every TypeScript module builds its `PrismaClient` here. This never caches;
 * each call returns a new client with its own pool.
 *
 * Under vitest the guard installer skips this module's stack frame, so the
 * caller decides whether the client carries the undefined-filter guard:
 * `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".
 */
export function createPrismaClient(options: PrismaClientFactoryOptions = {}): PrismaClient {
  const { url, ...rest } = options;
  const clientOptions: Prisma.PrismaClientOptions =
    url === undefined ? rest : { ...rest, datasources: { db: { url } } };
  return new PrismaClient(clientOptions);
}
