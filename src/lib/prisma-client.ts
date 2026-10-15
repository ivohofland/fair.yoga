import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * The one place a `PrismaClient` is constructed. Every call returns a new
 * client with its own connection pool — lock-order tests open several and
 * rely on them being separate connections — so this never caches.
 *
 * Under vitest the guard installer skips this module's stack frame, so the
 * caller decides whether the client carries the undefined-filter guard:
 * `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".
 */
export interface PrismaClientFactoryOptions {
  /** Connection URL. Omitted, Prisma reads `DATABASE_URL`. */
  url?: string;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
}

export function createPrismaClient(options: PrismaClientFactoryOptions = {}): PrismaClient {
  const { url, ...rest } = options;
  const clientOptions: Prisma.PrismaClientOptions =
    url === undefined ? rest : { ...rest, datasources: { db: { url } } };
  return new PrismaClient(clientOptions);
}
