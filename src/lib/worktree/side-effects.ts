import { PrismaClient } from '@prisma/client';
import { assertSafeDatabaseName, withDatabaseName } from '../db-provision';

export async function dropDatabaseReal(dbName: string, anyDatabaseUrl: string): Promise<void> {
  assertSafeDatabaseName(dbName);
  const admin = new PrismaClient({ datasources: { db: { url: withDatabaseName(anyDatabaseUrl, 'postgres') } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

export function killPidReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
