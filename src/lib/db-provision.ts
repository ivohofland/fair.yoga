import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

export function assertSafeDatabaseName(dbName: string): void {
  if (!/^[a-z0-9_]+$/i.test(dbName)) {
    throw new Error(`unsafe database name: ${dbName}`);
  }
}

export function withDatabaseName(baseUrl: string, dbName: string): string {
  assertSafeDatabaseName(dbName);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export interface ProvisionOptions {
  seed: boolean;
}

/**
 * Create-if-missing + `prisma migrate deploy` against `url`, optionally
 * seeding — but only when the database is actually empty of seed data
 * (checked by row count after a successful migrate), so a re-run against
 * an existing, already-seeded database never wipes data a developer put
 * there, and a database left empty by a prior failed migrate still gets
 * seeded once migrate succeeds.
 */
export async function provisionDatabase(url: string, options: ProvisionOptions): Promise<void> {
  const dbName = new URL(url).pathname.slice(1);
  assertSafeDatabaseName(dbName);

  const admin = new PrismaClient({ datasources: { db: { url: withDatabaseName(url, 'postgres') } } });
  try {
    const exists = await admin.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`[db-provision] created database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  if (options.seed) {
    const target = new PrismaClient({ datasources: { db: { url } } });
    let alreadyHasData: boolean;
    try {
      const [row] = await target.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) as count FROM "Teacher"`;
      alreadyHasData = (row?.count ?? BigInt(0)) > BigInt(0);
    } finally {
      await target.$disconnect();
    }
    if (!alreadyHasData) {
      execSync('npx prisma db seed', {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      console.log(`[db-provision] seeded database ${dbName}`);
    }
  }
}
