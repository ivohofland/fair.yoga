import type { PrismaClient } from '@/lib/prisma-client';
import { log } from '@/lib/log';
import { createPrismaClient } from './prisma-client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient({
    onPoolError: (err) => log.error({ err }, 'idle database connection errored'),
    onConnectionError: (err) => log.error({ err }, 'transaction database connection errored'),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
