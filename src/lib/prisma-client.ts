import { PrismaClient, type Prisma } from '@prisma/client';

export interface PrismaClientFactoryOptions {
  /** Connection URL. Omitted, Prisma reads `DATABASE_URL`. */
  url?: string;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
}

/**
 * The one place a `PrismaClient` is constructed. Every call returns a new
 * client with its own connection pool, and this never caches: callers that
 * open several rely on them being separate connections.
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
