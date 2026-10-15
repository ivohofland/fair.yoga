import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * This module is the codebase's one importer of `@prisma/client`; everything
 * else takes `Prisma`, the model types and the enums from here. `PrismaClient`
 * is exported as a type only, so `createPrismaClient` below stays the one
 * constructor: `new PrismaClient()` anywhere else is a compile error. Why:
 * `docs/technical-architecture.md`, "Where Prisma comes from".
 */
export * from '@prisma/client';
export type { PrismaClient } from '@prisma/client';

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
