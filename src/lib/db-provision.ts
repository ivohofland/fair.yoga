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
 * seeding — but only on the run that actually creates the database, so a
 * re-run against an existing one never wipes data a developer put there.
 */
export async function provisionDatabase(url: string, options: ProvisionOptions): Promise<void> {
  const dbName = new URL(url).pathname.slice(1);
  assertSafeDatabaseName(dbName);

  const admin = new PrismaClient({ datasources: { db: { url: withDatabaseName(url, 'postgres') } } });
  let created = false;
  try {
    const exists = await admin.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      created = true;
      console.log(`[db-provision] created database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  if (options.seed && created) {
    execSync('npx prisma db seed', {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    console.log(`[db-provision] seeded database ${dbName}`);
  }
}
