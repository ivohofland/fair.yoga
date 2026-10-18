import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { uniqueSuffix } from '../../tests/helpers';
import { RESERVED_SLUGS } from '../lib/reserved-slugs';
import { findReservedSlugHolders } from './reserved-slug-holders';
import { createPrismaClient } from '@/lib/prisma-client';

const db = createPrismaClient();
const suffix = uniqueSuffix();
const teacherIds: string[] = [];
const accountIds: string[] = [];

async function teacherWithSlug(pageSlug: string): Promise<string> {
  const email = `reserved-slug-${pageSlug}@test.local`;
  const t = await db.teacher.create({
    data: { firstName: 'Slug', lastName: 'Holder', email, bio: '', pageSlug, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return t.id;
}

afterAll(async () => {
  // Teacher → Account does not cascade, so the teachers go first.
  if (teacherIds.length > 0) {
    await db.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await db.$disconnect();
});

describe('findReservedSlugHolders', () => {
  it('names each teacher holding a reserved name, ordered by slug, and no one else', async () => {
    const b = await teacherWithSlug(`zz-b-${suffix}`);
    const a = await teacherWithSlug(`zz-a-${suffix}`);
    await teacherWithSlug(`zz-free-${suffix}`);
    const holders = await findReservedSlugHolders(db, [`zz-b-${suffix}`, `zz-a-${suffix}`, `zz-unheld-${suffix}`]);
    expect(holders).toEqual([
      { teacherId: a, pageSlug: `zz-a-${suffix}` },
      { teacherId: b, pageSlug: `zz-b-${suffix}` },
    ]);
  });

  it('answers empty for an empty list', async () => {
    expect(await findReservedSlugHolders(db, [])).toEqual([]);
  });
});

// The deploy gate itself, spawned as the migrate image runs it. The no-holder
// run needs the test database to hold no reserved slug but the one this block
// creates and removes, so no test may seed a teacher on a reserved name.
describe('scripts/check-reserved-slugs.ts', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const tsx = path.join(repoRoot, 'node_modules/.bin/tsx');
  const held = 'impressum';
  const heldEmail = `reserved-slug-${held}@test.local`;

  function runGate(databaseUrl: string): SpawnSyncReturns<string> {
    return spawnSync(tsx, ['scripts/check-reserved-slugs.ts'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    });
  }

  async function removeHeld(): Promise<void> {
    await db.teacher.deleteMany({ where: { OR: [{ pageSlug: held }, { email: heldEmail }] } });
    await db.account.deleteMany({ where: { email: heldEmail } });
  }

  beforeAll(async () => {
    expect(RESERVED_SLUGS.has(held)).toBe(true);
    await removeHeld();
  });

  afterAll(removeHeld);

  it('refuses when the database is unreachable', () => {
    const r = runGate('postgresql://u:p@127.0.0.1:1/none');
    expect(r.stderr).toContain('reserved-slug check: failed to run; refusing the deploy');
    expect(r.status).toBe(1);
  }, 30_000);

  it('refuses while a teacher holds a reserved slug, naming the slug and the teacher', async () => {
    const t = await db.teacher.create({
      data: { firstName: 'Slug', lastName: 'Holder', email: heldEmail, bio: '', pageSlug: held, account: { create: { email: heldEmail } } },
      select: { id: true },
    });
    try {
      const r = runGate(process.env.DATABASE_URL ?? '');
      expect(r.stderr).toContain(`"${held}" is held by teacher ${t.id}`);
      expect(r.stderr).toContain('refusing the deploy');
      expect(r.status).toBe(1);
    } finally {
      await removeHeld();
    }
  }, 30_000);

  it('passes when no teacher holds a reserved slug', () => {
    const r = runGate(process.env.DATABASE_URL ?? '');
    expect(r.stdout).toContain('no teacher holds a reserved page slug');
    expect(r.status).toBe(0);
  }, 30_000);
});
