/**
 * Global setup for the vitest `unit` project: provision and migrate the
 * dedicated test database (docs/test-database.md).
 *
 * The unit tier includes service tests that inject far-future clocks
 * into database-wide sweeps — on a shared database those once completed
 * the seed's future classes and mailed their payment requests. This
 * setup guarantees they run against `DATABASE_URL_TEST` instead.
 *
 * When DATABASE_URL_TEST is not set (CI), everything is skipped: CI's
 * database is already throwaway and migrated by the workflow.
 */

import { execSync } from 'child_process';
import { loadEnv } from 'vite';
import { PrismaClient } from '@prisma/client';

export default async function setup(): Promise<void> {
  const fileEnv = loadEnv('', process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  const testUrl = process.env.DATABASE_URL_TEST ?? fileEnv.DATABASE_URL_TEST;

  if (!testUrl) {
    console.log('[unit-db] DATABASE_URL_TEST not set — using DATABASE_URL as-is (CI mode)');
    return;
  }
  if (testUrl === devUrl) {
    throw new Error(
      '[unit-db] DATABASE_URL_TEST equals DATABASE_URL — refusing to run unit tests ' +
        'against the dev database. Point DATABASE_URL_TEST at a separate database.',
    );
  }

  const dbName = new URL(testUrl).pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(dbName)) {
    throw new Error(`[unit-db] unsafe test database name: ${dbName}`);
  }

  // Create the database if it doesn't exist, via the maintenance DB.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const exists = await admin.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`[unit-db] created database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }

  // Keep the schema in lockstep with dev — a no-op when up to date.
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  console.log(`[unit-db] unit tests run against ${dbName}`);
}
