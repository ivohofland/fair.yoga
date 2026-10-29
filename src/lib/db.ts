import type { PrismaClient } from '@/lib/prisma-client';
import { log } from '@/lib/log';
import { createPrismaClient } from './prisma-client';
import { recordPoolExhaustion } from './pool-exhaustion';

declare global {
  // Instrumentation, routes and pages each evaluate this module; one client is one pool for all.
  var __fairYogaPrisma: PrismaClient | undefined;
}

export const prisma = (globalThis.__fairYogaPrisma ??= createPrismaClient({
  onPoolError: (err) => log.error({ err }, 'idle database connection errored'),
  onConnectionError: (err) => log.error({ err }, 'transaction database connection errored'),
  onPoolExhausted: recordPoolExhaustion,
}));
