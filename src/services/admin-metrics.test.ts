import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';
import { scopeSweep } from '../../tests/scoped-sweep';
import { TEST_ADMIN_HOST, createAdminFixture, seedPasskeySession, cleanupAdminFixtures, type AdminFixture } from '../../tests/admin-fixtures';
import { resolveAdminAccess, type AdminProof } from '@/lib/admin-access';
import { getPlatformCounts } from './admin-metrics';

/**
 * Counts are whole-table, and this file runs in the parallel `unit` tier, so
 * every call goes through a `scopeSweep` client narrowed to this file's own
 * rows. Expected counts are pairwise distinct, so a swapped field cannot pass.
 */
const db = new PrismaClient();
const suffix = uniqueSuffix();
let admin: AdminFixture;
let proof: AdminProof;
const teacherIds: string[] = [];
const studentIds: string[] = [];
const roomIds: string[] = [];

async function teacher(label: string, erased: boolean): Promise<string> {
  const email = `metrics-t-${label}-${suffix}@test.local`;
  const t = await db.teacher.create({
    data: { firstName: 'M', lastName: label, email, bio: 'metrics', pageSlug: `metrics-${label}-${suffix}`, account: { create: { email } } },
  });
  if (erased) await db.teacher.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
  teacherIds.push(t.id);
  return t.id;
}

async function student(label: string, kind: 'claimed' | 'walk-in' | 'erased' | 'erased-walk-in'): Promise<void> {
  const email = `metrics-s-${label}-${suffix}@test.local`;
  const s = await db.student.create({
    data:
      kind === 'walk-in' || kind === 'erased-walk-in'
        ? { firstName: 'M', lastName: label, email, incomeTier: 3 }
        : { firstName: 'M', lastName: label, email, incomeTier: 3, claimedAt: new Date(), account: { create: { email } } },
  });
  if (kind === 'erased' || kind === 'erased-walk-in') await db.student.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
  studentIds.push(s.id);
}

async function room(label: string, isPublic: boolean, createdById: string): Promise<void> {
  const r = await db.room.create({
    data: { venueName: `V ${label}`, address: `${label} ${suffix} Street`, city: 'Utrecht', postcode: '3511AA', maxCapacity: 10, isPublic, createdById },
  });
  roomIds.push(r.id);
}

beforeAll(async () => {
  vi.stubEnv('ADMIN_HOST', TEST_ADMIN_HOST);
  admin = await createAdminFixture(db, 'metrics');
  const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
  if (access.kind !== 'granted') throw new Error('fixture admin was not granted');
  proof = access.proof;

  // Expected: teachers 3, withAccount 2, walkInOnly 4, public 5, private 6.
  const creator = await teacher('t0', false);
  await teacher('t1', false);
  await teacher('t2', false);
  await teacher('t3', true);
  for (const l of ['s0', 's1']) await student(l, 'claimed');
  await student('s2', 'erased');
  for (const l of ['w0', 'w1', 'w2', 'w3']) await student(l, 'walk-in');
  await student('w4', 'erased-walk-in');
  for (const l of ['p0', 'p1', 'p2', 'p3', 'p4']) await room(l, true, creator);
  for (const l of ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']) await room(l, false, creator);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (roomIds.length) await db.room.deleteMany({ where: { id: { in: roomIds } } });
  if (studentIds.length) await db.student.deleteMany({ where: { id: { in: studentIds } } });
  if (teacherIds.length) await db.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await db.account.deleteMany({ where: { email: { contains: `-${suffix}@test.local` }, adminGrants: { none: {} } } });
  if (admin) await cleanupAdminFixtures(db, [admin.accountId]);
  await db.$disconnect();
});

describe('getPlatformCounts', () => {
  it('counts live teachers, claimed and walk-in students, and public and private rooms', async () => {
    const { db: scoped } = scopeSweep(db, {
      Teacher: { id: { in: teacherIds } },
      Student: { id: { in: studentIds } },
      Room: { id: { in: roomIds } },
    });
    expect(await getPlatformCounts(proof, scoped)).toEqual({
      teachers: 3,
      students: { withAccount: 2, walkInOnly: 4 },
      rooms: { public: 5, private: 6 },
    });
  });

  it('refuses a proof it was not handed by the gate', async () => {
    const forged = { accountId: admin.accountId, sessionId: 'x' } as unknown as AdminProof;
    await expect(getPlatformCounts(forged, db)).rejects.toThrow();
  });
});
